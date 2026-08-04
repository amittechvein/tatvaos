using System.Text.RegularExpressions;
using DnsClient;

namespace TatvaOS.Api.Modules.Core;

/// <summary>
/// Proves someone controls a domain, by any of four routes.
///
/// Four rather than one because DNS panels differ wildly, and a real subset of
/// customers can edit their website but not their DNS — a school whose domain
/// was registered by a parent volunteer six years ago is a genuinely common
/// case, and turning them away over it costs a customer.
///
/// All four prove the same fact. None of them affect mail.
/// </summary>
public sealed class SignupVerifier(IConfiguration config, ILogger<SignupVerifier> log)
{
    private readonly ILookupClient _dns = new LookupClient(new LookupClientOptions
    {
        // No cache. Someone who just added a record retries within seconds, and
        // a stale negative answer makes the product look broken when their DNS
        // is fine.
        UseCache = false,
        Timeout = TimeSpan.FromSeconds(5),
        Retries = 1,
        UseTcpFallback = true,
    });

    private readonly HttpClient _http = new()
    {
        Timeout = TimeSpan.FromSeconds(8),
    };

    public enum Method { Txt, Cname, Html, Meta }

    public sealed record Instruction(
        Method Method,
        string Label,
        string Where,
        string What,
        string Note,
        bool Recommended);

    public sealed record Outcome(bool Verified, string Detail);

    private string VerifyHost => config["Mail:VerifyHost"] ?? "verify.tatvaos.com";

    /// <summary>
    /// What to show for each option. Generated here so the screen and the
    /// checker cannot drift — a checklist that asks for one thing and tests
    /// another is worse than no checklist.
    /// </summary>
    public IReadOnlyList<Instruction> Instructions(string fqdn, string token) =>
    [
        new(Method.Txt, "DNS TXT record",
            $"Add a TXT record on {fqdn}",
            $"tatvaos-verification={token}",
            "Survives you moving your website later. The other options do not — "
                + "they lapse silently the moment your site changes host.",
            Recommended: true),

        new(Method.Cname, "DNS CNAME record",
            $"Add a CNAME record at {token}._tatvaos.{fqdn}",
            VerifyHost,
            "Use this if your DNS panel rejects long TXT values — some older "
                + "ones cap them at 63 characters.",
            Recommended: false),

        new(Method.Html, "File on your website",
            $"Upload a file to https://{fqdn}/.well-known/tatvaos-{token}.txt",
            token,
            "For when you can edit your website but not your DNS. The file must "
                + "contain the token and nothing else.",
            Recommended: false),

        new(Method.Meta, "Tag in your homepage",
            $"Add this inside <head> on https://{fqdn}",
            $"<meta name=\"tatvaos-verification\" content=\"{token}\">",
            "For site builders like Wix or Squarespace, which usually have a "
                + "field for exactly this.",
            Recommended: false),
    ];

    public async Task<Outcome> CheckAsync(
        Method method, string fqdn, string token, CancellationToken ct = default) =>
        method switch
        {
            Method.Txt   => await CheckTxtAsync(fqdn, token, ct),
            Method.Cname => await CheckCnameAsync(fqdn, token, ct),
            Method.Html  => await CheckHtmlAsync(fqdn, token, ct),
            Method.Meta  => await CheckMetaAsync(fqdn, token, ct),
            _ => new Outcome(false, "Unknown verification method."),
        };

    // ------------------------------------------------------------------
    private async Task<Outcome> CheckTxtAsync(string fqdn, string token, CancellationToken ct)
    {
        var expected = $"tatvaos-verification={token}";
        var found = await TxtAsync(fqdn, ct);

        if (found.Any(t => string.Equals(t.Trim(), expected, StringComparison.OrdinalIgnoreCase)))
            return new Outcome(true, "Record found.");

        return new Outcome(false, found.Count == 0
            ? $"No TXT records found on {fqdn} at all. If you have just added it, DNS can take up to an hour to publish."
            // Naming what WAS found is the useful part — it is almost always a
            // value pasted with the hostname in it, or the record added to a
            // subdomain instead of the apex.
            : $"Found {found.Count} TXT record(s), none matching. Check the value was pasted whole, including the tatvaos-verification= prefix, and that it is on {fqdn} itself rather than a subdomain.");
    }

