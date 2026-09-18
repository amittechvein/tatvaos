namespace TatvaOS.Api.Modules.Admin;

/// <summary>
/// An organisation's own API key, for their software to act on their
/// organisation — today, to admit people (Amit, 18 September 2026).
///
/// SEPARATE FROM mail.api_keys ON PURPOSE. That one is a mail credential and
/// carries allowed sender addresses; it lives in Mail's schema and Mail's
/// lane. This one can create sign-in identities, which is the most
/// consequential thing any credential here can do, so it is a core table with
/// its own blast radius. The shape is otherwise identical — hash carrying its
/// scheme, visible prefix, revoke-not-delete, a SECURITY DEFINER resolver —
/// because a second pattern would be a second thing to get wrong.
/// </summary>
public sealed class OrgApiKey
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }

    /// <summary>Display only — "Student information system". Never authenticates.</summary>
    public string Label { get; set; } = "";

    /// <summary>
    /// Carries its own {SCHEME} prefix ({SHA256}). Unsalted and deterministic
    /// BECAUSE the lookup is by hash: an API key arrives with no username, so
    /// the key is the identifier and a salted hash could not be looked up at
    /// all. Safe on a 32-character random secret — the entropy is the defence.
    /// </summary>
    public string KeyHash { get; set; } = "";

    /// <summary>'tvk_a1b2c3d4' — the head, so two keys can be told apart in a
    /// list. Not a secret and not enough to authenticate.</summary>
    public string KeyPrefix { get; set; } = "";

    /// <summary>
    /// What this key may do, e.g. <c>people:admit</c>.
    ///
    /// EXPLICIT, NEVER IMPLIED. An empty array can do nothing at all, which is
    /// the right reading of a key whose scopes were never set — the opposite
    /// reading ("unset means everything") is how a credential quietly becomes
    /// a master key.
    /// </summary>
    public string[] Scopes { get; set; } = [];

    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>
    /// Written at most once an hour per key, like the OIDC applications
    /// column: it is a write on every call otherwise, and nobody asks this
    /// question to the second. NULL genuinely means never used.
    /// </summary>
    public DateTimeOffset? LastUsedAt { get; set; }

    /// <summary>Create people in this organisation.</summary>
    public const string ScopePeopleAdmit = "people:admit";

    /// <summary>
    /// Schedule meetings on behalf of a person in this organisation, and
    /// change or cancel the ones it scheduled (Amit, 18 September 2026: a
    /// school's ERP, so a teacher creates a class from the timetable they
    /// already keep).
    /// </summary>
    public const string ScopeMeetingsSchedule = "meetings:schedule";

    /// <summary>
    /// Read a meeting and get the link to join it.
    ///
    /// SEPARATE FROM meetings:schedule, and that separation is the point. The
    /// ERP half that shows a student their timetable needs to hand out join
    /// links and nothing else; if reading came free with scheduling, the key
    /// embedded in the student-facing half of the ERP could also create and
    /// cancel every class in the school. Two scopes, two keys, two blast
    /// radii — the same argument that made this table separate from
    /// mail.api_keys.
    /// </summary>
    public const string ScopeMeetingsJoin = "meetings:join";

    /// <summary>Every scope a key may be given. An unknown scope is refused at creation.</summary>
    public static readonly (string Scope, string Label)[] Offerable =
    [
        (ScopePeopleAdmit, "Add people to this organisation"),
        (ScopeMeetingsSchedule, "Schedule meetings for people in this organisation"),
        (ScopeMeetingsJoin, "Read meetings and hand out join links"),
    ];
}
