-- ============================================================================
--  Platform settings — provider credentials the super admin manages at runtime
-- ============================================================================
--
--  SMS gateway, SSO, payment keys, mail identity. These live in the database
--  rather than .env because the person who rotates an Infobip password is an
--  administrator with a browser, not an operator with SSH — and a credential
--  change should not require a deploy.
--
--  Secrets are stored as values but the API never returns them: a GET says
--  only whether one is set. The one place that would leak them is the endpoint
--  that deliberately does not.
--
--  NO RLS — these are platform-wide, there is no tenant to scope to. Access
--  control is the SuperAdmin policy on the endpoints. The mail edge gets no
--  grant at all: Postfix has no business reading payment keys.

CREATE TABLE IF NOT EXISTS core.platform_settings (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    is_secret  boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.platform_settings TO tatvaos_app;

-- Defaults that make sense before anyone opens the screen. Secrets are never
-- seeded — an empty secret is the honest state.
INSERT INTO core.platform_settings (key, value, is_secret) VALUES
    ('sms.infobip.base_url',   'https://api.infobip.com', false),
    ('sms.otp_template',       'Your TatvaOS verification code is {{otp}}. It expires in 10 minutes.', false),
    ('sms.country_prefix',     '91', false),
    -- ON until a real SMS provider is configured, or nobody can complete
    -- signup at all. The settings screen nags to turn it off before go-live.
    ('sms.show_otp_on_screen', 'true', false),
    ('mail.smtp_from',         'no-reply@tatvaos.com', false)
ON CONFLICT (key) DO NOTHING;

DO $$ BEGIN
    RAISE NOTICE '  Platform settings ready';
END $$;
