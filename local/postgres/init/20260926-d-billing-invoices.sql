-- ============================================================================
--  Billing, part 1: GST invoices (Amit, 26 Sept 2026).
--
--  His decisions the same day:
--    * invoices AND Razorpay online payment (Razorpay is part 2)
--    * prices are PLUS 18% GST
--    * monthly and yearly billing
--    * unpaid: warn, then read-only after a grace period (part 3)
--
--  AN ISSUED INVOICE NEVER CHANGES. Seller and buyer details, prices and
--  taxes are COPIED onto the invoice when it is issued. A plan price edited
--  next month, or a customer who changes their GSTIN, must not rewrite a tax
--  document already sent. Mistakes are corrected by voiding and re-issuing,
--  never by UPDATE — the one UPDATE allowed is recording payment or the void.
--
--  NUMBERING. GST requires invoice numbers to be consecutive and unique in a
--  financial year (April-March). core.invoice_sequences hands out the next
--  number inside the same transaction that writes the invoice, so a failed
--  issue does not burn a number. A voided invoice keeps its number (a gap
--  explained by a void is allowed; a silent gap is not).
--
--  Additive only; re-runs on every deploy.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1. Yearly prices. NULL = twelve times the monthly price.
-- ----------------------------------------------------------------------------
ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS price_per_user_yearly numeric(10,2);
ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS price_yearly          numeric(10,2);

-- ----------------------------------------------------------------------------
--  2. Monthly or yearly, per organisation. renews_at (already here) is when
--     the next period starts, and so when the next invoice is due to issue.
-- ----------------------------------------------------------------------------
ALTER TABLE core.subscriptions ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_billing_cycle_check'
                   AND conrelid = 'core.subscriptions'::regclass) THEN
        ALTER TABLE core.subscriptions ADD CONSTRAINT subscriptions_billing_cycle_check
            CHECK (billing_cycle IN ('monthly', 'yearly'));
    END IF;
END $$;

-- ----------------------------------------------------------------------------
--  3. Who the invoice is made out to. One row per organisation; the
--     organisation's administrator edits it, and so can the operator.
--     state_code is the two-digit GST state code (27 Maharashtra, 29
--     Karnataka, 10 Bihar ...): it decides CGST+SGST versus IGST.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.billing_profiles (
    tenant_id     uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    legal_name    text NOT NULL CHECK (length(btrim(legal_name)) > 0),
    gstin         text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
    address       text NOT NULL CHECK (length(btrim(address)) > 0),
    state_code    text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
    pincode       text CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
    email         text NOT NULL CHECK (email LIKE '%@%'),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    -- A GSTIN starts with its state code; a mismatch is a typo that would
    -- put the wrong tax on the invoice.
    CONSTRAINT billing_profiles_gstin_state CHECK (gstin IS NULL OR left(gstin, 2) = state_code)
);

-- ----------------------------------------------------------------------------
--  4. The numbering, platform-wide: one row per financial year ('2026-27').
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.invoice_sequences (
    financial_year  text PRIMARY KEY CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
    last_seq        integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
);

