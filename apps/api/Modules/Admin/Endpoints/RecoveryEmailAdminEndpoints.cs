using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Decision 0009 — an administrator sets a person's recovery email.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE THREAT (Mr. Singh, 21 Sept): an administrator who can write another
///  person's recovery address can point it at themselves, send a sign-in link
///  and own the account. Confirmation alone does not stop it — the
///  administrator confirms their own inbox. So, per his rulings of 24 and
///  27 Sept (docs/decisions/0009):
///
///   * The new address is confirmed by a link mailed to it before it counts.
///   * Replacing an existing address is HELD for 48 hours after confirmation.
///     core.users.recovery_email keeps the OLD address until the hold ends
///     (core.apply_due_recovery_changes(), RecoveryHoldWorker), so every
///     emailed credential link still goes to the confirmed old address; with
///     no confirmed old address, the links are refused and Reset password is
///     the visible fallback.
///   * Empty -> value is the only change that is not held.
///   * The person's sign-in mailbox and old address get a "this was not me"
///     link, valid 30 days: it reverts, never signs anyone in, and suspends
///     that administrator's ability to change recovery addresses until an
///     owner clears it. Owners and the platform operator are told.
///   * An owner's own recovery address is changeable only by that owner.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class RecoveryEmailAdminEndpoints
{
    public static readonly TimeSpan HoldDuration = TimeSpan.FromHours(48);
    public static readonly TimeSpan NotMeValidity = TimeSpan.FromDays(30);
    private static readonly TimeSpan ConfirmLifetime = TimeSpan.FromHours(24);

    public static void MapRecoveryEmailAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var users = app.MapGroup("/api/org/users")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");
        users.MapPut("/{id:guid}/recovery-email", SetAsync);
        users.MapPost("/{id:guid}/recovery-suspension/clear", ClearSuspensionAsync);

        app.MapPost("/api/auth/recovery-email/not-me", NotMeAsync)
            .AllowAnonymous()
            .RequireRateLimiting("auth-invite-accept")
            .WithTags("Authentication");
    }

    public sealed record SetRecoveryRequest(string? Email);
    public sealed record NotMeRequest(string? Token);

    /// <summary>A hold that is running on a person's recovery email, if any.</summary>
    public sealed record Hold(DateTimeOffset Until, bool HasConfirmedOld);

    /// <summary>
    /// The hold on this person's recovery address, if one is running. Called
    /// by Send sign-in link and Resend invitation (the tenant is already set).
    /// </summary>
    public static async Task<Hold?> ActiveHoldAsync(AppDbContext db, Guid userId, CancellationToken ct)
    {
        var held = await db.RecoveryEmailChanges.AsNoTracking()
            .Where(c => c.UserId == userId && c.Status == "held")
            .Select(c => new { c.HoldUntil, c.OldVerifiedAt, c.OldEmail })
            .FirstOrDefaultAsync(ct);
        return held?.HoldUntil is DateTimeOffset until && until > DateTimeOffset.UtcNow
            ? new Hold(until, held.OldVerifiedAt is not null && !string.IsNullOrWhiteSpace(held.OldEmail))
            : null;
    }

    /// <summary>The time a hold ends, in words an administrator reads (IST).</summary>
    public static string HoldEndText(DateTimeOffset until) =>
        until.ToOffset(TimeSpan.FromMinutes(330))
             .ToString("d MMM, HH:mm", System.Globalization.CultureInfo.InvariantCulture) + " IST";

    // ------------------------------------------------------------------
    /// <summary>PUT /api/org/users/{id}/recovery-email — an administrator sets it.</summary>
    private static async Task<IResult> SetAsync(
        Guid id, SetRecoveryRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        SystemMailer mailer, IConfiguration config, ILoggerFactory logs, CancellationToken ct)
    {
        var email = req.Email?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || !System.Net.Mail.MailAddress.TryCreate(email, out _)
            || email.Length > 320)
            return Results.BadRequest(new { error = "Enter a valid email address." });

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();
        if (user.Id == tenant.UserId)
            return Results.BadRequest(new { error = "Change your own recovery email from your account page." });
        // Mr. Singh, 24 Sept: an owner's own recovery address is changeable only
        // by that owner — not by an administrator, and not by another owner.
        if (user.Role == "org_owner")
            return Results.Json(new
            {
                error = "Only an owner can change their own recovery email, from their account page.",
            }, statusCode: 403);
        if (user.Status is "deleted" or "suspended")
            return Results.BadRequest(new { error = "This account is closed. Reactivate it first." });

        var suspended = await db.RecoveryAdminSuspensions.AsNoTracking()
            .AnyAsync(s => s.AdminUserId == tenant.UserId && s.ClearedAt == null, ct);
        if (suspended)
            return Results.Json(new
            {
                error = "A recovery email you set was reversed by the person it belongs to. "
                      + "You cannot change recovery emails until an owner has reviewed it.",
            }, statusCode: 403);

        if (string.Equals(email, user.Email, StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "The recovery email must differ from their sign-in email." });
        if (string.Equals(email, user.RecoveryEmail, StringComparison.OrdinalIgnoreCase)
            && user.RecoveryEmailVerifiedAt is not null)
            return Results.Ok(new { status = "unchanged", message = "That is already their confirmed recovery email." });

        // One change in flight per person: a new one supersedes the old.
        await db.RecoveryEmailChanges
            .Where(c => c.UserId == user.Id && (c.Status == "pending" || c.Status == "held"))
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.Status, "superseded"), ct);

        var confirmToken = TokenIssuer.GenerateRefreshToken();
        var notMeToken = TokenIssuer.GenerateRefreshToken();
        var now = DateTimeOffset.UtcNow;
        var change = new RecoveryEmailChange
        {
            TenantId = user.TenantId,
            UserId = user.Id,
            SetByUserId = tenant.UserId!.Value,
            OldEmail = user.RecoveryEmail,
            OldVerifiedAt = user.RecoveryEmailVerifiedAt,
            NewEmail = email,
            ConfirmTokenHash = TokenIssuer.HashRefreshToken(confirmToken),
            ConfirmSentAt = now,
            NotMeTokenHash = TokenIssuer.HashRefreshToken(notMeToken),
            NotMeExpiresAt = now + NotMeValidity,
        };
        db.RecoveryEmailChanges.Add(change);
        await db.SaveChangesAsync(ct);

        var admin = await db.Users.AsNoTracking()
            .Where(u => u.Id == tenant.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "An administrator";
        var replacing = !string.IsNullOrWhiteSpace(user.RecoveryEmail);
        var baseUrl = (config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');

        // The new address gets the confirmation link, and nothing else.
        var sent = await mailer.SendHtmlAsync(
            email, RecoveryVerifyEmail.Subject(),
            RecoveryVerifyEmail.Html(user.DisplayName, baseUrl,
                $"{baseUrl}/verify-recovery-email?token={Uri.EscapeDataString(confirmToken)}",
                (int)ConfirmLifetime.TotalMinutes),
            from: "no_reply@tatvaos.com", ct);

        // The person, at their sign-in mailbox AND the old address: who did it,
        // what happens next, and the undo. The new address appears only masked.
        var what = replacing
            ? $"{admin}, an administrator in your organisation, set your recovery email to {Mask.Email(email)}. "
              + $"It replaces {Mask.Email(user.RecoveryEmail)} only after it is confirmed and a further "
              + $"{(int)HoldDuration.TotalHours} hours have passed; until then, sign-in links still go to your previous address."
            : $"{admin}, an administrator in your organisation, set your recovery email to {Mask.Email(email)}. "
              + "It starts working once someone opens the confirmation link sent to it.";
        var notMeUrl = $"{baseUrl}/recovery-not-me?token={Uri.EscapeDataString(notMeToken)}";
        foreach (var to in new[] { user.Email, user.RecoveryEmail }
                     .Where(a => !string.IsNullOrWhiteSpace(a)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                await mailer.SendHtmlAsync(to!, RecoveryChangedEmail.Subject(),
                    RecoveryChangedEmail.Html(user.DisplayName, baseUrl, what, now, notMeUrl),
                    from: "no_reply@tatvaos.com", ct);
            }
            catch (Exception ex)
            {
                logs.CreateLogger("RecoveryEmailAdmin").LogWarning(ex,
                    "Recovery-change notice for user {UserId} could not be sent", user.Id);
            }
        }

        await audit.WriteAsync("user.recovery_set_by_admin", "user", user.Id.ToString(),
            before: new { value = Mask.Email(user.RecoveryEmail), verified = user.RecoveryEmailVerifiedAt is not null },
            after: new { value = Mask.Email(email), changeId = change.Id, held = replacing, confirmationSent = sent },
            ct: ct);

        return Results.Ok(new
        {
            status = "pending",
            sentTo = Mask.Email(email),
            held = replacing,
            message = replacing
                ? $"A confirmation link has been sent to {Mask.Email(email)}. Once it is confirmed, the change waits "
                  + $"{(int)HoldDuration.TotalHours} hours before it takes effect, and the person has been told."
                : $"A confirmation link has been sent to {Mask.Email(email)}. It becomes their recovery email once "
                  + "it is confirmed, and the person has been told.",
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// The confirmation link for an administrator's change. Called from
    /// POST /api/auth/recovery-email/verify when no person's own pending
    /// address matches the token, so the one link page serves both. Null when
    /// the token is not an administrator change at all.
    /// </summary>
    public static async Task<IResult?> ConfirmChangeAsync(
        string tokenHash, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var found = (await db.Database
            .SqlQuery<ChangeRef>($"""
                SELECT change_id AS "ChangeId", tenant_id AS "TenantId", sent_at AS "SentAt"
                  FROM core.recovery_change_for_confirm({tokenHash})
                """)
            .ToListAsync(ct)).FirstOrDefault();
        if (found is null) return null;
        if (found.SentAt is null || DateTimeOffset.UtcNow - found.SentAt > ConfirmLifetime)
            return Results.Json(new { error = "This verification link is invalid or has expired. Request a new one." },
                statusCode: 400);

        tenant.EnterAnonymousScope(found.TenantId, "system");
        await db.SyncTenantAsync(ct);

        var change = await db.RecoveryEmailChanges.FirstAsync(c => c.Id == found.ChangeId, ct);
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == change.UserId, ct);
        if (user is null || user.Status is "deleted" or "suspended")
            return Results.Json(new { error = "This verification link is invalid or has expired. Request a new one." },
                statusCode: 400);

        var now = DateTimeOffset.UtcNow;
        change.ConfirmTokenHash = null;
        change.ConfirmedAt = now;

        // The person changed it themselves meanwhile: theirs wins.
        if (!string.Equals(user.RecoveryEmail ?? "", change.OldEmail ?? "", StringComparison.OrdinalIgnoreCase))
        {
            change.Status = "superseded";
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = "This change was overtaken by a later one and no longer applies." },
                statusCode: 400);
        }

        // Empty -> value is the only change that is not held (Mr. Singh, 24 Sept).
        if (string.IsNullOrWhiteSpace(change.OldEmail))
        {
            user.RecoveryEmail = change.NewEmail;
            user.RecoveryEmailVerifiedAt = now;
            user.RecoveryEmailTokenHash = null;
            user.RecoveryEmailTokenSentAt = null;
            change.Status = "applied";
            change.AppliedAt = now;
        }
        else
        {
            change.Status = "held";
            change.HoldUntil = now + HoldDuration;
        }
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("user.recovery_admin_change_confirmed", "user", user.Id.ToString(),
            after: new { changeId = change.Id, status = change.Status, holdUntil = change.HoldUntil }, ct: ct);

        return Results.Ok(new { verified = true, held = change.Status == "held", holdUntil = change.HoldUntil });
    }

    private sealed record ChangeRef(Guid ChangeId, Guid TenantId, DateTimeOffset? SentAt);
    private sealed record NotMeRef(Guid ChangeId, Guid TenantId);

    // ------------------------------------------------------------------
    /// <summary>
    /// POST /api/auth/recovery-email/not-me — the person undoes an
    /// administrator's change. Anonymous: the token is the proof. Reverts
    /// ONLY: it never issues a session (Mr. Singh, 24 Sept).
    /// </summary>
    private static async Task<IResult> NotMeAsync(
        NotMeRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        SystemMailer mailer, CancellationToken ct)
    {
        const string Invalid = "This link is invalid, has expired, or has already been used.";
        if (string.IsNullOrWhiteSpace(req.Token)) return Results.BadRequest(new { error = Invalid });

        var hash = TokenIssuer.HashRefreshToken(req.Token.Trim());
        var found = (await db.Database
            .SqlQuery<NotMeRef>($"""
                SELECT change_id AS "ChangeId", tenant_id AS "TenantId"
                  FROM core.recovery_change_for_not_me({hash})
                """)
            .ToListAsync(ct)).FirstOrDefault();
        if (found is null) return Results.BadRequest(new { error = Invalid });

        tenant.EnterAnonymousScope(found.TenantId, "system");
        await db.SyncTenantAsync(ct);

        var change = await db.RecoveryEmailChanges.FirstAsync(c => c.Id == found.ChangeId, ct);
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == change.UserId, ct);
        if (user is null) return Results.BadRequest(new { error = Invalid });

        var now = DateTimeOffset.UtcNow;
        // Applied: put the old address back, as it was — but only if the
        // address is still the one this change set. Pending or held: the
        // recovery address never moved, so there is nothing to put back.
        if (change.Status == "applied"
            && string.Equals(user.RecoveryEmail ?? "", change.NewEmail, StringComparison.OrdinalIgnoreCase))
        {
            user.RecoveryEmail = change.OldEmail;
            user.RecoveryEmailVerifiedAt = change.OldVerifiedAt;
            user.RecoveryEmailTokenHash = null;
            user.RecoveryEmailTokenSentAt = null;
        }
        change.Status = "reverted";
        change.RevertedAt = now;
        change.NotMeTokenHash = null;
        change.ConfirmTokenHash = null;

        var alreadySuspended = await db.RecoveryAdminSuspensions
            .AnyAsync(s => s.AdminUserId == change.SetByUserId && s.ClearedAt == null, ct);
        if (!alreadySuspended)
            db.RecoveryAdminSuspensions.Add(new RecoveryAdminSuspension
            {
                TenantId = change.TenantId,
                AdminUserId = change.SetByUserId,
                ChangeId = change.Id,
            });
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("user.recovery_admin_change_reverted", "user", user.Id.ToString(),
            after: new { changeId = change.Id, administrator = change.SetByUserId, suspended = true }, ct: ct);

        // "Mr. Singh's review queue" means the organisation's owners and the
        // platform operator (his ruling, 24 Sept). Plain words, masked address.
        var admin = await db.Users.AsNoTracking().IgnoreQueryFilters()
            .Where(u => u.Id == change.SetByUserId).Select(u => new { u.DisplayName, u.Email })
            .FirstOrDefaultAsync(ct);
        var owners = await db.Users.AsNoTracking()
            .Where(u => u.Role == "org_owner" && u.Status == "active").Select(u => u.Email).ToListAsync(ct);
        var operators = await db.Users.AsNoTracking().IgnoreQueryFilters()
            .Where(u => u.Role == "super_admin" && u.Status == "active").Select(u => u.Email).ToListAsync(ct);
        var body =
            $"{user.DisplayName} used \"This was not me\" on a recovery email that {admin?.DisplayName ?? "an administrator"} "
            + $"({Mask.Email(admin?.Email)}) set for them ({Mask.Email(change.NewEmail)}).\n\n"
            + "The change has been undone. That administrator cannot change anyone's recovery email until an "
            + "owner reviews what happened and clears it (People, their account, Recovery changes).";
        foreach (var to in owners.Concat(operators).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try { await mailer.SendAsync(to, "A recovery email change was reversed", body, ct); }
            catch { /* one bad address must not stop the rest */ }
        }

        return Results.Ok(new
        {
            reverted = true,
            message = "Done. The change has been undone and your organisation's owner has been told. "
                    + "If you think someone has your password, change it now.",
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// POST /api/org/users/{id}/recovery-suspension/clear — an OWNER reviews a
    /// reversed change and lets that administrator change recovery emails again.
    /// </summary>
    private static async Task<IResult> ClearSuspensionAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.Role is not ("org_owner" or "super_admin"))
            return Results.Json(new { error = "Only an owner can clear this." }, statusCode: 403);

        var active = await db.RecoveryAdminSuspensions
            .FirstOrDefaultAsync(s => s.AdminUserId == id && s.ClearedAt == null, ct);
        if (active is null) return Results.NotFound(new { error = "Nothing to clear for this person." });

        active.ClearedAt = DateTimeOffset.UtcNow;
        active.ClearedByUserId = tenant.UserId;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.recovery_suspension_cleared", "user", id.ToString(),
            after: new { suspensionId = active.Id, changeId = active.ChangeId }, ct: ct);
        return Results.Ok(new { cleared = true });
    }
}
