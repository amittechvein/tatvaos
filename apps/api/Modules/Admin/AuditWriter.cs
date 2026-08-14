using System.Text.Json;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin;

/// <summary>
/// Writes the audit trail.
///
/// Every administrative action is recorded, including who did it and from
/// where. This matters most for platform-admin actions against a customer's
/// organisation: an operator suspending a tenant or resetting a password must
/// leave a trace the customer can later be shown.
///
/// The table is append-only by design. An audit log an administrator can edit
/// is not an audit log.
/// </summary>
public sealed class AuditWriter(AppDbContext db, TenantContext tenant, IHttpContextAccessor http)
{
    /// <param name="productCode">
    /// Which product the action belongs to — a code from core.products, e.g.
    /// "mail" or "drive". Null for Core's own administration, which is most of
    /// what writes here today.
    ///
    /// The column has existed since the first schema and was never populated:
    /// every row written so far carries null. That was harmless while Core was
    /// the only writer, and stops being harmless the moment a second product
    /// logs here — the audit viewer cannot filter by something nobody sets.
    /// Space is the first caller that needs it.
    /// </param>
    public async Task WriteAsync(
        string action,
        string? targetType = null,
        string? targetId = null,
        object? before = null,
        object? after = null,
        CancellationToken ct = default,
        string? productCode = null)
    {
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ProductCode = productCode,
            ActorUserId = tenant.UserId,
            ActorIp = http.HttpContext?.Connection.RemoteIpAddress?.ToString(),
            Action = tenant.IsPlatformScope ? $"platform:{action}" : action,
            TargetType = targetType,
            TargetId = targetId,
            BeforeState = before is null ? null : JsonSerializer.Serialize(before),
            AfterState = after is null ? null : JsonSerializer.Serialize(after),
        });

        await db.SaveChangesAsync(ct);
    }
}
