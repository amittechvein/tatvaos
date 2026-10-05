# ============================================================================
#  The three test phone numbers, made true before a suite signs in by them.
# ============================================================================
#
#  Suites sign in by OTP with fixed numbers:
#
#    +919999900001  amit@techvein.local        Techvein's owner
#    +919999900002  hr@techvein.local          a Techvein employee
#    +919999900003  principal@abcschool.local  ABC School's administrator
#
#  The seed (0002-seed.sql) gives nobody a phone. For weeks these numbers
#  existed only because someone had set them by hand in a local database; on
#  28 Sept 2026 they had gone, and two Connect suites (invitation caps, mute
#  all) failed at sign-in with nothing to do with what they test. The old
#  per-suite line - SET phone = ... WHERE ... AND phone IS NULL - does not
#  help when the person already has a DIFFERENT number, or another person
#  holds this one.
#
#  So: each number is taken from anyone else who has it, then given to its
#  person, every run. Test databases only - never point a suite at production.
#
#  Usage, after the suite's PG helper exists and the database answers:
#    . "$(dirname "$0")/../support/test-phones.sh"
#    PG "$TEST_PHONES_SQL" >/dev/null
# ============================================================================
TEST_PHONES_SQL="
UPDATE core.users SET phone = NULL
 WHERE (phone = '+919999900001' AND email <> 'amit@techvein.local')
    OR (phone = '+919999900002' AND email <> 'hr@techvein.local')
    OR (phone = '+919999900003' AND email <> 'principal@abcschool.local');
UPDATE core.users SET phone = '+919999900001', login_otp_sent_at = NULL, login_otp_attempts = 0 WHERE email = 'amit@techvein.local';
UPDATE core.users SET phone = '+919999900002', login_otp_sent_at = NULL, login_otp_attempts = 0 WHERE email = 'hr@techvein.local';
UPDATE core.users SET phone = '+919999900003', login_otp_sent_at = NULL, login_otp_attempts = 0 WHERE email = 'principal@abcschool.local';
SELECT count(*) FROM core.users
 WHERE (email, phone) IN (('amit@techvein.local', '+919999900001'),
                          ('hr@techvein.local', '+919999900002'),
                          ('principal@abcschool.local', '+919999900003'));"
