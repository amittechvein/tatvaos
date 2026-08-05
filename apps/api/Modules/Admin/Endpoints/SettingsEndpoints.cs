using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Platform settings — SMS provider, SSO, payment keys, mail identity.
///
/// Super admin only. The one hard rule here: a secret, once written, is never
/// returned. GET says whether it is set; PUT with an empty value leaves it
/// alone. That asymmetry is what lets an administrator rotate a password
/// without the old one ever transiting the browser again.
/// </summary>
public static class SettingsEndpoints
{
    public static void MapSettingsEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/settings")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");

        g.MapGet("/", ListAsync);
        g.MapPut("/", SaveAsync);
        g.MapPost("/test-sms", TestSmsAsync);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ListAsync(AppDbContext db, CancellationToken ct)
    {
        var stored = await db.PlatformSettings.AsNoTracking()
            .ToDictionaryAsync(s => s.Key, s => s, ct);

        // The registry drives the response, not the table — so a key that has
        // never been saved still appears, and one nobody knows about does not.
        var items = SettingKeys.All.Select(d =>
        {
            stored.TryGetValue(d.Key, out var row);
            return new
            {
                d.Key, d.Section, d.Label, d.Help,
                isSecret = d.Secret,
                hasValue = row is not null && row.Value.Length > 0,
                value = d.Secret ? null : row?.Value,
                updatedAt = row?.UpdatedAt,
            };
        });

        return Results.Ok(items);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> SaveAsync(
        Dictionary<string, string> body, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var changed = new List<string>();

        foreach (var (key, raw) in body)
        {
            if (!SettingKeys.IsKnown(key))
                return Results.BadRequest(new { error = $"Unknown setting: {key}" });

            var secret = SettingKeys.IsSecret(key);
            var value = raw?.Trim() ?? "";

            // Empty secret = keep. The form always submits every field, and a
            // blank password box means "unchanged", not "erase the credential".
            if (secret && value.Length == 0) continue;

            var row = await db.PlatformSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
            if (row is null)
            {
                db.PlatformSettings.Add(new PlatformSetting
                {
                    Key = key, Value = value, IsSecret = secret, UpdatedBy = tenant.UserId,
                });
                changed.Add(key);
            }
            else if (row.Value != value)
            {
                row.Value = value;
                row.UpdatedAt = DateTimeOffset.UtcNow;
                row.UpdatedBy = tenant.UserId;
                changed.Add(key);
            }
        }

        await db.SaveChangesAsync(ct);

        if (changed.Count > 0)
        {
            // Keys only, never values — an audit row is the last place a
            // credential should end up.
            await audit.WriteAsync("settings.changed", "settings", null,
                after: new { keys = changed }, ct: ct);
        }

        return Results.Ok(new { saved = changed.Count, keys = changed });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Sends a real OTP-shaped SMS to a number the admin types. The response
    /// carries the provider's own error verbatim — wrong sender ID, template
    /// mismatch and out-of-credit each look identical from the outside, and
    /// naming which is the entire value of a test button.
    /// </summary>
    private static async Task<IResult> TestSmsAsync(
        TestSmsRequest req, ISmsSender sms, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Phone))
            return Results.BadRequest(new { error = "A phone number is required." });

        var result = await sms.SendOtpAsync(req.Phone.Trim(), "123456", ct);

        return Results.Ok(new
        {
            sent = result.Sent,
            provider = result.Provider,
            detail = result.Detail ?? (result.Sent
                ? "Sent. The message uses the DLT template with code 123456."
                : null),
        });
    }
}

public sealed record TestSmsRequest(string? Phone);
