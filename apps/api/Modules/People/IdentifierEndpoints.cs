using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.People;

/// <summary>
/// Aadhaar, PAN and bank details (decision 0015; Amit's decisions 10 Oct 2026).
/// HELD FOR MR. SINGH - not to reach production until he rules and the lawyer
/// answers 0015 §10.6.
///
/// ─────────────────────────────────────────────────────────────────────────
///  MASKED BY DEFAULT. Lists show the kind, the last four and "verified".
///  People HR, the named readers and the employee see that; a manager never.
///
///  REVEAL = a reason + one read row per value (people.identifier_reads),
///  written in the same save as the decryption. Allowed to the people the
///  organisation names (people.identifier_readers - an owner only after
///  naming themselves, recorded) and to the employee for their own. The
///  response is Cache-Control: no-store. The employee can read who has seen
///  theirs.
///
///  NEVER ECHOED. No response, error message or audit row repeats a value or
///  its last four - not even a refused one ("that PAN is already on another
///  employee", not "ABCDE1234F is...").
///
///  FAILS CLOSED. Without People:IdentifierKey and People:IdentifierLookupKey
///  nothing is saved or revealed (503), and nothing falls back to another key.
///
///  NOT YET HERE (0015 §5, for Mr. Singh): asking for two-step verification
///  again before a reveal. It is the first step-up in TatvaOS - a sign-in
///  change - so it waits for his ruling rather than being guessed at.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class IdentifierEndpoints
{
    private const string Product = "people";

    public sealed record SetIdentifierRequest(string? Value, string? Ifsc);
    public sealed record RevealRequest(string? Reason, string? Note);

    public static void MapIdentifierEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/people").RequireAuthorization("User").WithTags("People");
        g.MapGet("/identifiers/status", (PeopleAccess access) => Results.Ok(new { configured = access.IdentifiersConfigured }));
        g.MapGet("/employees/{id:guid}/identifiers", ListAsync);
        g.MapPut("/employees/{id:guid}/identifiers/{kind}", SetAsync);
        g.MapPost("/employees/{id:guid}/identifiers/{kind}/verify", VerifyAsync);
        g.MapPost("/employees/{id:guid}/identifiers/{kind}/reveal", RevealAsync);
        g.MapGet("/employees/{id:guid}/identifier-reads", ReadsAsync);
        g.MapGet("/identifier-readers", ListReadersAsync);
        g.MapPut("/identifier-readers/{userId:guid}", AddReaderAsync);
        g.MapDelete("/identifier-readers/{userId:guid}", RemoveReaderAsync);
    }

    private static IResult Forbidden(string msg) => Results.Json(new { error = msg }, statusCode: StatusCodes.Status403Forbidden);
    private static IResult NotConfigured() => Results.Json(
        new { error = "Identity and bank details are not set up on this server yet." }, statusCode: StatusCodes.Status503ServiceUnavailable);

    private static async Task<IResult> ListAsync(Guid id, PeopleAccess access, CancellationToken ct)
    {
        if (!await access.CanSeeIdentifiersAsync(id, ct)) return Results.NotFound();
        var rows = await access.MaskedIdentifiersAsync(id, ct);
        return Results.Ok(new
        {
            configured = access.IdentifiersConfigured,
            canReveal = await access.CanRevealAsync(id, ct),
            canSet = await access.CanSetIdentifierAsync(id, ct),
            items = rows.Select(r => new { r.Kind, r.Last4, r.Ifsc, verified = r.VerifiedAt is not null, r.VerifiedAt, r.UpdatedAt }),
        });
    }

    private static async Task<IResult> SetAsync(
        Guid id, string kind, SetIdentifierRequest req, PeopleAccess access, AuditWriter audit, CancellationToken ct)
    {
        if (!IdentifierRules.Kinds.Contains(kind)) return Results.NotFound();
        if (!await access.CanSetIdentifierAsync(id, ct)) return Results.NotFound();
        if (!access.IdentifiersConfigured) return NotConfigured();
        var emp = await access.ForHrEditAsync(id, ct);
        if (emp is null) return Results.NotFound();
        if (emp.Status == "exited") return Results.Conflict(new { error = "This person has left. Their record is kept as it was." });

        var (value, last4, error) = IdentifierRules.Normalise(kind, req.Value);
        if (error is not null) return Results.BadRequest(new { error });
        string? ifsc = null;
        if (kind == "bank_account" && !string.IsNullOrWhiteSpace(req.Ifsc))
        {
            ifsc = req.Ifsc.Trim().ToUpperInvariant();
            if (!System.Text.RegularExpressions.Regex.IsMatch(ifsc, "^[A-Z]{4}0[A-Z0-9]{6}$"))
                return Results.BadRequest(new { error = "An IFSC is 11 characters, like HDFC0001234." });
        }
        try
        {
            await access.SaveIdentifierAsync(id, kind, value, last4, ifsc, ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "ux_people_identifiers_lookup" })
        {
            // Never which employee - that would reveal another person's number by inference.
            return Results.Conflict(new { error = kind == "pan"
                ? "That PAN is already on another employee's record here."
                : "That bank account is already on another employee's record here." });
        }
        await audit.WriteAsync("employee.identifier_set", "employee", id.ToString(), after: new { kind }, ct: ct, productCode: Product);
        return Results.Ok(new { kind, last4, verified = false });
    }

    private static async Task<IResult> VerifyAsync(Guid id, string kind, PeopleAccess access, AuditWriter audit, CancellationToken ct)
    {
        if (!await access.IsHrAsync(ct)) return Forbidden("Only People HR mark an original as seen.");
        if (!IdentifierRules.Kinds.Contains(kind) || !await access.MarkVerifiedAsync(id, kind, ct)) return Results.NotFound();
        await audit.WriteAsync("employee.identifier_verified", "employee", id.ToString(), after: new { kind }, ct: ct, productCode: Product);
        return Results.Ok(new { kind, verified = true });
    }

    private static async Task<IResult> RevealAsync(
        Guid id, string kind, RevealRequest req, PeopleAccess access, HttpContext http, CancellationToken ct)
    {
        if (!IdentifierRules.Kinds.Contains(kind)) return Results.NotFound();
        if (!await access.CanSeeIdentifiersAsync(id, ct)) return Results.NotFound();
        if (!await access.CanRevealAsync(id, ct))
            return Forbidden("Only the people your organisation names can reveal full identity and bank details.");
        if (!access.IdentifiersConfigured) return NotConfigured();
        if (req.Reason is null || !IdentifierRules.Reasons.Contains(req.Reason))
            return Results.BadRequest(new { error = "Choose why you need to see it." });
        var note = req.Note?.Trim();
        if (note is { Length: > 300 }) return Results.BadRequest(new { error = "The note can be at most 300 characters." });

        var (value, outcome) = await access.RevealAsync(id, kind, req.Reason, string.IsNullOrEmpty(note) ? null : note, ct);
        return outcome switch
        {
            "shown" => Results.Ok(new { kind, value }),
            "absent" => Results.NotFound(new { error = "Nothing is stored for this yet." }),
            _ => Results.Json(new { error = "This value could not be opened. It has been recorded, and an administrator has been alerted." },
                              statusCode: StatusCodes.Status500InternalServerError),
        };
    }

    /// <summary>Who has seen this person's identifiers. The person themselves, People HR and the named readers.</summary>
    private static async Task<IResult> ReadsAsync(Guid id, PeopleAccess access, AppDbContext db, CancellationToken ct)
    {
        if (!await access.CanSeeIdentifiersAsync(id, ct)) return Results.NotFound();
        var rows = await access.IdentifierReadsAsync(id, ct);
        var ids = rows.Select(r => r.ReaderId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return Results.Ok(rows.Select(r => new { r.Kind, reader = names.GetValueOrDefault(r.ReaderId), r.Reason, r.Note, r.Outcome, r.ReadAt }));
    }

    private static async Task<IResult> ListReadersAsync(PeopleAccess access, AppDbContext db, CancellationToken ct)
    {
        if (!access.CanNameHr() && !await access.IsHrAsync(ct)) return Forbidden("Only administrators and People HR can see who may reveal identifiers.");
        var rows = await access.IdentifierReadersAsync(ct);
        var ids = rows.Select(r => r.UserId).ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return Results.Ok(rows.Select(r => new { r.UserId, name = names.GetValueOrDefault(r.UserId), r.CreatedAt }));
    }

    /// <summary>Administrators name who may reveal - themselves included, recorded as such.</summary>
    private static async Task<IResult> AddReaderAsync(
        Guid userId, PeopleAccess access, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (!access.CanNameHr()) return Forbidden("Only an administrator can name who may reveal identifiers.");
        if (!await db.Users.AnyAsync(u => u.Id == userId && u.Status != "deleted", ct)) return Results.NotFound();
        if (!await access.AddIdentifierReaderAsync(userId, ct)) return Results.Ok(new { added = false });
        await audit.WriteAsync("identifier_reader.added", "user", userId.ToString(),
            after: new { appointedThemselves = userId == tenant.UserId }, ct: ct, productCode: Product);
        return Results.Ok(new { added = true });
    }

    private static async Task<IResult> RemoveReaderAsync(
        Guid userId, PeopleAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (!access.CanNameHr()) return Forbidden("Only an administrator can change who may reveal identifiers.");
        if (!await access.RemoveIdentifierReaderAsync(userId, ct)) return Results.NotFound();
        await audit.WriteAsync("identifier_reader.removed", "user", userId.ToString(),
            after: new { removedThemselves = userId == tenant.UserId }, ct: ct, productCode: Product);
        return Results.Ok(new { removed = true });
    }
}
