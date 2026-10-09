using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.People;

/// <summary>
/// How an organisation numbers its employees (people.employee_id_settings,
/// 20261008-people-employee-ids.sql). A scheme, not a number: no row is
/// about a person, which is why it can exist before people.employees does.
/// </summary>
public sealed class EmployeeIdSettings
{
    public Guid TenantId { get; set; }
    /// <summary>"auto" — TatvaOS gives the next number; "manual" — typed by an administrator.</summary>
    public string Mode { get; set; } = "auto";
    /// <summary>Upper-case letters, digits, '-' and '/', up to 10. May be empty.</summary>
    public string Prefix { get; set; } = "";
    /// <summary>The shortest the number is written, zero-padded. A minimum, never a cut.</summary>
    public int Digits { get; set; } = 4;
    public int NextNumber { get; set; } = 1;
    public Guid? UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// GET/PUT /api/org/employee-ids — Phase 0 of People (8 Oct 2026).
///
/// ─────────────────────────────────────────────────────────────────────────
///  ADMINS ONLY, like locations and designations: it is organisation set-up.
///
///  NO SCREEN YET, ON PURPOSE. People is not available to any customer and
///  there are no employees to number. A page called "Employee IDs" in the
///  console today would promise something that does not exist (handover
///  §5.2). The page arrives with people.employees.
///
///  THE PREVIEW IS THE DATABASE'S. "Next ID: TV-0001" comes from
///  people.format_employee_id(), the function the allocator will use, so
///  what an administrator is shown is what an employee will get.
///
///  NOT SAVED UNTIL SAVED. GET with no row answers the defaults with
///  saved = false; nothing is written by looking.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class EmployeeIdEndpoints
{
    public const int MinDigits = 1, MaxDigits = 8, MaxNumber = 99_999_999, MaxPrefix = 10;

    public static void MapEmployeeIdEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/employee-ids")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");
        g.MapGet("/", GetAsync);
        g.MapPut("/", PutAsync);
    }

    public sealed record SaveEmployeeIdsRequest(string? Mode, string? Prefix, int? Digits, int? NextNumber);

    private static async Task<IResult> GetAsync(AppDbContext db, CancellationToken ct)
    {
        var row = await db.Set<EmployeeIdSettings>().AsNoTracking().FirstOrDefaultAsync(ct);
        var s = row ?? new EmployeeIdSettings();
        return Results.Ok(await ShapeAsync(db, s, saved: row is not null, ct));
    }

    private static async Task<IResult> PutAsync(
        SaveEmployeeIdsRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var mode = (req.Mode ?? "auto").Trim().ToLowerInvariant();
        if (mode is not ("auto" or "manual"))
            return Results.BadRequest(new { error = "Mode must be auto or manual." });

        var prefix = (req.Prefix ?? "").Trim().ToUpperInvariant();
        if (prefix.Length > MaxPrefix)
            return Results.BadRequest(new { error = $"The prefix can be at most {MaxPrefix} characters." });
        if (!prefix.All(ch => ch is (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '-' or '/'))
            return Results.BadRequest(new { error = "The prefix can use only letters, digits, '-' and '/'." });

        var digits = req.Digits ?? 4;
        if (digits is < MinDigits or > MaxDigits)
            return Results.BadRequest(new { error = $"Digits must be between {MinDigits} and {MaxDigits}." });

        var next = req.NextNumber ?? 1;
        if (next is < 1 or > MaxNumber)
            return Results.BadRequest(new { error = $"The next number must be between 1 and {MaxNumber:N0}." });

        var row = await db.Set<EmployeeIdSettings>().FirstOrDefaultAsync(ct);
        var before = row is null ? null : new { row.Mode, row.Prefix, row.Digits, row.NextNumber };
        if (row is null)
        {
            row = new EmployeeIdSettings { TenantId = tenant.TenantId };
            db.Set<EmployeeIdSettings>().Add(row);
        }
        row.Mode = mode;
        row.Prefix = prefix;
        row.Digits = digits;
        row.NextNumber = next;
        row.UpdatedBy = tenant.UserId;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("employee_ids.updated", "employee_id_settings", tenant.TenantId.ToString(),
            before: before, after: new { row.Mode, row.Prefix, row.Digits, row.NextNumber },
            ct: ct, productCode: "people");

        return Results.Ok(await ShapeAsync(db, row, saved: true, ct));
    }

    private static async Task<object> ShapeAsync(AppDbContext db, EmployeeIdSettings s, bool saved, CancellationToken ct)
    {
        var preview = await db.Database
            .SqlQuery<string>($"""SELECT people.format_employee_id({s.Prefix}, {s.Digits}, {s.NextNumber}) AS "Value" """)
            .SingleAsync(ct);
        return new
        {
            s.Mode, s.Prefix, s.Digits, s.NextNumber,
            // In manual mode nothing is generated, so there is no "next ID".
            nextId = s.Mode == "auto" ? preview : null,
            saved,
            minDigits = MinDigits, maxDigits = MaxDigits, maxPrefix = MaxPrefix,
        };
    }
}
