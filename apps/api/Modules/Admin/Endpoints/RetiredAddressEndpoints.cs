using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Mail;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// The operator's list of retired addresses, organisation and personal alike,
/// and the ONLY way one is released (Mr. Singh, 26 Sept 2026). SuperAdmin.
///
/// A release needs all of, checked in the one UPDATE that performs it (so two
/// operators, or an operator and a new mailbox, cannot race past a check):
///  - a person — the signed-in operator, recorded as released_by;
///  - a reason — kept on the row and in the audit log;
///  - the mail server's count of ZERO message files at the address, taken by
///    infra/scripts/maildir-removals.sh — the API never looks at mail files;
///  - the rule's floor, if it set one (a deleted personal account: 90 days);
///  - no mailbox or alias row at the address any more.
/// The refusal names which one failed. Every release is audited
/// ("address.released"), so a mistaken one can be traced to who and why.
/// </summary>
public static class RetiredAddressEndpoints
{
    public static void MapRetiredAddressEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/retired-addresses")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        g.MapGet("/", ListAsync);
        g.MapPost("/{id:long}/release", ReleaseAsync);
    }

    public sealed record ReleaseRequest(string? Reason);

    private static async Task<IResult> ListAsync(
        string? q, string? status, AppDbContext db, CancellationToken ct)
    {
        var rows = db.RetiredAddresses.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(q)) rows = rows.Where(r => r.Address.Contains(q.Trim().ToLower()));
        rows = status == "released" ? rows.Where(r => r.ReleasedAt != null)
             : status == "all" ? rows
             : rows.Where(r => r.ReleasedAt == null);
        var list = await rows.OrderByDescending(r => r.RetiredAt).Take(200).ToListAsync(ct);

        var addresses = list.Select(r => r.Address).ToList();
        var inUse = (await db.Mailboxes.IgnoreQueryFilters().AsNoTracking()
                         .Where(m => addresses.Contains(m.Address)).Select(m => m.Address).ToListAsync(ct))
                    .Concat(await db.Aliases.IgnoreQueryFilters().AsNoTracking()
                         .Where(a => addresses.Contains(a.Address)).Select(a => a.Address).ToListAsync(ct))
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var now = DateTimeOffset.UtcNow;
        return Results.Ok(list.Select(r => new
        {
            r.Id, r.Address, r.TenantId, r.Source, r.RetiredAt, r.NotBefore,
            r.FilesLeft, r.FilesCheckedAt, r.ReleasedAt, r.ReleasedBy, r.ReleaseReason,
            rowStillExists = inUse.Contains(r.Address),
            releasable = r.ReleasedAt == null && BlockerFor(r, inUse.Contains(r.Address), now) is null,
            blocker = r.ReleasedAt == null ? BlockerFor(r, inUse.Contains(r.Address), now) : null,
        }));
    }

    /// <summary>Why this row cannot be released yet, in a sentence; null if it can.</summary>
    private static string? BlockerFor(RetiredAddress r, bool rowExists, DateTimeOffset now) =>
        rowExists ? "A mailbox or alias still has this address."
        : r.FilesCheckedAt is null ? "The mail server has not counted this address's files yet."
        : r.FilesLeft != 0 ? $"The mail server counted {r.FilesLeft} message file(s) still on disk."
        : r.NotBefore is DateTimeOffset nb && nb > now ? $"Held until {nb:yyyy-MM-dd} by its rule."
        : null;

    private static async Task<IResult> ReleaseAsync(
        long id, ReleaseRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        CancellationToken ct)
    {
        var reason = req.Reason?.Trim();
        if (string.IsNullOrEmpty(reason))
            return Results.BadRequest(new { error = "Give the reason. It is kept with the release and in the audit log." });
        if (tenant.UserId is not Guid operatorId) return Results.Unauthorized();

        var row = await db.RetiredAddresses.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return Results.NotFound();
        if (row.ReleasedAt is not null)
            return Results.Conflict(new { error = "That address was already released." });

        // Every condition again, inside the UPDATE itself: the reads above
        // are for the sentence, this is the rule.
        var released = await db.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE core.retired_addresses r
               SET released_at = now(), released_by = {operatorId}, release_reason = {reason}
             WHERE r.id = {id}
               AND r.released_at IS NULL
               AND r.files_checked_at IS NOT NULL AND r.files_left = 0
               AND (r.not_before IS NULL OR r.not_before <= now())
               AND NOT EXISTS (SELECT 1 FROM mail.mailboxes m WHERE m.address = r.address)
               AND NOT EXISTS (SELECT 1 FROM mail.aliases  a WHERE a.address = r.address)
            """, ct);
        if (released != 1)
        {
            var exists = await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == row.Address, ct)
                      || await db.Aliases.IgnoreQueryFilters().AnyAsync(a => a.Address == row.Address, ct);
            return Results.Conflict(new
            {
                error = BlockerFor(row, exists, DateTimeOffset.UtcNow)
                        ?? "It changed while you were releasing it. Reload and look again.",
            });
        }

        await audit.WriteAsync("address.released", "retired_address", id.ToString(),
            before: new { row.Address, row.Source, row.TenantId, row.RetiredAt, row.FilesLeft, row.FilesCheckedAt },
            after: new { reason }, ct: ct, productCode: "mail");
        return Results.Ok(new { released = true, row.Address });
    }
}
