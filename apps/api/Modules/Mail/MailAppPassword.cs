namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// One app password — the credential a third-party mail client is given so
/// the person's real TatvaOS password never leaves this platform.
///
/// ONE ACTIVE PER MAILBOX (a Dovecot SQL-passdb constraint, worn honestly —
/// see dovecot-sql-app.conf.ext). Rows are revoked, never deleted: "when was
/// this credential issued and when did it stop working" is the question an
/// incident asks, and a deleted row answers with a shrug.
///
/// Mapped explicitly with ToTable("app_passwords", "mail") in AppDbContext.
/// Schema: 20260827-a-mail-app-passwords.sql.
/// </summary>
public sealed class MailAppPassword
{
    public Guid Id { get; set; }
    public Guid MailboxId { get; set; }

    /// <summary>Display only — "Office laptop Thunderbird". Never part of
    /// authentication.</summary>
    public string Label { get; set; } = "";

    /// <summary>
    /// Carries its own {SCHEME} prefix ({SSHA512}). The scheme travels WITH
    /// the hash because the store that relied on a default scheme verified
    /// every hash against the wrong algorithm for weeks and nobody noticed.
    /// </summary>
    public string PasswordHash { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }

    // There is deliberately no LastUsedAt. Only Dovecot sees a successful
    // IMAP or SMTP authentication, its passdb query is SELECT-only, and the
    // mailedge role holds GRANT SELECT alone - so nothing could ever write
    // it. A column that is always NULL reads as "never used" to the person
    // deciding whether to revoke, when it actually means "never recorded".
    // Those two lead to opposite decisions. Removed rather than shipped.
}
