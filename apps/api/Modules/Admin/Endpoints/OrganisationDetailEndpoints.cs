using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// The operator's page for ONE organisation: its domains and whether their
/// DNS passes, every mail ID it has registered, its shared mailboxes and who
/// can open them, its aliases, and the head-counts that sit behind a plan.
/// (Amit, 26 Sept 2026: "how many and which domains they register, how many
/// mail IDs and their details, how many shared mail IDs".)
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHAT THIS DOES NOT SHOW, ON PURPOSE. Addresses, names, sizes and dates —
///  never a subject line, a folder, a message or a file. The operator runs
///  the platform; they do not read the customer's mail, and a console that
///  could is a promise we could not make to customers. Nothing here touches
///  mail.folders / mail.messages / mail.attachments.
///
///  TENANCY. Same stance as OrganisationEndpoints: platform scope sets the
///  tenant to this one organisation and RLS stays on. Every query ALSO says
///  TenantId == id in so many words. Several of these tables have no RLS
///  (domains, users, mailboxes, aliases are routing data) and some have no
///  EF query filter either (the API-key tables), so the explicit predicate is
///  the one guard that does not depend on which of the other two a table
///  happens to have. tests/admin-org-detail proves it with a second tenant.
///
///  AUDITED READS. Unlike the other operator GETs, these are written to the
///  organisation's own audit log (as platform:…): a list of a customer's
///  staff and who can open which mailbox is personal data, and the customer
///  is entitled to see that we looked.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class OrganisationDetailEndpoints
{
    public static void MapOrganisationDetailEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/organisations/{id:guid}")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");

        g.MapGet("/overview", OverviewAsync);
        g.MapGet("/mailboxes", MailboxesAsync);
    }

    private const int MaxPage = 200;

    // ------------------------------------------------------------------
    private static async Task<IResult> OverviewAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        tenant.EnterPlatformScope(id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        var users = db.Users.AsNoTracking().Where(u => u.TenantId == id);
        var mailboxes = db.Mailboxes.AsNoTracking().Where(m => m.TenantId == id);

        // Mailboxes per domain, so a domain row can say "12 mail IDs" and an
        // unused domain is visible as one.
        var perDomain = await mailboxes
            .GroupBy(m => m.DomainId)
            .Select(g => new { DomainId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.DomainId, x => x.Count, ct);

        var domainRows = await db.Domains.AsNoTracking()
            .Where(d => d.TenantId == id)
            .OrderByDescending(d => d.Type == "primary").ThenBy(d => d.Fqdn)
            .ToListAsync(ct);

        var domains = domainRows.Select(d => new
        {
            d.Id, d.Fqdn, d.Type, d.IsActive, d.IsPlatform, d.VerificationMethod,
            d.CreatedAt,
            ownershipVerifiedAt = d.OwnershipVerifiedAt,
            // Platform subdomains are ours: their DNS is correct by
            // construction and the checker never writes SPF/DKIM/DMARC for
            // them, so showing four red crosses would be a false alarm.
            checks = d.IsPlatform ? null : new
            {
                mx = d.MxVerifiedAt != null,
                spf = d.SpfVerifiedAt != null,
                dkim = d.DkimVerifiedAt != null,
                dmarc = d.DmarcVerifiedAt != null,
            },
            d.DmarcPolicy,
            d.LastCheckedAt,
            d.LastCheckResult,
            mailboxCount = perDomain.GetValueOrDefault(d.Id),
        }).ToList();

        var shared = await mailboxes
            .Where(m => m.Type == "shared")
            .OrderBy(m => m.Address)
            .Select(m => new { m.Id, m.Address, m.DisplayName, m.IsActive, m.QuotaBytes, m.UsedBytes, m.CreatedAt })
            .ToListAsync(ct);

        // Who can open each shared mailbox. mailbox_permissions carries no
        // tenant column; it is reached only through THIS tenant's mailbox ids.
        var sharedIds = shared.Select(s => s.Id).ToList();
        var grants = await (
                from p in db.MailboxPermissions.AsNoTracking()
                where sharedIds.Contains(p.MailboxId)
                join u in users on p.UserId equals u.Id
                orderby u.DisplayName
                select new { p.MailboxId, u.DisplayName, u.Email, p.Permission })
            .ToListAsync(ct);
        var grantsBy = grants.ToLookup(g => g.MailboxId);

        var now = DateTimeOffset.UtcNow;
        var counts = new
        {
            users = await users.CountAsync(ct),
            activeUsers = await users.CountAsync(u => u.Status == "active", ct),
            suspendedUsers = await users.CountAsync(u => u.Status == "suspended", ct),
            neverSignedIn = await users.CountAsync(u => u.LastLoginAt == null, ct),
            signedInLast30Days = await users.CountAsync(u => u.LastLoginAt > now.AddDays(-30), ct),
            admins = await users.CountAsync(u => u.Role == "org_admin", ct),
            twoStepOn = await users.CountAsync(u => u.MfaEnabled, ct),

            personalMailboxes = await mailboxes.CountAsync(m => m.Type == "user", ct),
            sharedMailboxes = shared.Count,
            groupMailboxes = await mailboxes.CountAsync(m => m.Type == "group", ct),
            inactiveMailboxes = await mailboxes.CountAsync(m => !m.IsActive, ct),
            aliases = await db.Aliases.AsNoTracking().CountAsync(a => a.TenantId == id && a.IsActive, ct),
            mailUsedBytes = await mailboxes.SumAsync(m => (long?)m.UsedBytes, ct) ?? 0,

            domains = domainRows.Count,
            verifiedDomains = domainRows.Count(d => d.OwnershipVerifiedAt != null),

            // Counts only. Labels and prefixes stay on the organisation's own
            // console; a key is never shown here in any form.
            orgApiKeys = await db.OrgApiKeys.AsNoTracking().CountAsync(k => k.TenantId == id && k.RevokedAt == null, ct),
            mailApiKeys = await db.MailApiKeys.AsNoTracking().CountAsync(k => k.TenantId == id && k.RevokedAt == null, ct),
            ssoApps = await db.OidcApplications.AsNoTracking().CountAsync(a => a.TenantId == id && a.RevokedAt == null, ct),
        };

        await audit.WriteAsync("organisation.detail_viewed", "tenant", id.ToString(), ct: ct);

        return Results.Ok(new
        {
            org = new { org.Id, org.Name, org.Type, org.Status, org.CreatedAt, org.TrialEndsAt, org.SuspendedAt },
            counts,
            domains,
            sharedMailboxes = shared.Select(s => new
            {
                s.Id, s.Address, s.DisplayName, s.IsActive, s.QuotaBytes, s.UsedBytes, s.CreatedAt,
                access = grantsBy[s.Id].Select(g => new { name = g.DisplayName, g.Email, g.Permission }),
            }),
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Every mail ID, a page at a time — a school has thousands. Filter by
    /// type (user / shared / group), by status (active / inactive), and by a
    /// search over the address and the person's name.
    /// </summary>
    private static async Task<IResult> MailboxesAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, HttpContext http,
        string? q, string? type, string? status, int? offset, int? limit, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();
        if (type is not (null or "" or "user" or "shared" or "group"))
            return Results.BadRequest(new { error = "type must be user, shared or group." });
        if (status is not (null or "" or "active" or "inactive"))
            return Results.BadRequest(new { error = "status must be active or inactive." });

        var skip = Math.Max(0, offset ?? 0);
        var take = Math.Clamp(limit ?? 50, 1, MaxPage);

        tenant.EnterPlatformScope(id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        var rows =
            from m in db.Mailboxes.AsNoTracking()
            where m.TenantId == id
            join u0 in db.Users.AsNoTracking().Where(u => u.TenantId == id)
                on m.UserId equals (Guid?)u0.Id into us
            from u in us.DefaultIfEmpty()
            select new { m, u };

        if (!string.IsNullOrEmpty(type)) rows = rows.Where(r => r.m.Type == type);
        if (status == "active") rows = rows.Where(r => r.m.IsActive);
        if (status == "inactive") rows = rows.Where(r => !r.m.IsActive);

        var term = (q ?? "").Trim().ToLowerInvariant();
        if (term.Length > 0)
        {
            var like = "%" + term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            rows = rows.Where(r => EF.Functions.ILike(r.m.Address, like, "\\")
                || (r.m.DisplayName != null && EF.Functions.ILike(r.m.DisplayName, like, "\\"))
                || (r.u != null && EF.Functions.ILike(r.u.DisplayName, like, "\\")));
        }

        var total = await rows.CountAsync(ct);
        var page = await rows
            .OrderBy(r => r.m.Address)
            .Skip(skip).Take(take)
            .Select(r => new
            {
                r.m.Id, r.m.Address, r.m.Type, r.m.IsActive, r.m.QuotaBytes, r.m.UsedBytes, r.m.CreatedAt,
                name = r.u != null ? r.u.DisplayName : r.m.DisplayName,
                person = r.u == null ? null : new
                {
                    r.u.Id, r.u.Role, r.u.Status, r.u.LastLoginAt, r.u.MfaEnabled,
                },
                // A personal mailbox whose person was deleted: UserId is NULL
                // but the type is still "user". Said out loud, because it
                // still counts against storage and nobody can sign into it.
                retained = r.m.Type == "user" && r.m.UserId == null,
            })
            .ToListAsync(ct);

        var ids = page.Select(p => p.Id).ToList();
        var aliases = (await db.Aliases.AsNoTracking()
                .Where(a => a.TenantId == id && a.IsActive && ids.Contains(a.TargetMailboxId))
                .OrderBy(a => a.Address)
                .Select(a => new { a.TargetMailboxId, a.Address })
                .ToListAsync(ct))
            .ToLookup(a => a.TargetMailboxId, a => a.Address);

        // One audit row per new list or search, not one per page turned —
        // otherwise paging through a school writes forty rows that say the
        // same thing.
        if (skip == 0)
            await audit.WriteAsync("organisation.mail_ids_viewed", "tenant", id.ToString(),
                after: new { q = term.Length > 0 ? term : null, type, status, total }, ct: ct, productCode: "mail");

        return Results.Ok(new
        {
            total, offset = skip, limit = take,
            items = page.Select(p => new
            {
                p.Id, p.Address, p.Type, p.IsActive, p.QuotaBytes, p.UsedBytes, p.CreatedAt,
                p.name, p.person, p.retained,
                aliases = aliases[p.Id],
            }),
        });
    }

    private static Guid CurrentUserId(HttpContext http) =>
        Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
}
