using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Turning an organisation API key into a tenant, once, for every endpoint on
/// the organisation API.
///
/// EXTRACTED FROM OrgApiEndpoints.AdmitAsync when the meetings endpoints were
/// added (18 September 2026). It was forty lines inline, and the second
/// endpoint would have copied them. The parts that must not drift are the
/// reason:
///
///   * a revoked key and an unknown key get the SAME answer, because telling
///     a caller that their key once existed tells an attacker their guess was
///     close. Two copies of that rule is one copy that eventually says
///     "revoked";
///   * the raw connection is opened and CLOSED again around the resolver, so
///     that EF afterwards opens its own through TenantConnectionInterceptor
///     and actually gets app.tenant_id set. A copy that forgot the close would
///     return zero rows for the whole request, for reasons nothing would
///     explain;
///   * the scope is checked explicitly against what the key carries, and an
///     empty scope list can do nothing.
///
/// The SECURITY DEFINER resolver breaks the circle every credential here has:
/// row-level security needs a tenant, and the tenant is not known until the
/// key is found. Same shape as mail.resolve_api_key and
/// core.resolve_refresh_token.
/// </summary>
public static class OrgApiAuth
{
    /// <summary>A key that was accepted, and what it is allowed to do.</summary>
    public sealed record Caller(Guid KeyId, Guid TenantId, string[] Scopes);

    /// <summary>
    /// Either a Caller, or the IResult to return to a caller who does not get
    /// one. Never both, and never an exception: every refusal on this surface
    /// is a deliberate sentence.
    /// </summary>
    public sealed record Outcome(Caller? Caller, IResult? Refusal)
    {
        public static Outcome Ok(Caller c) => new(c, null);
        public static Outcome No(IResult r) => new(null, r);
    }

    /// <summary>
    /// Resolve the bearer key, check it carries <paramref name="requiredScope"/>,
    /// and enter that organisation's tenant scope. On success every read and
    /// write afterwards is ordinary row-level security, exactly as it would be
    /// for a signed-in request — except that the actor is a key, so UserId
    /// stays null and audit rows say so.
    /// </summary>
    public static async Task<Outcome> AuthenticateAsync(
        HttpContext http, AppDbContext db, TenantContext tenant,
        string requiredScope, string scopeRefusal, CancellationToken ct)
    {
        var header = http.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
            return Outcome.No(Unauthorized(
                "Provide your organisation API key as: Authorization: Bearer tvk_..."));

        var hash = OrgApiKeyEndpoints.Sha256(header["Bearer ".Length..].Trim());

        Guid keyId, keyTenantId;
        bool wasRevoked;
        string[] scopes;
        {
            var conn = db.Database.GetDbConnection();
            // Opening the raw connection bypasses TenantConnectionInterceptor,
            // which sets app.tenant_id only when IT opens one. Leaving this
            // open would mean every query afterwards runs on a connection that
            // never got a tenant — zero rows, all request long. So it is
            // closed again immediately and EF opens its own through the
            // interceptor once the scope is set.
            var openedHere = conn.State != System.Data.ConnectionState.Open;
            if (openedHere) await conn.OpenAsync(ct);
            try
            {
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT key_id, tenant_id, was_revoked, scopes FROM core.resolve_api_key(@hash)";
                var p = cmd.CreateParameter(); p.ParameterName = "@hash"; p.Value = hash; cmd.Parameters.Add(p);
                await using var reader = await cmd.ExecuteReaderAsync(ct);

                // Revoked and unknown answer identically, on purpose.
                if (!await reader.ReadAsync(ct)) return Outcome.No(Unauthorized("That API key is not valid."));
                keyId = reader.GetGuid(0);
                keyTenantId = reader.GetGuid(1);
                wasRevoked = reader.GetBoolean(2);
                scopes = reader.IsDBNull(3) ? [] : reader.GetFieldValue<string[]>(3);
            }
            finally
            {
                if (openedHere) await conn.CloseAsync();
            }
        }
        if (wasRevoked) return Outcome.No(Unauthorized("That API key is not valid."));

        if (!scopes.Contains(requiredScope))
            return Outcome.No(Results.Json(new { error = scopeRefusal }, statusCode: 403));

        tenant.EnterAnonymousScope(keyTenantId, "org_api");
        await db.SyncTenantAsync(ct);
        await StampLastUsedAsync(db, keyId, ct);

        return Outcome.Ok(new Caller(keyId, keyTenantId, scopes));
    }

    /// <summary>
    /// At most once an hour per key, for the same reason the OIDC
    /// applications column is: it is a write on every call otherwise. Its
    /// failure can never fail the caller's request — it is bookkeeping about
    /// the key, not part of the work the caller asked for.
    /// </summary>
    private static async Task StampLastUsedAsync(AppDbContext db, Guid keyId, CancellationToken ct)
    {
        try
        {
            var cutoff = DateTimeOffset.UtcNow.AddHours(-1);
            await db.OrgApiKeys
                .Where(k => k.Id == keyId && (k.LastUsedAt == null || k.LastUsedAt < cutoff))
                .ExecuteUpdateAsync(s => s.SetProperty(k => k.LastUsedAt, DateTimeOffset.UtcNow), ct);
        }
        catch { /* see the summary */ }
    }

    /// <summary>The last X-Forwarded-For entry, the one Caddy wrote — the same
    /// rule every limiter and audit line here uses. Never the first: that one
    /// is whatever the client chose to claim.</summary>
    public static string ClientAddress(HttpContext http)
    {
        var xff = http.Request.Headers["X-Forwarded-For"].ToString();
        return string.IsNullOrEmpty(xff)
            ? http.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
    }

    public static IResult Unauthorized(string message) =>
        Results.Json(new { error = message }, statusCode: 401);
}
