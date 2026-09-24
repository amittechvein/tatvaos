// Asks DevOperatorGate.cs (linked from the API) every question that decides
// whether the development-only operator sign-in exists. The last line is the
// verdict: "PASS n" or "FAIL n of m". Exit code 1 on any failure.
//
// Calibrated 24 Sept 2026 by breaking each gate in the production file and
// watching the matching lines go red — see tests/dev-operator/README.md.
using System.Net;
using Microsoft.AspNetCore.Http;
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
Check(!DevOperatorGate.IsLocalCaller((IPAddress?)null), "no address at all: refused");

// Mr. Singh, 25 Sept 2026: gate 4 must NEVER read a forwarded header. The
// overload the handler calls takes the whole request, so every header a
// "harmonising" change might reach for is set here, claiming loopback.
HttpContext Request(string? connection, string? claimed)
{
    var http = new DefaultHttpContext();
    http.Connection.RemoteIpAddress = connection is null ? null : IPAddress.Parse(connection);
    if (claimed is not null)
    {
        http.Request.Headers["X-Forwarded-For"] = claimed;
        http.Request.Headers["X-Real-IP"] = claimed;
        http.Request.Headers["Forwarded"] = $"for={claimed}";
    }
    return http;
}
Console.WriteLine("Gate 4 — forwarded headers are never believed");
Check(!DevOperatorGate.IsLocalCaller(Request("::ffff:172.18.0.2", "127.0.0.1")),
    "connection is Caddy's, headers claim 127.0.0.1: refused");
Check(!DevOperatorGate.IsLocalCaller(Request("::ffff:172.18.0.2", "::1")),
    "connection is Caddy's, headers claim ::1: refused");
Check(!DevOperatorGate.IsLocalCaller(Request(null, "127.0.0.1")),
    "no connection address, headers claim 127.0.0.1: refused");
// The other direction, so the rule is "the connection decides", not "any
// header refuses": a real local caller is served whatever it claims.
Check(DevOperatorGate.IsLocalCaller(Request("::1", "203.0.113.9")),
    "connection is ::1, headers claim a remote address: served (headers ignored both ways)");
Check(DevOperatorGate.IsLocalCaller(Request("127.0.0.1", null)),
    "connection is 127.0.0.1, no headers: served");

// Gate 5: the database must be on this machine. Name resolution is passed
// in, so every answer DNS could give is asked without depending on it.
Console.WriteLine("Gate 5 — the database host must be loopback");
IPAddress[] Resolves(params string[] a) => a.Select(IPAddress.Parse).ToArray();
Func<string, IPAddress[]> To(params string[] a) => _ => Resolves(a);
Func<string, IPAddress[]> NeverAsked = h => throw new InvalidOperationException($"resolved {h}");
Func<string, IPAddress[]> Fails = h => throw new System.Net.Sockets.SocketException(11001);
const string Rest = ";Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=x";
bool Db(string? cs, Func<string, IPAddress[]> r) => DevOperatorGate.IsLoopbackDatabase(cs, r);

Check(!Db("Host=postgres" + Rest, To("172.18.0.3")), "Host=postgres resolving to 172.18.0.3 (production's own): refused");
Check(!Db("Host=172.18.0.3" + Rest, NeverAsked), "a private address (the compose network): refused");
Check(!Db("Host=172.31.20.198" + Rest, NeverAsked), "the laptop's WSL address (private, not loopback): refused");
Check(!Db("Host=192.168.1.7" + Rest, NeverAsked), "a LAN address: refused");
Check(!Db("Host=db.example" + Rest, To("203.0.113.9")), "a public name: refused");
Check(!Db("Host=localhost" + Rest, To("127.0.0.1", "192.168.1.7")), "a name resolving to loopback AND a LAN address: refused (every address must be loopback)");
Check(!Db("Host=localhost" + Rest, To()), "a name resolving to nothing: refused");
Check(!Db("Host=nowhere.invalid" + Rest, Fails), "a name that does not resolve: refused");
Check(!Db("Host=localhost,127.0.0.1" + Rest, NeverAsked), "a multi-host list: refused");
Check(!Db("Host=/var/run/postgresql" + Rest, NeverAsked), "a Unix socket path: refused");
Check(!Db("Host=0.0.0.0" + Rest, NeverAsked), "0.0.0.0: refused");
Check(!Db("Database=tatvaos_mail", NeverAsked), "no host at all: refused");
Check(!Db("", NeverAsked), "empty connection string: refused");
Check(!Db(null, NeverAsked), "no connection string: refused");
Check(!Db("Host=127.0.0.1;Port=5432;=broken", NeverAsked), "a malformed connection string: refused");
// Mr. Singh: localhost may resolve to ::1 rather than 127.0.0.1 — both
// loopback forms must pass, and the literal string is never the test.
Check(Db("Host=localhost" + Rest, To("::1", "127.0.0.1")), "Host=localhost resolving to ::1 and 127.0.0.1: allowed");
Check(Db("Host=localhost" + Rest, To("::1")), "Host=localhost resolving to ::1 only: allowed");
Check(Db("Host=localhost" + Rest, To("127.0.0.1")), "Host=localhost resolving to 127.0.0.1 only: allowed");
Check(Db("Host=127.0.0.1" + Rest, NeverAsked), "Host=127.0.0.1: allowed, and no name lookup");
Check(Db("Host=::1" + Rest, NeverAsked), "Host=::1: allowed");
Check(Db("Host=[::1]" + Rest, NeverAsked), "Host=[::1]: allowed");
Check(Db("Server=127.0.0.1" + Rest, NeverAsked), "Server= (the synonym): read too");

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
