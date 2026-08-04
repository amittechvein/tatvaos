namespace TatvaOS.Api.Shared.Tenancy;

/// <summary>
/// The tenant this request operates on.
///
/// ─────────────────────────────────────────────────────────────────────────
///  EVERY database query in the application is scoped by this value.
///
///  It is populated once, from the authenticated principal, and is never read
///  from a header, query string or request body. A client-supplied tenant id
///  is a cross-tenant read waiting to happen.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Scoped per request. Registered in DI so nothing can construct a DbContext
/// without one — see <c>AppDbContext</c>.
/// </summary>
public sealed class TenantContext
{
    private Guid? _tenantId;
    private bool _isPlatformScope;

    /// <summary>
    /// The current tenant. Throws rather than returning a default.
    ///
    /// Returning <c>Guid.Empty</c> here would silently produce queries that
    /// match nothing — or worse, match a row that happens to have an empty id.
    /// Failing loudly is the only safe behaviour.
    /// </summary>
    public Guid TenantId =>
        _tenantId ?? throw new InvalidOperationException(
            "Tenant context was not resolved. Every authenticated request must set it before " +
            "touching the database. If this fired on a platform-admin route, use " +
            "EnterPlatformScope() explicitly.");

    public bool HasTenant => _tenantId.HasValue;

    /// <summary>
    /// True when acting across tenants — platform administration only.
    ///
    /// This deliberately does NOT disable row-level security. It sets the
    /// tenant per operation instead, so a platform admin listing organisations
    /// still reads one tenant at a time. There is no "see everything" mode,
    /// because a bug in one would be unbounded.
    /// </summary>
    public bool IsPlatformScope => _isPlatformScope;

    public Guid? UserId { get; private set; }
    public string? Role { get; private set; }

    public void Set(Guid tenantId, Guid userId, string role)
    {
        _tenantId = tenantId;
        UserId = userId;
        Role = role;
        _isPlatformScope = false;
    }

    /// <summary>
    /// Enter platform scope for a single tenant.
    ///
    /// Used by super-admin endpoints that legitimately act on an organisation
    /// they do not belong to. Every call is audited by the caller — see
    /// <c>AuditLog</c>. Switching tenants mid-request is allowed and expected
    /// when iterating organisations; switching without auditing is not.
    /// </summary>
    public void EnterPlatformScope(Guid tenantId, Guid actingUserId)
    {
        _tenantId = tenantId;
        UserId = actingUserId;
        Role = "super_admin";
        _isPlatformScope = true;
    }
}
