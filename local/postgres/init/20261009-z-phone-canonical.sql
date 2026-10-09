-- ============================================================================
--  core.users.phone: one spelling (issue #327, found 27 Sept 2026; fixed 9 Oct).
--
--  Sign-in by OTP, the OTP password reset and the phone change all look a
--  number up with  u.phone = <typed>.  Administrators stored numbers however
--  they typed them, so "+919876543210" on the row and "98765 43210" at the
--  door never met: the person was told no account has that number.
--
--  From 9 Oct the API stores AND compares PhoneNumber.Stored(): an Indian
--  mobile in any of its bare spellings becomes +91XXXXXXXXXX, a number that
--  carries its "+" is kept, anything else (a landline, a bare non-Indian
--  number) is kept as Normalise left it. core.phone_canonical() below is
--  that rule in SQL; this file brings the rows already there to it.
--
--  Additive and re-runnable: UPDATE only where the spelling changes. A row
--  is LEFT ALONE when canonicalising it would make two live accounts share
--  one number - the sign-in code fails closed on an ambiguous number, so
--  rewriting would break sign-in for BOTH where today one of them works.
--  Those are counted and WARNED (deploy.sh prints WARNING lines, PR 362) for
--  a person to resolve. Production on 9 Oct 2026: 5 phones - 1 canonical,
--  3 to rewrite, 1 colliding pair.
-- ============================================================================

CREATE OR REPLACE FUNCTION core.phone_canonical(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE
        WHEN n ~ '^\+[0-9]{8,15}$'    THEN n
        WHEN n ~ '^[6-9][0-9]{9}$'    THEN '+91' || n
        WHEN n ~ '^0[6-9][0-9]{9}$'   THEN '+91' || substr(n, 2)
        WHEN n ~ '^91[6-9][0-9]{9}$'  THEN '+' || n
        ELSE NULL END
    FROM (SELECT regexp_replace(raw, '[[:space:]()-]', '', 'g') AS n) s;
$$;

DO $$
DECLARE rewritten int; colliding int;
BEGIN
    -- Live rows whose canonical spelling another LIVE row also has (in any
    -- spelling): counted, and left exactly as they are below.
    WITH live AS (
        SELECT id, core.phone_canonical(phone) AS c
          FROM core.users
         WHERE phone IS NOT NULL AND status NOT IN ('deleted', 'suspended')
    )
    SELECT count(*) INTO colliding
      FROM live
     WHERE c IS NOT NULL
       AND c IN (SELECT c FROM live WHERE c IS NOT NULL GROUP BY c HAVING count(*) > 1);

    UPDATE core.users u
       SET phone = core.phone_canonical(u.phone)
     WHERE u.phone IS NOT NULL
       AND core.phone_canonical(u.phone) IS NOT NULL
       AND core.phone_canonical(u.phone) <> u.phone
       AND NOT EXISTS (
           SELECT 1 FROM core.users o
            WHERE o.id <> u.id
              AND o.phone IS NOT NULL
              AND o.status NOT IN ('deleted', 'suspended')
              AND core.phone_canonical(o.phone) = core.phone_canonical(u.phone));
    GET DIAGNOSTICS rewritten = ROW_COUNT;

    IF rewritten > 0 THEN
        RAISE NOTICE 'phone canonical: % row(s) rewritten to +91 form', rewritten;
    END IF;
    IF colliding > 0 THEN
        RAISE WARNING 'phone canonical: % live account(s) hold one number in different spellings - left as they are; a person resolves them (two accounts cannot both sign in by one number)', colliding;
    END IF;
END $$;
