using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;

namespace TatvaOS.Api.Shared.Auth;

/// <summary>
/// The one implementation of "how a new person gets in" — decision 0005.
///
/// Three callers share it and must not drift: the single "add a person"
/// form, the CSV import, and "resend invitation" on a person's profile. The
/// rule, per person:
///
///   typed password           → that password, must be changed at first sign-in,
///                              NO invitation (the admin said how they get in)
///   blank + recovery email   → no usable password at all; a link goes there
///   blank + phone only       → treated as NO recovery info until an SMS
///                              template that may carry a link is registered
///                              with the provider (a launch rule, Amit's task)
///   blank + nothing          → refused: the admin must type a password
///
/// A person with no usable password has PasswordHash null, and sign-in
/// refuses every password for them — the link is the only way in, it is
/// single-use, and it dies after <see cref="Lifetime"/>.
/// </summary>
public static class Invitations
{
    /// <summary>
    /// 72 hours, not the reset link's one: a school onboarding on a Friday
    /// afternoon needs the link to survive the weekend. Proposed in 0005;
    /// Amit's to change.
    /// </summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(72);

    /// <summary>
    /// Flip when the SMS provider has approved a template that carries a
    /// link. Until then a phone-only person gets no invitation and the admin
    /// types a password — see the header. Kept as a constant rather than a
    /// setting so that turning it on is a reviewed change, not a console
    /// click that starts sending texts the carrier drops.
    /// </summary>
    public const bool SmsInvitationsAvailable = false;

    /// <summary>The refusal, word for word, wherever it is refused.</summary>
    public const string NoWayIn =
        "No recovery email or phone for this person — type a password to hand to them.";

    /// <summary>What the person sees for a dead link. One sentence for expired,
    /// used, tampered and unknown alike; the server cannot tell them apart and
    /// should not try.</summary>
    public const string Expired =
        "This invitation has expired. Ask your administrator to send a new one.";

    /// <summary>
    /// Which channel an invitation would use for this person, or null when
    /// there is no recovery route and the admin has to type a password.
    /// </summary>
    public static string? ChannelFor(string? recoveryEmail, string? phone)
    {
        if (!string.IsNullOrWhiteSpace(recoveryEmail)) return "email";
#pragma warning disable CS0162 // unreachable while the launch rule holds
        if (SmsInvitationsAvailable && !string.IsNullOrWhiteSpace(phone)) return "phone";
#pragma warning restore CS0162
        return null;
    }

    /// <summary>
    /// Mints a fresh token onto the row and returns it RAW, once, for the
    /// message. Only its hash is kept. Any earlier link stops working here —
    /// a resend is a replacement, never a second copy.
    /// </summary>
    public static string Issue(User user, string channel)
    {
        var token = TokenIssuer.GenerateRefreshToken();
        user.InviteTokenHash = TokenIssuer.HashRefreshToken(token);
        user.InviteSentAt = DateTimeOffset.UtcNow;
        user.InviteChannel = channel;
        user.InviteDelivered = null;
        user.InviteAcceptedAt = null;
        return token;
    }

    /// <summary>
    /// The link. The token rides in the FRAGMENT, as decision 0003 chose for
    /// the handoff: a query string reaches the server, every proxy, and any
    /// access log; a fragment never leaves the browser. The welcome page
    /// scrubs it from the address bar before doing anything else.
    /// </summary>
    public static string Link(string baseUrl, string token) =>
        $"{baseUrl.TrimEnd('/')}/welcome#t={Uri.EscapeDataString(token)}";

    public static bool IsExpired(User user) =>
        user.InviteSentAt is null || DateTimeOffset.UtcNow - user.InviteSentAt > Lifetime;

    /// <summary>
    /// What the people list says about this person's invitation, from the
    /// columns alone so the list can compute it in a projection:
    /// null (nothing to say — never invited, or already in), "pending",
    /// "expired", or "undelivered". Order matters: a link that never left the
    /// building is "undelivered" even once it has also expired, because that
    /// is the fact the admin has to act on.
    /// </summary>
    public static string? State(
        string? inviteTokenHash, string? passwordHash,
        DateTimeOffset? sentAt, bool? delivered, DateTimeOffset? acceptedAt)
    {
        if (inviteTokenHash is null || acceptedAt is not null || passwordHash is not null) return null;
        if (delivered == false) return "undelivered";
        if (sentAt is null || DateTimeOffset.UtcNow - sentAt > Lifetime) return "expired";
        return "pending";
    }

    /// <summary>
    /// Sends the email invitation and reports what the mail edge said. The
    /// caller records the answer in <see cref="User.InviteDelivered"/>; this
    /// is the one send that is NOT best-effort-and-forgotten.
    /// </summary>
    public static Task<bool> SendAsync(
        SystemMailer mailer, User user, string orgName, string baseUrl, string token,
        CancellationToken ct = default)
    {
        var to = user.RecoveryEmail
                 ?? throw new InvalidOperationException("An email invitation needs a recovery email.");
        return mailer.SendHtmlAsync(
            to,
            InviteEmail.Subject(orgName),
            InviteEmail.Html(user.DisplayName, orgName, baseUrl, user.Email,
                             Link(baseUrl, token), (int)Lifetime.TotalHours),
            from: "no_reply@tatvaos.com",
            ct: ct);
    }
}
