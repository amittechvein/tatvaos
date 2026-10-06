using System.ComponentModel.DataAnnotations;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Shared.Mail;

// ============================================================================
//  Retired addresses — one list, organisations and personal accounts alike
//  (Mr. Singh, 26 Sept 2026; local/postgres/init/20260927-retired-addresses.sql).
//
//  The mail importer files maildir files by ADDRESS, so a new mailbox at an
//  address somebody used before is handed their old mail from disk. The
//  database refuses that (triggers on mail.mailboxes and mail.aliases); this
//  file is the API's side:
//
//   - RetireAsync: every path that stops using an address writes its row.
//     Hard deletes are written by the database itself; the soft paths — a
//     person deleted or offboarded, a shared mailbox deactivated, a domain's
//     aliases removed — call this.
//   - IsHeldAsync / Held: the create paths check first, so a person is told
//     in a sentence rather than by a 500 from the trigger. The trigger stays
//     the rule; this is only the wording.
//   - Release happens only in the operator console (RetiredAddressEndpoints).
// ============================================================================

public class RetiredAddress
{
    public long Id { get; set; }
    [MaxLength(320)] public required string Address { get; set; }
    public Guid? TenantId { get; set; }
    public required string Source { get; set; }
    public DateTimeOffset RetiredAt { get; set; }
    public DateTimeOffset? NotBefore { get; set; }
    public Guid? ForwardMailboxId { get; set; }
    public int? FilesLeft { get; set; }
    public DateTimeOffset? FilesCheckedAt { get; set; }
    public DateTimeOffset? ReleasedAt { get; set; }
    public Guid? ReleasedBy { get; set; }
    public string? ReleaseReason { get; set; }
}

public static class RetiredAddresses
{
    /// <summary>The constraint name the database's refusal carries (23505).</summary>
    public const string HeldConstraint = "retired_address_held";

    /// <summary>What a person creating a mailbox or alias is told.</summary>
    public static string Held(string address) =>
        $"{address} was used before and is held, so nobody receives the previous owner's mail. " +
        "The TatvaOS team can release it.";

    /// <summary>
    /// Retire an address. Idempotent: an address already held keeps its row
    /// (and its source); a forward named here is added to it.
    /// Runs immediately, not at SaveChanges — the offboarding forward's alias
    /// is inserted after this, and the trigger must already see the forward.
    /// </summary>
    public static Task RetireAsync(AppDbContext db, string address, Guid? tenantId, string source,
                                   Guid? forwardMailboxId, CancellationToken ct) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO core.retired_addresses (address, tenant_id, source, forward_mailbox_id)
            VALUES ({address}::citext, {tenantId}, {source}, {forwardMailboxId})
            ON CONFLICT (address) WHERE released_at IS NULL
            DO UPDATE SET forward_mailbox_id =
                COALESCE(EXCLUDED.forward_mailbox_id, core.retired_addresses.forward_mailbox_id)
            """, ct);

    public static Task<bool> IsHeldAsync(AppDbContext db, string address, CancellationToken ct) =>
        db.RetiredAddresses.AnyAsync(r => r.Address == address && r.ReleasedAt == null, ct);

    /// <summary>The database refused a row at a held address (the trigger).</summary>
    public static bool IsHeldRefusal(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException { SqlState: "23505", ConstraintName: HeldConstraint };
}
