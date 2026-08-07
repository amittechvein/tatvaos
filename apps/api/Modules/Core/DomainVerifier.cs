using System.Net;
using DnsClient;
using DnsClient.Protocol;

namespace TatvaOS.Api.Modules.Core;

/// <summary>
/// Checks whether a customer has actually published the DNS records we asked
/// for.
///
/// ─────────────────────────────────────────────────────────────────────────
///  FIVE INDEPENDENT CHECKS, NOT ONE.
///
///  Collapsing these into a single "verified" flag produces the support
///  ticket that says "it says verified but mail bounces". Ownership can be
///  proven while MX still points at the previous provider — a completely
///  different problem with a completely different fix, and the admin needs to
///  be told which one they have.
///
///  Only ownership gates activation. The rest are advisory: a customer
///  mid-migration legitimately has old MX records for days, and refusing to
///  activate them over it helps nobody.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class DomainVerifier
{
    private readonly ILookupClient _dns;
    private readonly ILogger<DomainVerifier> _log;
    private readonly string _mailHost;
    private readonly string _spfInclude;

    public DomainVerifier(IConfiguration config, ILogger<DomainVerifier> log)
    {
        _log = log;
        _mailHost = config["Mail:Host"] ?? "mail.tatvaos.com";
        _spfInclude = config["Mail:SpfInclude"] ?? "_spf.tatvaos.com";

        _dns = new LookupClient(new LookupClientOptions
        {
            // Ask an authoritative answer rather than trusting a cached one.
            // A customer who just added a record will retry within seconds and
            // a stale negative cache makes the product look broken when their
            // DNS is fine.
            UseCache = false,
            Timeout = TimeSpan.FromSeconds(5),
            Retries = 1,
            // Records can exceed 512 bytes once SPF and DKIM are present.
            UseTcpFallback = true,
        });
    }

    public sealed record Check(
        string Id,
        string Label,
        bool Passed,
        string Detail,
        bool Required);

    public sealed record Result(
        bool OwnershipProven,
        IReadOnlyList<Check> Checks,
        string Summary);

    public async Task<Result> CheckAsync(
        string fqdn, string verificationToken, string? dkimSelector, CancellationToken ct = default)
    {
        var checks = new List<Check>();

        // Query the zone's OWN authoritative nameservers, not the server's
        // recursive resolver. UseCache=false only disables DnsClient's cache —
        // the upstream recursive resolver (here Docker's embedded DNS forwarding
        // to the host) still serves whatever record-set it cached, for the full
        // TTL. That is exactly how a just-added verification TXT stays invisible
        // for hours while the rest of the internet already sees it. Asking the
        // authoritative servers directly means there is no cache in the path.
        var zone = await ZoneClientAsync(fqdn, ct);

        // ---- Ownership ---------------------------------------------------
        // The only check that gates anything. A TXT record on the apex proves
        // whoever asked controls the zone — nothing else we could ask for does.
        var expected = $"tatvaos-verification={verificationToken}";
        var txt = await TxtAsync(zone, fqdn, ct);

        var owned = txt.Any(t => string.Equals(t.Trim(), expected, StringComparison.OrdinalIgnoreCase));
        checks.Add(new Check(
            "ownership",
            "Ownership",
            owned,
            owned
                ? "Verification record found."
                : txt.Count == 0
                    ? $"No TXT records found on {fqdn}. Add the record below, then check again — DNS changes can take up to an hour to appear."
                    : $"Found {txt.Count} TXT record(s), none matching. Check the value was pasted whole, including the tatvaos-verification= prefix.",
            Required: true));

        // ---- MX ----------------------------------------------------------
        var mx = await MxAsync(zone, fqdn, ct);
        var mxOk = mx.Any(h => h.TrimEnd('.').Equals(_mailHost, StringComparison.OrdinalIgnoreCase));
        checks.Add(new Check(
            "mx",
            "Mail delivery (MX)",
            mxOk,
            mxOk
                ? $"Mail for {fqdn} is directed to {_mailHost}."
                : mx.Count == 0
                    ? "No MX records found. Mail sent to this domain has nowhere to go."
                    // Naming the current provider is the useful part: it tells
                    // them their old mail still works, which is usually the
                    // thing they are most anxious about mid-migration.
                    : $"Mail currently goes to {string.Join(", ", mx.Take(3).Select(h => h.TrimEnd('.')))}. Existing mail is unaffected until you change this.",
            Required: false));

        // ---- SPF ---------------------------------------------------------
        var spf = txt.FirstOrDefault(t => t.StartsWith("v=spf1", StringComparison.OrdinalIgnoreCase));
        var spfOk = spf is not null && spf.Contains(_spfInclude, StringComparison.OrdinalIgnoreCase);
        checks.Add(new Check(
            "spf",
            "Sender authorisation (SPF)",
            spfOk,
            spfOk
                ? "Our servers are authorised to send as this domain."
                : spf is null
                    ? "No SPF record. Mail sent from this domain is more likely to be treated as spam."
                    : $"An SPF record exists but does not include {_spfInclude}. Add it rather than replacing what is there — removing an existing include breaks whatever currently sends as this domain.",
            Required: false));

        // ---- DKIM --------------------------------------------------------
        if (!string.IsNullOrWhiteSpace(dkimSelector))
        {
            var dkimHost = $"{dkimSelector}._domainkey.{fqdn}";
            var dkim = await TxtAsync(zone, dkimHost, ct);
            var dkimOk = dkim.Any(t => t.Contains("p=", StringComparison.OrdinalIgnoreCase));
            checks.Add(new Check(
                "dkim",
                "Signing key (DKIM)",
                dkimOk,
                dkimOk
                    ? "Signing key published — outbound mail can be signed."
                    : $"No key found at {dkimHost}. Without it, receivers cannot verify mail we send on your behalf.",
                Required: false));
        }

        // ---- DMARC -------------------------------------------------------
        var dmarc = await TxtAsync(zone, $"_dmarc.{fqdn}", ct);
        var dmarcOk = dmarc.Any(t => t.StartsWith("v=DMARC1", StringComparison.OrdinalIgnoreCase));
        checks.Add(new Check(
            "dmarc",
            "Anti-spoofing policy (DMARC)",
            dmarcOk,
            dmarcOk
                ? "A DMARC policy is published."
                : "No DMARC policy. Start with p=none, which reports without rejecting anything — it is safe to add today and tells you who is sending as your domain.",
            Required: false));

        var passed = checks.Count(c => c.Passed);
        var summary = owned
            ? $"Ownership proven. {passed} of {checks.Count} checks passing."
            : "Ownership not yet proven — no mail is accepted for this domain.";

        return new Result(owned, checks, summary);
    }

    // ------------------------------------------------------------------

    /// <summary>
    /// A resolver aimed straight at the domain's authoritative nameservers, so
    /// no recursive cache sits between us and the truth. Falls back to the
    /// default (recursive) client if the NS cannot be resolved — a verification
    /// that occasionally trusts a cache is better than one that cannot run.
    /// </summary>
    private async Task<ILookupClient> ZoneClientAsync(string fqdn, CancellationToken ct)
    {
        try
        {
            var apex = RegistrableDomain(fqdn);
            var ns = await _dns.QueryAsync(apex, QueryType.NS, cancellationToken: ct);
            var names = ns.Answers.NsRecords()
                .Select(n => n.NSDName.Value.TrimEnd('.'))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var ips = new List<IPAddress>();
            foreach (var name in names)
            {
                var a = await _dns.QueryAsync(name, QueryType.A, cancellationToken: ct);
                ips.AddRange(a.Answers.ARecords().Select(r => r.Address));
            }
            if (ips.Count == 0) return _dns;

            return new LookupClient(new LookupClientOptions([.. ips])
            {
                UseCache = false,
                UseTcpFallback = true,
                Timeout = TimeSpan.FromSeconds(5),
                Retries = 1,
            });
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Authoritative NS lookup failed for {Fqdn}; using recursive resolver", fqdn);
            return _dns;
        }
    }

    /// <summary>
    /// The apex the NS records live on — the last two labels. Good enough for
    /// the customers here; multi-part public suffixes like co.uk would need a
    /// Public Suffix List, and none are onboarding today.
    /// </summary>
    private static string RegistrableDomain(string fqdn)
    {
        var parts = fqdn.TrimEnd('.').Split('.');
        return parts.Length <= 2 ? fqdn : string.Join('.', parts[^2..]);
    }

    private async Task<List<string>> TxtAsync(ILookupClient dns, string host, CancellationToken ct)
    {
        try
        {
            var r = await dns.QueryAsync(host, QueryType.TXT, cancellationToken: ct);
            // Long TXT values arrive split into 255-byte chunks and must be
            // rejoined. A DKIM key is always split, so not doing this means
            // DKIM never validates.
            return r.Answers.TxtRecords()
                .Select(t => string.Concat(t.Text))
                .ToList();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "TXT lookup failed for {Host}", host);
            return [];
        }
    }

    private async Task<List<string>> MxAsync(ILookupClient dns, string host, CancellationToken ct)
    {
        try
        {
            var r = await dns.QueryAsync(host, QueryType.MX, cancellationToken: ct);
            return r.Answers.MxRecords()
                .OrderBy(m => m.Preference)
                .Select(m => m.Exchange.Value)
                .ToList();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "MX lookup failed for {Host}", host);
            return [];
        }
    }

    /// <summary>
    /// The records to show the customer. Generated rather than hardcoded so
    /// the screen and the checker can never drift apart — a checklist that
    /// asks for one thing and tests another is worse than no checklist.
    /// </summary>
    public IReadOnlyList<RequiredRecord> RequiredRecords(
        string fqdn, string verificationToken, string? dkimSelector, string? dkimPublicKey)
    {
        var records = new List<RequiredRecord>
        {
            new("TXT", "@", $"tatvaos-verification={verificationToken}",
                "Proves you control this domain. Nothing is accepted for it until this is found.", true),
            new("MX", "@", $"10 {_mailHost}",
                "Directs incoming mail to us. Add this only when you are ready to move — your current mail keeps working until you do.", false),
            new("TXT", "@", $"v=spf1 include:{_spfInclude} ~all",
                "Authorises our servers to send as you. If you already have an SPF record, add the include to it rather than creating a second one — two SPF records is an error.", false),
        };

        if (!string.IsNullOrWhiteSpace(dkimSelector))
        {
            records.Add(new RequiredRecord("TXT", $"{dkimSelector}._domainkey",
                dkimPublicKey ?? "v=DKIM1; k=rsa; p=<generated when you enable sending>",
                "Lets receivers verify mail we send on your behalf is genuinely from you.", false));
        }

        records.Add(new RequiredRecord("TXT", "_dmarc",
            "v=DMARC1; p=none; rua=mailto:dmarc@tatvaos.com",
            "Tells receivers what to do with mail that fails the checks above. p=none only reports — it rejects nothing, so it is safe to add immediately.", false));

        return records;
    }

    public sealed record RequiredRecord(
        string Type, string Host, string Value, string Purpose, bool Required);
}
