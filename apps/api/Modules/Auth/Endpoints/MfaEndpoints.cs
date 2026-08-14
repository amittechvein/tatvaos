using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// Turning two-step verification on and off.
///
/// ─────────────────────────────────────────────────────────────────────────
///  ENROLMENT IS THREE STEPS, AND THE MIDDLE ONE IS THE POINT.
///
///    begin    a secret is generated and returned with a QR payload.
///             Nothing changes about the account yet.
///    confirm  the user types a code from their app. Only now is MFA on,
///             and only now are recovery codes issued.
///    disable  password required, everything torn down.
///
///  Enabling on "begin" would be simpler and would lock people out. A scan
///  fails silently more often than anyone expects — the camera reads a stale
///  code from a previous screen, the phone's clock has drifted, the user
///  scanned into the wrong app. Every one of those produces an account that
///  demands a code nobody can produce, and the only way back is an
///  administrator. Confirming first makes that impossible.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Everything here acts on the CALLER's own account. There is deliberately no
/// endpoint for an administrator to enrol MFA on someone else's behalf: the
/// secret would have to pass through the admin's hands, which means the second
/// factor is something two people know, which means it is not a second factor.
/// An admin can only RESET someone's enrolment — see UserEndpoints.
/// </summary>
public static class MfaEndpoints
{
    public static void MapMfaEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/auth/mfa")
            .RequireAuthorization("User")
            .WithTags("Authentication");

