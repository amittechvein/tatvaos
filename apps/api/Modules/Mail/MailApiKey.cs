namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// An organisation API key for POST /api/v1/mail/send.
///
/// Shown once at creation and never retrievable — only the hash is stored.
/// Rows are revoked, never deleted: "when was this key issued and when did it
/// stop working" is the question an incident asks.
///
/// Mapped explicitly with ToTable("api_keys", "mail") in AppDbContext.
/// Schema: 20260903-mail-api-keys.sql.
/// </summary>
public sealed class MailApiKey
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }

    /// <summary>Display only — "Website contact form". Never authenticates.</summary>
    public string Label { get; set; } = "";

    /// <summary>
    /// Carries its own {SCHEME} prefix ({SHA256}). Unsalted and deterministic
    /// BECAUSE the lookup is by hash — an API key arrives with no username, so
    /// the key is the identifier. A salted hash could not be looked up at all.
    /// Safe on a 32-character random secret: the entropy is the defence.
    /// </summary>
    public string KeyHash { get; set; } = "";

    /// <summary>'tvos_a1b2c3d4' — the head, shown in lists so two keys can be
    /// told apart. Not a secret and not enough to authenticate.</summary>
    public string KeyPrefix { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>
    /// Unlike the app-password store's removed column, this one HAS a writer:
    /// the send endpoint sets it on every accepted send. So NULL genuinely
    /// means never used, and can be read that way.
    /// </summary>
    public DateTimeOffset? LastUsedAt { get; set; }

    /// <summary>
    /// Email addresses this key is restricted to. An empty array is
    /// stored but cannot be in effect (a CHECK constraint blocks it). At least
    /// one address must be present on an active key.
    /// Normalized to lowercase; case-insensitive matching during send.
    /// </summary>
    public string[] AllowedSenderAddresses { get; set; } = Array.Empty<string>();
}

/// <summary>
/// One row per API send attempt. Kept indefinitely (Amit's decision).
///
/// Two outcomes only. 'accepted' means Postfix took the message; 'refused'
/// means it did not, and Error carries its words. There is deliberately no
/// 'delivered' — nothing in this path can observe the receiving server, and a
/// status that is sometimes wrong is worse than one that is absent.
///
/// Mapped with ToTable("api_sends", "mail"). Schema: 20260903-mail-api-keys.sql.
/// </summary>
public sealed class MailApiSend
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid? ApiKeyId { get; set; }
    public string FromAddress { get; set; } = "";
    public string ToAddress { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Outcome { get; set; } = "";
    public string? Error { get; set; }
    public DateTimeOffset SentAt { get; set; }
}
