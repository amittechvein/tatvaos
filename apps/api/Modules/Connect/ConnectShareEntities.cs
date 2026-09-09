namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Sharing a recording with somebody who was not in the meeting.
///
/// ─────────────────────────────────────────────────────────────────────────
///  DRAFT — DO NOT REGISTER THIS IN AppDbContext YET.
///
///  The schema these map to is with Core for review and has four open
///  questions on it (see infra/proposals/20260826-connect-recording-shares
///  .sql.draft). Mapping them before the tables exist would make every
///  request that touches ConnectRecordings fail at startup, not at use.
///
///  When the migration lands, three ToTable calls in AppDbContext turn this
///  on and nothing else changes.
/// ─────────────────────────────────────────────────────────────────────────
///
///  THE ONE RULE EVERYTHING HERE OBEYS: THE BASELINE NEVER MOVES.
///
///  Everybody who was in the meeting, and the host, can already read the
///  recording. No row in any of these tables adds to that or takes from it.
///  A share only ever widens the door, and the baseline question is answered
///  in exactly one place — SeenMeetingAsync — which knows nothing about any
///  of this.
/// </summary>
public sealed class ConnectRecordingShare
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid RecordingId { get; set; }

    /// <summary>Denormalised from the recording. A recording never changes
    /// meetings, so there is nothing to drift, and carrying it lets the
    /// download route refuse a recording id from a DIFFERENT meeting in the
    /// same query that reads the share.</summary>
    public Guid MeetingId { get; set; }

    /// <summary>organisation | named | password | public. See ConnectShareLevels.</summary>
    public string Level { get; set; } = "";

    /// <summary>
    /// The link secret, for the two levels that have a link. 22 chars of
    /// base64url over 16 CSPRNG bytes — the same shape as a meeting code, and
    /// stored in plaintext for the same reason: it is a capability its owner
    /// re-reads and re-sends, and on its own it mints nothing.
    ///
    /// IT IS NOT THE AUTHORISATION. It names a row, which is then read, and
    /// the row is what decides.
    /// </summary>
    public string? Token { get; set; }

    /// <summary>Argon2id via the platform's IPasswordHasher, exactly like
    /// ConnectMeeting.PasswordHash. NULL except on the 'password' level.</summary>
    public string? PasswordHash { get; set; }

    /// <summary>
    /// Mandatory on 'password' and 'public'; optional above them.
    ///
    /// Clamped by a database trigger to the recording's own end of life, so a
    /// link can never outlive the file it points at. Clamped rather than
    /// refused: somebody asking for 30 days on a recording with 11 left gets
    /// 11, and the UI says so.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Set, never deleted. "Who could see this, and when did that
    /// stop" is a question somebody asks after an incident, and a deleted row
    /// cannot answer it.</summary>
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>Live means not revoked and not expired. Both halves matter:
    /// an expired share is as dead as a revoked one and neither should ever
    /// authorise a read.</summary>
    [System.ComponentModel.DataAnnotations.Schema.NotMapped]
    public bool IsLive => RevokedAt is null
        && (ExpiresAt is null || ExpiresAt > DateTimeOffset.UtcNow);
}

/// <summary>
/// One named reader of one share.
///
/// SubjectTenantId may differ from TenantId — cross-organisation grants are
/// permitted, and are the reason connect.share_allows_user() has to be a
/// SECURITY DEFINER function rather than an ordinary query.
/// </summary>
public sealed class ConnectRecordingShareGrant
{
    public Guid Id { get; set; }

    /// <summary>The RECORDING's tenant, so the row is owned where the
    /// recording is.</summary>
    public Guid TenantId { get; set; }

    public Guid ShareId { get; set; }
    public Guid SubjectUserId { get; set; }

    /// <summary>Stored so that revoking everything shared with one
    /// organisation is a single statement rather than a hunt.</summary>
    public Guid SubjectTenantId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

/// <summary>
/// One row per read of a recording by somebody who was NOT in the meeting.
///
/// Participants and hosts are deliberately absent: they are the baseline, and
/// logging them would bury the rows that matter under the rows that do not.
/// </summary>
public sealed class ConnectRecordingAccess
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid RecordingId { get; set; }
    public Guid? ShareId { get; set; }

