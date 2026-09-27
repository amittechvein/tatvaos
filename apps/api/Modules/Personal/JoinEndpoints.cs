using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// /join — a free personal address for anyone (build plan §3, part B).
/// Separate from /api/signup, which creates ORGANISATIONS and is unchanged.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Address → details and age → phone code → password and terms → account.
///
///  CLOSED unless all three hold: a personal house with a verified domain
///  exists (PersonalHouse), Personal:PhoneHashKey is set, and the operator
///  setting personal.signup_open is on. A deploy can therefore never open
///  it by accident; the switch-on is a decision (§1's five gates).
///
///  The phone code is the main barrier (§3, bot protection), so it is
///  rate-limited three ways, counted in the database rather than in memory so
///  a restart does not hand out a fresh allowance: 3 codes an hour per number,
///  10 per address, and a platform-wide hourly ceiling (a setting). Behind
///  those, a honeypot field and a signed "form opened at" token refuse forms
///  filled faster than a person could.
///
///  NO PHONE NUMBER IN ANY LOG (§3.4; the #194 rule, #184's lesson). Nothing
///  here logs one; the SMS sender masks its own. tests/personal-join greps
///  the API's log for the test numbers.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class JoinEndpoints
{
    public const int CodesPerNumberPerHour = 3;
    public const int CodesPerIpPerHour = 10;
    public const int DefaultCodesPerHour = 200;
    private static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ResendGap = TimeSpan.FromSeconds(60);
    private const int MaxAttempts = 5;
    /// <summary>A person cannot pick an address, type a name, a date of birth and a phone number in less.</summary>
    public static readonly TimeSpan MinFillTime = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan MaxFormAge = TimeSpan.FromHours(2);
    /// <summary>A verified phone must be turned into an account within this, or verified again.</summary>
    private static readonly TimeSpan VerifiedWindow = TimeSpan.FromMinutes(30);

    /// <summary>
    /// The versions a person accepts. DRAFT until the lawyer and Amit approve
    /// the public texts (§1 gate 4, §10). Stored per account, so an account
    /// created on a draft can be found and asked again.
    /// </summary>
    public const string TermsVersion = "draft-2026-09-26";
    public const string PrivacyVersion = "draft-2026-09-26";

    public static void MapJoinEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/join").WithTags("Personal signup").AllowAnonymous()
            .RequireRateLimiting("join");

        g.MapGet("/status", StatusAsync);
        // Its own tighter limit: the availability check is the one call that
        // answers "does this address exist", so it must not become a way to
        // list them (§3.1).
        g.MapGet("/address", AddressAsync).RequireRateLimiting("join-address");
        g.MapPost("/start", StartAsync);
        g.MapPost("/{id:guid}/resend", ResendAsync);
        g.MapPost("/{id:guid}/verify", VerifyAsync);
        g.MapPost("/{id:guid}/complete", CompleteAsync);
    }

    private static readonly object Closed = new
    {
        open = false,
        error = "Personal accounts aren't open yet.",
    };

    /// <summary>The house, if /join is open right now; null if closed for any reason.</summary>
    private static async Task<PersonalHouse.House?> OpenHouseAsync(
        PersonalHouse houses, PersonalPhone phones, SettingsReader settings, CancellationToken ct)
    {
        if (!phones.Configured) return null;
        if (!await settings.FlagAsync(SettingKeys.PersonalSignupOpen, fallback: false, ct)) return null;
        return await houses.GetAsync(ct);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> StatusAsync(
        PersonalHouse houses, PersonalPhone phones, SettingsReader settings, CancellationToken ct)
    {
        var house = await OpenHouseAsync(houses, phones, settings, ct);
        if (house is null) return Results.Ok(Closed);
        return Results.Ok(new
        {
            open = true,
            domain = house.Domain,
            minLength = PersonalAddress.MinLength,
            maxLength = PersonalAddress.MaxLength,
            passwordMinLength = PasswordPolicy.MinimumLength,
            termsVersion = TermsVersion,
            privacyVersion = PrivacyVersion,
            // The "form opened at" token. Issued here, when the page loads.
            formToken = phones.FormToken(DateTimeOffset.UtcNow),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> AddressAsync(
        string? name, AppDbContext db, PersonalHouse houses, PersonalPhone phones,
        SettingsReader settings, CancellationToken ct)
    {
        var house = await OpenHouseAsync(houses, phones, settings, ct);
        if (house is null) return Results.NotFound(Closed);

        var local = PersonalAddress.Normalise(name);
        var problem = await PersonalAddress.ProblemAsync(db, local, house.Domain, ct);
        // Suggestions only for a name that passed the rules but is not free:
        // "a" has nothing sensible to suggest from.
        var suggestions = problem == PersonalAddress.Unavailable
            ? await PersonalAddress.SuggestAsync(db, local, house.Domain, ct)
            : [];
        return Results.Ok(new
        {
            address = $"{local}@{house.Domain}",
            available = problem is null,
            problem,
            suggestions,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> StartAsync(
        StartJoinRequest req, AppDbContext db, PersonalHouse houses, PersonalPhone phones,
        SettingsReader settings, ISmsSender sms, HttpContext http,
        ILogger<PersonalSignup> log, CancellationToken ct)
    {
        var house = await OpenHouseAsync(houses, phones, settings, ct);
        if (house is null) return Results.NotFound(Closed);

        var now = DateTimeOffset.UtcNow;
        var ip = ClientIp.From(http);

        // ---- bots: honeypot, and a form filled faster than a person could.
        // One vague sentence for all of it — a precise refusal teaches the
        // script what to fix.
        var formAge = phones.FormTokenAge(req.FormToken, now);
        if (!string.IsNullOrEmpty(req.Website) || formAge is null
            || formAge < MinFillTime || formAge > MaxFormAge)
        {
            await RecordAsync(db, null, ip, "refused_bot", ct);
            log.LogInformation("Join refused as automated from {Ip}", ip);
            return Results.BadRequest(new { error = "Something went wrong. Reload the page and try again." });
        }

        // ---- the address
        var local = PersonalAddress.Normalise(req.LocalPart);
        if (await PersonalAddress.ProblemAsync(db, local, house.Domain, ct) is string addressProblem)
            return Results.BadRequest(new { error = addressProblem, field = "address" });

        // ---- the name
        var displayName = (req.DisplayName ?? "").Trim();
        if (displayName.Length is < 2 or > 100)
            return Results.BadRequest(new { error = "Enter your full name — it's shown on the mail you send.", field = "name" });

        // ---- age (D7). The date is used for this and discarded.
        DateOnly? dob = DateOnly.TryParseExact(req.DateOfBirth, "yyyy-MM-dd", out var d) ? d : null;
        switch (AgeGate.Decide(req.DeclaredAdult, dob, now))
        {
            case AgeGate.Verdict.Minor:
                await RecordAsync(db, null, ip, "refused_minor", ct);
                return Results.BadRequest(new { error = AgeGate.MinorMessage, field = "age", minor = true });
            case AgeGate.Verdict.Invalid:
                return Results.BadRequest(new { error = AgeGate.NotDeclaredMessage, field = "age" });
        }

        // ---- the phone
        var phone = PersonalPhone.Canonical(req.Phone);
        if (phone is null)
            return Results.BadRequest(new
            {
                error = "Enter a mobile number, with the country code if it's outside India.",
                field = "phone",
            });
        var phoneHash = phones.Fingerprint(phone);

        if (await db.PersonalAccounts.IgnoreQueryFilters().AnyAsync(a => a.PhoneHash == phoneHash, ct))
        {
            await RecordAsync(db, phoneHash, ip, "refused_phone_taken", ct);
            return Results.Conflict(new
            {
                error = "This mobile number already has a personal account. Sign in instead.",
                field = "phone",
                signIn = true,
            });
        }

        if (await LimitProblemAsync(db, settings, phoneHash, ip, now, ct) is IResult limited)
            return limited;

        await PruneAsync(db, now, ct);

        // One draft per number: starting again resumes rather than piling up.
        var draft = await db.PersonalSignups
            .FirstOrDefaultAsync(s => s.PhoneHash == phoneHash && s.CompletedAt == null, ct);
        if (draft is null)
        {
            draft = new PersonalSignup { LocalPart = local, DisplayName = displayName, PhoneHash = phoneHash };
            db.PersonalSignups.Add(draft);
        }
        draft.LocalPart = local;
        draft.DisplayName = displayName;
        draft.Phone = phone;
        draft.AdultDeclaredAt = now;
        draft.PhoneVerifiedAt = null;
        draft.UpdatedAt = now;

        var issued = await IssueCodeAsync(db, draft, sms, ip, ct);
        await db.SaveChangesAsync(ct);
        log.LogInformation("Join started: signup {Signup}, code sent {Sent}", draft.Id, issued.Sent);

        var showOtp = await settings.FlagAsync(SettingKeys.ShowOtpOnScreen, fallback: false, ct);
        return Results.Ok(new
        {
            signupId = draft.Id,
            address = $"{local}@{house.Domain}",
            phoneMasked = PhoneNumber.Mask(phone),
            // Same rule as /api/signup: echoed only when the real send failed
            // AND testing mode is on. Never while SMS works.
            devCode = showOtp && !issued.Sent ? issued.Code : null,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ResendAsync(
        Guid id, AppDbContext db, PersonalHouse houses, PersonalPhone phones,
        SettingsReader settings, ISmsSender sms, HttpContext http, CancellationToken ct)
    {
        if (await OpenHouseAsync(houses, phones, settings, ct) is null) return Results.NotFound(Closed);

        var draft = await db.PersonalSignups.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (draft is null || draft.CompletedAt is not null || draft.Phone is null) return Results.NotFound();
        if (draft.PhoneVerifiedAt is not null) return Results.Ok(new { sent = false, verified = true });

        var now = DateTimeOffset.UtcNow;
        if (draft.CodeSentAt is DateTimeOffset last && now - last < ResendGap)
            return Results.Json(new { error = "A code was just sent. Wait a minute before asking again." },
                statusCode: 429);

        var ip = ClientIp.From(http);
        if (await LimitProblemAsync(db, settings, draft.PhoneHash, ip, now, ct) is IResult limited)
            return limited;

        var issued = await IssueCodeAsync(db, draft, sms, ip, ct);
        await db.SaveChangesAsync(ct);

        var showOtp = await settings.FlagAsync(SettingKeys.ShowOtpOnScreen, fallback: false, ct);
        return Results.Ok(new { sent = true, devCode = showOtp && !issued.Sent ? issued.Code : null });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> VerifyAsync(
        Guid id, VerifyJoinRequest req, AppDbContext db, CancellationToken ct)
    {
        var draft = await db.PersonalSignups.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (draft is null || draft.CompletedAt is not null) return Results.NotFound();
        if (draft.PhoneVerifiedAt is not null) return Results.Ok(new { verified = true });

        if (draft.CodeAttempts >= MaxAttempts)
            return Results.Json(new { error = "Too many wrong codes. Ask for a new one.", needResend = true },
                statusCode: 429);

        var now = DateTimeOffset.UtcNow;
        if (draft.CodeSentAt is null || now - draft.CodeSentAt > CodeLifetime || draft.CodeHash is null)
            return Results.BadRequest(new { error = "That code has expired. Ask for a new one.", needResend = true });

        if (!Equals(HashCode(draft.Id, (req.Code ?? "").Trim()), draft.CodeHash))
        {
            draft.CodeAttempts++;
            draft.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
            return Results.BadRequest(new
            {
                error = "That code isn't right.",
                attemptsLeft = Math.Max(0, MaxAttempts - draft.CodeAttempts),
            });
        }

        draft.PhoneVerifiedAt = now;
        draft.CodeHash = null;          // single use
        draft.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        // Told only AFTER the code proves they hold the number, so this is not
        // a way to ask "does this number have a work account?" (Mr. Singh on
        // PR 311: say so on the page rather than refuse the signup).
        return Results.Ok(new
        {
            verified = true,
            numberOnWorkAccount = draft.Phone is not null && await NumberInUseAsync(db, draft.Phone, ct),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> CompleteAsync(
        Guid id, CompleteJoinRequest req, AppDbContext db, PersonalHouse houses, PersonalPhone phones,
        SettingsReader settings, IPasswordHasher hasher, TenantContext tenant, StorageAllocator storage,
        AuditWriter audit, SystemMailer mailer, IConfiguration config, HttpContext http,
        ILogger<PersonalSignup> log, CancellationToken ct)
    {
        var house = await OpenHouseAsync(houses, phones, settings, ct);
        if (house is null) return Results.NotFound(Closed);

        var draft = await db.PersonalSignups.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (draft is null || draft.CompletedAt is not null || draft.Phone is null) return Results.NotFound();

        var now = DateTimeOffset.UtcNow;
        if (draft.PhoneVerifiedAt is null || now - draft.PhoneVerifiedAt > VerifiedWindow)
            return Results.BadRequest(new { error = "Verify your phone first.", field = "phone", needResend = true });

        // ---- terms (§3.5): no account without both ticks.
        if (!req.AcceptTerms || !req.AcceptPrivacy)
            return Results.BadRequest(new
            {
                error = "Please accept the Terms of Service and the Privacy policy to create your account.",
                field = "terms",
            });

        // ---- password: the platform rule, the same constant every set-path reads.
        if (string.IsNullOrEmpty(req.Password) || req.Password.Length < PasswordPolicy.MinimumLength)
            return Results.BadRequest(new { error = PasswordPolicy.TooShort, field = "password" });

        var address = $"{draft.LocalPart}@{house.Domain}";

        // ---- recovery email: optional, recommended, confirmed by link.
        var recovery = string.IsNullOrWhiteSpace(req.RecoveryEmail) ? null : req.RecoveryEmail.Trim();
        if (recovery is not null && !EmailAddress.LooksValid(recovery))
            return Results.BadRequest(new { error = "That recovery email doesn't look right.", field = "recovery" });
        if (recovery is not null && string.Equals(recovery, address, StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new
            {
                error = "Your recovery email has to be a different address — it's how you get back in if you're locked out of this one.",
                field = "recovery",
            });

        // ---- everything checked at start, checked again: time has passed.
        if (await PersonalAddress.ProblemAsync(db, draft.LocalPart, house.Domain, ct) is string addressProblem)
            return Results.Conflict(new { error = addressProblem + " Pick another.", field = "address" });
        if (await db.PersonalAccounts.IgnoreQueryFilters().AnyAsync(a => a.PhoneHash == draft.PhoneHash, ct))
            return Results.Conflict(new
            {
                error = "This mobile number already has a personal account. Sign in instead.",
                field = "phone", signIn = true,
            });

        // The verified number goes on the account for OTP sign-in and
        // recovery (§3.5) — UNLESS another live account already has it.
        // Sign-in by phone and the phone reset both need exactly one live
        // account per number (AuthEndpoints), so giving it to a second
        // account would silently break both for the first. The personal
        // account still holds the fingerprint, so "one per number" holds.
        //
        // NOTHING here writes to that other account: it is read, never
        // changed — its phone, and its SMS sign-in, stay exactly as they were
        // (tests/personal-join proves it, red first).
        var numberInUse = await NumberInUseAsync(db, draft.Phone, ct);

        var ip = ClientIp.From(http);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        tenant.EnterPlatformScope(house.TenantId, Guid.Empty);
        await db.SyncTenantAsync(ct);

        var quota = await storage.ResolveQuotaAsync(house.TenantId, null, null, "mail", ct);
        string? recoveryToken = recovery is null ? null : TokenIssuer.GenerateRefreshToken();

        var user = new User
        {
            TenantId = house.TenantId,
            DomainId = house.DomainId,
            Email = address,
            DisplayName = draft.DisplayName,
            Role = "employee",
            Status = "active",
            PasswordHash = hasher.Hash(req.Password),
            PasswordChangedAt = now,
            // Their own new mailbox — nothing to confirm.
            EmailConfirmedAt = now,
            Phone = numberInUse ? null : draft.Phone,
            RecoveryEmail = recovery,
            RecoveryEmailTokenHash = recoveryToken is null ? null : TokenIssuer.HashRefreshToken(recoveryToken),
            RecoveryEmailTokenSentAt = recoveryToken is null ? null : now,
            StorageQuotaBytes = quota,
            MustChangePassword = false,
        };
        db.Users.Add(user);
        db.Calendars.Add(CalendarProvisioning.PrimaryFor(house.TenantId, user.Id));
        // Mail and Space (§4.1). Calendar and Connect are not product-gated.
        foreach (var code in new[] { "mail", "drive" })
            db.ProductAccess.Add(new ProductAccess { TenantId = house.TenantId, UserId = user.Id, ProductCode = code });
        db.Mailboxes.Add(new Mailbox
        {
            TenantId = house.TenantId,
            DomainId = house.DomainId,
            UserId = user.Id,
            Address = address,
            LocalPart = draft.LocalPart,
            Type = "user",
            DisplayName = draft.DisplayName,
            ImapPasswordHash = hasher.Hash(req.Password),
            QuotaBytes = quota,
        });
        db.PersonalAccounts.Add(new PersonalAccount
        {
            UserId = user.Id,
            TenantId = house.TenantId,
            PhoneHash = draft.PhoneHash,
            AdultDeclaredAt = draft.AdultDeclaredAt,
            TermsVersion = TermsVersion,
            PrivacyVersion = PrivacyVersion,
            TermsAcceptedAt = now,
        });

        draft.CompletedAt = now;
        draft.CompletedUserId = user.Id;
        draft.Phone = null;             // plain text only until here
        draft.UpdatedAt = now;
        db.PersonalSignupAttempts.Add(new PersonalSignupAttempt
        {
            PhoneHash = draft.PhoneHash, Ip = ip, Outcome = "completed",
        });

        try
        {
            await db.SaveChangesAsync(ct);
            await audit.WriteAsync("personal.account_created", "user", user.Id.ToString(),
                after: new { address, phoneOnAccount = !numberInUse, terms = TermsVersion }, ct: ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            // Two people finishing on the same address or number in the same
            // second: the unique indexes decide, and the loser is told plainly.
            await tx.RollbackAsync(ct);
            log.LogInformation("Join lost a race on a unique key: signup {Signup}", draft.Id);
            return Results.Conflict(new { error = "That address or number was just taken. Pick another address.", field = "address" });
        }

        log.LogInformation("Join completed: signup {Signup} became user {User}", draft.Id, user.Id);

        // Best-effort and after commit, like /api/signup: a mail hiccup must
        // never undo a finished account.
        var baseUrl = (config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');
        await mailer.SendHtmlAsync(address, WelcomeEmail.Subject("TatvaOS"),
            WelcomeEmail.Html(user.DisplayName, "TatvaOS", baseUrl, address),
            from: "no_reply@tatvaos.com", ct: ct);
        if (recovery is not null && recoveryToken is not null)
        {
            var verifyUrl = $"{baseUrl}/verify-recovery-email?token={Uri.EscapeDataString(recoveryToken)}";
            await mailer.SendHtmlAsync(recovery, RecoveryVerifyEmail.Subject(),
                RecoveryVerifyEmail.Html(user.DisplayName, baseUrl, verifyUrl, 24 * 60),
                from: "no_reply@tatvaos.com", ct: ct);
        }

        return Results.Ok(new
        {
            address,
            signInAt = "/login",
            phoneOnAccount = !numberInUse,
        });
    }

    // ------------------------------------------------------------------

    private sealed record Issued(string Code, bool Sent);

    private static async Task<Issued> IssueCodeAsync(
        AppDbContext db, PersonalSignup draft, ISmsSender sms, string? ip, CancellationToken ct)
    {
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        draft.CodeHash = HashCode(draft.Id, code);
        draft.CodeSentAt = DateTimeOffset.UtcNow;
        draft.CodeAttempts = 0;
        var sent = (await sms.SendOtpAsync(draft.Phone!, code, ct)).Sent;
        // A failed send counts against the limits too: it is still a request
        // to text a stranger's phone, and a failing provider must not become
        // an unlimited retry loop.
        db.PersonalSignupAttempts.Add(new PersonalSignupAttempt
        {
            PhoneHash = draft.PhoneHash, Ip = ip, Outcome = sent ? "code_sent" : "code_send_failed",
        });
        return new Issued(code, sent);
    }

    private static readonly string[] CodeOutcomes = ["code_sent", "code_send_failed"];

    /// <summary>
    /// The three limits (§3.4), counted from the attempts table over the last
    /// hour. Each refusal is recorded, so the abuse view shows it. The
    /// messages say which limit was hit in a way that is safe to say: the
    /// per-number one names no number.
    /// </summary>
    private static async Task<IResult?> LimitProblemAsync(
        AppDbContext db, SettingsReader settings, string phoneHash, string? ip,
        DateTimeOffset now, CancellationToken ct)
    {
        var since = now.AddHours(-1);
        var sent = db.PersonalSignupAttempts.AsNoTracking()
            .Where(a => a.OccurredAt > since && CodeOutcomes.Contains(a.Outcome));

        if (await sent.CountAsync(a => a.PhoneHash == phoneHash, ct) >= CodesPerNumberPerHour)
        {
            await RecordAsync(db, phoneHash, ip, "refused_number_limit", ct);
            return Results.Json(new
            {
                error = "Too many codes have been sent to this number. Try again in an hour.",
                field = "phone",
            }, statusCode: 429);
        }
        if (ip is not null && await sent.CountAsync(a => a.Ip == ip, ct) >= CodesPerIpPerHour)
        {
            await RecordAsync(db, phoneHash, ip, "refused_ip_limit", ct);
            return Results.Json(new { error = "Too many signups from your network. Try again in an hour." },
                statusCode: 429);
        }
        var ceiling = int.TryParse(await settings.GetAsync(SettingKeys.PersonalCodesPerHour, ct), out var c)
            ? c : DefaultCodesPerHour;
        if (await sent.CountAsync(ct) >= ceiling)
        {
            await RecordAsync(db, phoneHash, ip, "refused_global_limit", ct);
            return Results.Json(new { error = "Signups are very busy right now. Please try again in a little while." },
                statusCode: 429);
        }
        return null;
    }

    private static async Task RecordAsync(
        AppDbContext db, string? phoneHash, string? ip, string outcome, CancellationToken ct)
    {
        db.PersonalSignupAttempts.Add(new PersonalSignupAttempt { PhoneHash = phoneHash, Ip = ip, Outcome = outcome });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// The ONE prune for both tables: abandoned signups (and the plain-text
    /// numbers in them) after a day; attempts after 90. Run by each new start
    /// AND hourly by PersonalSignupPruneWorker — while signup is shut nobody
    /// starts one, and a number must not outlive its day for want of a visitor.
    /// </summary>
    internal static async Task<(int Signups, int Attempts)> PruneAsync(AppDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var dayAgo = now.AddDays(-1);
        var signups = await db.PersonalSignups.Where(s => s.CompletedAt == null && s.UpdatedAt < dayAgo)
            .ExecuteDeleteAsync(ct);
        var ninetyDaysAgo = now.AddDays(-90);
        var attempts = await db.PersonalSignupAttempts.Where(a => a.OccurredAt < ninetyDaysAgo)
            .ExecuteDeleteAsync(ct);
        return (signups, attempts);
    }

    /// <summary>
    /// Is this number already on another live account (a work account)? Read
    /// across every tenant, as CreatePersonAsync reads core.users. READ ONLY:
    /// nothing in signup ever writes another account's phone.
    /// </summary>
    private static async Task<bool> NumberInUseAsync(AppDbContext db, string canonical, CancellationToken ct)
    {
        var spellings = Spellings(canonical);
        return await db.Users.IgnoreQueryFilters()
            .AnyAsync(u => u.Phone != null && spellings.Contains(u.Phone)
                           && u.Status != "deleted" && u.Status != "suspended", ct);
    }

    /// <summary>The ways the same Indian number may already be stored on core.users.</summary>
    private static List<string> Spellings(string canonical)
    {
        var list = new List<string> { canonical };
        if (canonical.StartsWith("+91") && canonical.Length == 13)
        {
            var ten = canonical[3..];
            list.AddRange([ten, "91" + ten, "0" + ten]);
        }
        return list;
    }

    // Salted with the signup id, as /api/signup does.
    private static string HashCode(Guid signupId, string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{signupId:N}:{code}"))).ToLowerInvariant();
}

public sealed record StartJoinRequest(
    string? LocalPart, string? DisplayName, string? Phone,
    bool DeclaredAdult, string? DateOfBirth,
    string? FormToken, string? Website);

public sealed record VerifyJoinRequest(string? Code);

public sealed record CompleteJoinRequest(
    string? Password, string? RecoveryEmail, bool AcceptTerms, bool AcceptPrivacy);