    // ------------------------------------------------------------------
    private async Task<Outcome> CheckCnameAsync(string fqdn, string token, CancellationToken ct)
    {
        var host = $"{token}._tatvaos.{fqdn}";
        try
        {
            var r = await _dns.QueryAsync(host, QueryType.CNAME, cancellationToken: ct);
            var targets = r.Answers.CnameRecords()
                .Select(c => c.CanonicalName.Value.TrimEnd('.'))
                .ToList();

            if (targets.Any(t => t.Equals(VerifyHost, StringComparison.OrdinalIgnoreCase)))
                return new Outcome(true, "Record found.");

            return new Outcome(false, targets.Count == 0
                ? $"Nothing found at {host}."
                : $"{host} points at {string.Join(", ", targets)} rather than {VerifyHost}.");
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "CNAME lookup failed for {Host}", host);
            return new Outcome(false, $"Could not look up {host}.");
        }
    }

    // ------------------------------------------------------------------
    private async Task<Outcome> CheckHtmlAsync(string fqdn, string token, CancellationToken ct)
    {
        var url = $"https://{fqdn}/.well-known/tatvaos-{token}.txt";
        try
        {
            var res = await _http.GetAsync(url, ct);
            if (!res.IsSuccessStatusCode)
                return new Outcome(false, $"{url} returned {(int)res.StatusCode}. The file must be reachable over HTTPS without a redirect to a login page.");

            var body = (await res.Content.ReadAsStringAsync(ct)).Trim();

            // A 200 that returns a styled 404 page is the common failure —
            // many hosts do this — so the content is checked, not the status.
            return body.Contains(token, StringComparison.OrdinalIgnoreCase)
                ? new Outcome(true, "File found.")
                : new Outcome(false, $"{url} loaded but does not contain the token. Some hosts answer 200 with a styled error page — check the file is really there.");
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "HTML verification failed for {Url}", url);
            return new Outcome(false, $"Could not reach {url}. It must be served over HTTPS with a valid certificate.");
        }
    }

    // ------------------------------------------------------------------
    private async Task<Outcome> CheckMetaAsync(string fqdn, string token, CancellationToken ct)
    {
        var url = $"https://{fqdn}";
        try
        {
            var res = await _http.GetAsync(url, ct);
            if (!res.IsSuccessStatusCode)
                return new Outcome(false, $"{url} returned {(int)res.StatusCode}.");

            var html = await res.Content.ReadAsStringAsync(ct);

            // Deliberately loose: attribute order varies, quoting varies, and
            // site builders inject their own whitespace. Being strict here
            // fails customers who did exactly what we asked.
            var m = Regex.Match(html,
                @"<meta[^>]+name\s*=\s*[""']tatvaos-verification[""'][^>]+content\s*=\s*[""']([^""']+)[""']",
                RegexOptions.IgnoreCase);

            if (!m.Success)
                m = Regex.Match(html,
                    @"<meta[^>]+content\s*=\s*[""']([^""']+)[""'][^>]+name\s*=\s*[""']tatvaos-verification[""']",
                    RegexOptions.IgnoreCase);

            if (m.Success && m.Groups[1].Value.Trim() == token)
                return new Outcome(true, "Tag found.");

            return new Outcome(false, m.Success
                ? "A verification tag is present but the value does not match. It may be from an earlier attempt — replace it with the current one."
                : $"No verification tag found on {url}. It must be inside <head>, and some builders only publish it after the site is republished.");
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Meta verification failed for {Url}", url);
            return new Outcome(false, $"Could not load {url}.");
        }
    }

    // ------------------------------------------------------------------
    private async Task<List<string>> TxtAsync(string host, CancellationToken ct)
    {
        try
        {
            var r = await _dns.QueryAsync(host, QueryType.TXT, cancellationToken: ct);
            // Long values arrive split into 255-byte chunks and must be
            // rejoined before comparing.
            return r.Answers.TxtRecords().Select(t => string.Concat(t.Text)).ToList();
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "TXT lookup failed for {Host}", host);
            return [];
        }
    }
}
