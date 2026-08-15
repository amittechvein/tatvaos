using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Decides which mailbox a request is allowed to act on.
///
/// ─────────────────────────────────────────────────────────────────────────
///  ONE RESOLVER, ON PURPOSE. Delegation goes wrong when the permission check
///  lives in each handler: it ends up present on the list and missing on
///  delete, and nobody notices until somebody deletes somebody else's mail.
///  Every handler that accepts a mailboxId asks this and nothing else.
///
///  WHERE THE TENANT BOUNDARY COMES FROM. mail.mailbox_permissions has no
///  tenant_id and no EF query filter - it is keyed only on mailbox and user.
///  (It DOES carry RLS, scoped through the mailbox's tenant - see
///  01-mail-schema.sql - so the database is a second net. Neither layer is
///  allowed to lean on the other: RLS holds only when app.tenant_id is set,
///  and the EF filter holds only when code resolves through it.) The app-side
///  boundary is that the mailbox is looked up through db.Mailboxes, which has
///  the tenant query filter. A grant row pointing at a mailbox in another
///  organisation resolves to nothing, because the mailbox itself is invisible.
///  The grant table is never the thing being trusted; the mailbox lookup is.
///
///  PERMISSIONS DO NOT IMPLY EACH OTHER, except 'full', which implies all of
///  them. In particular send_as does NOT confer read. An administrator who
///  grants exactly one thing has said exactly one thing, and inventing the
///  rest for them is how a service account that was meant only to send ends
///  up able to read a year of correspondence.
///
///  send_on_behalf is in the schema's CHECK constraint and is NOT implemented.
///  It means something different on the wire - the person in From, the mailbox
///  in Sender - and quietly treating it as send_as would do the opposite of
///  what was asked for. It is refused at the API rather than accepted and
///  ignored, because a grant that appears to work and does nothing is worse
///  than one that was never made.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailboxAccess
{
    public const string Read = "read";
    public const string SendAs = "send_as";
    public const string Full = "full";

    /// <summary>What an administrator may grant today. Ordered for display.</summary>
    public static readonly string[] Grantable = [Read, SendAs, Full];

    /// <summary>
    /// In the schema, refused by the API. See the note above.
    /// </summary>
    public const string SendOnBehalf = "send_on_behalf";

    private static bool Satisfies(string held, string required) =>
        string.Equals(held, Full, StringComparison.OrdinalIgnoreCase)
        || string.Equals(held, required, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The mailbox this caller may act on at the level required, or null.
    ///
    /// A null mailboxId means "my own", which is the entire existing behaviour
    /// of this API and needs no grant. Passing your own mailbox's id explicitly
    /// is the same thing said out loud.
    /// </summary>
    public static async Task<Mailbox?> ResolveAsync(
        AppDbContext db, TenantContext tenant, Guid? mailboxId, string required, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return null;

        var own = await db.Mailboxes.FirstOrDefaultAsync(m => m.UserId == uid && m.IsActive, ct);

        if (mailboxId is not Guid wanted) return own;
        if (own is not null && own.Id == wanted) return own;

        // Tenant-filtered. This is the boundary; see the class note.
        var box = await db.Mailboxes.FirstOrDefaultAsync(m => m.Id == wanted && m.IsActive, ct);
        if (box is null) return null;

        var held = await db.MailboxPermissions.AsNoTracking()
            .Where(p => p.MailboxId == box.Id && p.UserId == uid)
            .Select(p => p.Permission)
            .ToListAsync(ct);

        return held.Exists(h => Satisfies(h, required)) ? box : null;
    }

    /// <summary>
    /// May this caller change who has access to this mailbox?
    ///
    /// 'full' on the mailbox, or an organisation administrator. The second half
    /// is not a convenience: a shared mailbox starts with no grants at all, so
    /// without it nobody could ever make the first one.
    /// </summary>
    public static async Task<bool> CanAdministerAsync(
        AppDbContext db, TenantContext tenant, Guid mailboxId, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return false;

        // The mailbox must exist INSIDE this tenant before any of the rest
        // matters. db.Mailboxes is tenant-filtered; mail.mailbox_permissions is
        // not, so without this an organisation administrator could pass the id
        // of a mailbox in another organisation and have the role check wave
        // them through to somebody else's grant list.
        var box = await db.Mailboxes.AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == mailboxId, ct);
        if (box is null) return false;

        if (await ResolveAsync(db, tenant, mailboxId, Full, ct) is not null) return true;

        var role = await db.Users.AsNoTracking()
            .Where(u => u.Id == uid)
            .Select(u => u.Role)
            .FirstOrDefaultAsync(ct);

        return role is "super_admin" or "org_owner" or "org_admin";
    }
}
