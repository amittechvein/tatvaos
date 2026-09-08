namespace TatvaOS.Api.Modules.Core;

/// <summary>
/// Domain names Core must never let into core.domains.
///
/// INVARIANT, shared with local/postfix/main.cf: the bounce subdomain
/// (Bounce:Domain, bounces.tatvaos.com today) and anything under it must
/// never become a core.domains row. Postfix's virtual-domains.cf and
/// local-recipient-domains.cf match a recipient's domain by EXACT fqdn
/// against core.domains; a row for the bounce subdomain would make Postfix
/// treat it as a hosted mailbox domain, and reject_unlisted_recipient would
/// then refuse every VERP bounce address BEFORE the policy service is
/// consulted. Bounce intake stops, and it stops silently - the API keeps
/// signing return addresses that nothing can receive.
///
/// main.cf records the invariant; this is the enforcement it points at.
/// Three paths create domain rows and all three call here: an organisation
/// adding its own domain, the platform creating an organisation (its own
/// domain), and the platform-subdomain allocator (an organisation named
/// "Bounces" must not be handed bounces.tatvaos.com).
/// </summary>
public static class ReservedDomains
{
    // The literal Postfix routes on (main.cf relay_domains). Honoured even
    // while Bounce:Domain is unset and VERP is dormant, because the Postfix
    // side of the invariant is live regardless.
    private const string DefaultBounceDomain = "bounces.tatvaos.com";

    //  IsNullOrWhiteSpace, NOT `??`. Bounce__Domain is wired in
    //  docker-compose.base.yml as ${BOUNCE_DOMAIN:-}, and `:-` does NOT mean
    //  "leave the variable unset" — Compose CREATES the variable with an EMPTY
    //  value. .NET's environment provider then hands back "" rather than null,
    //  so `??` never fires and this returned "". IsBounceDomain would compare
    //  every fqdn against "" and against EndsWith("."), match neither, and
    //  refuse nothing — the guard off while looking present, which is the exact
    //  failure it exists to prevent. A blank is as absent as a null here and
    //  must be read the same way.
    public static string BounceDomain(IConfiguration config)
    {
        var configured = config["Bounce:Domain"];
        var domain = string.IsNullOrWhiteSpace(configured) ? DefaultBounceDomain : configured;
        return domain.Trim().ToLowerInvariant().TrimEnd('.');
    }

    /// <summary>True when fqdn IS the bounce domain or sits anywhere under it.</summary>
    public static bool IsBounceDomain(IConfiguration config, string fqdn)
    {
        var bounce = BounceDomain(config);
        var f = fqdn.Trim().ToLowerInvariant().TrimEnd('.');
        return f == bounce || f.EndsWith("." + bounce, StringComparison.Ordinal);
    }

    public static string Refusal(IConfiguration config)
        => $"{BounceDomain(config)} is reserved for bounce handling. It cannot be registered, and neither can anything under it.";
}
