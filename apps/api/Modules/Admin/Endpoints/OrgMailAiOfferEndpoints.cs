using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// The operator's "offer Mail AI to this organisation" action (30 Sept 2026).
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS IS AN ACTION AND NOT A SETTING EDIT
///
///  Organisation 5 turned Mail AI on on 25 Sept, under a disclosure the
///  privacy page did not yet match, and sent five requests before the
///  Techvein-only gate (ai.mail.organisations) shipped. The gate HIDES their
///  switch; it does not reset it. Production, 30 Sept: allow_mail_ai = true,
///  suggestions on. So typing their id into the list on the Settings page
///  would have resumed Mail AI at once, on the consent they gave to the OLD
///  words. Found while writing the switch-on for Mr. Singh.
///
///  So offering Mail AI and resetting the organisation's own Mail AI switches
///  are ONE act, in ONE transaction: the organisation goes on the list with
///  Mail AI off, sorting off and every feature at today's default, and its
///  administrator must agree again, under the text that is live now.
///
///  Mr. Singh, 30 Sept: through the console, not raw SQL, because an audit
///  row inserted by hand names nobody (PR 355's actor rule). This one is
///  written by AuditWriter as the operator who pressed the button.
///
///  THE LIST YOU SAW. The request carries the list the console showed
///  (expectedList) and is refused if the stored value is different — the
///  generalised form of the "is it still Techvein-only?" guard he asked to
///  keep. Two operators, or an operator and the Settings page, cannot
///  overwrite each other's change without seeing it.
///
///  The list's own value is NOT written into the audit row: that row lands in
///  the CUSTOMER's audit trail, and the list holds other organisations' ids.
///  The row says whether this organisation was on it and how many entries it
///  had, before and after.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class OrgMailAiOfferEndpoints
{
    public static void MapOrgMailAiOfferEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/organisations/{id:guid}/mail-ai", GetAsync)
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        app.MapPost("/api/admin/organisations/{id:guid}/mail-ai/offer", OfferAsync)
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
    }

    /// <summary>expectedList: the ai.mail.organisations value the console showed ("" when there was none).</summary>
    public sealed record OfferRequest(string? ExpectedList);

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, CancellationToken ct)
    {
        var org = await db.Tenants.AsNoTracking().Where(t => t.Id == id)
            .Select(t => new { t.AllowAi, t.AllowMailAi, t.MailAiTriageSince, t.MailAiRewrite, t.MailAiSuggest, t.MailAiSummary })
            .FirstOrDefaultAsync(ct);
        if (org is null) return Results.NotFound();
        var list = await new SettingsReader(db).GetAsync(SettingKeys.AiMailOrganisations, ct) ?? "";
        return Results.Ok(new
        {
            // The raw value, for the operator only: it is what they must send
            // back as expectedList.
            list,
            onList = MailAiOrganisationList.Allows(list, id),
            everyone = IsEveryone(list),
            allowAi = org.AllowAi,
            allowMailAi = org.AllowMailAi,
            sorting = org.MailAiTriageSince != null,
            features = new { rewrite = org.MailAiRewrite, suggest = org.MailAiSuggest, summary = org.MailAiSummary },
        });
    }

    private static async Task<IResult> OfferAsync(
        Guid id, OfferRequest req, AppDbContext db, TenantContext tenant, HttpContext http,
        AuditWriter audit, CancellationToken ct)
    {
        if (req?.ExpectedList is null)
            return Results.BadRequest(new { error = "Send the list you were shown (expectedList), even if it is empty." });

        var actor = SignedIn.UserIdOrEmpty(http);
        tenant.EnterPlatformScope(id, actor);
        await db.SyncTenantAsync(ct);

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // Locked for the rest of the transaction: the check below and the
        // write after it see the same value.
        var setting = await db.PlatformSettings
            .FromSqlRaw("SELECT * FROM core.platform_settings WHERE key = {0} FOR UPDATE", SettingKeys.AiMailOrganisations)
            .FirstOrDefaultAsync(ct);
        var current = setting?.Value ?? "";

        if (current.Trim() != req.ExpectedList.Trim())
            return Results.Conflict(new
            {
                error = "The Mail AI list has changed since this page loaded. Reload and check it before offering.",
            });
        if (IsEveryone(current))
            return Results.Conflict(new { error = "Mail AI is already offered to every organisation (the list is \"all\")." });
        if (MailAiOrganisationList.Parse(current).Contains(id))
            return Results.Conflict(new { error = "This organisation is already on the Mail AI list." });

        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var before = new
        {
            onList = false,
            listEntries = MailAiOrganisationList.Parse(current).Count,
            allowMailAi = org.AllowMailAi,
            sorting = org.MailAiTriageSince != null,
            features = new { rewrite = org.MailAiRewrite, suggest = org.MailAiSuggest, summary = org.MailAiSummary },
        };

        // 1. On the list. Appended to what is there, so nothing the Settings
        //    page wrote is rewritten or reordered.
        var next = current.Trim().Length == 0 ? id.ToString() : $"{current.Trim()},{id}";
        if (setting is null)
            db.PlatformSettings.Add(new PlatformSetting
            {
                Key = SettingKeys.AiMailOrganisations, Value = next, IsSecret = false, UpdatedBy = actor,
            });
        else
        {
            setting.Value = next;
            setting.UpdatedAt = DateTimeOffset.UtcNow;
            setting.UpdatedBy = actor;
        }

        // 2. Its own Mail AI back to the start: off, sorting off, features at
        //    the defaults an organisation turning Mail AI on for the first
        //    time would get. The administrator agrees again, to today's text.
        var hadSorting = org.MailAiTriageSince != null;
        org.AllowMailAi = false;
        org.MailAiTriageSince = null;
        org.MailAiRewrite = AiProductSwitch.DefaultRewrite;
        org.MailAiSuggest = AiProductSwitch.DefaultSuggest;
        org.MailAiSummary = AiProductSwitch.DefaultSummary;
        await db.SaveChangesAsync(ct);

        // Sorting off wipes the labels it made, as the organisation's own
        // switch does (OrgAiEndpoints.PutAsync). Platform scope has set this
        // organisation as the tenant, so the filter holds it to their mail.
        var cleared = 0;
        if (hadSorting)
            cleared = await db.Messages
                .Where(m => m.AiLabelledAt != null)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(m => m.AiLabel, (string?)null)
                    .SetProperty(m => m.AiLabelledAt, (DateTimeOffset?)null), ct);

        // 3. The record, as the operator (AuditWriter refuses Guid.Empty for
        //    a signed-in operator), inside the same transaction: if it cannot
        //    be written, nothing above happened either.
        var after = new
        {
            onList = true,
            listEntries = before.listEntries + 1,
            // Read back from the row, not written as the intended values: a
            // line that says "off" must mean the row says off (the test's
            // calibration run, with the reset removed, is how this was found).
            allowMailAi = org.AllowMailAi,
            sorting = org.MailAiTriageSince != null,
            labelsCleared = cleared,
            features = new { rewrite = org.MailAiRewrite, suggest = org.MailAiSuggest, summary = org.MailAiSummary },
        };
        await audit.WriteAsync("org.ai.mail.offered", "core.tenant", id.ToString(),
            before: before, after: after, ct: ct, productCode: "mail");

        await tx.CommitAsync(ct);
        return Results.Ok(after);
    }

    private static bool IsEveryone(string raw) =>
        string.Equals(raw.Trim(), MailAiOrganisationList.Everyone, StringComparison.OrdinalIgnoreCase);
}