-- ----------------------------------------------------------------------------
--  5. Invoices and their lines.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.invoices (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES core.tenants(id) ON DELETE RESTRICT,
    number            text NOT NULL UNIQUE,
    financial_year    text NOT NULL,
    seq               integer NOT NULL CHECK (seq > 0),
    status            text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
    issued_on         date NOT NULL,
    due_on            date NOT NULL,
    period_start      date,
    period_end        date,
    billing_cycle     text CHECK (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'yearly')),
    currency          text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    -- Snapshots taken at issue. jsonb because they are shown, never queried.
    seller            jsonb NOT NULL,
    buyer             jsonb NOT NULL,
    place_of_supply   text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
    subtotal          numeric(12,2) NOT NULL CHECK (subtotal >= 0),
    cgst              numeric(12,2) NOT NULL DEFAULT 0 CHECK (cgst >= 0),
    sgst              numeric(12,2) NOT NULL DEFAULT 0 CHECK (sgst >= 0),
    igst              numeric(12,2) NOT NULL DEFAULT 0 CHECK (igst >= 0),
    total             numeric(12,2) NOT NULL CHECK (total >= 0),
    -- Payment: one payment settles one invoice. Part 2 (Razorpay) fills
    -- payment_method = 'razorpay' and the reference from the webhook.
    paid_on           date,
    paid_amount       numeric(12,2),
    payment_method    text CHECK (payment_method IS NULL OR payment_method IN
                                  ('bank_transfer', 'upi', 'cheque', 'cash', 'razorpay', 'other')),
    payment_reference text,
    recorded_by       uuid,
    voided_at         timestamptz,
    void_reason       text,
    created_by        uuid NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invoices_fy_seq UNIQUE (financial_year, seq),
    CONSTRAINT invoices_tax_shape CHECK ((igst = 0) OR (cgst = 0 AND sgst = 0)),
    CONSTRAINT invoices_total_adds_up CHECK (total = subtotal + cgst + sgst + igst),
    CONSTRAINT invoices_paid_shape CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
    CONSTRAINT invoices_void_shape CHECK ((status = 'void') = (voided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_invoices_tenant ON core.invoices (tenant_id, issued_on DESC);
CREATE INDEX IF NOT EXISTS ix_invoices_unpaid ON core.invoices (due_on) WHERE status = 'issued';

CREATE TABLE IF NOT EXISTS core.invoice_lines (
    invoice_id   uuid NOT NULL REFERENCES core.invoices(id) ON DELETE CASCADE,
    line_no      integer NOT NULL CHECK (line_no > 0),
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE RESTRICT,
    description  text NOT NULL CHECK (length(btrim(description)) > 0),
    sac          text NOT NULL,
    quantity     numeric(12,2) NOT NULL CHECK (quantity > 0),
    unit_price   numeric(12,2) NOT NULL CHECK (unit_price >= 0),
    amount       numeric(12,2) NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (invoice_id, line_no)
);

-- ----------------------------------------------------------------------------
--  6. RLS on everything per organisation. The sequence table is platform-wide
--     reference data (a number, no customer data) and has none.
--     Invoices are never deleted: DELETE is not granted.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['billing_profiles', 'invoices', 'invoice_lines'] LOOP
        EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON core.%I', t);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON core.%I
            USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.billing_profiles TO tatvaos_app;
GRANT SELECT, INSERT ON core.invoice_lines TO tatvaos_app;
REVOKE DELETE ON core.invoices, core.invoice_lines FROM tatvaos_app;
REVOKE UPDATE ON core.invoice_lines FROM tatvaos_app;
GRANT SELECT, INSERT, UPDATE ON core.invoice_sequences TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  7. "An issued invoice never changes", enforced HERE and not only in the
--     code (Mr. Singh, 26 Sept 2026; the same stance as the 15 Sept
--     append-only work). Two layers:
--
--     a) The app may INSERT an invoice and UPDATE only the columns that
--        record payment or void. The total, the buyer, the number: no
--        UPDATE privilege at all. Revoking table-level UPDATE also drops any
--        column grants, so this block re-grants them on every run; billing
--        part 2 adds its own payment columns in a later file.
--     b) A trigger allows only issued -> paid and issued -> void. A paid
--        invoice's payment record cannot be rewritten, a paid invoice cannot
--        become unpaid or void, and NOTHING on a void invoice changes.
--        Measured red first: before this, the app's role turned a paid
--        invoice into a void one carrying a forged payment reference.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT ON core.invoices TO tatvaos_app;
REVOKE UPDATE ON core.invoices FROM tatvaos_app;
GRANT UPDATE (status, paid_on, paid_amount, payment_method, payment_reference, recorded_by, voided_at, void_reason)
    ON core.invoices TO tatvaos_app;

CREATE OR REPLACE FUNCTION core.invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'void' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'invoice %: a void invoice cannot change', OLD.number USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'paid' AND (
           NEW.status IS DISTINCT FROM OLD.status
        OR NEW.paid_on IS DISTINCT FROM OLD.paid_on
        OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount
        OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
        OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
        OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
        OR NEW.voided_at IS DISTINCT FROM OLD.voided_at) THEN
        RAISE EXCEPTION 'invoice %: a paid invoice cannot become unpaid or void, or have its payment rewritten', OLD.number
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_invoices_guard ON core.invoices;
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE ON core.invoices
    FOR EACH ROW EXECUTE FUNCTION core.invoices_guard();

-- ----------------------------------------------------------------------------
--  8. GST caps an invoice number at 16 characters. The code keeps the prefix
--     to 3 letters (ABC/2026-27/0001 is exactly 16) and refuses a longer
--     number; this is the backstop whatever the code does.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_number_length'
                   AND conrelid = 'core.invoices'::regclass) THEN
        ALTER TABLE core.invoices ADD CONSTRAINT invoices_number_length CHECK (length(number) <= 16);
    END IF;
END $$;

DO $$
DECLARE n int; p int;
BEGIN
    SELECT count(*) INTO n FROM core.invoices;
    SELECT count(*) INTO p FROM core.billing_profiles;
    RAISE NOTICE 'billing-invoices: % invoice(s), % billing profile(s)', n, p;
END $$;
