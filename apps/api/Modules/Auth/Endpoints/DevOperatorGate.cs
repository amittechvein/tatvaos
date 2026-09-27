using System.Net;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// Every decision about whether the development-only operator sign-in may
/// exist or answer, in one place with no dependencies — so DevOperatorSignIn.cs cannot
/// ask the question two different ways, and tests/dev-operator/gates can
/// compile THIS file (linked, not copied) and prove each answer directly.
/// The why is in DevOperatorSignIn.cs.
/// </summary>
public static class DevOperatorGate
{
    /// <summary>
    /// The switch. Set as the environment variable DevOperatorSignIn__Enabled.
    /// Never put it in appsettings.json or appsettings.Development.json: CI
    /// runs as Development and reads the latter.
    /// </summary>
    public const string EnabledKey = "DevOperatorSignIn:Enabled";

    public static bool IsRequested(IConfiguration config) =>
        config.GetValue<bool>(EnabledKey);

    /// <summary>Gate 1. Throws when the switch is on outside Development.</summary>
    public static void RefuseToStartOutsideDevelopment(IHostEnvironment env, IConfiguration config)
    {
        if (IsRequested(config) && !env.IsDevelopment())
            throw new InvalidOperationException(
                "Refusing to start: DevOperatorSignIn__Enabled is on but ASPNETCORE_ENVIRONMENT is " +
                $"'{env.EnvironmentName}'. That switch opens a password-less platform-operator " +
                "sign-in and exists only for a developer's own machine. Remove it from this " +
                "environment.");
    }

    /// <summary>
    /// Gates 2 and 3: the route exists, and answers, only in Development with
    /// the switch on. Development alone is NOT enough — CI runs as Development.
    /// </summary>
    public static bool IsOpen(IHostEnvironment env, IConfiguration config) =>
        env.IsDevelopment() && IsRequested(config);

    /// <summary>
    /// Gate 4, the one the handler calls: judged on the CONNECTION's address
    /// and nothing else.
    ///
    /// NEVER X-Forwarded-For, X-Real-IP or Forwarded (Mr. Singh, 25 Sept
    /// 2026). The rate limiters in this codebase DO read the rightmost
    /// X-Forwarded-For, correctly for them — Caddy appends it. Someone
    /// "harmonising" this gate with them would let any caller on the
    /// internet claim 127.0.0.1 in a header and be believed. Pinned by
    /// tests/dev-operator/gates (the header claims loopback, the connection
    /// is Caddy's: refused) and test.sh (a loopback caller claiming a remote
    /// address is still served, so no middleware rewrote the connection
    /// address from the header either).
    /// </summary>
    public static bool IsLocalCaller(HttpContext http) =>
        IsLocalCaller(http.Connection.RemoteIpAddress);

    /// <summary>
    /// The address rule behind gate 4. Null (no socket, e.g. an in-process
    /// test server) is refused. An IPv4 address mapped into IPv6 is judged
    /// as the IPv4 address it carries — production's caller arrives as
    /// ::ffff:172.18.0.2 (Caddy on the compose network), which must be
    /// refused, and ::ffff:127.0.0.1 is this machine.
    /// </summary>
    public static bool IsLocalCaller(IPAddress? remote) => IsLoopbackAddress(remote);

    private static bool IsLoopbackAddress(IPAddress? address)
    {
        if (address is null) return false;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        return IPAddress.IsLoopback(address);
    }

    /// <summary>
    /// Gate 5, on the DATA rather than the process (Mr. Singh, 25 Sept
    /// 2026): the operator account is created or signed in only when the
    /// database this API talks to is on this machine.
    ///
    /// Why. Otherwise the defence against a password-less super_admin in a
    /// real organisation — "the oldest organisation", which in production
    /// is a real school — is that production Postgres publishes no port.
    /// That is a deployment fact, not a code property; the day the port is
    /// exposed for a reporting tool, a laptop running this in Development
    /// could reach it. This makes that a problem, but not THIS problem.
    ///
    /// LOOPBACK ONLY, and deliberately no private ranges: production's
    /// database is "postgres" on the compose network, which resolves to a
    /// private address (172.18.x). A rule allowing private ranges would pass
    /// in production and protect nothing. A lock loosened to make a laptop
    /// convenient is no lock — the local stack connects as Host=localhost
    /// (WSL forwards it) instead.
    ///
    /// Judged on ADDRESSES, never on the string "localhost", which is a name:
    /// an IP literal must be loopback; a name must resolve, and EVERY
    /// address it resolves to must be loopback (both 127.0.0.1 and ::1
    /// forms accepted). A multi-host list, a Unix socket path, an
    /// unresolvable name or no connection string at all: refused.
    /// </summary>
    public static bool IsLoopbackDatabase(string? connectionString, Func<string, IPAddress[]> resolve)
    {
        if (string.IsNullOrWhiteSpace(connectionString)) return false;

        string? host;
        try
        {
            var csb = new System.Data.Common.DbConnectionStringBuilder { ConnectionString = connectionString };
            host = (csb.TryGetValue("Host", out var h) ? h : csb.TryGetValue("Server", out var sv) ? sv : null)?.ToString()?.Trim();
        }
        catch (ArgumentException) { return false; }

        if (string.IsNullOrEmpty(host) || host.Contains(',') || host.StartsWith('/') || host.StartsWith('@'))
            return false;

        if (IPAddress.TryParse(host.Trim('[', ']'), out var literal))
            return IsLoopbackAddress(literal);

        IPAddress[] resolved;
        try { resolved = resolve(host); }
        catch (Exception) { return false; }

        return resolved.Length > 0 && resolved.All(a => IsLoopbackAddress(a));
    }
}
