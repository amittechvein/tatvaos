// Asks DevOperatorGate.cs (linked from the API) every question that decides
// whether the development-only operator sign-in exists. The last line is the
// verdict: "PASS n" or "FAIL n of m". Exit code 1 on any failure.
//
// Calibrated 24 Sept 2026 by breaking each gate in the production file and
// watching the matching lines go red — see tests/dev-operator/README.md.
using System.Net;
using Microsoft.Extensions.FileProviders;
using TatvaOS.Api.Modules.Auth.Endpoints;

var passed = 0;
var failed = 0;
void Check(bool ok, string what)
{
    if (ok) { passed++; Console.WriteLine($"  ok    {what}"); }
    else { failed++; Console.WriteLine($"  FAIL  {what}"); }
}

IConfiguration Config(string? value)
{
    var pairs = new Dictionary<string, string?>();
    if (value is not null) pairs[DevOperatorGate.EnabledKey] = value;
    return new ConfigurationBuilder().AddInMemoryCollection(pairs).Build();
}

// What the API does at start: true when it would refuse to boot.
bool Refuses(string environment, string? value)
{
    try { DevOperatorGate.RefuseToStartOutsideDevelopment(new Env(environment), Config(value)); return false; }
    catch (Exception) { return true; }
}

Console.WriteLine("Gate 1 — refuse to start with the switch on outside Development");
Check(Refuses("Production", "true"), "Production + switch on: refuses to start");
Check(Refuses("Staging", "true"), "Staging + switch on: refuses to start");
Check(Refuses("", "true"), "no environment name + switch on: refuses to start");
Check(Refuses("Production", "True"), "Production + 'True': refuses to start");
// A value that is not a boolean must not slip past as "off" in production.
Check(Refuses("Production", "yes"), "Production + 'yes' (not a boolean): still refuses to start");
Check(!Refuses("Production", null), "Production + switch absent: starts (production is unaffected)");
Check(!Refuses("Production", "false"), "Production + switch false: starts");
Check(!Refuses("Development", "true"), "Development + switch on: starts (the case the switch is for)");
try
{
    DevOperatorGate.RefuseToStartOutsideDevelopment(new Env("Production"), Config("true"));
    Check(false, "the refusal names the environment it saw");
}
catch (InvalidOperationException ex)
{
    Check(ex.Message.Contains("'Production'") && ex.Message.Contains("DevOperatorSignIn__Enabled"),
        "the refusal names the switch and the environment it saw");
}

Console.WriteLine("Gates 2 and 3 — the route exists only in Development with the switch on");
Check(DevOperatorGate.IsOpen(new Env("Development"), Config("true")), "Development + on: open");
Check(!DevOperatorGate.IsOpen(new Env("Development"), Config(null)), "Development + absent: closed (CI runs as Development)");
Check(!DevOperatorGate.IsOpen(new Env("Development"), Config("false")), "Development + false: closed");
Check(!DevOperatorGate.IsOpen(new Env("Production"), Config(null)), "Production + absent: closed");
Check(!DevOperatorGate.IsOpen(new Env("Staging"), Config(null)), "Staging + absent: closed");
// Unreachable in the running API (gate 1 stops it booting) — asked anyway,
// so the request-time gate holds even if the startup check were removed.
Check(!DevOperatorGate.IsOpen(new Env("Production"), Config("true")), "Production + on: closed even so");

Console.WriteLine("Gate 4 — a caller on this machine only");
Check(DevOperatorGate.IsLocalCaller(IPAddress.Parse("127.0.0.1")), "127.0.0.1: local");
Check(DevOperatorGate.IsLocalCaller(IPAddress.Parse("::1")), "::1: local");
Check(DevOperatorGate.IsLocalCaller(IPAddress.Parse("::ffff:127.0.0.1")), "::ffff:127.0.0.1: local");
// Production's caller, exactly as the API sees it (the sign-in alert showed
// this address before PR 251 read the forwarded header).
Check(!DevOperatorGate.IsLocalCaller(IPAddress.Parse("::ffff:172.18.0.2")), "::ffff:172.18.0.2 (Caddy in production): refused");
Check(!DevOperatorGate.IsLocalCaller(IPAddress.Parse("172.18.0.2")), "172.18.0.2: refused");
Check(!DevOperatorGate.IsLocalCaller(IPAddress.Parse("192.168.1.7")), "a LAN address: refused");
Check(!DevOperatorGate.IsLocalCaller(IPAddress.Parse("0.0.0.0")), "0.0.0.0: refused");
Check(!DevOperatorGate.IsLocalCaller(IPAddress.Parse("::")), ":: : refused");
Check(!DevOperatorGate.IsLocalCaller(null), "no address at all: refused");

Console.WriteLine();
Console.WriteLine(failed == 0 ? $"PASS {passed}" : $"FAIL {failed} of {passed + failed}");
return failed == 0 ? 0 : 1;

sealed class Env(string name) : IHostEnvironment
{
    public string EnvironmentName { get; set; } = name;
    public string ApplicationName { get; set; } = "gates";
    public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}
