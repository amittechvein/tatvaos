using System.ComponentModel.DataAnnotations;
using NpgsqlTypes;

namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  FAMILY — contacts
//
//  Mirrors local/postgres/init/19-family-schema.sql. Kept in its own file
//  rather than appended to Entities.cs so the third product does not make the
//  first two harder to read.
//
//  The distinction that drives everything below:
//
//    core.users       someone who can sign in
//    family.contacts  someone you correspond with
//
//  And within contacts:
//
//    personal        OwnerUserId set; invisible to colleagues
//    organisational  OwnerUserId null; visible tenant-wide
//
//  Both are enforced by RLS, not only here. See the schema file.
// ============================================================================

/// <summary>
/// A person or organisation the tenant corresponds with.
///
/// DisplayName is required and is what every list renders. First/last are
/// optional because an auto-saved contact starts life with nothing but an
/// address — "accounts@supplier.com" has no surname to record.
/// </summary>
public class Contact
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Null once the creator's account is deleted; the contact survives.</summary>
    public Guid? CreatedByUserId { get; set; }

    /// <summary>"personal" or "organisational". Paired with OwnerUserId by a CHECK.</summary>
    [MaxLength(16)] public string OwnershipType { get; set; } = "personal";

    /// <summary>Set for personal contacts, null for organisational ones.</summary>
    public Guid? OwnerUserId { get; set; }

    [MaxLength(400)] public required string DisplayName { get; set; }
    [MaxLength(200)] public string? FirstName { get; set; }
    [MaxLength(200)] public string? LastName { get; set; }
    [MaxLength(200)] public string? Nickname { get; set; }
    [MaxLength(200)] public string? JobTitle { get; set; }
    [MaxLength(300)] public string? CompanyName { get; set; }

    /// <summary>
    /// manual | import | api | auto_received | auto_sent | auto_reply.
    /// The auto_* values mark rows no human typed, so the UI can offer to
    /// review them in bulk.
    /// </summary>
    [MaxLength(20)] public string Source { get; set; } = "manual";

    public bool IsFavourite { get; set; }
    public string? Notes { get; set; }

    public DateTimeOffset? LastContactedAt { get; set; }
    public int InteractionCount { get; set; }

    /// <summary>Soft delete — the audit log points here and must outlive the row.</summary>
    public DateTimeOffset? DeletedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Maintained by a trigger (19-family-schema.sql), never by this code.</summary>
    public NpgsqlTsVector? SearchVector { get; set; }

    public List<ContactEmail> Emails { get; set; } = [];
    public List<ContactPhone> Phones { get; set; } = [];
    public List<ContactAddress> Addresses { get; set; } = [];
}

/// <summary>
/// One address for a contact.
///
/// Two columns for one value on purpose. Email is what the person typed and is
/// what gets displayed; EmailNormalised is what deduplication compares, with
/// Gmail's dots and +tags folded away. Matching on the raw address would give
/// a fresh contact every time the same sender varied their alias.
/// </summary>
public class ContactEmail
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ContactId { get; set; }

    [MaxLength(320)] public required string Email { get; set; }
    [MaxLength(320)] public required string EmailNormalised { get; set; }

    [MaxLength(16)] public string Type { get; set; } = "work";
    public bool IsPrimary { get; set; }

    public DateTimeOffset? LastContactedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class ContactPhone
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ContactId { get; set; }

    [MaxLength(64)] public required string Phone { get; set; }

    /// <summary>Digits only, so "+91 98765 43210" matches "09876543210".</summary>
    [MaxLength(64)] public required string PhoneNormalised { get; set; }

    [MaxLength(16)] public string Type { get; set; } = "mobile";
    public bool IsPrimary { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class ContactAddress
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ContactId { get; set; }

    [MaxLength(16)]  public string Type { get; set; } = "work";
    [MaxLength(300)] public string? StreetLine1 { get; set; }
    [MaxLength(300)] public string? StreetLine2 { get; set; }
    [MaxLength(150)] public string? City { get; set; }
    [MaxLength(150)] public string? StateProvince { get; set; }
    [MaxLength(32)]  public string? PostalCode { get; set; }
    [MaxLength(150)] public string? Country { get; set; }

    public bool IsPrimary { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>A named set of contacts. Tenant-wide, like a shared label.</summary>
public class ContactGroup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid? CreatedByUserId { get; set; }

    [MaxLength(200)] public required string Name { get; set; }
    [MaxLength(500)] public string? Description { get; set; }
    [MaxLength(16)]  public string? Colour { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class ContactGroupMember
{
    public Guid TenantId { get; set; }
    public Guid GroupId { get; set; }
    public Guid ContactId { get; set; }
    public DateTimeOffset AddedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// One recorded exchange with a contact.
///
/// MailMessageId is nullable and set-null on delete: "we emailed them on the
/// 3rd" stays true after the message is gone.
/// </summary>
public class ContactInteraction
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ContactId { get; set; }

    /// <summary>email_received | email_sent | call_inbound | call_outbound | meeting | note | other</summary>
    [MaxLength(20)] public required string Type { get; set; }

    [MaxLength(1000)] public string? Subject { get; set; }
    public string? Notes { get; set; }

    public Guid? MailMessageId { get; set; }

    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Append only. The database withholds UPDATE and DELETE from tatvaos_app, so
/// a bug here cannot rewrite the record.
/// </summary>
public class ContactAuditLog
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ContactId { get; set; }
    public Guid? ActorUserId { get; set; }

    /// <summary>create | update | delete | merge</summary>
    [MaxLength(16)] public required string Operation { get; set; }

    /// <summary>jsonb: { "field": { "old": ..., "new": ... } }. Null for create and delete.</summary>
    public string? Changes { get; set; }

    [MaxLength(500)] public string? Reason { get; set; }
    [MaxLength(64)]  public string? IpAddress { get; set; }
    [MaxLength(512)] public string? UserAgent { get; set; }

    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// One person's auto-save preferences.
///
/// Sent defaults to false: you already know who you wrote to, and saving every
/// one-off recipient fills an address book with noise within a week.
/// </summary>
public class ContactSetting
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public bool AutoSaveReceived { get; set; } = true;
    public bool AutoSaveSent { get; set; }
    public bool AutoSaveReply { get; set; } = true;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Which message produced which contact.
///
/// This is the idempotency key for auto-save. The maildir worker re-reads
/// messages after a restart; without this row, every restart would add another
/// interaction and inflate the count.
/// </summary>
public class ContactSource
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ContactId { get; set; }
    public Guid MailMessageId { get; set; }

    /// <summary>sender | recipient</summary>
    [MaxLength(16)] public required string SourceType { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
