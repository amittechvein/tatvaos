-- ============================================================================
--  Domain verification
-- ============================================================================
--
--  A domain moves through five independent checks, not one. Collapsing them
--  into a single "verified" flag is what produces the support ticket that
--  says "it says verified but mail bounces" — ownership can be proven while
--  MX still points at the old provider, which is a completely different
--  problem with a completely different fix.
--
--    ownership  TXT token          we accept nothing for the domain without it
--    mx         MX -> our host     inbound mail actually arrives
--    spf        TXT v=spf1         our servers may send as them
--    dkim       TXT selector       signatures validate
--    dmarc      TXT _dmarc         a policy exists at all
--
--  Only ownership gates activation. The rest are advisory and shown as a
--  checklist, because a customer mid-migration legitimately has old MX
--  records for days and blocking them on that helps nobody.
-- ============================================================================

ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS spf_verified_at   timestamptz;
ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS dkim_verified_at  timestamptz;
ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS dmarc_verified_at timestamptz;
ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS last_checked_at   timestamptz;

-- Free-text reason from the last check. Shown to the admin verbatim, because
-- "NXDOMAIN looking up TXT" tells whoever manages their DNS far more than
-- "verification failed" does.
ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS last_check_result text;

-- ----------------------------------------------------------------------------
--  Domains we own and hand out
-- ----------------------------------------------------------------------------
--
--  Every new organisation gets a working address on OUR domain immediately —
--  abcschool.tatvaos.com — so they can sign in, create people and send mail
--  the same afternoon. Their own domain is added and verified later, from
--  inside their console, with no rush and no risk to their existing mail.
--
--  Making the customer verify DNS before they can log in at all is how
--  onboarding stalls for a week: the person evaluating the product is rarely
--  the person who can edit DNS.
--
--  is_platform marks these so they cannot be deleted by a customer, and so
--  billing can tell a free subdomain from a domain they brought.
-- ----------------------------------------------------------------------------

ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;

-- A platform subdomain is verified by construction: we own the parent zone.
-- Recording it as verified rather than special-casing it everywhere keeps one
-- code path for "can this domain receive mail".
COMMENT ON COLUMN core.domains.is_platform IS
    'Subdomain of a domain TatvaOS owns. Verified by construction, not deletable by the customer.';

CREATE INDEX IF NOT EXISTS idx_core_domains_platform
    ON core.domains(tenant_id) WHERE is_platform;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Domain verification ready — five independent checks';
    RAISE NOTICE '  Only ownership gates activation; the rest are advisory.';
    RAISE NOTICE '';
END $$;
