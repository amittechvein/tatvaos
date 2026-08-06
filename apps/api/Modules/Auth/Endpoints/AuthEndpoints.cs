using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// Core sign-in. ONE login for every TatvaOS product.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Two things here are worth understanding before changing anything.
///
///  1. LOGIN IS THE ONE CROSS-TENANT LOOKUP IN THE SYSTEM.
///     A sign-in request carries an email address and nothing else — we
///     cannot know the tenant until we have found the user. So this is the
///     only place that queries core.users with the tenant filter off. It is
///     safe because core.users carries no RLS by design (the mail edge must
///     resolve recipients before any tenant is known), and because the query
///     is by exact email, which returns one row or none.
///
///  2. FAILURES ARE DELIBERATELY INDISTINGUISHABLE.
///     Wrong password, unknown address, suspended account and suspended
///     organisation all return the same message. Telling an attacker which
///     addresses exist on the platform is a free customer list, and telling
///     them an account is merely suspended tells them it is worth pursuing.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AuthEndpoints
{
    // Five is enough for someone genuinely mistyping; far too few to guess a
    // password. The lockout expires on its own, because the common cause is a
    // person fumbling their own credentials and an admin ticket for that helps
    // nobody.
    private const int MaxFailedAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    private const string GenericFailure =
        "That email address and password combination was not recognised.";

    // ---------------------------------------------------------------------
    //  The refresh token also goes out as an httpOnly cookie.
    //
    //  This is a mail product: it renders HTML written by strangers. Assume a
    //  cross-site scripting bug will happen one day, and design so that it is
    //  survivable. A token in localStorage is readable by any script on the
    //  page; an httpOnly cookie is not readable by script at all.
    //
    //  Web clients should therefore ignore the refreshToken in the response
    //  body entirely and let the browser handle the cookie. It stays in the
    //  body for the mobile apps, which have no cookie jar to rely on and put
    //  it in the Keychain or Keystore — storage that XSS cannot reach either.
    //
    //  Path is scoped to /api/auth so the token is not attached to every
    //  ordinary API call, and SameSite=Strict because there is no legitimate
    //  cross-site request that should carry it.
    // ---------------------------------------------------------------------
    private const string LegacyRefreshCookie = "tv_refresh";

    // =====================================================================
    //  MULTIPLE ACCOUNTS IN ONE BROWSER
    // =====================================================================
    //
    //  A person runs amit@techvein.com and hr@techvein.com, or an IT admin
    //  holds an account in three of their customers. Forcing a sign-out
    //  between them is the single most irritating thing a work account can
    //  do, so each signed-in account gets its own SLOT.
    //
    //  Slot N owns three cookies:
    //
    //    tv_refresh_N   the refresh token.        httpOnly
    //    tv_label_N     email | name | org.       httpOnly
    //    tv_active      which slot is current.    httpOnly
    //
    //  ALL THREE ARE httpOnly, INCLUDING THE LABEL.
    //
    //  Google's chooser reads its account list from script-readable storage.
    //  We do not, and the reason is worth keeping: an XSS bug on a page that
    //  renders mail written by strangers would otherwise hand the attacker
    //  every other identity this person holds — which customers they work
    //  for, which organisations they administer. The roster is assembled
    //  server-side and returned in the /refresh and /accounts responses, so
    //  the switcher renders from a normal API result and script never has a
    //  cookie to read.
    //
    //  The label is stored separately from the token ON PURPOSE. It outlives
    //  the token, so an expired account still appears by name with a "Signed
    //  out — Sign in / Remove" row rather than silently vanishing from the
    //  list, which reads as data loss.
    //
    //  A label cookie is display text and nothing else. It grants no access:
    //  switching validates the slot's actual refresh token against the
    //  database, and the identity in the response comes from core.users. A
    //  tampered label can mislead the chooser and cannot mislead the server.
    // =====================================================================

    /// <summary>Slots 0-5. Six is past what anyone juggles; the cap stops
    /// cookie headers growing without bound.</summary>
    private const int MaxAccounts = 6;

    private const string ActiveCookie = "tv_active";
    private static string RefreshCookie(int slot) => $"tv_refresh_{slot}";
    private static string LabelCookie(int slot) => $"tv_label_{slot}";

    // ---------------------------------------------------------------------
    //  Cookie domain — the thing that makes ONE login cover every product.
    //
    //  Core is core.tatvaos.com and Mail is mail.tatvaos.com. A cookie with no
    //  Domain attribute is host-only, so a session established on Core would
    //  not be sent to Mail and the "one sign-in for everything" promise would
    //  quietly become "one sign-in per product".
    //
    //  Setting Domain=.tatvaos.com fixes that, and is why the setting exists —
    //  but it also means EVERY host under tatvaos.com receives the refresh
    //  cookie. Never point a customer-controlled hostname at that domain, and
    //  leave this unset anywhere the domain is shared with something we do not
    //  run. It stays empty for local and staging, where one host serves
    //  everything and the wider scope would buy nothing.
    // ---------------------------------------------------------------------
    private static string? _cookieDomain;

    public static void ConfigureCookies(IConfiguration config) =>
        _cookieDomain = config["Auth:CookieDomain"] is { Length: > 0 } d ? d : null;

    private static CookieOptions CookieOpts(DateTimeOffset? expires = null) => new()
    {
        HttpOnly = true,
        Secure = true,
        // Strict, not Lax, and it still works across core./mail./tatvaos.com:
        // SameSite is judged on the registrable domain, and those are the same
        // site. It is cross-SITE requests that must never carry this.
        SameSite = SameSiteMode.Strict,
        Path = "/api/auth",
        Domain = _cookieDomain,
        Expires = expires,
    };

    private static void SetRefreshCookie(HttpContext http, int slot, string token)
    {
        http.Response.Cookies.Append(RefreshCookie(slot), token,
            CookieOpts(DateTimeOffset.UtcNow.Add(TokenIssuer.RefreshTokenLifetime)));

        // The active marker is a session cookie — no Expires. Closing the
        // browser should not decide which of six accounts you land in.
        http.Response.Cookies.Append(ActiveCookie, slot.ToString(), CookieOpts());
    }

    /// <summary>
    /// Signs a slot out but leaves it listed. Deliberate: the account stays
    /// visible as "Signed out" so signing back in is one click, which is the
    /// behaviour the chooser exists to provide. Use Forget to remove it.
    /// </summary>
    private static void ClearRefreshCookie(HttpContext http, int slot) =>
        http.Response.Cookies.Delete(RefreshCookie(slot), CookieOpts());

    private static void ForgetSlot(HttpContext http, int slot)
    {
        http.Response.Cookies.Delete(RefreshCookie(slot), CookieOpts());
        http.Response.Cookies.Delete(LabelCookie(slot), CookieOpts());
    }

    private static void SetLabel(HttpContext http, int slot, User user, string? org)
    {
        // Pipe-separated and percent-encoded. A display name containing a pipe
        // would otherwise shift the org into the name field, and names contain
        // whatever people type.
        var value = string.Join('|',
            Uri.EscapeDataString(user.Email),
            Uri.EscapeDataString(user.DisplayName ?? ""),
            Uri.EscapeDataString(org ?? ""));

        // Outlives the token by design — a signed-out account keeps its name
        // in the list for as long as the person might come back to it.
        http.Response.Cookies.Append(LabelCookie(slot), value,
            CookieOpts(DateTimeOffset.UtcNow.AddDays(90)));
    }

    private sealed record Label(string Email, string Name, string Org);

    private static Label? ReadLabel(HttpContext http, int slot)
    {
        var raw = http.Request.Cookies[LabelCookie(slot)];
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var parts = raw.Split('|');
        if (parts.Length < 1) return null;

        try
        {
            return new Label(
                Uri.UnescapeDataString(parts[0]),
                parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "",
                parts.Length > 2 ? Uri.UnescapeDataString(parts[2]) : "");
        }
        catch (UriFormatException)
        {
            // A malformed cookie is not worth a 500. Drop the row.
            return null;
        }
    }

    private static int ActiveSlot(HttpContext http) =>
        int.TryParse(http.Request.Cookies[ActiveCookie], out var s)
        && s is >= 0 and < MaxAccounts ? s : 0;

    /// <summary>
    /// Which slot this email should occupy.
    ///
    /// Signing in as someone already listed REPLACES that slot rather than
    /// adding a second row, otherwise the chooser fills with duplicates of the
    /// account you use most.
    /// </summary>
    private static int PickSlot(HttpContext http, string email)
    {
        for (var i = 0; i < MaxAccounts; i++)
            if (string.Equals(ReadLabel(http, i)?.Email, email, StringComparison.OrdinalIgnoreCase))
                return i;

        for (var i = 0; i < MaxAccounts; i++)
            if (ReadLabel(http, i) is null) return i;

        // Full. Evict the last slot — arbitrary, but the alternative is
        // refusing the sign-in the person just asked for, and that is worse
        // than dropping the account they added least recently.
        return MaxAccounts - 1;
    }

    /// <summary>
    /// The account list for this browser.
    ///
    /// <paramref name="signedOut"/> and <paramref name="removed"/> carry slots
    /// changed EARLIER IN THIS REQUEST. Request.Cookies is what the browser
    /// sent and does not see what we have written to the response, so without
    /// them /logout would hand back a roster still showing the account it just
    /// signed out — the one screen where being wrong is most obvious.
    /// </summary>
    private static object BuildRoster(
        HttpContext http, int active,
        HashSet<int>? signedOut = null, HashSet<int>? removed = null,
        HashSet<int>? signedIn = null)
    {
        var list = new List<object>();

        for (var slot = 0; slot < MaxAccounts; slot++)
        {
            if (removed?.Contains(slot) == true) continue;

            var label = ReadLabel(http, slot);
            if (label is null) continue;

            // Presence of the cookie, not a database check. This runs on an
            // anonymous endpoint, so validating six tokens per call would put
            // a free query amplifier on the open internet. Switching does the
            // real check, and the UI corrects itself from that response.
            var hasToken = signedOut?.Contains(slot) != true
                && (signedIn?.Contains(slot) == true
                    || !string.IsNullOrWhiteSpace(http.Request.Cookies[RefreshCookie(slot)]));

            list.Add(new
            {
                slot,
                email = label.Email,
                displayName = string.IsNullOrWhiteSpace(label.Name) ? label.Email : label.Name,
                organisation = label.Org,
                signedIn = hasToken,
                active = slot == active && hasToken,
            });
        }

        return list;
    }

    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/auth").WithTags("Authentication");

        g.MapPost("/login", LoginAsync).AllowAnonymous();
        // Sign-in by mobile OTP — the second tab on the login screen. Same
        // session issuance as the password path, different credential.
        g.MapPost("/otp/request", OtpRequestAsync).AllowAnonymous();
        g.MapPost("/otp/verify", OtpVerifyAsync).AllowAnonymous();
        g.MapPost("/refresh", RefreshAsync).AllowAnonymous();
        g.MapPost("/logout", LogoutAsync).RequireAuthorization("User");
        g.MapGet("/me", MeAsync).RequireAuthorization("User");
        g.MapPost("/change-password", ChangePasswordAsync).RequireAuthorization("User");
        g.MapGet("/sessions", SessionsAsync).RequireAuthorization("User");

        // ---- multi-account ----------------------------------------------
        // All anonymous. The authority for every one of them is possession of
        // the slot's httpOnly cookie, which is a stronger claim than an access
        // token for a DIFFERENT account would be — requiring auth here would
        // mean you must be signed into account A to touch account B.
        g.MapGet("/accounts", AccountsAsync).AllowAnonymous();
        g.MapPost("/switch", SwitchAsync).AllowAnonymous();
        g.MapPost("/forget", ForgetAsync).AllowAnonymous();
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> LoginAsync(
        LoginRequest req, AppDbContext db, TokenIssuer tokens, IPasswordHasher hasher,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        var email = req.Email?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrEmpty(req.Password))
            return Results.BadRequest(new { error = "Email and password are required." });

        // IgnoreQueryFilters is required, not a shortcut: the global filter
        // reads TenantContext.TenantId, which THROWS when no tenant is set —
        // and on an anonymous login there is none.
        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.Email == email, ct);

        if (user is null)
        {
            // Hash anyway. Returning immediately makes an unknown address
            // measurably faster than a wrong password, which turns response
            // time into an account-enumeration oracle.
            hasher.Verify(req.Password, DummyHash);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        if (user.LockedUntil is DateTimeOffset until && until > DateTimeOffset.UtcNow)
        {
            var minutes = Math.Max(1, (int)(until - DateTimeOffset.UtcNow).TotalMinutes);
            return Results.Json(new
            {
                error = $"Too many failed attempts. Try again in {minutes} minute(s).",
            }, statusCode: 429);
        }

        // From here the tenant is known, so the rest of the request can use
        // normal scoped queries — and the refresh token INSERT below needs the
        // database session set, because core.refresh_tokens is RLS-forced.
        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var valid = user.PasswordHash is not null && hasher.Verify(req.Password, user.PasswordHash);

        if (!valid)
        {
            user.FailedLoginCount++;
            if (user.FailedLoginCount >= MaxFailedAttempts)
            {
                user.LockedUntil = DateTimeOffset.UtcNow.Add(LockoutDuration);
                user.FailedLoginCount = 0;
            }
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        // Checked AFTER the password, on purpose. Checking first would let
        // anyone discover which accounts are suspended without a credential.
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (user.Status is "suspended" or "deleted" || org?.Status is "suspended" or "deleted")
            return Results.Json(new { error = GenericFailure }, statusCode: 401);

        return await CompleteSignInAsync(user, org, db, tokens, http, ct);
    }

    // =====================================================================
    //  SIGN-IN BY MOBILE OTP
    // =====================================================================
    //
    //  Every bank in India signs its customers in this way, so the flow needs
    //  no explanation to the people this product is for. Mechanically it is
    //  the signup OTP applied to login: six digits, SHA-256 over (user id,
    //  code), five-minute expiry, five attempts, sixty-second resend gap.
    //
    //  THE RESPONSE NEVER SAYS WHETHER A NUMBER EXISTS. "If this number is
    //  registered, a code has been sent" is the answer for a real number, an
    //  unknown one, and one shared by two accounts alike — a login form that
    //  confirms which mobile numbers are on the platform is a lookup service
    //  for anyone with a list of numbers.
    //
    //  A number shared by TWO users gets no code at all (same generic reply).
    //  Ambiguity has to fail closed: sending a code that signs in "whichever
    //  account matched first" hands one person another person's mailbox.
    // =====================================================================

    private const string OtpGenericReply =
        "If this number is registered, a code has been sent to it.";

    private static readonly TimeSpan OtpLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan OtpResendGap = TimeSpan.FromSeconds(60);
    private const int OtpMaxAttempts = 5;

    private static string OtpHash(Guid userId, string code)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"{userId:N}:{code}"));
        return Convert.ToHexString(bytes);
    }

    private static async Task<IResult> OtpRequestAsync(
        OtpRequest req, AppDbContext db, TenantContext tenant,
        Shared.Notify.ISmsSender sms, Shared.Settings.SettingsReader settings,
        HttpContext http, CancellationToken ct)
    {
        var phone = Shared.PhoneNumber.Normalise(req.Phone);
        if (phone is null)
            return Results.BadRequest(new
            {
                error = "Enter the mobile number with its country code, like +91 98765 43210.",
            });

        // Cross-tenant on purpose, like the email login — the tenant cannot be
        // known until the user is found. Exactly one live match may proceed.
        var matches = await db.Users.IgnoreQueryFilters()
            .Where(u => u.Phone == phone && u.Status != "deleted" && u.Status != "suspended")
            .Take(2)
            .ToListAsync(ct);

        if (matches.Count != 1)
            return Results.Ok(new { sent = true, message = OtpGenericReply });

        var user = matches[0];

        // The password lockout applies here too. OTP must not be the side door
        // around a lockout the password path just imposed.
        if (user.LockedUntil is DateTimeOffset until && until > DateTimeOffset.UtcNow)
            return Results.Ok(new { sent = true, message = OtpGenericReply });

        // Resend throttle. Same generic reply — a different answer inside the
        // gap would itself confirm the number exists.
        if (user.LoginOtpSentAt is DateTimeOffset last
            && DateTimeOffset.UtcNow - last < OtpResendGap)
            return Results.Ok(new { sent = true, message = OtpGenericReply });

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var code = System.Security.Cryptography.RandomNumberGenerator
            .GetInt32(0, 1_000_000).ToString("D6");

        user.LoginOtpHash = OtpHash(user.Id, code);
        user.LoginOtpSentAt = DateTimeOffset.UtcNow;
        user.LoginOtpAttempts = 0;
        await db.SaveChangesAsync(ct);

        var result = await sms.SendOtpAsync(phone, code, ct);

        // Echoed on screen ONLY when the real send failed AND the testing-mode
        // setting is on — the same self-securing rule as the signup OTP. With
        // SMS working, the echo stops by itself.
        var showOtp = await settings.FlagAsync(
            Shared.Settings.SettingKeys.ShowOtpOnScreen, fallback: false, ct);

        return Results.Ok(new
        {
            sent = true,
            message = OtpGenericReply,
            devCode = showOtp && !result.Sent ? code : null,
        });
    }

    private static async Task<IResult> OtpVerifyAsync(
        OtpVerifyRequest req, AppDbContext db, TokenIssuer tokens,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        var phone = Shared.PhoneNumber.Normalise(req.Phone);
        var code = req.Code?.Trim() ?? "";

        if (phone is null || code.Length != 6)
            return Results.Json(new { error = GenericFailure }, statusCode: 401);

        var matches = await db.Users.IgnoreQueryFilters()
            .Where(u => u.Phone == phone && u.Status != "deleted" && u.Status != "suspended")
            .Take(2)
            .ToListAsync(ct);

        if (matches.Count != 1)
            return Results.Json(new { error = GenericFailure }, statusCode: 401);

        var user = matches[0];

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var expired = user.LoginOtpSentAt is null
            || DateTimeOffset.UtcNow - user.LoginOtpSentAt > OtpLifetime;

        if (user.LoginOtpHash is null || expired
            || user.LoginOtpAttempts >= OtpMaxAttempts
            || OtpHash(user.Id, code) != user.LoginOtpHash)
        {
            user.LoginOtpAttempts++;
            if (user.LoginOtpAttempts >= OtpMaxAttempts)
            {
                // Burn the code. Five guesses at six digits is nothing; five
                // guesses per code with unlimited codes would add up.
                user.LoginOtpHash = null;
            }
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        // Single use, before anything else can fail.
        user.LoginOtpHash = null;
        user.LoginOtpSentAt = null;
        user.LoginOtpAttempts = 0;

        // Organisation checked after the credential, same as the password
        // path and for the same reason.
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (org?.Status is "suspended" or "deleted")
        {
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        return await CompleteSignInAsync(user, org, db, tokens, http, ct);
    }

    /// <summary>
    /// Everything that happens once a credential — ANY credential — has been
    /// accepted: counters reset, session issued, slot taken, roster returned.
    ///
    /// Shared by the password login and the OTP login so the two cannot drift.
    /// A second copy of this tail is how one path ends up skipping the
    /// pending→active promotion or the slot pick, and the symptom would be a
    /// user who exists differently depending on how they signed in.
    /// </summary>
    private static async Task<IResult> CompleteSignInAsync(
        User user, Tenant? org, AppDbContext db, TokenIssuer tokens,
        HttpContext http, CancellationToken ct)
    {
        user.FailedLoginCount = 0;
        user.LockedUntil = null;
        user.LastLoginAt = DateTimeOffset.UtcNow;
        if (user.Status == "pending") user.Status = "active";

        var (refresh, _) = await IssueRefreshAsync(db, user, Guid.NewGuid(), http, ct);
        var access = tokens.IssueAccessToken(user);
        await db.SaveChangesAsync(ct);

        // Take a slot rather than overwriting whoever was signed in. Somebody
        // adding a second account should not be silently signed out of the
        // first — that is the entire point of the chooser.
        var slot = PickSlot(http, user.Email);
        SetRefreshCookie(http, slot, refresh);
        SetLabel(http, slot, user, org?.Name);

        return Results.Ok(new AuthResponse(
            AccessToken: access.Value,
            ExpiresAt: access.ExpiresAt,
            RefreshToken: refresh,
            MustChangePassword: user.MustChangePassword,
            User: Describe(user),
            Slot: slot,
            Accounts: BuildRoster(http, slot)));
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// The account chooser's list. Anonymous and cookie-only — the sign-in
    /// page needs it before anyone is authenticated, which is exactly when
    /// "pick which of your accounts" is most useful.
    /// </summary>
    private static IResult AccountsAsync(HttpContext http)
    {
        var migrated = MigrateLegacyCookie(http);
        var active = migrated is null ? ActiveSlot(http) : 0;

        return Results.Ok(new
        {
            accounts = BuildRoster(http, active,
                signedIn: migrated is null ? null : [0]),
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Switch to an account already signed in on this browser.
    ///
    /// No password: the slot's refresh token is the credential, and it is
    /// checked against the database here with the same rotation and reuse
    /// detection as any other refresh. A slot whose token has expired or been
    /// revoked returns 401, and the chooser then shows it as signed out —
    /// which is the honest outcome rather than a silent failure.
    /// </summary>
    private static async Task<IResult> SwitchAsync(
        SwitchRequest req, AppDbContext db, TokenIssuer tokens,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        if (req.Slot is < 0 or >= MaxAccounts)
            return Results.BadRequest(new { error = "Unknown account." });

        var presented = http.Request.Cookies[RefreshCookie(req.Slot)];
        if (string.IsNullOrWhiteSpace(presented))
            return Results.Json(new
            {
                error = "That account is signed out on this browser. Sign in again.",
                slot = req.Slot,
            }, statusCode: 401);

        var outcome = await RotateAsync(presented, db, tokens, tenant, http, ct);

        if (outcome.Error is not null)
        {
            // The token is gone but the label stays, so the account remains in
            // the list as a one-click "Sign in" rather than disappearing.
            ClearRefreshCookie(http, req.Slot);
            return Results.Json(new
            {
                error = outcome.Error,
                slot = req.Slot,
                accounts = BuildRoster(http, -1, signedOut: [req.Slot]),
            }, statusCode: outcome.Status);
        }

        var user = outcome.User!;
        SetRefreshCookie(http, req.Slot, outcome.RefreshToken!);

        // Refresh the label while we are here — a display name or organisation
        // renamed since the last sign-in would otherwise stay wrong for 90 days.
        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        SetLabel(http, req.Slot, user, org?.Name);

        return Results.Ok(new AuthResponse(
            outcome.Access!.Value, outcome.Access.ExpiresAt, outcome.RefreshToken!,
            user.MustChangePassword, Describe(user),
            Slot: req.Slot,
            Accounts: BuildRoster(http, req.Slot)));
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// "Remove" in the chooser. Revokes the slot's session family and drops
    /// its label, so the account leaves the list entirely.
    ///
    /// Anonymous because possession of the cookie is the authority. It also
    /// has to work on an ALREADY signed-out slot, where by definition there is
    /// no token to authenticate with — and being unable to tidy a stale entry
    /// off a shared machine would be the worse failure.
    /// </summary>
    private static async Task<IResult> ForgetAsync(
        SwitchRequest req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        if (req.Slot is < 0 or >= MaxAccounts)
            return Results.BadRequest(new { error = "Unknown account." });

        var presented = http.Request.Cookies[RefreshCookie(req.Slot)];
        if (!string.IsNullOrWhiteSpace(presented))
            await RevokeFamilyAsync(presented, db, tenant, "removed from this browser", ct);

        ForgetSlot(http, req.Slot);

        var active = ActiveSlot(http);
        return Results.Ok(new
        {
            removed = true,
            accounts = BuildRoster(http, active == req.Slot ? -1 : active,
                                   removed: [req.Slot]),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> RefreshAsync(
        RefreshRequest req, AppDbContext db, TokenIssuer tokens,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        // A session from before slots existed becomes slot 0. The token comes
        // back from the call because the cookie we just wrote is on the
        // response, and Request.Cookies only holds what the browser sent.
        var migrated = MigrateLegacyCookie(http);

        var slot = migrated is null ? ActiveSlot(http) : 0;

        // Cookie first. A browser sends it automatically and never exposes it
        // to script; the body is the mobile path.
        var presented = migrated ?? http.Request.Cookies[RefreshCookie(slot)];

        // The active slot may have been signed out while another account is
        // still live — land on that one instead of demanding a fresh sign-in.
        if (string.IsNullOrWhiteSpace(presented))
            for (var i = 0; i < MaxAccounts; i++)
            {
                var candidate = http.Request.Cookies[RefreshCookie(i)];
                if (!string.IsNullOrWhiteSpace(candidate)) { slot = i; presented = candidate; break; }
            }

        if (string.IsNullOrWhiteSpace(presented)) presented = req.RefreshToken;

        if (string.IsNullOrWhiteSpace(presented))
            return Results.Json(new
            {
                error = "A refresh token is required.",
                accounts = BuildRoster(http, -1),
            }, statusCode: 401);

        var outcome = await RotateAsync(presented, db, tokens, tenant, http, ct);

        if (outcome.Error is not null)
        {
            ClearRefreshCookie(http, slot);
            return Results.Json(new
            {
                error = outcome.Error,
                accounts = BuildRoster(http, -1, signedOut: [slot]),
            }, statusCode: outcome.Status);
        }

        var refreshed = outcome.User!;
        SetRefreshCookie(http, slot, outcome.RefreshToken!);

        var tenantRow = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == refreshed.TenantId, ct);
        SetLabel(http, slot, refreshed, tenantRow?.Name);

        return Results.Ok(new AuthResponse(
            outcome.Access!.Value, outcome.Access.ExpiresAt, outcome.RefreshToken!,
            refreshed.MustChangePassword, Describe(refreshed),
            Slot: slot,
            Accounts: BuildRoster(http, slot)));
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Validate a refresh token, rotate it, and issue a new access token.
    ///
    /// Shared by /refresh and /switch. Written once because these two paths
    /// must agree on reuse detection and the suspension check — a second copy
    /// is how one of them ends up missing the check that makes suspension
    /// mean anything.
    /// </summary>
    private static async Task<RotateOutcome> RotateAsync(
        string presented, AppDbContext db, TokenIssuer tokens,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        var hash = TokenIssuer.HashRefreshToken(presented);

        // core.refresh_tokens is RLS-forced and we do not yet know the tenant,
        // so this goes through the SECURITY DEFINER function that exists for
        // exactly this one lookup. See 04-auth.sql.
        //
        // Raw ADO rather than EF's SqlQuery<T>: that only maps scalar types
        // unless the result type is registered as a keyless entity, and a
        // multi-column projection through it compiles fine and then fails at
        // runtime. Not a place to find out.
        var resolved = await ResolveTokenAsync(db, hash, ct);

        if (resolved is null)
            return RotateOutcome.Fail(401, "Session expired. Sign in again.");

        tenant.Set(resolved.TenantId, resolved.UserId, "employee");
        await db.SyncTenantAsync(ct);

        // A revoked token being presented means someone is replaying one that
        // was already spent — either a thief, or the real user after a thief.
        // There is no way to tell which, so both are stopped: kill the family.
        // The legitimate user signs in again; the thief has nothing.
        if (resolved.WasRevoked)
        {
            await db.RefreshTokens
                .Where(t => t.FamilyId == resolved.FamilyId && t.RevokedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                    .SetProperty(t => t.RevokeReason, (string?)"reuse detected"), ct);

            return RotateOutcome.Fail(401,
                "This session was already used elsewhere and has been ended. Sign in again.");
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == resolved.UserId, ct);
        var org = user is null ? null
            : await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);

        // THE check that makes suspension real. An access token cannot be
        // withdrawn, but it only lasts fifteen minutes — and it is renewed
        // here, where the database gets a say.
        if (user is null || user.Status is "suspended" or "deleted"
            || org?.Status is "suspended" or "deleted")
        {
            await db.RefreshTokens
                .Where(t => t.FamilyId == resolved.FamilyId && t.RevokedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                    .SetProperty(t => t.RevokeReason, (string?)"account or organisation suspended"), ct);

            return RotateOutcome.Fail(401, "This account is no longer active.");
        }

        var old = await db.RefreshTokens.FirstAsync(t => t.Id == resolved.TokenId, ct);
        var (newToken, newRow) = await IssueRefreshAsync(db, user, resolved.FamilyId, http, ct);

        old.RevokedAt = DateTimeOffset.UtcNow;
        old.RevokeReason = "rotated";
        old.ReplacedBy = newRow.Id;

        var access = tokens.IssueAccessToken(user);
        await db.SaveChangesAsync(ct);

        return new RotateOutcome(null, 200, user, newToken, access);
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Sign out of the CURRENT account only.
    ///
    /// The other accounts in this browser stay signed in — signing out of a
    /// personal account should not evict you from the organisation you were
    /// administering in the next tab. Pass all=true for the "sign out of
    /// everything" case, which is what someone on a shared machine wants.
    /// </summary>
    private static async Task<IResult> LogoutAsync(
        LogoutRequest? req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        var all = req?.All == true;
        var active = ActiveSlot(http);

        var signedOut = new HashSet<int>();
        var removed = new HashSet<int>();

        for (var slot = 0; slot < MaxAccounts; slot++)
        {
            if (!all && slot != active) continue;

            var presented = http.Request.Cookies[RefreshCookie(slot)];
            if (string.IsNullOrWhiteSpace(presented)) continue;

            await RevokeFamilyAsync(presented, db, tenant, "signed out", ct);

            if (all) { ForgetSlot(http, slot); removed.Add(slot); }
            // Label kept, so this account stays in the chooser as a one-click
            // "Sign in" rather than vanishing the moment you sign out of it.
            else { ClearRefreshCookie(http, slot); signedOut.Add(slot); }
        }

        // Mobile clients send the token in the body and have no cookie jar.
        var bodyToken = req?.RefreshToken;
        if (!string.IsNullOrWhiteSpace(bodyToken))
            await RevokeFamilyAsync(bodyToken, db, tenant, "signed out", ct);

        if (all) http.Response.Cookies.Delete(ActiveCookie, CookieOpts());

        // Land on whichever account is still signed in, so the browser does
        // not sit on an empty session while a valid one exists.
        var next = -1;
        if (!all)
            for (var slot = 0; slot < MaxAccounts; slot++)
                if (slot != active
                    && !string.IsNullOrWhiteSpace(http.Request.Cookies[RefreshCookie(slot)]))
                { next = slot; break; }

        if (next >= 0)
            http.Response.Cookies.Append(ActiveCookie, next.ToString(), CookieOpts());

        return Results.Ok(new
        {
            signedOut = true,
            switchedTo = next < 0 ? (int?)null : next,
            accounts = BuildRoster(http, next, signedOut, removed),
        });
    }

    /// <summary>
    /// Revokes every live token in the presented token's family, so "signed
    /// out" means signed out rather than "signed out until the refresh token
    /// is presented again".
    /// </summary>
    private static async Task RevokeFamilyAsync(
        string presented, AppDbContext db, TenantContext tenant, string reason, CancellationToken ct)
    {
        var hash = TokenIssuer.HashRefreshToken(presented);

        // Resolved through the SECURITY DEFINER function, not a direct query:
        // core.refresh_tokens is RLS-forced and this can run with no tenant on
        // the connection — signing out of a slot you are not currently in.
        var resolved = await ResolveTokenAsync(db, hash, ct);
        if (resolved is null) return;

        tenant.Set(resolved.TenantId, resolved.UserId, "employee");
        await db.SyncTenantAsync(ct);

        await db.RefreshTokens
            .Where(t => t.FamilyId == resolved.FamilyId && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                .SetProperty(t => t.RevokeReason, (string?)reason), ct);
    }

    /// <summary>
    /// Moves a pre-slot session into slot 0, and hands the token back.
    ///
    /// Without this, deploying multi-account signs out everyone who was already
    /// using the product — a self-inflicted incident on release day. The old
    /// cookie is deleted so it runs once per browser.
    ///
    /// It RETURNS the token rather than making it readable from
    /// Request.Cookies, because Request.Cookies is what the browser sent and
    /// cannot see what we have just written to the response. An earlier version
    /// swapped in a custom IRequestCookieCollection to fake that, which is a lot
    /// of surface area — and an exact nullability match against a BCL interface
    /// — for one migration that runs once. A return value says the same thing.
    /// </summary>
    private static string? MigrateLegacyCookie(HttpContext http)
    {
        var legacy = http.Request.Cookies[LegacyRefreshCookie];
        if (string.IsNullOrWhiteSpace(legacy)) return null;
        if (!string.IsNullOrWhiteSpace(http.Request.Cookies[RefreshCookie(0)])) return null;

        http.Response.Cookies.Append(RefreshCookie(0), legacy,
            CookieOpts(DateTimeOffset.UtcNow.Add(TokenIssuer.RefreshTokenLifetime)));
        http.Response.Cookies.Append(ActiveCookie, "0", CookieOpts());
        http.Response.Cookies.Delete(LegacyRefreshCookie, CookieOpts());

        return legacy;
    }

    private sealed record RotateOutcome(
        string? Error, int Status, User? User, string? RefreshToken,
        TokenIssuer.AccessToken? Access)
    {
        public static RotateOutcome Fail(int status, string error) =>
            new(error, status, null, null, null);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> MeAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);

        var products = await db.ProductAccess.AsNoTracking()
            .Where(p => p.UserId == user.Id && p.RevokedAt == null)
            .Select(p => p.ProductCode)
            .ToListAsync(ct);

        var mailbox = await db.Mailboxes.AsNoTracking()
            .Where(m => m.UserId == user.Id)
            .Select(m => m.Address)
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            user = Describe(user),
            organisation = org is null ? null : new { org.Id, org.Name, org.Type, org.Status },
            products,
            mailboxAddress = mailbox,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ChangePasswordAsync(
        ChangePasswordRequest req, AppDbContext db, IPasswordHasher hasher,
        TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(req.CurrentPassword) || string.IsNullOrEmpty(req.NewPassword))
            return Results.BadRequest(new { error = "Both the current and new password are required." });

        // Twelve, with no composition rules. Length beats character classes:
        // "Password1!" satisfies every rule most systems impose and is on
        // every wordlist, while a four-word phrase is stronger and memorable.
        if (req.NewPassword.Length < 12)
            return Results.BadRequest(new
            {
                error = "Use at least 12 characters. A short phrase you can remember beats a short password you cannot.",
            });

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (user.PasswordHash is null || !hasher.Verify(req.CurrentPassword, user.PasswordHash))
            return Results.Json(new { error = "Current password is incorrect." }, statusCode: 401);

        if (req.NewPassword == req.CurrentPassword)
            return Results.BadRequest(new { error = "The new password must be different." });

        user.PasswordHash = hasher.Hash(req.NewPassword);
        user.PasswordChangedAt = DateTimeOffset.UtcNow;
        user.MustChangePassword = false;

        // Every other session ends. If the reason for changing the password is
        // that someone else knows it, leaving their session alive defeats the
        // entire exercise.
        await db.RefreshTokens
            .Where(t => t.UserId == user.Id && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                .SetProperty(t => t.RevokeReason, (string?)"password changed"), ct);

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.password_changed", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new
        {
            changed = true,
            note = "All other sessions have been signed out. Sign in again on your other devices.",
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> SessionsAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var sessions = await db.RefreshTokens.AsNoTracking()
            .Where(t => t.UserId == tenant.UserId && t.RevokedAt == null
                        && t.ExpiresAt > DateTimeOffset.UtcNow)
            .OrderByDescending(t => t.IssuedAt)
            .Select(t => new { t.Id, t.IssuedAt, t.ExpiresAt, t.UserAgent, t.IpAddress })
            .ToListAsync(ct);

        return Results.Ok(sessions);
    }

    // ------------------------------------------------------------------

    private static async Task<ResolvedToken?> ResolveTokenAsync(
        AppDbContext db, string hash, CancellationToken ct)
    {
        var conn = db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open)
            await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT tenant_id, user_id, token_id, family_id, was_revoked " +
            "FROM core.resolve_refresh_token(@hash)";

        var p = cmd.CreateParameter();
        p.ParameterName = "@hash";
        p.Value = hash;
        cmd.Parameters.Add(p);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;

        return new ResolvedToken(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2),
            reader.GetGuid(3), reader.GetBoolean(4));
    }

    private static async Task<(string Token, RefreshToken Row)> IssueRefreshAsync(
        AppDbContext db, User user, Guid familyId, HttpContext http, CancellationToken ct)
    {
        var token = TokenIssuer.GenerateRefreshToken();

        var row = new RefreshToken
        {
            TenantId = user.TenantId,
            UserId = user.Id,
            TokenHash = TokenIssuer.HashRefreshToken(token),
            FamilyId = familyId,
            ExpiresAt = DateTimeOffset.UtcNow.Add(TokenIssuer.RefreshTokenLifetime),
            UserAgent = Truncate(http.Request.Headers.UserAgent.ToString(), 512),
            IpAddress = http.Connection.RemoteIpAddress?.ToString(),
        };

        db.RefreshTokens.Add(row);
        await Task.CompletedTask;
        return (token, row);
    }

    private static object Describe(User u) => new
    {
        u.Id, u.Email, u.DisplayName, u.Role, u.Status, u.MfaEnabled, u.DepartmentId,
    };

    private static string? Truncate(string? s, int max) =>
        string.IsNullOrEmpty(s) ? null : s.Length <= max ? s : s[..max];

    /// <summary>
    /// A real Argon2id hash of a value nobody knows, so the unknown-address
    /// path costs the same as the wrong-password path.
    /// </summary>
    private const string DummyHash =
        "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA==$" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    private sealed record ResolvedToken(
        Guid TenantId, Guid UserId, Guid TokenId, Guid FamilyId, bool WasRevoked);
}

public sealed record LoginRequest(string? Email, string? Password);
public sealed record OtpRequest(string? Phone);
public sealed record OtpVerifyRequest(string? Phone, string? Code);
public sealed record RefreshRequest(string? RefreshToken);

/// <summary>Which account slot to act on. See the multi-account block above.</summary>
public sealed record SwitchRequest(int Slot);

/// <summary>
/// all=false (the default) signs out of the current account only and leaves the
/// others in this browser alone. all=true is the shared-machine case.
/// </summary>
public sealed record LogoutRequest(bool All = false, string? RefreshToken = null);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);

public sealed record AuthResponse(
    string AccessToken,
    DateTimeOffset ExpiresAt,
    string RefreshToken,
    bool MustChangePassword,
    object User,
    // Which browser slot this session occupies.
    int Slot = 0,
    // Every account signed in on this browser, so the switcher can render
    // without a second request. Assembled server-side from httpOnly cookies —
    // see the multi-account block in AuthEndpoints for why it is not simply
    // stored somewhere the client can read.
    object? Accounts = null);
