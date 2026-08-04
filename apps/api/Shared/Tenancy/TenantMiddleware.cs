using System.Security.Claims;

namespace TatvaOS.Api.Shared.Tenancy;

/// <summary>
/// Populates TenantContext from the authenticated principal.
///
/// The tenant comes from a signed JWT claim and from nowhere else. Not a
/// header, not a query parameter, not a request body — a client-supplied
/// tenant id is a cross-tenant read waiting to happen.
///
/// Unauthenticated requests leave the context empty. Because RLS fails closed,
/// any query that somehow reaches the database returns nothing rather than
/// everything.
/// </summary>
public sealed class TenantMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, TenantContext tenant)
    {
        var user = context.User;

        if (user.Identity?.IsAuthenticated == true)
        {
            var tenantClaim = user.FindFirst("tenant_id")?.Value;
            var subClaim = user.FindFirst(ClaimTypes.NameIdentifier)?.Value
                           ?? user.FindFirst("sub")?.Value;
            var role = user.FindFirst(ClaimTypes.Role)?.Value ?? "employee";

            if (Guid.TryParse(tenantClaim, out var tenantId) &&
                Guid.TryParse(subClaim, out var userId))
            {
                tenant.Set(tenantId, userId, role);
            }
            else if (role != "super_admin")
            {
                // Authenticated but with no usable tenant. Refuse rather than
                // continue with an empty context and let RLS silently return
                // nothing — a 401 is far easier to diagnose than an
                // inexplicably empty inbox.
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new
                {
                    error = "Token carries no valid tenant claim.",
                });
                return;
            }
        }

        await next(context);
    }
}
