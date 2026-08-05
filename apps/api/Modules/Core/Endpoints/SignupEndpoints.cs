using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Core.Endpoints;

/// <summary>
/// Self-service signup.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Organisation → you → prove your EMAIL and PHONE are real → account.
///
///  The domain moved out of signup entirely. It is added and verified from
///  inside the console, because the person signing up is often not the person
///  who can edit DNS — and losing them over a step they cannot complete was
///  the whole problem with the previous flow.
///
///  What domain ownership gates is unchanged: OUTBOUND MAIL. A tenant with no
///  verified domain can use the console and email its own organisation, and
///  cannot reach a stranger. The abuse answer we gave Linode still holds.
/// ─────────────────────────────────────────────────────────────────────────
///
/// OTP rules: 6 digits, hashed at rest, 10-minute expiry, 5 shared attempts
/// (then both codes die, the draft survives), 60-second resend throttle.
/// Non-production responses echo the codes so staging is testable end to end
/// while there is no SMS provider; production never does.
/// </summary>
public static class SignupEndpoints
{
    private static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ResendThrottle = TimeSpan.FromSeconds(60);
    private const int MaxAttempts = 5;

    public static void MapSignupEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/signup").WithTags("Signup").AllowAnonymous();

        g.MapPost("/", StartAsync);
        g.MapGet("/{id:guid}", ResumeAsync);
        g.MapPost("/{id:guid}/verify", VerifyCodesAsync);
        g.MapPost("/{id:guid}/resend", ResendAsync);
        g.MapPost("/{id:guid}/complete", CompleteAsync);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> StartAsync(
        StartSignupRequest req, AppDbContext db, SystemMailer mailer, ISmsSender sms,
        SettingsReader settings, CancellationToken ct)
    {
        var email = req.AdminEmail?.Trim().ToLowerInvariant() ?? "";
        var phone = NormalisePhone(req.AdminPhone);

        if (string.IsNullOrWhiteSpace(req.OrgName) || req.OrgName.Trim().Length < 2)
            return Results.BadRequest(new { error = "An organisation name is required." });
        if (!Regex.IsMatch(email, @"^[^@\s]+@[^@\s]+\.[^@\s]+$"))
            return Results.BadRequest(new { error = "That does not look like an email address." });
        if (string.IsNullOrWhiteSpace(req.AdminName))
            return Results.BadRequest(new { error = "Your name is required." });
        if (phone is null)
            return Results.BadRequest(new { error = "A mobile number is required — include the country code, like +91 98765 43210." });

        if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == email, ct))
            return Results.Conflict(new
            {
                error = "That email address already has an account. Sign in instead, or use the forgotten-password link.",
                signIn = true,
            });

        // Resume rather than duplicate — a dozen rows per person makes the
        // sales queue useless.
        var draft = await db.SignupDrafts
            .FirstOrDefaultAsync(d => d.AdminEmail == email && d.CompletedAt == null, ct);

        if (draft is null)
        {
            draft = new SignupDraft
            {
                OrgName = "", AdminName = "", AdminEmail = email,
                VerificationToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            };
            db.SignupDrafts.Add(draft);
        }

        draft.OrgName = req.OrgName.Trim();
        draft.OrgType = req.OrgType ?? "business";
        draft.Country = req.Country ?? "India";
        draft.Gstin = req.Gstin;
        draft.AdminName = req.AdminName.Trim();
        draft.AdminPhone = phone;
        draft.ReachedStep = 3;
        draft.UpdatedAt = DateTimeOffset.UtcNow;

        var issued = await IssueCodesAsync(draft, mailer, sms, ct);
        await db.SaveChangesAsync(ct);

        // Codes are echoed on screen ONLY when the real send failed AND the
        // testing-mode setting is on. Self-securing: the moment Infobip is
        // configured and sending, echo stops by itself — and turning the
        // setting off kills it regardless. A code echoed while SMS works
        // would make the phone check decorative.
        var showOtp = await settings.FlagAsync(SettingKeys.ShowOtpOnScreen, fallback: false, ct);

        return Results.Ok(new
        {
            draftId = draft.Id,
            sentTo = new { email, phone = Mask(phone) },
            resumeUrl = $"/signup?draft={draft.Id}",
            devEmailCode = showOtp && !issued.EmailSent ? issued.EmailCode : null,
            devPhoneCode = showOtp && !issued.SmsSent ? issued.PhoneCode : null,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ResumeAsync(Guid id, AppDbContext db, CancellationToken ct)
    {
        var d = await db.SignupDrafts.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();

        return Results.Ok(new
        {
            draftId = d.Id,
            completed = d.CompletedAt != null,
            d.OrgName, d.OrgType, d.Country, d.Gstin,
            d.AdminName, d.AdminEmail,
            phoneMasked = Mask(d.AdminPhone),
            emailVerified = d.EmailVerifiedAt != null,
            phoneVerified = d.PhoneVerifiedAt != null,
            step = d.ReachedStep,
        });
    }

    // ------------------------------------------------------------------
    /// <summary>Either code, or both — whichever the person has typed so far.</summary>
    private static async Task<IResult> VerifyCodesAsync(
        Guid id, VerifyCodesRequest req, AppDbContext db, CancellationToken ct)
    {
        var d = await db.SignupDrafts.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();
        if (d.CompletedAt is not null) return Results.BadRequest(new { error = "Already finished." });

        if (d.CodeAttempts >= MaxAttempts)
            return Results.Json(new
            {
                error = "Too many wrong codes. Request fresh ones — your details are safe.",
                needResend = true,
            }, statusCode: 429);

        var now = DateTimeOffset.UtcNow;
        var wrong = new List<string>();

        if (!string.IsNullOrWhiteSpace(req.EmailCode) && d.EmailVerifiedAt is null)
        {
            if (Expired(d.EmailCodeSentAt, now)) wrong.Add("The email code has expired — request a new one.");
            else if (Hash(id, req.EmailCode.Trim()) == d.EmailCodeHash) d.EmailVerifiedAt = now;
            else wrong.Add("The email code is not right.");
        }

        if (!string.IsNullOrWhiteSpace(req.PhoneCode) && d.PhoneVerifiedAt is null)
        {
            if (Expired(d.PhoneCodeSentAt, now)) wrong.Add("The SMS code has expired — request a new one.");
            else if (Hash(id, req.PhoneCode.Trim()) == d.PhoneCodeHash) d.PhoneVerifiedAt = now;
            else wrong.Add("The SMS code is not right.");
        }

        if (wrong.Count > 0) d.CodeAttempts++;
        d.LastAttemptAt = now;
        d.UpdatedAt = now;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            emailVerified = d.EmailVerifiedAt != null,
            phoneVerified = d.PhoneVerifiedAt != null,
            errors = wrong,
            attemptsLeft = Math.Max(0, MaxAttempts - d.CodeAttempts),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ResendAsync(
        Guid id, AppDbContext db, SystemMailer mailer, ISmsSender sms,
        SettingsReader settings, CancellationToken ct)
    {
        var d = await db.SignupDrafts.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();
        if (d.CompletedAt is not null) return Results.BadRequest(new { error = "Already finished." });

        var last = d.EmailCodeSentAt ?? DateTimeOffset.MinValue;
        if (DateTimeOffset.UtcNow - last < ResendThrottle)
            return Results.Json(new
            {
                error = "Codes were just sent. Wait a minute before asking again.",
            }, statusCode: 429);

        // Fresh codes also reset the attempt counter — the person locked out by
        // five typos gets a clean slate rather than a support ticket.
        d.CodeAttempts = 0;
        var issued = await IssueCodesAsync(d, mailer, sms, ct);
        await db.SaveChangesAsync(ct);

        var showOtp = await settings.FlagAsync(SettingKeys.ShowOtpOnScreen, fallback: false, ct);

        return Results.Ok(new
        {
            sent = true,
            devEmailCode = showOtp && !issued.EmailSent ? issued.EmailCode : null,
            devPhoneCode = showOtp && !issued.SmsSent ? issued.PhoneCode : null,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> CompleteAsync(
        Guid id, CompleteSignupRequest req, AppDbContext db, IPasswordHasher hasher,
        TenantContext tenant, IConfiguration config, CancellationToken ct)
    {
        var d = await db.SignupDrafts.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();
        if (d.CompletedAt is not null) return Results.BadRequest(new { error = "Already finished." });

        // Both, not either. The email receives every invoice and password
        // reset; the phone is what the sales queue calls. An account reachable
        // by neither is an account that cannot be helped.
        if (d.EmailVerifiedAt is null || d.PhoneVerifiedAt is null)
            return Results.BadRequest(new { error = "Verify both codes first." });

        if (string.IsNullOrEmpty(req.Password) || req.Password.Length < 12)
            return Results.BadRequest(new
            {
                error = "Choose a password of at least 12 characters. A short phrase you will remember beats a short password you will not.",
            });

        // Belt and braces on the email: StartAsync checks this too, but a
        // retry after a partial failure must land on 409-sign-in, not a unique
        // index violation dressed as a 500.
        if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == d.AdminEmail, ct))
            return Results.Conflict(new
            {
                error = "That email address already has an account. Sign in instead.",
                signIn = true,
            });

        // ------------------------------------------------------------------
        //  One transaction for the whole account.
        //
        //  Without it, the tenant is saved first and everything else second —
        //  so a failure in the second half leaves an orphan organisation with
        //  no owner, invisible to sign-in but present in every count, and each
        //  retry mints another one. All-or-nothing is the only shape that
        //  retries cleanly.
        // ------------------------------------------------------------------
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        var org = new Tenant
        {
            Name = d.OrgName,
            Type = d.OrgType,
            Status = "trial",
            Origin = "signup",
            AdminName = d.AdminName,
            AdminEmail = d.AdminEmail,
            Phone = d.AdminPhone,
            Country = d.Country,
            Gstin = d.Gstin,
            TrialEndsAt = DateTimeOffset.UtcNow.AddDays(30),
        };
        db.Tenants.Add(org);
        await db.SaveChangesAsync(ct);

        // The transaction holds the connection open, so this is the case
        // SyncTenantAsync exists for: the RLS-forced inserts below need
        // app.tenant_id set on THIS session, not the next one from the pool.
        tenant.EnterPlatformScope(org.Id, Guid.Empty);
        await db.SyncTenantAsync(ct);

        var owner = new User
        {
            TenantId = org.Id,
            Email = d.AdminEmail,
            DisplayName = d.AdminName,
            Role = "org_owner",
            Status = "active",
            PasswordHash = hasher.Hash(req.Password),
            EmailConfirmedAt = d.EmailVerifiedAt,
            MustChangePassword = false,
        };
        db.Users.Add(owner);

        db.ProductAccess.Add(new ProductAccess { TenantId = org.Id, UserId = owner.Id, ProductCode = "mail" });
        db.StoragePools.Add(new StoragePool
        {
            TenantId = org.Id, StorageModel = "per_user",
            PerUserQuotaBytes = 15L * 1024 * 1024 * 1024,
        });
        db.StorageAllocations.Add(new StorageAllocation
        {
            TenantId = org.Id, ProductCode = "mail", AllocatedBytes = null,
        });

        foreach (var c in DefaultCategories(d.OrgType, org.Id))
            db.UserCategories.Add(c);

        d.CompletedAt = DateTimeOffset.UtcNow;
        d.ConvertedTenantId = org.Id;
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        return Results.Ok(new
        {
            organisationId = org.Id,
            email = owner.Email,
            signInAt = config["App:AdminUrl"] ?? "/login",
            nextStep = new
            {
                title = "Add your domain",
                detail = "Your account is ready. Add your organisation's domain under Domains " +
                         "in the console — until it is verified, mail stays exactly where it is today.",
            },
        });
    }

    // ------------------------------------------------------------------

    private sealed record Issued(string EmailCode, string PhoneCode, bool EmailSent, bool SmsSent);

    private static async Task<Issued> IssueCodesAsync(
        SignupDraft d, SystemMailer mailer, ISmsSender sms, CancellationToken ct)
    {
        var emailCode = NewCode();
        var phoneCode = NewCode();
        var now = DateTimeOffset.UtcNow;

        d.EmailCodeHash = Hash(d.Id, emailCode);
        d.EmailCodeSentAt = now;
        d.PhoneCodeHash = Hash(d.Id, phoneCode);
        d.PhoneCodeSentAt = now;

        var emailSent = await mailer.SendAsync(d.AdminEmail,
            "Your TatvaOS verification code",
            $"Your code is {emailCode}\n\nIt expires in 10 minutes. If you did not ask for this, ignore it.",
            ct);

        var smsSent = false;
        if (!string.IsNullOrWhiteSpace(d.AdminPhone))
            smsSent = (await sms.SendOtpAsync(d.AdminPhone, phoneCode, ct)).Sent;

        return new Issued(emailCode, phoneCode, emailSent, smsSent);
    }

    private static string NewCode() =>
        RandomNumberGenerator.GetInt32(100000, 1000000).ToString();

    // Salted with the draft id, so identical codes on two drafts do not
    // produce identical hashes.
    private static string Hash(Guid draftId, string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{draftId:N}:{code}"))).ToLowerInvariant();

    private static bool Expired(DateTimeOffset? sentAt, DateTimeOffset now) =>
        sentAt is null || now - sentAt > CodeLifetime;

    private static string? NormalisePhone(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var p = Regex.Replace(raw, @"[\s\-()]", "");
        return Regex.IsMatch(p, @"^\+?[0-9]{8,15}$") ? p : null;
    }

    private static string? Mask(string? phone) =>
        string.IsNullOrEmpty(phone) || phone.Length < 4
            ? phone
            : new string('•', phone.Length - 4) + phone[^4..];

    /// <summary>
    /// Starting categories by organisation type — an admin facing an empty
    /// screen has to invent structure before creating a single person.
    /// </summary>
    private static IEnumerable<UserCategory> DefaultCategories(string orgType, Guid tenantId)
    {
        const long GB = 1024L * 1024 * 1024;
        string[] mail = ["mail"];

        (string Name, long Quota, string Role, bool External)[] defs = orgType switch
        {
            "school" =>
            [
                ("Leadership", 50 * GB, "org_admin", true),
                ("Teachers", 15 * GB, "employee", true),
                ("Administration", 20 * GB, "manager", true),
                // Students blocked from external send by default — a school
                // requirement and one of the strongest abuse controls we have.
                ("Students", 2 * GB, "employee", false),
            ],
            "hospital" =>
            [
                ("Doctors", 30 * GB, "employee", true),
                ("Nursing", 15 * GB, "employee", true),
                ("Reception", 10 * GB, "employee", true),
                ("Administration", 30 * GB, "manager", true),
            ],
            _ =>
            [
                ("Leadership", 50 * GB, "org_admin", true),
                ("Staff", 30 * GB, "employee", true),
                ("Contractors", 5 * GB, "employee", true),
            ],
        };

        return defs.Select(x => new UserCategory
        {
            TenantId = tenantId,
            Name = x.Name,
            DefaultQuotaBytes = x.Quota,
            DefaultRole = x.Role,
            DefaultProducts = mail,
            CanSendExternal = x.External,
        });
    }
}

public sealed record StartSignupRequest(
    string? OrgName, string? OrgType, string? Country, string? Gstin,
    string? AdminName, string? AdminEmail, string? AdminPhone);

public sealed record VerifyCodesRequest(string? EmailCode, string? PhoneCode);

public sealed record CompleteSignupRequest(string Password);
