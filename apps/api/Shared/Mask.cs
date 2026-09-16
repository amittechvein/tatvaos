namespace TatvaOS.Api.Shared;

/// <summary>
/// "Enough for the owner to recognise, not enough for anyone else to reuse."
///
/// One implementation, because these strings go into three places that must
/// agree — audit rows, the mail that says "a recovery email was added", and
/// the people list's "invitation sent to r•••@gmail.com". Until 16 Sept 2026
/// this lived as two private methods inside AuthEndpoints; the invitation work
/// needed it from the admin endpoints as well, and a second copy is how the
/// audit log and the screen end up masking differently.
/// </summary>
public static class Mask
{
    /// <summary>r•••@gmail.com</summary>
    public static string Email(string? email)
    {
        if (string.IsNullOrWhiteSpace(email)) return "";
        var at = email.IndexOf('@');
        return at <= 0 ? "•••" : email[0] + "•••" + email[at..];
    }

    /// <summary>+91•••••3210</summary>
    public static string Phone(string? phone)
    {
        if (string.IsNullOrWhiteSpace(phone)) return "";
        return phone.Length <= 4 ? "•••" : phone[..3] + "•••••" + phone[^4..];
    }
}
