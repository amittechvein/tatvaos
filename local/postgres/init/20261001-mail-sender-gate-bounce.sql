-- ============================================================================
--  mail.sender_gate_class(sender) - the outbound gate's one decision, for
--  every kind of envelope sender, including the send API's bounce addresses.
-- ============================================================================
--
--  THE GAP (found 1 Oct 2026, writing decision 0013). Postfix's outbound gate
--  (local/postfix/sql/sender-external-gate.cf, the check_sender_access both
--  submission ports run) asked "is the ENVELOPE sender a mailbox that may not
--  send outside?". The organisation send API, with bounce tracking on, submits
--  with a signed bounce address as envelope sender (BounceAddress.Build:
--  "<send id, 32 hex>.<key id>.<days>.<sig>@<bounce domain>"), which is not a
--  mailbox. The lookup found nothing, Postfix treated that as "no objection",
--  and the verified-domain rule - outside mail only from an organisation that
--  owns and routes its own domain - did not apply to that mail at all. Off on
--  production that day only because no bounce signing key was set yet; it
--  would have opened, silently, the day one was.
--
--  NOW the gate asks this function instead, and it answers for:
--   * a mailbox            - as before: 'internal_only' if it is not in
--                            mail.senders_allowed_external, else nothing;
--   * a bounce address     - the send it names (mail.api_send_envelopes, by
--                            the id at its start) and the mailbox that send
--                            was FROM, judged exactly as above;
--   * a bounce-shaped address with NO send behind it - 'internal_only'. It
--                            fails CLOSED: the send API writes the envelope
--                            record before it submits (MailSendApiEndpoints),
--                            so a missing one is a fault, and a fault must show
--                            up as refused mail, not as mail that slipped past;
--   * anything else        - nothing, as before (Postfix's next check decides).
--
--  Not a signature check: the id alone finds the record, and a forged address
--  can only point at a send that already exists - judged by the mailbox that
--  really sent it. (Whether a mail-app user on port 587 can claim another
--  address at all is a separate question; see the PR that added this file.)
--
--  WHY A TABLE OF ITS OWN, AND NOT mail.api_sends. The gate needs the send's
--  from-address at the moment Postfix answers RCPT, which is BEFORE the send
--  has an outcome. mail.api_sends is one row per attempt WITH its outcome, and
--  is append-only for the app on purpose (20260905-mail-bounce-intake.sql
--  revokes UPDATE and DELETE). The first version of this fix wrote that row
--  early as "refused / not yet submitted" and UPDATEd it after the submit: the
--  test caught every send failing with "permission denied for table api_sends".
--  Loosening that grant, or a definer that edits the outcome after the fact,
--  would make the send log something the app can rewrite. So the app records
--  the one fact the gate needs - this id sends as this mailbox - in a table
--  that is append-only too, then writes api_sends after the submit exactly as
--  it always has. If the process dies between the two, api_sends has no row
--  for that send, as it would have before this change.
--
--  Kept like api_sends (no retention limit, Amit's decision for the send log);
--  one short row per send. Pruning it later is safe for the gate - it only
--  needs a record for the seconds a submit takes - and is not done here.
--
--  SECURITY DEFINER because the mail edge must read mail.api_send_envelopes
--  here and nowhere else; it gets EXECUTE on this function, no grant on the
--  table. Returns one short word and nothing about the send. search_path
--  pinned with pg_temp last, as every definer here. Addresses compared with
--  lower(): the citext operators live in a schema the pinned path leaves out,
--  and a case-sensitive match would let "Name@School.example" past a rule
--  that "name@school.example" is held to.
--
--  tests/mail-api/test-bounce-gate.sh: the gate's real query text, the real
--  send API with bounce tracking on through a stand-in that decides as Postfix
--  does at submit time, and the grants on both tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.api_send_envelopes (
    -- The send's id: the same one mail.api_sends gets after the submit, and
    -- the one encoded at the start of its bounce address.
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    from_address text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mail.api_send_envelopes IS
    'Which mailbox each send-API send goes out as, written BEFORE the submit so '
    'Postfix''s outbound gate (mail.sender_gate_class) can judge a bounce-'
    'tracked envelope by it. Append-only for the app. See '
    '20261001-mail-sender-gate-bounce.sql.';

ALTER TABLE mail.api_send_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.api_send_envelopes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail.api_send_envelopes;
CREATE POLICY tenant_isolation ON mail.api_send_envelopes
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 0001-mail-schema.sql grants the app every write on every mail table, on
-- every deploy, and its default privileges do the same for new tables. This
-- file sorts after it, so the REVOKE re-runs after the blanket grant each
-- time and the table stays append-only, as api_sends does.
GRANT  SELECT, INSERT ON mail.api_send_envelopes TO   tatvaos_app;
REVOKE UPDATE, DELETE ON mail.api_send_envelopes FROM tatvaos_app;
REVOKE ALL            ON mail.api_send_envelopes FROM tatvaos_mailedge;

CREATE OR REPLACE FUNCTION mail.sender_gate_class(sender text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, mail, core, pg_temp
AS $$
DECLARE
    who text;
BEGIN
    IF sender IS NULL OR sender = '' THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM mail.mailboxes m WHERE lower(m.address::text) = lower(sender)) THEN
        who := sender;
    ELSIF sender ~ '^[0-9a-f]{32}\.[A-Za-z0-9]{1,16}\.[0-9]+\.[0-9a-f]+@[^@]+$' THEN
        SELECT e.from_address INTO who
          FROM mail.api_send_envelopes e
         WHERE e.id = substring(sender from 1 for 32)::uuid;
        IF who IS NULL THEN
            RETURN 'internal_only';            -- no send behind it: fail closed
        END IF;
    ELSE
        RETURN NULL;                           -- not ours to judge, as before
    END IF;

    IF EXISTS (SELECT 1 FROM mail.senders_allowed_external a WHERE lower(a.address::text) = lower(who)) THEN
        RETURN NULL;
    END IF;
    RETURN 'internal_only';
END
$$;

REVOKE ALL ON FUNCTION mail.sender_gate_class(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mail.sender_gate_class(text) TO tatvaos_mailedge;
