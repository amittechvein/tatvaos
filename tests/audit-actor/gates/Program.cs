// Asks the three production files (linked, not copied) every question that
// decides whether an audit line names the person who acted. The last line is
// the verdict: "PASS n" or "FAIL n of m". Exit code 1 on any failure.
using System.Net;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared;
using TatvaOS.Api.Shared.Auth;

var passed = 0;
var failed = 0;
void Check(bool ok, string what)
{
    if (ok) { passed++; Console.WriteLine($"  ok    {what}"); }
    else { failed++; Console.WriteLine($"  FAIL  {what}"); }
}

var amit = Guid.Parse("3f0c1a52-9d1e-4a57-8d53-0c1f1b6f7a11");
ClaimsPrincipal With(params (string type, string value)[] claims) =>
    new(new ClaimsIdentity(claims.Select(c => new Claim(c.type, c.value)), "test"));

Console.WriteLine("Who is signed in");
// THE CASE THAT WAS BROKEN: what the JWT handler actually hands an endpoint.
// "sub" has been renamed; there is no claim called "sub" at all.
Check(SignedIn.UserId(With((ClaimTypes.NameIdentifier, amit.ToString()))) == amit,
    "the id arrives renamed to NameIdentifier, as the JWT handler delivers it: found");
Check(SignedIn.UserId(With(("sub", amit.ToString()))) == amit,
    "the id arrives as plain 'sub' (renaming turned off): found");
Check(SignedIn.UserId(With((ClaimTypes.NameIdentifier, amit.ToString()), ("sub", Guid.NewGuid().ToString()))) == amit,
    "both present: NameIdentifier wins, the order TenantMiddleware uses");
Check(SignedIn.UserId(With(("email", "a@b.test"))) is null, "no id claim: null, not a made-up id");
Check(SignedIn.UserId(With((ClaimTypes.NameIdentifier, "not-a-guid"))) is null, "an id that is not a Guid: null");
Check(SignedIn.UserId(With((ClaimTypes.NameIdentifier, Guid.Empty.ToString()))) is null,
    "the all-zero id is nobody: null");
Check(SignedIn.UserId((ClaimsPrincipal?)null) is null, "no principal at all: null");
var ctx = new DefaultHttpContext { User = With((ClaimTypes.NameIdentifier, amit.ToString())) };
Check(SignedIn.UserIdOrEmpty(ctx) == amit, "UserIdOrEmpty names the person");
Check(SignedIn.UserIdOrEmpty(new DefaultHttpContext()) == Guid.Empty, "UserIdOrEmpty with nobody signed in: Guid.Empty");

Console.WriteLine("Whether the line may be written");
Check(AuditActorGuard.Refusal(true, true, Guid.Empty, "organisation.suspended") is not null,
    "operator signed in, platform scope, all-zero actor: REFUSED");
Check(AuditActorGuard.Refusal(true, true, null, "organisation.suspended") is not null,
    "operator signed in, platform scope, no actor: REFUSED");
Check(AuditActorGuard.Refusal(true, true, Guid.Empty, "invoice.issued")?.Contains("invoice.issued") == true,
    "the refusal names the action it would not write");
Check(AuditActorGuard.Refusal(true, true, amit, "organisation.suspended") is null,
    "operator signed in, platform scope, named: written");
Check(AuditActorGuard.Refusal(true, false, Guid.Empty, "personal.account_created") is null,
    "nobody signed in (a sign-up, a personal account joining): written, there is nobody to name");
Check(AuditActorGuard.Refusal(false, true, amit, "user.created") is null,
    "an organisation's own administrator, not platform scope: written");
Check(AuditActorGuard.Refusal(false, true, null, "connect.guest") is null,
    "not platform scope: this guard has no opinion");

Console.WriteLine("Where the request came from");
DefaultHttpContext From(string? xff, string? peer)
{
    var c = new DefaultHttpContext();
    if (xff is not null) c.Request.Headers["X-Forwarded-For"] = xff;
    if (peer is not null) c.Connection.RemoteIpAddress = IPAddress.Parse(peer);
    return c;
}
Check(ClientIp.From(From("203.0.113.7", "::ffff:172.18.0.2")) == "203.0.113.7",
    "behind Caddy: the forwarded address, not Caddy's container");
Check(ClientIp.From(From("198.51.100.9, 203.0.113.7", "172.18.0.2")) == "203.0.113.7",
    "a client that sends its own X-Forwarded-For: the LAST entry, the one Caddy wrote");
Check(ClientIp.From(From("198.51.100.9, 203.0.113.7", "172.18.0.2")) != "198.51.100.9",
    "…and never the first, which the client chose");
Check(ClientIp.From(From(null, "::ffff:192.0.2.4")) == "192.0.2.4", "no proxy: the peer, as IPv4");
Check(ClientIp.From(From("not an address", "172.18.0.2")) is null, "a forwarded value that is not an address: nothing stored");

Console.WriteLine();
if (failed == 0) { Console.WriteLine($"PASS {passed}"); return 0; }
Console.WriteLine($"FAIL {failed} of {passed + failed}");
return 1;
