using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
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
        g.MapGet("/recovery-status", RecoveryStatusAsync).RequireAuthorization("User");
        g.MapPost("/recovery-email", SetRecoveryEmailAsync).RequireAuthorization("User");
        g.MapPost("/recovery-email/verify", VerifyRecoveryEmailAsync).AllowAnonymous();

        // ---- forgot password (anonymous: the whole point is no session) --
        // Email link and phone OTP, each a request/complete pair. Every
        // request path answers the same whether the account exists or not.
        // The second half of a challenged sign-in. Anonymous, because by
        // definition there is no session yet — the challenge IS the credential
        // that says the password was already accepted.
        g.MapPost("/mfa/verify", MfaVerifyAsync).AllowAnonymous();

        g.MapPost("/password/forgot", ForgotPasswordAsync).AllowAnonymous();
        g.MapPost("/password/reset", ResetPasswordAsync).AllowAnonymous();
        g.MapPost("/password/forgot-otp", ForgotPasswordOtpAsync).AllowAnonymous();
        g.MapPost("/password/reset-otp", ResetPasswordOtpAsync).AllowAnonymous();

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
        TenantContext tenant, HttpContext http, IServiceScopeFactory scopeFactory,
        IConfiguration config, TotpService totp, CancellationToken ct)
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

        return await CompleteSignInAsync(user, org, db, tokens, http, scopeFactory, config, ct, totp);
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
        TenantContext tenant, HttpContext http, IServiceScopeFactory scopeFactory,
        IConfiguration config, TotpService totp, CancellationToken ct)
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

        return await CompleteSignInAsync(user, org, db, tokens, http, scopeFactory, config, ct, totp);
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
    /// <param name="totp">
    /// Present when the caller is a first-factor path (password, mobile OTP).
    /// Null when the second factor has ALREADY been checked — the MFA verify
    /// endpoint passes null so it does not challenge the person twice.
    /// </param>
    private static async Task<IResult> CompleteSignInAsync(
        User user, Tenant? org, AppDbContext db, TokenIssuer tokens,
        HttpContext http, IServiceScopeFactory scopeFactory, IConfiguration config,
        CancellationToken ct, TotpService? totp = null)
    {
        // ---------------------------------------------------------------
        //  The second factor, if there is one.
        //
        //  This sits BEFORE any of the state below because none of it should
        //  happen on a half-finished sign-in: the failed-login counter must
        //  not reset, the lockout must not lift, LastLoginAt must not move,
        //  and a pending account must not become active. Somebody who knows
        //  the password and not the code has not signed in, and the account
        //  should look exactly as it did.
        //
        //  No session, no cookie, no slot — only a challenge.
        // ---------------------------------------------------------------
        if (totp is not null && user.MfaEnabled && user.MfaSecretRef is not null)
        {
            return Results.Ok(new
            {
                mfaRequired = true,
                challenge = totp.IssueChallenge(user.Id),
                note = "Enter the code from your authenticator app.",
            });
        }

        user.FailedLoginCount = 0;
        user.LockedUntil = null;
        user.LastLoginAt = DateTimeOffset.UtcNow;
        if (user.Status == "pending") user.Status = "active";

        // Asked BEFORE the new session is written, or the device we are about
        // to record would count as evidence that we had seen it before.
        var alertDevice = await IsNewDeviceAsync(db, user, http, ct);

        var (refresh, _) = await IssueRefreshAsync(db, user, Guid.NewGuid(), http, ct);
        var access = tokens.IssueAccessToken(user);
        await db.SaveChangesAsync(ct);

        // Sent in the background, deliberately: a slow or dead SMTP server must
        // never add latency to a sign-in, let alone fail one. The person is
        // already through the door — the mail is a notification, not a gate.
        if (alertDevice)
            SendNewDeviceAlertInBackground(
                scopeFactory, user.Email, user.DisplayName,
                Shared.DeviceFingerprint.Describe(http.Request.Headers.UserAgent.ToString()),
                http.Connection.RemoteIpAddress?.ToString(),
                config["Jwt:Issuer"] ?? "https://core.tatvaos.com");

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

    // =====================================================================
    //  NEW-DEVICE SIGN-IN ALERTS
    // =====================================================================
    //
    //  The other half of the security story. Recovery and credentials were
    //  already strong, but a stolen password used from the attacker's own
    //  machine produced no signal at all to the person it belonged to. This
    //  sends the "we noticed a new sign-in" mail every serious provider sends.
    //
    //  It hangs off CompleteSignInAsync because that is the ONE point every
    //  credential passes through — password and OTP alike. A second copy for
    //  the OTP path is how one door ends up silent.
    //
    //  Two things are suppressed on purpose, both to protect the alert's
    //  credibility. An alert people learn to ignore is worse than none.
    // =====================================================================

    /// <summary>
    /// True when this browser/OS has never been seen for this user AND we hold
    /// at least one fingerprinted session to compare against.
    ///
    /// That second condition does two jobs at once:
    ///
    ///   FIRST-EVER SIGN-IN. A brand-new account has nothing to compare to, so
    ///   every first sign-in would be "new". Alerting there is noise — the
    ///   person is holding the welcome email that told them to sign in.
    ///
    ///   THE DEPLOY OF THIS FEATURE. Sessions created before device_key existed
    ///   carry null, so on release day every existing user would be told their
    ///   own everyday laptop was unrecognised. That is an alert storm that
    ///   teaches thousands of people to ignore this email forever, on the one
    ///   day it has no real news to carry.
    ///
    /// Both resolve themselves: this sign-in writes a fingerprint, so the next
    /// genuinely new device does alert. Revoked and expired sessions still
    /// count as having seen the device — signing out does not make your own
    /// laptop foreign.
    /// </summary>
    private static async Task<bool> IsNewDeviceAsync(
        AppDbContext db, User user, HttpContext http, CancellationToken ct)
    {
        var key = Shared.DeviceFingerprint.Key(http.Request.Headers.UserAgent.ToString());

        var seenThisDevice = await db.RefreshTokens
            .AnyAsync(t => t.UserId == user.Id && t.DeviceKey == key, ct);

        if (seenThisDevice) return false;

        return await db.RefreshTokens
            .AnyAsync(t => t.UserId == user.Id && t.DeviceKey != null, ct);
    }

    /// <summary>
    /// Sends the alert on a background task with its OWN service scope.
    ///
    /// The request's AppDbContext is disposed the moment the response is
    /// written, so reusing it here would throw as soon as the send took longer
    /// than the request — which is exactly what a slow SMTP server does. Same
    /// shape as the bulk welcome sender in UserEndpoints.
    ///
    /// Every failure is swallowed. A security notice that could 500 a sign-in
    /// would make the product less available in exchange for making it more
    /// secure, and nobody asked for that trade.
    /// </summary>
    private static void SendNewDeviceAlertInBackground(
        IServiceScopeFactory scopeFactory, string email, string displayName,
        string device, string? ip, string baseUrl)
    {
        var when = DateTimeOffset.UtcNow;

        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();

                await mailer.SendHtmlAsync(
                    email,
                    SignInAlertEmail.Subject(device),
                    SignInAlertEmail.Html(displayName, baseUrl, device, ip, when),
                    from: "no_reply@tatvaos.com");
            }
            catch
            {
                // Best effort by design — see the summary above. SystemMailer
                // already logs its own failures.
            }
        });
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
    /// <summary>
    /// GET /api/auth/recovery-status — can the current user get back in? Read-
    /// only; the login reminder reads this to decide whether to nudge. A
    /// recovery email counts only once VERIFIED.
    /// </summary>
    private static async Task<IResult> RecoveryStatusAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var row = await db.Users.AsNoTracking()
            .Where(u => u.Id == tenant.UserId)
            .Select(u => new
            {
                HasPhone = u.Phone != null && u.Phone != "",
                HasVerifiedRecoveryEmail = u.RecoveryEmailVerifiedAt != null,
            })
            .FirstOrDefaultAsync(ct);
        if (row is null) return Results.NotFound();
        return Results.Ok(new
        {
            row.HasPhone,
            row.HasVerifiedRecoveryEmail,
            needsAttention = !row.HasPhone || !row.HasVerifiedRecoveryEmail,
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// POST /api/auth/recovery-email — set (or change) the current user's
    /// recovery email. Stored UNVERIFIED; a link is emailed to the address and
    /// it counts for nothing until that link is opened.
    /// </summary>
    private static async Task<IResult> SetRecoveryEmailAsync(
        SetRecoveryEmailRequest req, AppDbContext db, TenantContext tenant,
        SystemMailer mailer, IConfiguration config, CancellationToken ct)
    {
        var email = req.Email?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || !System.Net.Mail.MailAddress.TryCreate(email, out _))
            return Results.BadRequest(new { error = "Enter a valid email address." });

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (string.Equals(email, user.Email, StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "Your recovery email must differ from your sign-in email." });

        if (string.Equals(user.RecoveryEmail, email, StringComparison.OrdinalIgnoreCase)
            && user.RecoveryEmailVerifiedAt is not null)
            return Results.Ok(new { sent = false, message = "That address is already your verified recovery email." });

        // Resend throttle for the same address, matching the reset flow's gap.
        if (user.RecoveryEmailTokenSentAt is DateTimeOffset last
            && DateTimeOffset.UtcNow - last < OtpResendGap
            && string.Equals(user.RecoveryEmail, email, StringComparison.OrdinalIgnoreCase))
            return Results.Ok(new { sent = true, message = RecoveryVerifySentReply });

        var token = TokenIssuer.GenerateRefreshToken();
        user.RecoveryEmail = email;
        user.RecoveryEmailVerifiedAt = null;          // a changed address must be re-proven
        user.RecoveryEmailTokenHash = TokenIssuer.HashRefreshToken(token);
        user.RecoveryEmailTokenSentAt = DateTimeOffset.UtcNow;
        user.RecoveryEmailTokenAttempts = 0;
        await db.SaveChangesAsync(ct);

        var baseUrl = (config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');
        var verifyUrl = $"{baseUrl}/verify-recovery-email?token={Uri.EscapeDataString(token)}";
        await mailer.SendHtmlAsync(
            email,
            RecoveryVerifyEmail.Subject(),
            RecoveryVerifyEmail.Html(user.DisplayName, baseUrl, verifyUrl, (int)RecoveryVerifyLifetime.TotalMinutes),
            from: "no_reply@tatvaos.com", ct);

        return Results.Ok(new { sent = true, message = RecoveryVerifySentReply });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// POST /api/auth/recovery-email/verify — consume the verification link.
    /// Anonymous: the token in the link IS the proof. Found by the token hash
    /// (unique per issuance), so a shared recovery address is unambiguous here;
    /// the one-live-match rule only governs RESET, a later stage.
    /// </summary>
    private static async Task<IResult> VerifyRecoveryEmailAsync(
        VerifyRecoveryEmailRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Token))
            return Results.BadRequest(new { error = "A verification token is required." });

        var hash = TokenIssuer.HashRefreshToken(req.Token.Trim());
        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.RecoveryEmailTokenHash == hash
                                      && u.Status != "deleted" && u.Status != "suspended", ct);
        var expired = user?.RecoveryEmailTokenSentAt is null
            || DateTimeOffset.UtcNow - user.RecoveryEmailTokenSentAt > RecoveryVerifyLifetime;
        if (user is null || expired)
            return Results.Json(new
            {
                error = "This verification link is invalid or has expired. Request a new one.",
            }, statusCode: 400);

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);
        user.RecoveryEmailVerifiedAt = DateTimeOffset.UtcNow;
        user.RecoveryEmailTokenHash = null;           // single-use
        user.RecoveryEmailTokenSentAt = null;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { verified = true });
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

    // =====================================================================
    //  SECOND FACTOR
    // =====================================================================
    //
    //  Completes a sign-in that CompleteSignInAsync stopped and handed back a
    //  challenge for. Two ways through: the six digits from the authenticator,
    //  or one of the recovery codes issued at enrolment.
    //
    //  THE FAILURE MESSAGE IS THE SAME FOR BOTH, and does not say which was
    //  tried. Distinguishing "wrong code" from "wrong recovery code" tells an
    //  attacker holding a stolen password which of the two they are closer to.
    //
    //  The password lockout counter applies here too. Without it the second
    //  factor is a free six-digit oracle: someone with the password could
    //  grind a million guesses against a challenge they can reissue at will.

    private const string MfaFailure =
        "That code was not accepted. Try the current code from your app, or one of your recovery codes.";

    private static async Task<IResult> MfaVerifyAsync(
        MfaVerifyRequest req, AppDbContext db, TokenIssuer tokens, TotpService totp,
        TenantContext tenant, HttpContext http, IServiceScopeFactory scopeFactory,
        IConfiguration config, CancellationToken ct)
    {
        var userId = totp.ReadChallenge(req.Challenge);
        if (userId is null)
            return Results.Json(new
            {
                error = "That sign-in attempt has expired. Enter your password again.",
            }, statusCode: 401);

        // Cross-tenant, like every pre-auth lookup here: the challenge carries
        // a user id and nothing else.
        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.Id == userId, ct);

        if (user is null || !user.MfaEnabled || user.MfaSecretRef is null)
            return Results.Json(new { error = MfaFailure }, statusCode: 401);

        if (user.LockedUntil is DateTimeOffset until && until > DateTimeOffset.UtcNow)
        {
            var minutes = Math.Max(1, (int)(until - DateTimeOffset.UtcNow).TotalMinutes);
            return Results.Json(new
            {
                error = $"Too many failed attempts. Try again in {minutes} minute(s).",
            }, statusCode: 429);
        }

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var code = (req.Code ?? "").Trim();
        var accepted = false;

        // A six-digit string is a TOTP code; anything else is treated as a
        // recovery code. Trying both against the same input would let one
        // attempt consume two guesses.
        if (code.Count(char.IsDigit) == 6 && code.All(c => char.IsDigit(c) || char.IsWhiteSpace(c)))
        {
            var secret = totp.Unprotect(user.MfaSecretRef);
            var step = secret is null ? null : totp.Verify(secret, code, user.MfaLastStep);
            if (step is not null)
            {
                // Recorded so the same code cannot be replayed inside its window.
                user.MfaLastStep = step;
                accepted = true;
            }
        }
        else
        {
            var hash = TotpService.HashRecoveryCode(code);
            var match = await db.MfaRecoveryCodes
                .FirstOrDefaultAsync(c => c.UserId == user.Id && c.CodeHash == hash && c.UsedAt == null, ct);

            if (match is not null)
            {
                // Single use, marked before anything else can fail.
                match.UsedAt = DateTimeOffset.UtcNow;
                accepted = true;
            }
        }

        if (!accepted)
        {
            user.FailedLoginCount++;
            if (user.FailedLoginCount >= MaxFailedAttempts)
            {
                user.LockedUntil = DateTimeOffset.UtcNow.Add(LockoutDuration);
                user.FailedLoginCount = 0;
            }
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = MfaFailure }, statusCode: 401);
        }

        // Re-checked here, not carried from the first factor: a suspension
        // applied in the seconds between password and code should still bite.
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (user.Status is "suspended" or "deleted" || org?.Status is "suspended" or "deleted")
        {
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        // totp deliberately omitted — the factor has just been checked, and
        // passing it would challenge the same person a second time.
        return await CompleteSignInAsync(user, org, db, tokens, http, scopeFactory, config, ct);
    }

    // =====================================================================
    //  FORGOT PASSWORD
    // =====================================================================
    //
    //  Two channels, both request/complete pairs, both anonymous:
    //
    //    email  /password/forgot  →  /password/reset      (a one-time link)
    //    phone  /password/forgot-otp → /password/reset-otp (a six-digit code)
    //
    //  THE REQUEST STEP NEVER REVEALS WHETHER AN ACCOUNT EXISTS. A form that
    //  answers differently for a known and an unknown address is a free
    //  membership check — the same rule the login and login-OTP paths follow,
    //  and for the same reason. Every request returns the identical generic
    //  reply whether we sent anything or not.
    //
    //  On success EVERY session ends, exactly like change-password: if the
    //  reason for the reset is that someone else had the old password, leaving
    //  their session alive defeats the point. The reset also clears any lockout
    //  — someone recovering their password should not then be told to wait
    //  fifteen minutes.
    //
    //  Reset state lives in the password_reset_* columns, kept separate from the
    //  login OTP so neither secret can be spent at the other's endpoint. The
    //  channel column pins which door a secret was minted for.
    // =====================================================================

    private const string ForgotEmailReply =
        "If an account exists for that address, a link to reset the password has been sent to it.";
    private const string ForgotPhoneReply =
        "If that number is registered, a code to reset the password has been sent to it.";

    // Longer than the login OTP's five minutes: an email hop can be slow, and a
    // link the recipient opens twenty minutes later must still work.
    private static readonly TimeSpan ResetLinkLifetime = TimeSpan.FromHours(1);
    // Recovery-email verification link. Longer than the reset link because it
    // only confirms ownership and grants no access.
    private static readonly TimeSpan RecoveryVerifyLifetime = TimeSpan.FromHours(24);
    private const string RecoveryVerifySentReply =
        "We've sent a link to that address. Open it to confirm your recovery email.";

    private const int MinPasswordLength = 12;
    private const string ShortPasswordMessage =
        "Use at least 12 characters. A short phrase you can remember beats a short password you cannot.";

    // ------------------------------------------------------------------
    private static async Task<IResult> ForgotPasswordAsync(
        ForgotPasswordRequest req, AppDbContext db, TenantContext tenant,
        SystemMailer mailer, IConfiguration config, CancellationToken ct)
    {
        var email = req.Email?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email))
            return Results.BadRequest(new { error = "An email address is required." });

        // Cross-tenant, like login: the tenant is unknown until the user is
        // found. Exact-match on email returns one row or none.
        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.Email == email && u.Status != "deleted" && u.Status != "suspended", ct);

        if (user is null)
            return Results.Ok(new { sent = true, message = ForgotEmailReply });

        // Resend throttle — a different answer inside the gap would itself leak
        // that the address exists.
        if (user.PasswordResetSentAt is DateTimeOffset last
            && DateTimeOffset.UtcNow - last < OtpResendGap)
            return Results.Ok(new { sent = true, message = ForgotEmailReply });

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        // High-entropy token, carried in the link. The user is later found BY
        // its hash, so the token needs no separate identity.
        var token = TokenIssuer.GenerateRefreshToken();
        user.PasswordResetHash = TokenIssuer.HashRefreshToken(token);
        user.PasswordResetSentAt = DateTimeOffset.UtcNow;
        user.PasswordResetAttempts = 0;
        user.PasswordResetChannel = "email";
        await db.SaveChangesAsync(ct);

        var baseUrl = (config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');
        var resetUrl = $"{baseUrl}/reset-password?token={Uri.EscapeDataString(token)}";

        await mailer.SendHtmlAsync(
            user.Email,
            ResetEmail.Subject(),
            ResetEmail.Html(user.DisplayName, baseUrl, resetUrl, (int)ResetLinkLifetime.TotalMinutes),
            from: "no_reply@tatvaos.com", ct);

        return Results.Ok(new { sent = true, message = ForgotEmailReply });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ResetPasswordAsync(
        ResetPasswordRequest req, AppDbContext db, IPasswordHasher hasher,
        TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Token) || string.IsNullOrEmpty(req.NewPassword))
            return Results.BadRequest(new { error = "A reset token and a new password are required." });

        if (req.NewPassword.Length < MinPasswordLength)
            return Results.BadRequest(new { error = ShortPasswordMessage });

        var hash = TokenIssuer.HashRefreshToken(req.Token.Trim());

        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.PasswordResetHash == hash
                                      && u.PasswordResetChannel == "email"
                                      && u.Status != "deleted" && u.Status != "suspended", ct);

        var expired = user?.PasswordResetSentAt is null
            || DateTimeOffset.UtcNow - user.PasswordResetSentAt > ResetLinkLifetime;

        if (user is null || expired)
            return Results.Json(new
            {
                error = "This reset link is invalid or has expired. Request a new one.",
            }, statusCode: 400);

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        // A used email link proves the address is readable — worth recording,
        // since an unconfirmed address is a support case waiting to happen.
        user.EmailConfirmedAt ??= DateTimeOffset.UtcNow;

        await ApplyPasswordResetAsync(user, req.NewPassword, hasher, db, ct);
        await audit.WriteAsync("user.password_reset", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new
        {
            reset = true,
            note = "Your password has been reset and all sessions signed out. Sign in with your new password.",
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ForgotPasswordOtpAsync(
        ForgotPasswordOtpRequest req, AppDbContext db, TenantContext tenant,
        Shared.Notify.ISmsSender sms, Shared.Settings.SettingsReader settings,
        CancellationToken ct)
    {
        var phone = Shared.PhoneNumber.Normalise(req.Phone);
        if (phone is null)
            return Results.BadRequest(new
            {
                error = "Enter the mobile number with its country code, like +91 98765 43210.",
            });

        // Exactly one live match may proceed — an ambiguous number fails closed,
        // like the login OTP, since a code that reset "whichever matched first"
        // would hand one person another person's account.
        var matches = await db.Users.IgnoreQueryFilters()
            .Where(u => u.Phone == phone && u.Status != "deleted" && u.Status != "suspended")
            .Take(2)
            .ToListAsync(ct);

        if (matches.Count != 1)
            return Results.Ok(new { sent = true, message = ForgotPhoneReply });

        var user = matches[0];

        if (user.PasswordResetSentAt is DateTimeOffset last
            && DateTimeOffset.UtcNow - last < OtpResendGap)
            return Results.Ok(new { sent = true, message = ForgotPhoneReply });

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var code = System.Security.Cryptography.RandomNumberGenerator
            .GetInt32(0, 1_000_000).ToString("D6");

        user.PasswordResetHash = OtpHash(user.Id, code);
        user.PasswordResetSentAt = DateTimeOffset.UtcNow;
        user.PasswordResetAttempts = 0;
        user.PasswordResetChannel = "phone";
        await db.SaveChangesAsync(ct);

        var result = await sms.SendOtpAsync(phone, code, ct);

        var showOtp = await settings.FlagAsync(
            Shared.Settings.SettingKeys.ShowOtpOnScreen, fallback: false, ct);

        return Results.Ok(new
        {
            sent = true,
            message = ForgotPhoneReply,
            devCode = showOtp && !result.Sent ? code : null,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ResetPasswordOtpAsync(
        ResetPasswordOtpRequest req, AppDbContext db, IPasswordHasher hasher,
        TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var phone = Shared.PhoneNumber.Normalise(req.Phone);
        var code = req.Code?.Trim() ?? "";

        if (string.IsNullOrEmpty(req.NewPassword))
            return Results.BadRequest(new { error = "A new password is required." });
        if (req.NewPassword.Length < MinPasswordLength)
            return Results.BadRequest(new { error = ShortPasswordMessage });
        if (phone is null || code.Length != 6)
            return Results.Json(new { error = "That code is invalid or has expired." }, statusCode: 400);

        var matches = await db.Users.IgnoreQueryFilters()
            .Where(u => u.Phone == phone && u.Status != "deleted" && u.Status != "suspended")
            .Take(2)
            .ToListAsync(ct);

        if (matches.Count != 1)
            return Results.Json(new { error = "That code is invalid or has expired." }, statusCode: 400);

        var user = matches[0];

        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var expired = user.PasswordResetSentAt is null
            || DateTimeOffset.UtcNow - user.PasswordResetSentAt > OtpLifetime;

        if (user.PasswordResetHash is null || user.PasswordResetChannel != "phone" || expired
            || user.PasswordResetAttempts >= OtpMaxAttempts
            || OtpHash(user.Id, code) != user.PasswordResetHash)
        {
            user.PasswordResetAttempts++;
            // Burn the code after five wrong guesses so an attacker cannot sit
            // on one code and grind all million combinations.
            if (user.PasswordResetAttempts >= OtpMaxAttempts)
                user.PasswordResetHash = null;
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = "That code is invalid or has expired." }, statusCode: 400);
        }

        await ApplyPasswordResetAsync(user, req.NewPassword, hasher, db, ct);
        await audit.WriteAsync("user.password_reset", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new
        {
            reset = true,
            note = "Your password has been reset and all sessions signed out. Sign in with your new password.",
        });
    }

    /// <summary>
    /// The tail shared by both reset paths: set the new password, clear the
    /// reset state and any lockout, and END EVERY OTHER SESSION. Written once
    /// so the email and phone paths cannot drift on the part that matters most
    /// — a reset that forgot to revoke sessions would leave a thief signed in.
    /// </summary>
    private static async Task ApplyPasswordResetAsync(
        User user, string newPassword, IPasswordHasher hasher, AppDbContext db, CancellationToken ct)
    {
        user.PasswordHash = hasher.Hash(newPassword);
        user.PasswordChangedAt = DateTimeOffset.UtcNow;
        user.MustChangePassword = false;

        // The secret is spent, and the lockout (if any) is lifted — recovering
        // a password should not then make you wait out a lockout.
        user.PasswordResetHash = null;
        user.PasswordResetSentAt = null;
        user.PasswordResetAttempts = 0;
        user.PasswordResetChannel = null;
        user.FailedLoginCount = 0;
        user.LockedUntil = null;

        await db.RefreshTokens
            .Where(t => t.UserId == user.Id && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                .SetProperty(t => t.RevokeReason, (string?)"password reset"), ct);

        await db.SaveChangesAsync(ct);
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
            // Set on ROTATION as well as sign-in, so a device stays recognised
            // for as long as it keeps renewing. Were it only stamped at
            // sign-in, a long-lived session that rotates for weeks would age
            // out of its own history and alert the user about their own desk.
            DeviceKey = Shared.DeviceFingerprint.Key(http.Request.Headers.UserAgent.ToString()),
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
public sealed record SetRecoveryEmailRequest(string? Email);
public sealed record VerifyRecoveryEmailRequest(string? Token);

/// <summary>Which account slot to act on. See the multi-account block above.</summary>
public sealed record SwitchRequest(int Slot);

/// <summary>
/// all=false (the default) signs out of the current account only and leaves the
/// others in this browser alone. all=true is the shared-machine case.
/// </summary>
public sealed record LogoutRequest(bool All = false, string? RefreshToken = null);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);

/// <summary>
/// The second half of a challenged sign-in. <paramref name="Code"/> is either
/// six digits from the authenticator or a recovery code.
/// </summary>
public sealed record MfaVerifyRequest(string? Challenge, string? Code);

// ---- forgot password ----
public sealed record ForgotPasswordRequest(string? Email);
public sealed record ResetPasswordRequest(string? Token, string NewPassword);
public sealed record ForgotPasswordOtpRequest(string? Phone);
public sealed record ResetPasswordOtpRequest(string? Phone, string? Code, string NewPassword);

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
