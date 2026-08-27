using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Core.Endpoints;

/// <summary>
/// The organisation's AI consent switch — the screen for core.tenants.allow_ai.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Until this existed the switch was a one-line UPDATE run by Techvein,
///  which is fine for Techvein and disqualifying in a sales call: "can we
///  turn it off ourselves?" must be answered with a screen, not a promise
///  that somebody else will run SQL.
///
///  ORG-ADMIN, not per-user, deliberately: consent to send an organisation's
///  content to an external AI provider is the organisation's decision, made
///  once by someone with the authority to make it — the same governance
///  shape as allow_public_links and allow_connect_recording.
///
///  The GET also reports whether the PLATFORM has AI at all (a key
///  configured), so the screen can say "AI is not available on this
///  platform" instead of showing a switch that flips nothing.
///
///  Every change is audited with who and when. For a hospital, "who agreed,
///  and when" is not metadata — it is the answer to the only question their
///  compliance officer will ask.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class OrgAiEndpoints
{
    public static void MapOrgAiEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/ai")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Org");

        g.MapGet("", GetAsync);
        g.MapPut("", PutAsync);
    }

    public sealed record PutRequest(bool? Enabled);

    private static async Task<IResult> GetAsync(
        AppDbContext db, TenantContext tenant, IAiGateway ai, CancellationToken ct)
    {
        var row = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == tenant.TenantId)
            .Select(t => new { t.AllowAi })
            .FirstOrDefaultAsync(ct);
        if (row is null) return Results.NotFound();

        return Results.Ok(new
        {
            enabled = row.AllowAi,
            // Whether the platform can do AI at all. Without a key the switch
            // is honest about being decorative.
            platformConfigured = ai.IsConfigured,
            model = ai.IsConfigured ? ai.Model : null,
            // Where the data goes when enabled — said HERE, by the API, so the
            // consent screen can never soften it. Update when the provider
            // moves to Azure India; that is the point of it being a string.
            disclosure = "When enabled, meeting transcripts and (in future) mail "
                       + "content from this organisation are sent to OpenAI in the "
                       + "United States to be processed. Nothing is sent while this "
                       + "is off.",
        });
    }

    private static async Task<IResult> PutAsync(
        PutRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (req?.Enabled is not bool enabled)
            return Results.BadRequest(new { error = "Say on or off." });

        var row = await db.Tenants
            .FirstOrDefaultAsync(t => t.Id == tenant.TenantId, ct);
        if (row is null) return Results.NotFound();

        if (row.AllowAi == enabled)
            return Results.Ok(new { enabled });   // idempotent, no audit noise

        var before = row.AllowAi;
        row.AllowAi = enabled;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("org.ai." + (enabled ? "enabled" : "disabled"),
            "core.tenant", row.Id.ToString(),
            before: new { allowAi = before }, after: new { allowAi = enabled },
            ct: ct, productCode: "core");

        return Results.Ok(new { enabled });
    }
}
