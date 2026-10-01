using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// The operator's list of addresses nobody may sign up for (build plan §3.2,
/// §9): view, add, remove. Platform-wide reference data, SuperAdmin only.
///
/// Remove is a soft delete. The migration re-seeds its starter list on every
/// deploy with ON CONFLICT DO NOTHING; a removed row still conflicts, so a
/// removal survives the next deploy. Adding a removed name back revives it.
///
/// Nothing here affects an address that already exists — reserving "sbi"
/// today does not take sbi@ from whoever has it. That is deliberate: a
/// reserved list is about the future, and taking a live mailbox is part F's
/// suspension flow, with a reason and a person behind it.
/// </summary>
public static class ReservedUsernameEndpoints
{
    private static readonly string[] Matches = ["exact", "contains"];
    private static readonly string[] Categories = ["system", "product", "lookalike", "other"];

    public static void MapReservedUsernameEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/reserved-usernames")
            .RequireOperator()
            .WithTags("Platform administration");
        g.MapGet("/", ListAsync);
        g.MapPost("/", AddAsync);
        g.MapDelete("/{name}", RemoveAsync);
    }

    private static async Task<IResult> ListAsync(AppDbContext db, CancellationToken ct) =>
        Results.Ok(await db.ReservedUsernames.AsNoTracking()
            .Where(r => r.RemovedAt == null)
            .OrderBy(r => r.Category).ThenBy(r => r.Name)
            .Select(r => new { r.Name, r.Match, r.Category, r.CreatedAt })
            .ToListAsync(ct));

    private static async Task<IResult> AddAsync(
        AddReservedRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var name = PersonalAddress.Normalise(req.Name);
        // Reserved names may be shorter than a signup could pick ("sbi"), so
        // only the character set is checked, not the length rule.
        if (name.Length is < 2 or > 64 || !name.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '.' or '-' or '_'))
            return Results.BadRequest(new { error = "Use 2 to 64 lowercase letters, numbers, dots, hyphens or underscores." });
        var match = req.Match ?? "exact";
        var category = req.Category ?? "other";
        if (!Matches.Contains(match)) return Results.BadRequest(new { error = "Match is 'exact' or 'contains'." });
        if (!Categories.Contains(category)) return Results.BadRequest(new { error = "Unknown category." });

        var row = await db.ReservedUsernames.FirstOrDefaultAsync(r => r.Name == name, ct);
        if (row is null)
        {
            db.ReservedUsernames.Add(new ReservedUsername
            {
                Name = name, Match = match, Category = category, CreatedBy = tenant.UserId,
            });
        }
        else
        {
            row.Match = match;
            row.Category = category;
            row.RemovedAt = null;
            row.RemovedBy = null;
        }
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.reserved_name_added", "reserved_username", name,
            after: new { name, match, category }, ct: ct);
        return Results.Ok(new { name, match, category });
    }

    private static async Task<IResult> RemoveAsync(
        string name, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var key = PersonalAddress.Normalise(name);
        var row = await db.ReservedUsernames.FirstOrDefaultAsync(r => r.Name == key && r.RemovedAt == null, ct);
        if (row is null) return Results.NotFound();
        row.RemovedAt = DateTimeOffset.UtcNow;
        row.RemovedBy = tenant.UserId;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("personal.reserved_name_removed", "reserved_username", key,
            before: new { row.Name, row.Match, row.Category }, ct: ct);
        return Results.NoContent();
    }
}

public sealed record AddReservedRequest(string? Name, string? Match, string? Category);
