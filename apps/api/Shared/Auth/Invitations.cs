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

    // ── A SIGN-IN LINK FOR SOMEBODY WHO IS ALREADY IN ───────────────────────
    //  Amit, 19 Sept 2026, on the People page: "give option here send invitation
    //  of login with one use there they just add new password and get it login".
    //
    //  Until then an administrator helping somebody who had forgotten their
    //  password had one tool, Reset password: a generated password the admin
    //  SEES and has to hand over, the opposite of what decision 0005 wanted for
    //  new people. This is the same link a new person gets, sent to somebody
    //  who already has a password.
    //
    //  It rides the SAME token columns and the SAME accept endpoint on purpose:
    //  one single-use token per person, so sending this replaces any pending
    //  invitation and the reverse. What differs is the channel value, and three
    //  things hang on it:
    //    - a SHORTER life. An account with data in it is worth more to whoever
    //      finds the mail than an empty new one; a day, not a weekend.
    //    - the mail says why it came ("your administrator sent you this"), not
    //      "welcome".
    //    - on acceptance every existing session ENDS, as every other password
    //      reset here does. A new person has none to end.
    //
    //  THE OLD PASSWORD KEEPS WORKING until the link is used. Sending it is an
    //  offer, not a lockout: an administrator's mis-click must not shut somebody
    //  out until they next read their personal mail. For an account that may be
    //  in the wrong hands, Reset password is the tool - it kills the password
    //  and the sessions at once - and the People page says so beside the button.
    // ─────────────────────────────────────────────────────────────────────────
    public const string ChannelEmail = "email";
    public const string ChannelSignInLink = "email-signin";
    public static readonly TimeSpan SignInLinkLifetime = TimeSpan.FromHours(24);

    public static bool IsEmailChannel(string? channel) =>
        channel is ChannelEmail or ChannelSignInLink;

    public static TimeSpan LifetimeFor(string? channel) =>
        channel == ChannelSignInLink ? SignInLinkLifetime : Lifetime;

    /// <summary>The refusal when there is nowhere to send a sign-in link.</summary>
    public const string NoRecoveryEmail =
        "This person has no recovery email on file, so a link has nowhere to go. Use Reset password.";

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
        user.InviteSentAt is null || DateTimeOffset.UtcNow - user.InviteSentAt > LifetimeFor(user.InviteChannel);

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
    /// <summary>
    /// Said after every invitation or sign-in link the console reports as
    /// sent. ONE copy, because three screens say "sent" and wording that
    /// drifts apart reads as three different features.
    ///
    /// Amit, 24 September 2026, after TatvaOS mail was found in Gmail's spam
    /// folder. The cause is not a defect we can fix in code: authentication
    /// is fully compliant (SPF, DKIM, DMARC, alignment — Google's own
    /// dashboard says so) and the user-reported spam rate is 0.00%. What is
    /// missing is SENDING HISTORY: Postmaster Tools has no data for the
    /// domain after 21 September because the volume is below what Google
    /// will report on, and an unknown sender is filed cautiously.
    ///
    /// So the honest thing is to tell the administrator at the moment they
    /// are already waiting for the mail, rather than send every customer a
    /// message announcing that our email looks untrustworthy. Marking it
    /// "not spam" also teaches Gmail for the whole domain, which is the one
    /// lever that works while the volume is small.
    ///
    /// Remove this sentence when the domain has a reputation — it should not
    /// outlive its reason.
    /// </summary>
    public const string CheckSpamNote =
        " If it has not arrived in a few minutes, ask them to check their spam folder "
        + "and mark it as not spam.";

    public static Task<bool> SendAsync(
        SystemMailer mailer, User user, string orgName, string baseUrl, string token,
        CancellationToken ct = default)
    {
        var to = user.RecoveryEmail
                 ?? throw new InvalidOperationException("An email invitation needs a recovery email.");
        var signInLink = user.InviteChannel == ChannelSignInLink;
        return mailer.SendHtmlAsync(
            to,
            InviteEmail.Subject(orgName, signInLink),
            InviteEmail.Html(user.DisplayName, orgName, baseUrl, user.Email,
                             Link(baseUrl, token), (int)LifetimeFor(user.InviteChannel).TotalHours, signInLink),
            from: "no_reply@tatvaos.com",
            ct: ct);
    }
}
