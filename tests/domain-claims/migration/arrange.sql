-- The already-deployed state: rows a running platform has, including the
-- case that was IMPOSSIBLE before this migration — two organisations with a
-- pending claim on one name.
INSERT INTO core.domains (tenant_id, fqdn, ownership_verified_at, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'school.test',   NULL, now() - interval '40 days'),
  ('22222222-2222-2222-2222-222222222222', 'school.test',   NULL, now() - interval '2 days'),
  ('11111111-1111-1111-1111-111111111111', 'verified.test', now(), now() - interval '90 days');

-- And the rule that must still hold: a SECOND verified row for one name is
-- refused. Recorded as a row so it can be asserted afterwards.
CREATE TABLE IF NOT EXISTS probe (what text, refused boolean);
DO $$
BEGIN
    INSERT INTO core.domains (tenant_id, fqdn, ownership_verified_at)
    VALUES ('33333333-3333-3333-3333-333333333333', 'verified.test', now());
    INSERT INTO probe VALUES ('second verified row', false);
EXCEPTION WHEN unique_violation THEN
    INSERT INTO probe VALUES ('second verified row', true);
END $$;
