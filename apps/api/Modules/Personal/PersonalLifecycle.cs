using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Modules.Connect.Endpoints;
using TatvaOS.Api.Modules.Space;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// A personal account's life after signup (build plan §8, part F):
/// deleting itself (7-day grace), being deleted for inactivity (12 months, two
/// warnings, then 90 days), being suspended for abuse, and the purge that ends
/// all three.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE PURGE IS THE ONLY HARD DELETE OF A PERSON ON THE PLATFORM.
///  Organisations soft-delete (UserEndpoints.DeleteAsync) and are untouched.
///
///  1. Rows, in one transaction: core.purge_personal_account(), which refuses
///     anyone outside the personal house and returns the FILES to remove.
///  2. Files, after the commit: Space blobs, recording files, the maildir.
///     Any that cannot be removed become core.personal_purge_leftovers and are
///     retried every pass. Rows first because a row pointing at a missing file
///     is a broken product; a file with no row is only disk, and is found.
///  3. The address is HELD for 90 days (core.address_holds) — and for as long
///     as its maildir leftover exists, whatever the date. The mail importer
///     matches maildir files by ADDRESS: an address given to a new person while
///     the old owner's files are on disk would hand them the old mail.
///
///  If this machine cannot see the maildir at all (Mail:VmailRoot missing),
///  the maildir is recorded as a leftover rather than assumed gone: "I could
///  not look" is never treated as "there was nothing there".
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class PersonalLifecycle(
    AppDbContext db, TenantContext tenant, PersonalHouse houses, AuditWriter audit,
    IBlobStore blobs, ConnectRecordingOptions recordings, SystemMailer mailer,
    IConfiguration config, ILogger<PersonalLifecycle> log)
{
    public static readonly TimeSpan SelfDeleteGrace = TimeSpan.FromDays(7);
    public static readonly TimeSpan InactiveAfter = TimeSpan.FromDays(365);
    public static readonly TimeSpan FinalWarningAfter = TimeSpan.FromDays(30);
    public static readonly TimeSpan DeleteAfterFirstWarning = TimeSpan.FromDays(90);

    // DRAFT wording — customer-facing, for Mr. Singh and Amit (build plan §10).
    // Mr. Singh's condition on PR 319: someone who has stolen the password
    // could otherwise delete an account in silence. Sent to the account AND
    // its confirmed recovery address, the moment the deletion is scheduled.
    public const string DeletionScheduledSubject = "Your TatvaOS account is set to be deleted";
    public const string DeletionScheduledBody =
        "Your account {0} is set to be deleted on {1}. "
        + "If this wasn't you, sign in and choose Keep my account.";
    public const string InactiveSubject = "Your TatvaOS account will be deleted if it stays unused";
    public const string InactiveBody =
        "Nobody has signed in to {0} for a year. If nobody signs in by {1}, the account and everything "
        + "in it will be deleted.\n\nTo keep it, just sign in.";
    public const string InactiveFinalSubject = "Last reminder: your TatvaOS account will be deleted";
    public const string DeletedSubject = "Your TatvaOS account has been deleted";
    public const string DeletedBody =
        "The TatvaOS account {0} has been deleted, with everything that was in it.";

    // ------------------------------------------------------------------
    //  Scheduling
    // ------------------------------------------------------------------
    private async Task<PersonalAccount?> AccountAsync(Guid userId, CancellationToken ct) =>
        await db.PersonalAccounts.IgnoreQueryFilters().FirstOrDefaultAsync(a => a.UserId == userId, ct);

    /// <summary>Self-delete: purge in 7 days unless cancelled (§8).</summary>
    public async Task<DateTimeOffset?> RequestSelfDeletionAsync(Guid userId, CancellationToken ct)
    {
        var acct = await AccountAsync(userId, ct);
        if (acct is null) return null;
        var now = DateTimeOffset.UtcNow;
        acct.DeletionRequestedAt = now;
        acct.DeleteAfter = now + SelfDeleteGrace;
        acct.DeletionReason = "self";
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.deletion_requested", "user", userId.ToString(),
            after: new { deleteAfter = acct.DeleteAfter, reason = "self" }, ct: ct);
        await NotifyAsync(userId, DeletionScheduledSubject,
            (address) => string.Format(DeletionScheduledBody, address, IndiaDate(acct.DeleteAfter.Value)), ct);
        return acct.DeleteAfter;
    }

    public async Task<bool> CancelDeletionAsync(Guid userId, CancellationToken ct)
    {
        var acct = await AccountAsync(userId, ct);
        if (acct?.DeleteAfter is null) return false;
        // An operator's deletion is not the person's to cancel.
        if (acct.DeletionReason == "operator") return false;
        acct.DeleteAfter = null;
        acct.DeletionRequestedAt = null;
        acct.DeletionReason = null;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.deletion_cancelled", "user", userId.ToString(), ct: ct);
        return true;
    }

    /// <summary>The operator deletes (§9): at the next pass, no grace.</summary>
    public async Task<bool> OperatorDeleteAsync(Guid userId, string reason, CancellationToken ct)
    {
        var acct = await AccountAsync(userId, ct);
        if (acct is null) return false;
        var now = DateTimeOffset.UtcNow;
        acct.DeletionRequestedAt = now;
        acct.DeleteAfter = now;
        acct.DeletionReason = "operator";
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.deletion_by_operator", "user", userId.ToString(),
            after: new { reason }, ct: ct);
        return true;
    }

    public async Task<bool> SuspendAsync(Guid userId, Guid operatorId, string reason, CancellationToken ct)
    {
        var acct = await AccountAsync(userId, ct);
        if (acct is null) return false;
        acct.SuspendedAt = DateTimeOffset.UtcNow;
        acct.SuspendedReason = reason;
        acct.SuspendedBy = operatorId;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.suspended", "user", userId.ToString(), after: new { reason }, ct: ct);
        return true;
    }

    public async Task<bool> ResumeAsync(Guid userId, CancellationToken ct)
    {
        var acct = await AccountAsync(userId, ct);
        if (acct?.SuspendedAt is null) return false;
        var before = new { acct.SuspendedAt, acct.SuspendedReason };
        acct.SuspendedAt = null;
        acct.SuspendedReason = null;
        acct.SuspendedBy = null;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.resumed", "user", userId.ToString(), before: before, ct: ct);
        return true;
    }

    // ------------------------------------------------------------------
    //  One pass: inactive rule, due purges, leftovers. The worker calls this
    //  hourly; the operator may call it at once (for testing, and so a
    //  deletion they ordered does not wait an hour).
    // ------------------------------------------------------------------
    public sealed record PassReport(int Warned, int FinalWarned, int Scheduled, int Purged, int LeftoversCleared, int LeftoversRemaining);

    public async Task<PassReport> RunPassAsync(CancellationToken ct)
    {
        if (await houses.HouseIdAsync(ct) is not Guid house) return new(0, 0, 0, 0, 0, 0);
        tenant.EnterPlatformScope(house, Guid.Empty);
        await db.SyncTenantAsync(ct);

        var (warned, finalWarned, scheduled) = await InactiveRuleAsync(house, ct);

        var now = DateTimeOffset.UtcNow;
        var due = await db.PersonalAccounts.IgnoreQueryFilters()
            .Where(a => a.TenantId == house && a.DeleteAfter != null && a.DeleteAfter <= now)
            .Select(a => a.UserId).ToListAsync(ct);
        var purged = 0;
        foreach (var uid in due)
            if (await PurgeAsync(uid, ct)) purged++;

        var (cleared, remaining) = await RetryLeftoversAsync(ct);
        return new PassReport(warned, finalWarned, scheduled, purged, cleared, remaining);
    }

    /// <summary>
    /// No sign-in for 12 months → a warning; 30 days later a second; 90 days
    /// after the first, deletion (§8). Coming back at any point clears it all.
    /// "Activity" is the latest of: signing in (last_login_at), a session
    /// being refreshed (a refresh token issued), or the account being made —
    /// someone who stays signed in on a phone for a year is not inactive.
    /// </summary>
    private async Task<(int Warned, int Final, int Scheduled)> InactiveRuleAsync(Guid house, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var rows = await (
            from a in db.PersonalAccounts.IgnoreQueryFilters()
            join u in db.Users.IgnoreQueryFilters() on a.UserId equals u.Id
            where a.TenantId == house && u.Status == "active"
            select new
            {
                Account = a,
                u.LastLoginAt,
                u.CreatedAt,
                LastRefresh = db.RefreshTokens.IgnoreQueryFilters()
                    .Where(t => t.UserId == u.Id).Max(t => (DateTimeOffset?)t.IssuedAt),
            }).ToListAsync(ct);

        int warned = 0, final = 0, scheduled = 0;
        foreach (var r in rows)
        {
            var a = r.Account;
            var active = new[] { r.LastLoginAt, r.LastRefresh, (DateTimeOffset?)r.CreatedAt }.Max()!.Value;

            // Came back after a warning: everything the inactive rule set is undone.
            if (a.InactiveWarnedAt is DateTimeOffset w && active > w)
            {
                a.InactiveWarnedAt = null;
                a.InactiveFinalWarnedAt = null;
                if (a.DeletionReason == "inactive") { a.DeleteAfter = null; a.DeletionReason = null; a.DeletionRequestedAt = null; }
                continue;
            }
            if (a.DeleteAfter is not null) continue;      // already on its way out

            if (a.InactiveWarnedAt is null)
            {
                if (now - active < InactiveAfter) continue;
                var deleteOn = now + DeleteAfterFirstWarning;
                if (await NotifyAsync(a.UserId, InactiveSubject,
                        address => string.Format(InactiveBody, address, IndiaDate(deleteOn)), ct))
                {
                    a.InactiveWarnedAt = now;
                    warned++;
                }
            }
            else if (a.InactiveFinalWarnedAt is null && now - a.InactiveWarnedAt.Value >= FinalWarningAfter)
            {
                var deleteOn = a.InactiveWarnedAt.Value + DeleteAfterFirstWarning;
                if (await NotifyAsync(a.UserId, InactiveFinalSubject,
                        address => string.Format(InactiveBody, address, IndiaDate(deleteOn)), ct))
                {
                    a.InactiveFinalWarnedAt = now;
                    final++;
                }
            }
            else if (a.InactiveWarnedAt is DateTimeOffset first && now - first >= DeleteAfterFirstWarning)
            {
                a.DeletionRequestedAt = now;
                a.DeleteAfter = now;
                a.DeletionReason = "inactive";
                scheduled++;
            }
        }
        await db.SaveChangesAsync(ct);
        return (warned, final, scheduled);
    }

    // ------------------------------------------------------------------
    //  The purge
    // ------------------------------------------------------------------
    private sealed class FileRow { public string Kind { get; set; } = ""; public string Ref { get; set; } = ""; }

    public async Task<bool> PurgeAsync(Guid userId, CancellationToken ct)
    {
        var who = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId).Select(u => new { u.Email, u.RecoveryEmail, u.RecoveryEmailVerifiedAt })
            .FirstOrDefaultAsync(ct);
        if (who is null) return false;

        List<FileRow> files;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            files = await db.Database
                .SqlQuery<FileRow>($"SELECT kind AS \"Kind\", ref AS \"Ref\" FROM core.purge_personal_account({userId})")
                .ToListAsync(ct);
            await audit.WriteAsync("personal.account_purged", "user", userId.ToString(),
                after: new { address = who.Email, files = files.Count }, ct: ct);
            await tx.CommitAsync(ct);
        }
        log.LogInformation("Personal account {User} purged: {Files} file(s) to remove", userId, files.Count);

        foreach (var f in files)
            if (await RemoveFileAsync(f.Kind, f.Ref, who.Email, ct) is string error)
                await RecordLeftoverAsync(f.Kind, f.Ref, who.Email, error, ct);

        // Told, where there is somewhere left to tell: their recovery address.
        if (who.RecoveryEmail is string rec && who.RecoveryEmailVerifiedAt is not null)
            await mailer.SendAsync(rec, DeletedSubject, string.Format(DeletedBody, who.Email), ct);
        return true;
    }

    /// <summary>Null when the file is gone (or was never there); else why not.</summary>
    private async Task<string?> RemoveFileAsync(string kind, string reference, string address, CancellationToken ct)
    {
        try
        {
            switch (kind)
            {
                case "space_blob":
                    await blobs.DeleteAsync(reference);
                    return null;
                case "recording":
                    if (ConnectRecordingEndpoints.ResolvePath(recordings, reference) is not { } path)
                        return "unsafe recording file name";
                    if (File.Exists(path)) File.Delete(path);
                    return null;
                case "maildir":
                    var root = config["Mail:VmailRoot"] ?? "/var/mail/vhosts";
                    // Could not look ≠ nothing there: without the root, the files
                    // may well exist, and the address must stay held.
                    if (!Directory.Exists(root)) return $"maildir root {root} is not visible from here";
                    var at = reference.IndexOf('@');
                    if (at <= 0) return "not an address";
                    var local = reference[..at];
                    var domain = reference[(at + 1)..];
                    if (local.Contains('/') || local.Contains('\\') || local.Contains("..")
                        || domain.Contains('/') || domain.Contains('\\') || domain.Contains(".."))
                        return "unsafe address for a path";
                    var dir = Path.Combine(root, domain, local);
                    if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
                    return null;
                default:
                    return $"unknown kind {kind}";
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ex.GetType().Name + ": " + ex.Message;
        }
    }

    private async Task RecordLeftoverAsync(string kind, string reference, string address, string error, CancellationToken ct)
    {
        log.LogWarning("Purge could not remove {Kind} for {Address}: {Error}", kind, address, error);
        var row = await db.PurgeLeftovers.FirstOrDefaultAsync(l => l.Kind == kind && l.Ref == reference, ct);
        if (row is null)
            db.PurgeLeftovers.Add(new PurgeLeftover { Kind = kind, Ref = reference, Address = address, LastError = error, Attempts = 1 });
        else { row.Attempts++; row.LastError = error; }
        await db.SaveChangesAsync(ct);
    }

    private async Task<(int Cleared, int Remaining)> RetryLeftoversAsync(CancellationToken ct)
    {
        var rows = await db.PurgeLeftovers.OrderBy(l => l.Id).Take(200).ToListAsync(ct);
        var cleared = 0;
        foreach (var l in rows)
        {
            if (await RemoveFileAsync(l.Kind, l.Ref, l.Address ?? "", ct) is string error)
            {
                l.Attempts++;
                l.LastError = error;
            }
            else
            {
                db.PurgeLeftovers.Remove(l);
                cleared++;
            }
        }
        await db.SaveChangesAsync(ct);
        return (cleared, await db.PurgeLeftovers.CountAsync(ct));
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// To the account's own address and, if confirmed, its recovery address.
    /// True if at least one of them was taken by the mail edge — a warning
    /// that reached nobody is not a warning, and the date is not moved on.
    /// </summary>
    private async Task<bool> NotifyAsync(Guid userId, string subject, Func<string, string> body, CancellationToken ct)
    {
        var who = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId).Select(u => new { u.Email, u.RecoveryEmail, u.RecoveryEmailVerifiedAt })
            .FirstOrDefaultAsync(ct);
        if (who is null) return false;
        var text = body(who.Email);
        var any = await mailer.SendAsync(who.Email, subject, text, ct);
        if (who.RecoveryEmail is string rec && who.RecoveryEmailVerifiedAt is not null)
            any = await mailer.SendAsync(rec, subject, text, ct) || any;
        return any;
    }

    private static string IndiaDate(DateTimeOffset at) => at.ToOffset(TimeSpan.FromMinutes(330)).ToString("d MMMM yyyy");
}
