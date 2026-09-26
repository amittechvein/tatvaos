-- ============================================================================
--  Billing, part 2: paying invoices online through Razorpay (Amit, 26 Sept
--  2026: "payment mode only online via razorpay").
--
--  Each unpaid invoice gets ONE Razorpay Payment Link for its exact total.
--  An invoice is marked paid by either of two independent proofs:
--    * Razorpay's webhook (payment_link.paid), signed with the webhook secret
--    * the customer's return to TatvaOS, signed with the key secret
--  Whichever arrives first records it; the other finds it already paid.
--
--  THE WEBHOOK HAS NO TENANT. It arrives with no session, so app.tenant_id is
--  unset and forced RLS shows it no invoices at all — reading through an
--  ordinary query would find nothing and still answer Razorpay 200, which is
--  exactly the silent failure recorded in ConnectWebhookEndpoints. The first
--  read goes through a SECURITY DEFINER function that returns only which
--  organisation and invoice a link belongs to; everything after runs inside
--  that organisation.
--
--  Additive only; re-runs on every deploy.
-- ============================================================================

ALTER TABLE core.invoices ADD COLUMN IF NOT EXISTS razorpay_link_id    text;
ALTER TABLE core.invoices ADD COLUMN IF NOT EXISTS razorpay_link_url   text;
ALTER TABLE core.invoices ADD COLUMN IF NOT EXISTS razorpay_payment_id text;
ALTER TABLE core.invoices ADD COLUMN IF NOT EXISTS emailed_at          timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_razorpay_link
    ON core.invoices (razorpay_link_id) WHERE razorpay_link_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_razorpay_payment
    ON core.invoices (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

-- Every webhook delivery, once. Razorpay retries until it gets a 2xx and may
-- deliver an event twice; the event id makes the second a no-op. Platform
-- data (ids and an outcome), no customer details.
CREATE TABLE IF NOT EXISTS core.razorpay_events (
    event_id     text PRIMARY KEY,
    event_type   text NOT NULL,
    invoice_id   uuid,
    outcome      text NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON core.razorpay_events TO tatvaos_app;

-- Which organisation and invoice a Payment Link belongs to — nothing else.
CREATE OR REPLACE FUNCTION core.invoice_by_razorpay_link(p_link_id text)
RETURNS TABLE (tenant_id uuid, invoice_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT i.tenant_id, i.id
      FROM core.invoices i
     WHERE i.razorpay_link_id = p_link_id
     LIMIT 1;
$$;
REVOKE ALL ON FUNCTION core.invoice_by_razorpay_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.invoice_by_razorpay_link(text) TO tatvaos_app;

DO $$
DECLARE linked int;
BEGIN
    SELECT count(*) INTO linked FROM core.invoices WHERE razorpay_link_id IS NOT NULL;
    RAISE NOTICE 'billing-razorpay: % invoice(s) with a Razorpay payment link', linked;
END $$;
