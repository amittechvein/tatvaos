using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Shared mailboxes — admissions@, support@, accounts@.
///
/// ─────────────────────────────────────────────────────────────────────────
///  A mailbox WITHOUT a person behind it. Everything that provisions mail
///  until now hangs a mailbox off a user, because until now every mailbox
///  belonged to somebody: create the person, get the address. A queue that
///  four people answer has no person to hang off, and the delegation work in
///  Mail (grants, read-as, send-as) had nothing to point at without this.
///
///  WHY THIS LIVES IN CORE AND NOT IN MAIL. Provisioning is Core's job — it
///  is the same decision as creating a person: it consumes an address on a
///  verified domain, it takes storage out of the organisation's pool, and it
///  is an administrator's act. Mail decides who may READ a mailbox; Core
///  decides that the mailbox exists at all.
///
///  NO PASSWORD, DELIBERATELY. A shared mailbox has no IMAP password and
///  therefore no sign-in of its own: the only way in is a grant, through a
///  named human's session, which is the entire point. A shared password is
///  how "who sent that?" becomes unanswerable — and it always leaves with
///  the first person who does.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class SharedMailboxEndpoints
{
    public static void MapSharedMailboxEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/mailboxes")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/", ListAsync);
        g.MapPost("/", CreateAsync);
        g.MapDelete("/{id:guid}", DeactivateAsync);
    }

    public sealed record CreateSharedMailboxRequest(
        string? LocalPart, Guid? DomainId, string? DisplayName, long? QuotaBytes);

    // ------------------------------------------------------------------
    /// <summary>
    /// Every shared mailbox in this organisation, with how many people can
    /// reach it — the number an administrator actually wants: a queue nobody
    /// has been granted access to is mail arriving in a room with no door.
    /// </summary>
    private static async Task<IResult> ListAsync(
        AppDbContext db, CancellationToken ct)
    {
        var boxes = await db.Mailboxes.AsNoTracking()
            .Where(m => m.Type == "shared")
            .OrderBy(m => m.Address)
            .Select(m => new
            {
                m.Id,
                m.Address,
                m.LocalPart,
                m.DisplayName,
                m.IsActive,
                m.QuotaBytes,
                m.UsedBytes,
                m.CreatedAt,
                grantCount = db.MailboxPermissions.Count(p => p.MailboxId == m.Id),
            })
            .ToListAsync(ct);

        return Results.Ok(new { mailboxes = boxes });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> CreateAsync(
        CreateSharedMailboxRequest req, AppDbContext db, TenantContext tenant,
        StorageAllocator storage, AuditWriter audit, CancellationToken ct)
    {
        var localPart = (req.LocalPart ?? "").Trim().ToLowerInvariant();

        // Deliberately strict, and strict in the same way Postfix is: this
        // becomes a routable address, and a "+" or an apostrophe that the
        // console accepts but the mail edge rejects is a mailbox that exists
        // and silently receives nothing.
        if (localPart.Length < 2 || localPart.Length > 64
            || !System.Text.RegularExpressions.Regex.IsMatch(localPart, @"^[a-z0-9][a-z0-9._-]*[a-z0-9]$"))
            return Results.BadRequest(new
            {
                error = "Use 2–64 characters: letters, numbers, dots, hyphens or underscores.",
            });

        // Verified AND active, the same rule person-creation uses: a mailbox
        // on an unverified domain receives nothing, and looks like our fault.
        var domain = req.DomainId is Guid did
            ? await db.Domains.FirstOrDefaultAsync(d => d.Id == did, ct)
            : await db.Domains.FirstOrDefaultAsync(
                d => d.IsActive && d.OwnershipVerifiedAt != null, ct);

        if (domain is null || domain.OwnershipVerifiedAt is null || !domain.IsActive)
            return Results.BadRequest(new
            {
                error = "Choose a verified, active domain. Unverified domains receive no mail.",
            });

        var address = $"{localPart}@{domain.Fqdn}";

        // One namespace: people and shared mailboxes share the address space,
        // so this must check BOTH, not just other shared boxes.
        if (await db.Mailboxes.AnyAsync(m => m.Address == address, ct)
            || await db.Aliases.AnyAsync(a => a.Address == address && a.IsActive, ct))
            return Results.BadRequest(new { error = $"{address} is already in use." });

        var quota = await storage.ResolveQuotaAsync(
            tenant.TenantId, null, req.QuotaBytes, "mail", ct);

        var box = new Mailbox
        {
            TenantId = tenant.TenantId,
            DomainId = domain.Id,
            // NULL: this is what makes it shared. The column already documents
            // that a null UserId means a shared mailbox or a retained one.
            UserId = null,
            Address = address,
            LocalPart = localPart,
            Type = "shared",
            DisplayName = string.IsNullOrWhiteSpace(req.DisplayName) ? null : req.DisplayName.Trim(),
            // No ImapPasswordHash. See the class note: access is by grant only.
            QuotaBytes = quota,
        };

        db.Mailboxes.Add(box);
        // Default folders come from the trg_mail_default_folders trigger, the
        // same as any other mailbox — one implementation, no drift.
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mailbox.shared.created", "mail.mailbox", box.Id.ToString(),
            after: new { box.Address, box.DisplayName, quotaBytes = quota },
            ct: ct, productCode: "mail");

        return Results.Created($"/api/org/mailboxes/{box.Id}", new
        {
            box.Id, box.Address, box.LocalPart, box.DisplayName,
            box.QuotaBytes, box.UsedBytes, box.IsActive,
            grantCount = 0,
            note = "Nobody can reach it yet — grant access to the people who answer this queue.",
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Close a shared mailbox: stop accepting mail, keep what it holds.
    ///
    /// NOT a delete. A support queue's history is the organisation's record of
    /// what it promised customers, and destroying it because somebody clicked
    /// the wrong row is not recoverable. Deactivating stops delivery, and the
    /// grants are revoked with it so nobody keeps a door into a mailbox the
    /// organisation considers closed.
    /// </summary>
    private static async Task<IResult> DeactivateAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var box = await db.Mailboxes.FirstOrDefaultAsync(m => m.Id == id && m.Type == "shared", ct);
        if (box is null) return Results.NotFound();

        box.IsActive = false;

        var grants = await db.MailboxPermissions.Where(p => p.MailboxId == id).ToListAsync(ct);
        db.MailboxPermissions.RemoveRange(grants);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mailbox.shared.deactivated", "mail.mailbox", id.ToString(),
            before: new { box.Address, grantsRevoked = grants.Count },
            ct: ct, productCode: "mail");

        return Results.Ok(new
        {
            deactivated = true,
            grantsRevoked = grants.Count,
            note = "Delivery has stopped and access was revoked. The stored mail is retained.",
        });
    }
}
