using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Core.Endpoints;

/// <summary>
/// Domains, from the customer's side.
///
/// A customer signs in on the subdomain we issued them at onboarding and adds
/// their own domain here when they are ready. Nothing about their existing
/// mail changes until they move their MX record, which is entirely their
/// decision and reversible.
/// </summary>
public static class DomainEndpoints
{
    public static void MapDomainEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/domains")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/", ListAsync);
        g.MapGet("/{id:guid}", GetAsync);
        g.MapPost("/", AddAsync);
        g.MapPost("/{id:guid}/verify", VerifyAsync);
        g.MapDelete("/{id:guid}", RemoveAsync);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ListAsync(AppDbContext db, CancellationToken ct)
    {
        var domains = await db.Domains.AsNoTracking()
            .OrderByDescending(d => d.IsPlatform)
            .ThenBy(d => d.Fqdn)
            .Select(d => new
            {
                d.Id, d.Fqdn, d.Type, d.IsActive, d.IsPlatform,
                ownershipVerified = d.OwnershipVerifiedAt != null,
                d.OwnershipVerifiedAt, d.MxVerifiedAt, d.SpfVerifiedAt,
                d.DkimVerifiedAt, d.DmarcVerifiedAt,
                d.LastCheckedAt, d.LastCheckResult, d.CreatedAt,
            })
            .ToListAsync(ct);

        return Results.Ok(domains);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, DomainVerifier verifier, CancellationToken ct)
    {
        var d = await db.Domains.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();

        return Results.Ok(new
        {
            d.Id, d.Fqdn, d.IsActive, d.IsPlatform,
            ownershipVerified = d.OwnershipVerifiedAt != null,
            d.LastCheckedAt, d.LastCheckResult,
            // Always returned, even once verified. An admin changing DNS
            // providers next year needs to know what to recreate, and making
            // them open a support ticket for a value we can simply show is
            // needless friction.
            records = d.IsPlatform
                ? []
                : verifier.RequiredRecords(d.Fqdn, d.VerificationToken ?? "", d.DkimSelector, null),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> AddAsync(
        AddDomainRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, DomainVerifier verifier, CancellationToken ct)
    {
        var fqdn = req.Fqdn?.Trim().ToLowerInvariant().TrimEnd('.') ?? "";

        if (!IsPlausibleDomain(fqdn))
            return Results.BadRequest(new { error = "That does not look like a domain name." });

        // Platform-wide, not per tenant. Two organisations cannot both claim
        // example.com — whoever proves ownership first holds it, and letting
        // both add it would make delivery ambiguous rather than merely wrong.
        if (await db.Domains.IgnoreQueryFilters().AnyAsync(d => d.Fqdn == fqdn, ct))
            return Results.Conflict(new
            {
                error = $"{fqdn} is already registered on this platform. If your organisation " +
                        "owns it and someone else has claimed it, contact support — we verify " +
                        "ownership before transferring a domain.",
            });

        var domain = new Domain
        {
            TenantId = tenant.TenantId,
            Fqdn = fqdn,
            Type = "primary",
            // Inactive until ownership is proven. This single line is what
            // stops anyone accepting mail for a domain they do not control.
            IsActive = false,
            VerificationToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            DkimSelector = $"tv{DateTime.UtcNow:yyyy}a",
        };

        db.Domains.Add(domain);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("domain.added", "domain", domain.Id.ToString(),
            after: new { domain.Fqdn }, ct: ct);

        return Results.Created($"/api/org/domains/{domain.Id}", new
        {
            domain.Id,
            domain.Fqdn,
            ownershipVerified = false,
            records = verifier.RequiredRecords(fqdn, domain.VerificationToken!, domain.DkimSelector, null),
            note = "Add the ownership record first, then check again. Your existing mail is " +
                   "unaffected — nothing changes until you move the MX record.",
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> VerifyAsync(
        Guid id, AppDbContext db, DomainVerifier verifier, AuditWriter audit,
        CancellationToken ct)
    {
        var d = await db.Domains.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();

        if (d.IsPlatform)
            return Results.Ok(new
            {
                d.Id, d.Fqdn, ownershipVerified = true,
                summary = "This is a TatvaOS subdomain — nothing to verify.",
                checks = Array.Empty<object>(),
            });

        var result = await verifier.CheckAsync(d.Fqdn, d.VerificationToken ?? "", d.DkimSelector, ct);
        var now = DateTimeOffset.UtcNow;

        d.LastCheckedAt = now;
        d.LastCheckResult = result.Summary;

        // Timestamps are set once and never cleared. A record that passed in
        // March and is missing today is a regression worth seeing, not a
        // reason to silently pretend it was never configured — the checks
        // array carries the current state.
        foreach (var c in result.Checks.Where(c => c.Passed))
        {
            switch (c.Id)
            {
                case "ownership": d.OwnershipVerifiedAt ??= now; break;
                case "mx":        d.MxVerifiedAt ??= now; break;
                case "spf":       d.SpfVerifiedAt ??= now; break;
                case "dkim":      d.DkimVerifiedAt ??= now; break;
                case "dmarc":     d.DmarcVerifiedAt ??= now; break;
            }
        }

        var justActivated = false;
        if (result.OwnershipProven && !d.IsActive)
        {
            d.IsActive = true;
            justActivated = true;
        }

        await db.SaveChangesAsync(ct);

        if (justActivated)
            await audit.WriteAsync("domain.verified", "domain", d.Id.ToString(),
                after: new { d.Fqdn }, ct: ct);

        return Results.Ok(new
        {
            d.Id, d.Fqdn,
            ownershipVerified = result.OwnershipProven,
            isActive = d.IsActive,
            justActivated,
            summary = result.Summary,
            checkedAt = now,
            checks = result.Checks,
            records = verifier.RequiredRecords(d.Fqdn, d.VerificationToken ?? "", d.DkimSelector, null),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> RemoveAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var d = await db.Domains.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (d is null) return Results.NotFound();

        if (d.IsPlatform)
            return Results.BadRequest(new
            {
                error = "The TatvaOS subdomain cannot be removed — it is how your organisation " +
                        "signs in if your own domain's DNS ever breaks.",
            });

        // Refusing while mailboxes exist, rather than cascading. The delete
        // would take their mail with it, and "are you sure" is not adequate
        // consent for that.
        var mailboxes = await db.Mailboxes.CountAsync(m => m.DomainId == id, ct);
        if (mailboxes > 0)
            return Results.BadRequest(new
            {
                error = $"{mailboxes} mailbox(es) still use {d.Fqdn}. Move or remove them first — " +
                        "deleting the domain would delete their mail.",
            });

        db.Domains.Remove(d);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("domain.removed", "domain", id.ToString(),
            before: new { d.Fqdn }, ct: ct);

        return Results.Ok(new { removed = true });
    }

    // ------------------------------------------------------------------
    private static bool IsPlausibleDomain(string fqdn) =>
        fqdn.Length is > 3 and <= 253 &&
        Regex.IsMatch(fqdn, @"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$");
}

public sealed record AddDomainRequest(string? Fqdn);
