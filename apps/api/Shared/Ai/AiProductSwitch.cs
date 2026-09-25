using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// Per-product AI switches, on top of the organisation's consent.
///
/// ─────────────────────────────────────────────────────────────────────────
///  core.tenants.allow_ai says "this organisation's content may go to the AI
///  provider". It was enough while meeting minutes were the only caller.
///  Mail is the first product an organisation may want to keep out on its
///  own (Amit, 25 Sept 2026: "Mail ai on/off switch") — see
///  20260925-mail-ai-switch.sql for why.
///
///  Keyed by the FEATURE LABEL every request has carried since PR 280, and
///  checked in MeteredAiGateway beside the consent check, so a Mail feature
///  that forgets to ask is refused anyway. Fail-closed: if the switch cannot
///  be read, the answer is no.
///
///  A new product that wants its own switch adds a prefix and a column here;
///  products without one (connect.*, docs) are governed by allow_ai alone,
///  exactly as before.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AiProductSwitch
{
    public const string MailPrefix = "mail.";

    public const string MailOff =
        "TatvaOS AI is not switched on for Mail in this organisation. An administrator can turn it on "
        + "under TatvaOS AI.";

    /// <summary>Sorting incoming mail: needs Mail AI AND its own switch.</summary>
    public const string MailTriageFeature = "mail.triage";

    public const string MailTriageOff =
        "Sorting incoming mail with TatvaOS AI is not switched on for this organisation.";

    /// <summary>
    /// Whether the CURRENT tenant has sorting on (mail_ai_triage_since set).
    /// Fail-closed, like the Mail switch.
    /// </summary>
    public static async Task<bool> TriageAllowedAsync(
        AppDbContext db, TenantContext tenant, ILogger log, CancellationToken ct)
    {
        if (!tenant.HasTenant) return false;
        try
        {
            return await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId)
                .Select(t => t.MailAiTriageSince != null)
                .FirstOrDefaultAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Could not read the Mail AI sorting switch for tenant {Tenant} — refused fail-closed.",
                tenant.TenantId);
            return false;
        }
    }

    public static bool IsMail(string feature) =>
        feature.StartsWith(MailPrefix, StringComparison.Ordinal);

    /// <summary>
    /// Whether the CURRENT tenant has Mail AI on. Says nothing about allow_ai;
    /// the gateway checks that first, and the status endpoint checks both.
    /// </summary>
    public static async Task<bool> MailAllowedAsync(
        AppDbContext db, TenantContext tenant, ILogger log, CancellationToken ct)
    {
        if (!tenant.HasTenant) return false;
        try
        {
            return await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId)
                .Select(t => t.AllowMailAi)
                .FirstOrDefaultAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Could not read the Mail AI switch for tenant {Tenant} — refused fail-closed.",
                tenant.TenantId);
            return false;
        }
    }
}
