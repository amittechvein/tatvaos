using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Npgsql;
using OpenIddict.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Auth.Oidc;

// ============================================================================
//  Option (b) of decision 0004: OpenIddict's stores, with the two lookups
//  that run before a tenant is known routed through SECURITY DEFINER
//  resolvers. Everything else these stores do is the stock EF Core store
//  under row-level security.
//
//  THE RULE, and the reason a wrong version of this file would be a
//  cross-tenant hole: a resolver is consulted ONLY when no tenant is set on
//  the request. When one IS set — a signed-in person at the authorize
//  endpoint — the lookup runs under that person's RLS and an application
//  belonging to another organisation simply is not found. If the resolver
//  were allowed to switch the tenant on a request that already had one, a
//  person from tenant B could be moved into tenant A's context by naming
//  tenant A's client id. Test 7 of 0004 exists for that, and the check is
//  `tenant.HasTenant` below, in both stores.
// ============================================================================

public sealed class TenantSafeApplicationStore(
    IMemoryCache cache, IOpenIddictEntityFrameworkCoreContext context,
    IOptionsMonitor<OpenIddictEntityFrameworkCoreOptions> options,
    AppDbContext db, TenantContext tenant)
    : OpenIddictEntityFrameworkCoreApplicationStore<OidcApplication, OidcAuthorization, OidcToken, Guid>(cache, context, options)
{
    private readonly AppDbContext _db = db;
    private readonly TenantContext _tenant = tenant;

    /// <summary>
    /// Client by id. Anonymous callers (the token endpoint, and authorize
    /// before sign-in) reach this with no tenant: the resolver names the
    /// organisation, the request enters that tenant's scope, and the row is
    /// then read under RLS like any other. A revoked application is answered
    /// as "no such client" from the revoking commit onward.
    /// </summary>
    public override async ValueTask<OidcApplication?> FindByClientIdAsync(string identifier, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(identifier)) return null;

        if (!_tenant.HasTenant)
        {
            var hit = await ResolveClientAsync(identifier, cancellationToken);
            if (hit is null || hit.Value.Revoked) return null;
            _tenant.EnterAnonymousScope(hit.Value.TenantId, "oidc_client");
            await _db.SyncTenantAsync(cancellationToken);
        }

        var app = await base.FindByClientIdAsync(identifier, cancellationToken);
        // The signed-in path never consulted the resolver, so the liveness
        // check happens here for both paths — one implementation.
        return app is null || app.RevokedAt is not null ? null : app;
    }

    private async Task<(Guid TenantId, bool Revoked)?> ResolveClientAsync(string clientId, CancellationToken ct)
    {
        var conn = _db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = _db.Database.CurrentTransaction?.GetDbTransaction();
        cmd.CommandText = "SELECT tenant_id, was_revoked FROM core.resolve_oidc_client(@client_id)";
        var p = cmd.CreateParameter(); p.ParameterName = "@client_id"; p.Value = clientId; cmd.Parameters.Add(p);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return (r.GetGuid(0), r.GetBoolean(1));
    }
}

public sealed class TenantSafeTokenStore(
    IMemoryCache cache, IOpenIddictEntityFrameworkCoreContext context,
    IOptionsMonitor<OpenIddictEntityFrameworkCoreOptions> options,
    AppDbContext db, TenantContext tenant)
    : OpenIddictEntityFrameworkCoreTokenStore<OidcToken, OidcApplication, OidcAuthorization, Guid>(cache, context, options)
{
    private readonly AppDbContext _db = db;
    private readonly TenantContext _tenant = tenant;

    /// <summary>
    /// Token by reference — the hash OpenIddict stored for an opaque access
    /// or refresh token. Userinfo, introspection and revocation arrive with
    /// no tenant: the resolver names it from the hash, the request enters
    /// that scope, and the row is read under RLS. Same HasTenant rule as the
    /// application store, for the same reason.
    /// </summary>
    public override async ValueTask<OidcToken?> FindByReferenceIdAsync(string identifier, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(identifier)) return null;

        if (!_tenant.HasTenant)
        {
            var tenantId = await ResolveTokenTenantAsync(identifier, cancellationToken);
            if (tenantId is null) return null;
            _tenant.EnterAnonymousScope(tenantId.Value, "oidc_token");
            await _db.SyncTenantAsync(cancellationToken);
        }

        return await base.FindByReferenceIdAsync(identifier, cancellationToken);
    }

    private async Task<Guid?> ResolveTokenTenantAsync(string referenceId, CancellationToken ct)
    {
        var conn = _db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.Transaction = _db.Database.CurrentTransaction?.GetDbTransaction();
        cmd.CommandText = "SELECT tenant_id FROM core.resolve_oidc_token(@reference_id)";
        var p = cmd.CreateParameter(); p.ParameterName = "@reference_id"; p.Value = referenceId; cmd.Parameters.Add(p);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is Guid g ? g : null;
    }
}
