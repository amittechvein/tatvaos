using System.Net;
using Microsoft.AspNetCore.Http;

namespace TatvaOS.Api.Shared;

/// <summary>
/// The address a person's request came from: as we show it BACK TO THEM (the
/// new-sign-in email, their list of signed-in devices) and as the audit log
/// records it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY NOT Connection.RemoteIpAddress.
///
///  Behind Caddy the peer is the proxy, so that property is Caddy's address on
///  the compose network — "::ffff:172.18.0.2" — for every person on earth. A
///  customer read exactly that in their sign-in alert on 23 Sept 2026 and
///  asked what it was. An address that is the same for everyone tells the
///  reader nothing, and in a security email it reads as a fault.
///
///  Same rule as the rate limiters in Program.cs: the client is the LAST entry
///  of X-Forwarded-For. Caddy appends the real peer there; anything earlier is
///  client-supplied and spoofable. The API publishes no port, so nothing but
///  Caddy can reach it to write that last entry.
///
///  IPv4 is shown as IPv4. Kestrel listens dual-stack and reports a v4 peer
///  as "::ffff:1.2.3.4"; people know their address as "1.2.3.4".
///
///  ALSO what the audit log records, since 29 Sept 2026 (Mr. Singh). Until
///  then AuditWriter wrote the connection's address, so every line in
///  production names Caddy's container. Older lines are not rewritten.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ClientIp
{
    public static string? From(HttpContext http)
    {
        var xff = http.Request.Headers["X-Forwarded-For"].ToString();
        var raw = string.IsNullOrWhiteSpace(xff)
            ? http.Connection.RemoteIpAddress?.ToString()
            : xff.Split(',')[^1].Trim();

        return Normalise(raw);
    }

    /// <summary>Unwraps IPv4-mapped IPv6; anything unparseable becomes null
    /// rather than being shown to a person or stored.</summary>
    public static string? Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || !IPAddress.TryParse(raw, out var ip)) return null;
        return ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4().ToString() : ip.ToString();
    }
}