    /// <summary>Which of the four let them in. Never empty — a row here means
    /// a share authorised the read.</summary>
    public string Level { get; set; } = "";

    /// <summary>The reader, when there is one. NULL for a link holder, which
    /// is the entire reason this is a Connect table rather than a platform
    /// audit row: AuditWriter wants an actor who is a user.</summary>
    public Guid? SubjectUserId { get; set; }
    public Guid? SubjectTenantId { get; set; }

    /// <summary>Truncated to a /24 or /48 before it is written. Enough to say
    /// "this link was opened from twelve different places"; not a location.</summary>
    public string? AddressPrefix { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// The four levels, in the order they give away more.
///
/// Shaped like ConnectShare and ConnectChat — one idea to learn, not three —
/// but note what is different: those two are about a live meeting and are
/// enforced in a token or in the client. THIS ONE IS ENFORCED IN THE DATABASE,
/// on every request, and nothing about it is a courtesy.
/// </summary>
public static class ConnectShareLevels
{
    public const string Organisation = "organisation";
    public const string Named = "named";
    public const string Password = "password";
    public const string Public = "public";

    /// <summary>Least exposure first. The order the UI must offer them in.</summary>
    public static readonly string[] All = [Organisation, Named, Password, Public];

    public static bool IsValid(string? level) =>
        level is Organisation or Named or Password or Public;

    /// <summary>True for the levels reached by holding a URL rather than by
    /// signing in. These are the ones where expiry is mandatory.</summary>
    public static bool HasLink(string level) =>
        level is Password or Public;

    /// <summary>
    /// What this level actually means, in the words a person must read BEFORE
    /// they choose it.
    ///
    /// The 'public' sentence is Core's, verbatim, and is not to be softened.
    /// "Anyone with the link" is how every product in this category words it
    /// and is how people end up surprised — it sounds like a small circle.
    /// The API returns these so the web and any future client cannot drift
    /// into two different promises about the same row.
    /// </summary>
    public static string Exposure(string level) => level switch
    {
        Organisation => "Anyone signed in to your organisation",
        Named => "Only the people you list, wherever they work",
        Password => "Anyone holding this link who also knows the password",
        Public => "Anyone on the internet holding this link",
        _ => "Unknown",
    };

    /// <summary>The default life of a new link. Seven days: long enough to
    /// cover a week somebody is away, short enough that a link forgotten in
    /// an inbox has stopped working before anybody thinks about it again.</summary>
    public const int DefaultDays = 7;
}

/// <summary>
/// Per-organisation Connect settings that Connect owns.
///
/// One row per organisation, and a MISSING row is meaningful: it means every
/// setting is at its default, which for a switch that exposes recordings to
/// anyone holding a link means off. Nothing backfills this table, so an
/// organisation nobody has asked has not accidentally agreed.
///
/// WHY IT IS NOT ON core.tenants, where the three older Connect flags live.
/// Those three — allow_connect_recording, connect_email_minutes,
/// connect_recording_retention_days — are Core's file, and moving them is a
/// live-table migration with application code reading them. New module
/// switches go in the module's own table instead, which is what Space did
/// with space.tenant_settings.allow_public_links and what Core confirmed on
/// 8 September. This is the pattern from here on.
/// </summary>
public sealed class ConnectTenantSettings
{
    public Guid TenantId { get; set; }

    /// <summary>
    /// Amit's ruling, 26 August: level 4 — anyone holding the link — is off
    /// for the whole organisation until an administrator turns it on.
    ///
    /// Read in TWO places and they are not equivalent. Here, at share time,
    /// so a person is refused politely instead of generating a link that
    /// would never work. And inside connect.resolve_share_token, at read
    /// time, which is the one that matters: turning this off has to kill the
    /// links that already exist, not merely stop new ones being made.
    /// </summary>
    public bool AllowPublicRecordingLinks { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}
