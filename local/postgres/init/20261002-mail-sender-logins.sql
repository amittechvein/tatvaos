-- ============================================================================
--  mail.sender_logins(sender) - who may put this address in MAIL FROM on
--  port 587. Postfix's smtpd_sender_login_maps asks it
--  (local/postfix/sql/sender-login-maps.cf).
-- ============================================================================
--
--  THE HOLE (found 1 Oct 2026, proven on the local stack 2 Oct). Port 587
--  required a sign-in and then let the signed-in user claim ANY sender.
--  Signed in as ABC School's principal, mail as Techvein's amit@ was queued
--  (250), and so was mail as ceo@bank.example. One organisation's account
--  could send as another organisation, and past the outbound gate, which
--  judges the address claimed, not the person signed in. Our DKIM signer
--  signs by the From domain, so such a message would very likely have
--  carried the impersonated domain's real signature.
--
--  THE ANSWER this function gives, for an envelope sender:
--   * a mailbox (user, shared or group): its own sign-in, which is the
--     mailbox's address (Dovecot authenticates by address, lowercased);
--   * a SHARED mailbox, as well: the personal mailbox of everyone holding
--     send_as, send_on_behalf or full on it. Not 'read';
--   * an ALIAS: the mailbox it delivers to;
--   * anything else: nothing. Postfix then refuses a signed-in sender with
--     "553 5.7.1 Sender address rejected: not owned by user".
--
--  Only SIGNED-IN sessions are checked (reject_authenticated_sender_login_
--  mismatch in main.cf), so the API's port 10587, which has no sign-in and
--  serves our own web app on our own network, is not affected.
--
--  Inactive mailboxes and aliases own nothing; a suspended person or
--  organisation cannot sign in at all (Dovecot's passdb), so that is not
--  repeated here.
--
--  SECURITY DEFINER because the answer needs mail.mailbox_permissions,
--  which the mail edge must not read wholesale. It gets EXECUTE on this
--  function and nothing more, and the function returns sign-in names for
--  one address, which is what Postfix already compares against the
--  session. search_path pinned with pg_temp last, as every definer here.
--  Addresses compared with lower(), because the citext operators live
--  outside the pinned path and case must not be a way round.
--
--  local/scripts/test-mail.sh, section "Port 587", runs the cases on the
--  real stack with production's 587 rules.
-- ============================================================================

CREATE OR REPLACE FUNCTION mail.sender_logins(sender text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, mail, core, pg_temp
AS $$
    SELECT string_agg(DISTINCT login, ',' ORDER BY login)
      FROM (
            -- The mailbox itself: its own sign-in.
            SELECT lower(m.address::text) AS login
              FROM mail.mailboxes m
             WHERE lower(m.address::text) = lower(sender)
               AND m.is_active
            UNION
            -- People with a send right on it, signing in as their own mailbox.
            SELECT lower(own.address::text)
              FROM mail.mailboxes m
              JOIN mail.mailbox_permissions p
                ON p.mailbox_id = m.id
               AND p.permission IN ('send_as', 'send_on_behalf', 'full')
              JOIN mail.mailboxes own
                ON own.user_id = p.user_id
               AND own.type = 'user'
               AND own.is_active
               AND own.tenant_id = m.tenant_id
             WHERE lower(m.address::text) = lower(sender)
               AND m.is_active
            UNION
            -- An alias: the mailbox it delivers to.
            SELECT lower(t.address::text)
              FROM mail.aliases a
              JOIN mail.mailboxes t
                ON t.id = a.target_mailbox_id
               AND t.is_active
             WHERE lower(a.address::text) = lower(sender)
               AND a.is_active
           ) owners
$$;

REVOKE ALL ON FUNCTION mail.sender_logins(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mail.sender_logins(text) TO tatvaos_mailedge;
