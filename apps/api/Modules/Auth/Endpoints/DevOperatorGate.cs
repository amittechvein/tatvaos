using System.Net;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// Every decision about whether the development-only operator sign-in may
/// exist, in one place with no dependencies — so DevOperatorSignIn.cs cannot
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
    /// Gate 4: a caller on this machine. Null (no socket, e.g. an in-process
    /// test server) is refused. An IPv4 address mapped into IPv6 is judged
    /// as the IPv4 address it carries — production's caller arrives as
    /// ::ffff:172.18.0.2 (Caddy on the compose network), which must be
    /// refused, and ::ffff:127.0.0.1 is this machine.
    /// </summary>
    public static bool IsLocalCaller(IPAddress? remote)
    {
        if (remote is null) return false;
        if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
        return IPAddress.IsLoopback(remote);
    }
}
