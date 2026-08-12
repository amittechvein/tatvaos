using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Reading the audit trail.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE TRAIL WAS BEING WRITTEN FROM TWENTY-NINE PLACES AND READ FROM NONE.
///
///  Every administrative action has been recorded since the beginning — who
///  did it, from which address, and the before and after state. None of it
///  was reachable. An audit log nobody can read is a cost with no benefit:
///  it is worthless exactly when it matters, which is the afternoon a
///  customer asks who suspended their colleague, or a DPDP-Act enquiry asks
///  what was accessed and when.
///
///  This is a READ PATH ONLY, and deliberately so. core.audit_logs is
///  append-only by design — an audit log an administrator can edit is not an
///  audit log — so there is no update or delete here, and there never should
///  be. AuditWriter remains the single writer.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Two audiences, one endpoint. An organisation's own admin sees their
/// organisation, enforced by RLS rather than by a WHERE clause. A platform
/// admin can pass ?tenantId= to look into one customer's trail — which is
/// itself an action worth recording, and AuditWriter already prefixes
/// platform actions with "platform:" so those entries are distinguishable
/// from the customer's own.
/// </summary>
public static class AuditEndpoints
{
    /// <summary>
    /// Fifty is a screenful and a cheap query. The cap exists because this
    /// table is the largest in the schema on a busy tenant and an unbounded
    /// take is how a console page pulls a million rows into memory.
    /// </summary>
    private const int DefaultPageSize = 50;
    private const int MaxPageSize = 200;

    public static void MapAuditEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/audit")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/", ListAsync);
        g.MapGet("/actions", ActionsAsync);
    }

    // ------------------------------------------------------------------
    public sealed record Entry(
        long Id,
        DateTimeOffset OccurredAt,
        string Action,
        string? ProductCode,
        Guid? ActorUserId,
        string? ActorName,
        string? ActorEmail,
        string? ActorIp,
        string? TargetType,
        string? TargetId,
        bool HasDetail,
        string? BeforeState,
        string? AfterState);

    public sealed record Page(List<Entry> Entries, long? NextBefore, bool HasMore);

    /// <summary>
    /// Newest first, filtered, keyset-paged.
    ///
    /// PAGING IS BY ID, NOT BY OFFSET. The trail grows while it is being read
    /// — that is the nature of it — and OFFSET on a table receiving inserts
    /// shows the same row twice or skips one entirely as later pages shift
    /// beneath the reader. `before` is the last id seen, so each page
    /// continues exactly where the previous one stopped no matter what has
    /// been written since.
    /// </summary>
    private static async Task<IResult> ListAsync(
        AppDbContext db, TenantContext tenant,
        string? action, string? targetType, Guid? actorUserId,
        DateTimeOffset? from, DateTimeOffset? to,
        long? before, int? limit,
        CancellationToken ct)
    {
        var take = Math.Clamp(limit ?? DefaultPageSize, 1, MaxPageSize);

        var q = db.AuditLogs.AsNoTracking().AsQueryable();

        // Prefix match, so "user." finds user.created, user.suspended and the
        // rest. The console offers whole actions from /actions; this is for
        // someone who wants a family of them.
        if (!string.IsNullOrWhiteSpace(action))
        {
            var a = action.Trim().ToLowerInvariant();
            q = q.Where(e => e.Action.StartsWith(a));
        }

        if (!string.IsNullOrWhiteSpace(targetType))
        {
            var t = targetType.Trim().ToLowerInvariant();
            q = q.Where(e => e.TargetType == t);
        }

        if (actorUserId is Guid actor)
            q = q.Where(e => e.ActorUserId == actor);

        // Inclusive of `from`, exclusive of `to`. A caller passing the same
        // date for both means "that day" only if the boundary is half-open;
        // the alternative silently includes midnight of the next day.
        if (from is DateTimeOffset f) q = q.Where(e => e.OccurredAt >= f);
        if (to is DateTimeOffset t2) q = q.Where(e => e.OccurredAt < t2);

        if (before is long b) q = q.Where(e => e.Id < b);

        // One more than asked for: its presence is what proves another page
        // exists, without a second COUNT over a table this size.
        var rows = await q
            .OrderByDescending(e => e.Id)
            .Take(take + 1)
            .ToListAsync(ct);

        var hasMore = rows.Count > take;
        if (hasMore) rows.RemoveAt(rows.Count - 1);

        // Actor names resolved in one lookup rather than a join per row. The
        // actor may be deleted or may be the platform itself, so a missing
        // name is normal and renders as the raw id.
        var actorIds = rows.Where(r => r.ActorUserId != null)
                           .Select(r => r.ActorUserId!.Value)
                           .Distinct()
                           .ToList();

        var actors = await db.Users.AsNoTracking()
            .IgnoreQueryFilters()
            .Where(u => actorIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email })
            .ToDictionaryAsync(u => u.Id, ct);

        var entries = rows.Select(r =>
        {
            var who = r.ActorUserId is Guid id ? actors.GetValueOrDefault(id) : null;

            return new Entry(
                Id: r.Id,
                OccurredAt: r.OccurredAt,
                Action: r.Action,
                ProductCode: r.ProductCode,
                ActorUserId: r.ActorUserId,
                ActorName: who?.DisplayName,
                ActorEmail: who?.Email,
                ActorIp: r.ActorIp,
                TargetType: r.TargetType,
                TargetId: r.TargetId,
                HasDetail: r.BeforeState is not null || r.AfterState is not null,
                BeforeState: r.BeforeState,
                AfterState: r.AfterState);
        }).ToList();

        return Results.Ok(new Page(
            Entries: entries,
            NextBefore: hasMore && entries.Count > 0 ? entries[^1].Id : null,
            HasMore: hasMore));
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// The distinct actions this organisation has actually recorded, so the
    /// filter offers what exists rather than a hardcoded list that drifts
    /// every time an endpoint adds an audit call. Cheap: the cardinality is
    /// tens of values however many millions of rows sit behind it.
    /// </summary>
    private static async Task<IResult> ActionsAsync(
        AppDbContext db, CancellationToken ct)
    {
        var actions = await db.AuditLogs.AsNoTracking()
            .Select(e => e.Action)
            .Distinct()
            .OrderBy(a => a)
            .ToListAsync(ct);

        return Results.Ok(actions);
    }
}