        g.MapGet("/", StatusAsync);
        g.MapPost("/begin", BeginAsync);
        g.MapPost("/confirm", ConfirmAsync);
        g.MapPost("/disable", DisableAsync);
        g.MapPost("/recovery-codes", RegenerateCodesAsync);
    }

    // ------------------------------------------------------------------
    public sealed record MfaStatus(
        bool Enabled,
        DateTimeOffset? EnrolledAt,
        int RecoveryCodesRemaining,
        bool EnrolmentPending);

    private static async Task<IResult> StatusAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        var remaining = await db.MfaRecoveryCodes
            .CountAsync(c => c.UserId == user.Id && c.UsedAt == null, ct);

        return Results.Ok(new MfaStatus(
            Enabled: user.MfaEnabled,
            EnrolledAt: user.MfaEnrolledAt,
            RecoveryCodesRemaining: remaining,
            EnrolmentPending: user.MfaPendingSecret is not null && !user.MfaEnabled));
    }

    // ------------------------------------------------------------------
    public sealed record BeginResponse(string Secret, string OtpauthUri);

    /// <summary>
    /// Generates a secret and hands back the QR payload.
    ///
    /// The secret is returned in plaintext ONCE, here, because the user has to
    /// get it into their authenticator — either by scanning or by typing it
    /// when the camera will not cooperate. It is stored encrypted and is never
    /// readable again.
    ///
    /// Calling this twice simply replaces the pending secret. That is
    /// deliberate: someone who abandons a half-finished enrolment and starts
    /// again should not be told to clean up first.
    /// </summary>
    private static async Task<IResult> BeginAsync(
        AppDbContext db, TenantContext tenant, TotpService totp, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (user.MfaEnabled)
            return Results.BadRequest(new
            {
                error = "Two-step verification is already on. Turn it off first if you want to set it up again.",
            });

        var secret = totp.NewSecret();
        user.MfaPendingSecret = totp.Protect(secret);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new BeginResponse(
            Secret: secret,
            OtpauthUri: totp.ProvisioningUri(secret, user.Email)));
    }

    // ------------------------------------------------------------------
    public sealed record ConfirmRequest(string Code);
    public sealed record ConfirmResponse(bool Enabled, List<string> RecoveryCodes, string Note);

    /// <summary>
    /// Proves the app works, then switches MFA on and issues recovery codes.
    ///
    /// The codes are returned exactly once and stored hashed. There is no
    /// endpoint that shows them again — if that existed, an attacker holding a
    /// live session could read them and the second factor would be worth
    /// nothing.
    /// </summary>
    private static async Task<IResult> ConfirmAsync(
        ConfirmRequest req, AppDbContext db, TenantContext tenant,
        TotpService totp, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (user.MfaEnabled)
            return Results.BadRequest(new { error = "Two-step verification is already on." });

        var secret = totp.Unprotect(user.MfaPendingSecret);
        if (secret is null)
            return Results.BadRequest(new
            {
                error = "Start the setup again — there is no enrolment in progress.",
            });

        var step = totp.Verify(secret, req.Code);
        if (step is null)
            return Results.BadRequest(new
            {
                error = "That code is not right. Check your authenticator app and try the current code.",
            });

        // The pending secret becomes the live one, and the step is recorded so
        // the code just used cannot immediately be replayed.
        user.MfaSecretRef = user.MfaPendingSecret;
        user.MfaPendingSecret = null;
        user.MfaEnabled = true;
        user.MfaEnrolledAt = DateTimeOffset.UtcNow;
        user.MfaLastStep = step;

        // Any codes from a previous enrolment are dead the moment a new secret
        // is live — leaving them usable would be a way back in that the person
        // no longer knows about.
        await db.MfaRecoveryCodes
            .Where(c => c.UserId == user.Id)
            .ExecuteDeleteAsync(ct);

        var codes = TotpService.NewRecoveryCodes();
        foreach (var code in codes)
        {
            db.MfaRecoveryCodes.Add(new MfaRecoveryCode
            {
                UserId = user.Id,
                TenantId = user.TenantId,
                CodeHash = TotpService.HashRecoveryCode(code),
            });
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.mfa_enabled", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new ConfirmResponse(
            Enabled: true,
            RecoveryCodes: codes,
            Note: "Save these somewhere safe. Each one works once, they are the only way in if you lose your phone, and they cannot be shown again."));
    }

    // ------------------------------------------------------------------
    public sealed record DisableRequest(string Password);

    /// <summary>
    /// Turning it off requires the password, not merely a live session.
    ///
    /// A borrowed unlocked laptop is the exact situation the second factor
    /// exists for. If a session alone could remove it, anyone who sat down at
    /// one could strip the protection and then sign in from anywhere at
    /// leisure.
    /// </summary>
    private static async Task<IResult> DisableAsync(
        DisableRequest req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (string.IsNullOrEmpty(req.Password)
            || user.PasswordHash is null
            || !hasher.Verify(req.Password, user.PasswordHash))
        {
            return Results.Json(new { error = "That password is not right." }, statusCode: 401);
        }

        user.MfaEnabled = false;
        user.MfaSecretRef = null;
        user.MfaPendingSecret = null;
        user.MfaEnrolledAt = null;
        user.MfaLastStep = null;

        await db.MfaRecoveryCodes
            .Where(c => c.UserId == user.Id)
            .ExecuteDeleteAsync(ct);

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.mfa_disabled", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new
        {
            enabled = false,
            note = "Two-step verification is off. Your recovery codes no longer work.",
        });
    }

    // ------------------------------------------------------------------
    public sealed record RegenerateRequest(string Password);

    /// <summary>
    /// A fresh set, replacing the old.
    ///
    /// Needed when someone has used most of theirs, or has lost the paper.
    /// Password-gated for the same reason as disabling, and it INVALIDATES the
    /// previous set — a printout left in a drawer stops working, which is the
    /// point of asking for new ones.
    /// </summary>
    private static async Task<IResult> RegenerateCodesAsync(
        RegenerateRequest req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (!user.MfaEnabled)
            return Results.BadRequest(new { error = "Two-step verification is not on." });

        if (string.IsNullOrEmpty(req.Password)
            || user.PasswordHash is null
            || !hasher.Verify(req.Password, user.PasswordHash))
        {
            return Results.Json(new { error = "That password is not right." }, statusCode: 401);
        }

        await db.MfaRecoveryCodes
            .Where(c => c.UserId == user.Id)
            .ExecuteDeleteAsync(ct);

        var codes = TotpService.NewRecoveryCodes();
        foreach (var code in codes)
        {
            db.MfaRecoveryCodes.Add(new MfaRecoveryCode
            {
                UserId = user.Id,
                TenantId = user.TenantId,
                CodeHash = TotpService.HashRecoveryCode(code),
            });
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.mfa_recovery_codes_regenerated", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new ConfirmResponse(
            Enabled: true,
            RecoveryCodes: codes,
            Note: "Your previous codes no longer work. Save these instead."));
    }
}
