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
    public const int MinimumLength = 12;

    /// <summary>The sentence every caller shows, so they all say it the same
    /// way and the number cannot drift out of the wording.</summary>
    public static string TooShort =>
        $"Use at least {MinimumLength} characters. A short phrase you can " +
        "remember beats a short password you cannot.";
}
