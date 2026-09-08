-- ============================================================================
--  Backstop: the bounce subdomain can never be a core.domains row
-- ============================================================================
--
--  The application guard (ReservedDomains, PR #58) refuses the bounce
--  subdomain on every path that creates a domain row. This is the
--  constraint underneath it, for the same reason the api_keys constraint
--  sits under the app check that closed the empty-sender hole: three code
--  paths today are four after the next hire, and a constraint does not
--  need to be remembered.
--
--  Why this matters (local/postfix/main.cf, INVARIANT): virtual-domains.cf
--  matches a recipient's domain by exact fqdn against core.domains. A row
--  for bounces.tatvaos.com - or anything under it - would make Postfix
--  treat the bounce subdomain as a hosted mailbox domain, and
--  reject_unlisted_recipient would refuse every VERP bounce address before
--  the policy service is consulted. Bounce intake stops, silently.
--
--  The literal is deliberate and matches main.cf's relay_domains, which is
--  also a literal: the database cannot read Bounce:Domain. If the bounce
--  subdomain ever moves, main.cf, ReservedDomains.DefaultBounceDomain and
--  this constraint change together.
--
--  fqdn is citext, so the comparison is already case-insensitive; lower()
--  is spelled out so the intent survives a future column-type change.
--
--  DROP IF EXISTS then ADD: every file here re-runs on every deploy.

ALTER TABLE core.domains DROP CONSTRAINT IF EXISTS domains_fqdn_not_bounce_subdomain;
ALTER TABLE core.domains ADD CONSTRAINT domains_fqdn_not_bounce_subdomain
    CHECK (lower(fqdn::text) <> 'bounces.tatvaos.com'
           AND lower(fqdn::text) NOT LIKE '%.bounces.tatvaos.com');

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  core.domains: bounces.tatvaos.com and anything under it refused at the table';
    RAISE NOTICE '';
END $$;
