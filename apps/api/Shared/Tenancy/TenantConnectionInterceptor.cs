using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;

namespace TatvaOS.Api.Shared.Tenancy;

/// <summary>
/// Sets <c>app.tenant_id</c> on every database connection.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS CLASS IS THE MECHANISM BEHIND TENANT ISOLATION.
///
///  The RLS policies in the database read <c>current_setting('app.tenant_id')</c>.
///  If this interceptor does not run, that setting is absent, the policy
///  evaluates to NULL, and every query returns zero rows.
///
///  Failing closed is deliberate. A missing tenant context must produce an
///  empty result, never an unfiltered one.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Why a connection interceptor rather than <c>SET LOCAL</c> in a transaction:
/// most reads here are not inside an explicit transaction, and a plain
/// <c>SET</c> would persist on a pooled connection and leak into the next
/// request that borrowed it. Setting on open and resetting on close keeps the
/// value bound to the connection's period of use.
///
/// Npgsql also sends <c>DISCARD ALL</c> when returning a connection to the
/// pool, which clears the setting independently. Both mechanisms are kept —
/// pool reset behaviour is a configuration flag someone could change, and a
/// silent regression there would be a cross-tenant leak.
/// </summary>
public sealed class TenantConnectionInterceptor(TenantContext tenant) : DbConnectionInterceptor
{
    public override async Task ConnectionOpenedAsync(
        DbConnection connection,
        ConnectionEndEventData eventData,
        CancellationToken cancellationToken = default)
    {
        if (!tenant.HasTenant)
        {
            // No tenant resolved. Leave the setting absent so RLS denies
            // everything, rather than guessing a value.
            return;
        }

        await SetTenantAsync(connection, tenant.TenantId, tenant.UserId, cancellationToken);
    }

    /// <remarks>
    /// Note the signature: EF Core's closing hooks take an
    /// <see cref="InterceptionResult"/> and deliberately no CancellationToken —
    /// releasing a connection is not something that should be cancellable
    /// half-way through.
    /// </remarks>
    public override async ValueTask<InterceptionResult> ConnectionClosingAsync(
        DbConnection connection,
        ConnectionEventData eventData,
        InterceptionResult result)
    {
        if (connection.State == System.Data.ConnectionState.Open)
        {
            try
            {
                await using var cmd = connection.CreateCommand();
                cmd.CommandText = "RESET app.tenant_id; RESET app.user_id";
                await cmd.ExecuteNonQueryAsync();
            }
            catch
            {
                // The connection may already be gone. Npgsql's DISCARD ALL on
                // pool return covers this case, so a failure here is not fatal.
            }
        }

        // Pass the result through unchanged — this interceptor observes the
        // close, it does not suppress it.
        return result;
    }

    /// <summary>
    /// Sets <c>app.tenant_id</c> and <c>app.user_id</c> for this connection.
    ///
    /// The user id is needed because Family's contacts are visible per PERSON,
    /// not merely per tenant: a personal contact must stay hidden from a
    /// colleague. Core and Mail policies ignore it, so adding it changes
    /// nothing for them.
    ///
    /// A NULL user id writes an empty string, which
    /// <c>current_setting('app.user_id', true)::uuid</c> reads back as NULL and
    /// every comparison against it then fails. That is the intended behaviour
    /// for a background worker with no person behind it: organisational rows
    /// remain reachable, personal ones do not.
    /// </summary>
    private static async Task SetTenantAsync(
        DbConnection connection, Guid tenantId, Guid? userId, CancellationToken ct)
    {
        await using var cmd = connection.CreateCommand();

        // Parameterised. set_config is used rather than string-concatenating a
        // SET statement, because a SET cannot take parameters and building SQL
        // from a value — even a Guid — is a habit that eventually meets a
        // string.
        cmd.CommandText = "SELECT set_config('app.tenant_id', @tenant, false), " +
                          "       set_config('app.user_id',   @user,   false)";

        var p = cmd.CreateParameter();
        p.ParameterName = "@tenant";
        p.Value = tenantId.ToString();
        cmd.Parameters.Add(p);

        var u = cmd.CreateParameter();
        u.ParameterName = "@user";
        u.Value = userId?.ToString() ?? string.Empty;
        cmd.Parameters.Add(u);

        await cmd.ExecuteNonQueryAsync(ct);
    }
}
