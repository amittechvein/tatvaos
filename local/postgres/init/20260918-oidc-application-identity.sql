-- ============================================================================
--  OpenID Connect applications — who the application says it is (decision
--  0004; Amit's review of the Applications page, 18 Sept 2026, group 2)
-- ============================================================================
--
--  Before a customer connects a THIRD-PARTY application, a person deciding
--  on the consent screen needs more than a name: what it is, who operates
--  it, where its privacy policy is, and who to write to. These columns hold
--  that.
--
--  STANDARD NAMES WHERE STANDARD NAMES EXIST (CTO, 18 Sept 2026): client_uri,
--  logo_uri, policy_uri, tos_uri and contacts are OpenID Connect client
--  metadata (RFC 7591 §2). Using them costs nothing now and means these
--  fields already match if dynamic client registration ever arrives.
--  description and operator_name are NOT standard; they are ours, and are
--  named plainly rather than dressed up as protocol fields.
--
--  THE LOGO IS OURS TO SERVE, NEVER HOTLINKED. The bytes are stored here and
--  served from our own endpoint. If the consent screen loaded an image from
--  the application's own server, every person who reached that screen would
--  have their IP address handed to the application BEFORE agreeing to
--  anything, and the application could swap the image after the administrator
--  approved it — a logo that passed review becoming something else, on a
--  security screen (CTO, 18 Sept 2026). So logo_uri holds OUR url, and the
--  console takes an upload rather than an address.
--
--  WHAT WE VOUCH FOR AND WHAT IS CLAIMED ARE DIFFERENT THINGS. Everything in
--  this file except created_by is a string somebody typed into a form. The
--  consent screen presents it as the application's own description of itself,
--  visually separate from "Added by <organisation> administrators", which is
--  a fact we can vouch for. A self-declared company name rendered with the
--  authority of a checked one is a phishing vector, and the whole trick is
--  making people read the first as the second.
--
--  Additive and re-runnable, like every file here.
-- ----------------------------------------------------------------------------

ALTER TABLE core.oidc_applications
    ADD COLUMN IF NOT EXISTS description       text,
    ADD COLUMN IF NOT EXISTS operator_name     text,
    ADD COLUMN IF NOT EXISTS client_uri        text,
    ADD COLUMN IF NOT EXISTS policy_uri        text,
    ADD COLUMN IF NOT EXISTS tos_uri           text,
    ADD COLUMN IF NOT EXISTS contacts          text,
    -- Our hosted copy of the logo. logo_content_type is the ONLY type it is
    -- ever served as, so a file claiming to be a PNG cannot be served as
    -- something a browser will execute. SVG is refused on upload: it is a
    -- document that can carry script, and this one is rendered on a consent
    -- screen of all places.
    ADD COLUMN IF NOT EXISTS logo_bytes        bytea,
    ADD COLUMN IF NOT EXISTS logo_content_type text,
    ADD COLUMN IF NOT EXISTS logo_updated_at   timestamptz;

COMMENT ON COLUMN core.oidc_applications.description IS
    'What the application says it does. Claimed, not verified.';
COMMENT ON COLUMN core.oidc_applications.operator_name IS
    'Who the application says operates it. Claimed, not verified — never render this with the authority of "Added by <org> administrators".';
COMMENT ON COLUMN core.oidc_applications.contacts IS
    'Support addresses, comma separated. RFC 7591 calls this contacts and makes it an array; stored as text like OpenIddict''s own list columns.';
COMMENT ON COLUMN core.oidc_applications.logo_bytes IS
    'Our copy of the logo. Never hotlinked from the application''s own server: that would hand every person who reaches the consent screen to the application before they agree to anything, and let the image change after approval.';

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  OpenID Connect applications: identity columns ready (0004, group 2)';
    RAISE NOTICE '';
END $$;
