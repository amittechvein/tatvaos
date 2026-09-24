namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The Message-ID a system email carries.
///
/// ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
///
///  Amit forwarded a sign-in link on 24 September 2026 that Gmail had filed
///  as spam. Its headers read:
///
///      Message-ID: <6ab4ed00...SMTPIN_ADDED_MISSING@mx.google.com>
///
///  That is GMAIL'S id, not ours: the message arrived without one and the
///  receiving server invented it. System.Net.Mail writes no Message-ID, and
///  Postfix did not add one either, so every invitation, sign-in link,
///  welcome, alert and OTP this platform has sent went out unidentified. A
///  missing Message-ID is a spam signal, it breaks threading in the
///  recipient's client, and it means a bounce cannot be tied back to what
///  was sent.
///
///  MailSender learned the same lesson for WEBMAIL on 3 September, when
///  Gmail received ids on the container's hostname. This is that fix for the
///  other path, three weeks later.
///
/// ── THE DOMAIN IS THE SENDER'S ───────────────────────────────────────────
///
///  Never the machine's hostname: inside a container that is a random hex
///  Docker id which resolves to nothing, and receivers check.
/// </summary>
public static class MailIdentity
{
    /// <summary>
    /// A Message-ID for a message sent as <paramref name="sender"/>, with the
    /// angle brackets a header needs. Unique per call: random, and stamped
    /// with the time, so two messages in the same millisecond still differ.
    /// </summary>
    public static string MessageIdFor(string? sender)
    {
        var at = sender?.LastIndexOf('@') ?? -1;
        var domain = at >= 0 && at < sender!.Length - 1
            ? sender[(at + 1)..].Trim().Trim('>').ToLowerInvariant()
            : "tatvaos.com";           // a sender we cannot read is still ours
        if (domain.Length == 0) domain = "tatvaos.com";

        var unique = Guid.NewGuid().ToString("N");
        var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return $"<{unique}.{stamp}@{domain}>";
    }
}
