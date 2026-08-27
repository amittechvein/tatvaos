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
/// Schema: 20260828-mail-app-passwords.sql.
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
    public DateTimeOffset? LastUsedAt { get; set; }
}
