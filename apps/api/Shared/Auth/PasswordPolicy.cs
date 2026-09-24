namespace TatvaOS.Api.Shared.Auth;

/// <summary>
/// How long a password has to be — in ONE place.
///
/// The number lived in AuthEndpoints as a private const, was used from two
/// places there, and was ALSO written as a bare 12 in a third, with the
/// sentence "at least 12 characters" spelled out in two message strings on top
/// of that. A fifth copy was about to appear in the CSV import, which has to
/// validate admin-supplied passwords.
///
/// Copies of one number is how an import quietly accepts a password the
/// change-password screen would refuse — and the person then cannot set that
/// password again themselves, from a screen that never explains why.
///
/// It is deliberately not configurable. A per-organisation minimum is a real
/// feature with real consequences — an admin lowering it for convenience
/// weakens every account in that organisation, silently — and it should arrive
/// as that feature, with an audit row and a conversation, rather than as a
/// constant that quietly grew a setting.
/// </summary>
public static class PasswordPolicy
{
    // ── 12, AND IT WAS 8 FOR A DAY. ─────────────────────────────────────
    //  Amit lowered it to 8 on seeing the sign-in screen's "At least 12
    //  characters" (PR 203, live 23 Sept 2026 17:33 UTC). Mr. Singh's ruling
    //  on 203 was that 8 does not ship WITHOUT a common-password blocklist:
    //  two-step verification is off on every account, so at 8 with no list,
    //  "password" is a working password for any user. It shipped without one.
    //  Put back to 12 on 24 Sept — a one-number return to a state known safe.
    //
    //  8 comes back only TOGETHER with the blocklist, checked on every path a
    //  password is set (signup, change, admin-set, bulk-create). Lowering this
    //  number on its own again reopens exactly this.
    //
    //  Existing passwords are unaffected either way: this governs what a NEW
    //  password must be. Anything set at 8-11 characters while it was live is
    //  still valid, and is the blocklist's job to catch at next sign-in.
    //  BootstrapAdmin keeps its own 12: the first super admin is set by an
    //  operator, not typed by a customer.
    // ─────────────────────────────────────────────────────────────────────
    public const int MinimumLength = 12;

    /// <summary>The sentence every caller shows, so they all say it the same
    /// way and the number cannot drift out of the wording.</summary>
    public static string TooShort =>
        $"Use at least {MinimumLength} characters. A short phrase you can " +
        "remember beats a short password you cannot.";
}
