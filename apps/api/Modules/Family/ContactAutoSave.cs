using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Family;

/// <summary>
/// Turns correspondence into contacts.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE RULE THAT KEEPS THIS FROM BECOMING A NUISANCE:
///  auto-saved contacts are always PERSONAL, never organisational.
///
///  A message arriving in one person's mailbox says something about that
///  person's correspondents. It says nothing about who the ORGANISATION
///  knows, and promoting it would publish one employee's contacts to the
///  whole tenant without anyone choosing to.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Three cases, and which setting governs each:
///
///   sender is unknown        create the contact        AutoSaveReceived
///   sender is already known  bump the timestamp only   AutoSaveReply
///   we sent to an address    create the contact        AutoSaveSent  (default OFF)
///
/// "Reply" is defined as correspondence with someone already in the address
/// book, rather than by reading In-Reply-To. Header threading is unreliable
/// across clients, and the distinction that actually matters to the person
/// is new-person versus known-person.
///
/// IDEMPOTENCY. family.contact_sources holds one row per
/// (contact, message, direction), with a unique constraint. The maildir
/// worker re-reads messages after a restart, so without that row every
/// restart would re-log the interaction and inflate the count. Anything
/// already recorded is skipped in full.
///
/// FAILURE. Every path swallows its exception and logs. Mail delivery must
/// not fail because the address book could not be updated — a lost contact
/// is an inconvenience, a bounced message is not.
/// </summary>
public sealed class ContactAutoSave(ILogger<ContactAutoSave> log)
{
    /// <summary>
    /// Record correspondence for a batch of messages that have ALREADY been
    /// saved. The caller must have committed them first: contact_sources
    /// carries a foreign key to mail.messages, so an uncommitted message id
    /// would fail the insert.
    /// </summary>
    /// <param name="ownerUserId">
    /// The person whose address book this is. Null for a shared mailbox —
    /// support@ has nobody behind it, and a personal contact needs an owner.
    /// Those mailboxes are skipped rather than guessed at.
    /// </param>
    public async Task RecordAsync(
        AppDbContext db, TenantContext tenant, Guid? ownerUserId,
        IReadOnlyList<Message> messages, string direction, CancellationToken ct)
    {
        if (ownerUserId is not Guid owner || messages.Count == 0) return;

        try
        {
            var settings = await db.ContactSettings
                .FirstOrDefaultAsync(s => s.UserId == owner, ct);

            var onNew = direction == "sender"
                ? settings?.AutoSaveReceived ?? true
                : settings?.AutoSaveSent ?? false;
            var onKnown = settings?.AutoSaveReply ?? true;

            if (!onNew && !onKnown) return;

            foreach (var m in messages)
            {
                foreach (var address in AddressesFor(m, direction))
                    await RecordOneAsync(db, tenant, owner, m, address, direction,
                                         onNew, onKnown, ct);
            }

            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            // Deliberately swallowed. See the class comment.
            log.LogWarning(ex, "Auto-save skipped for {Count} message(s)", messages.Count);
        }
    }

    /// <summary>
    /// Whose address to record. For received mail that is the sender; for a
    /// Sent copy it is everyone it went to, To and Cc alike — a Cc is still
    /// someone you corresponded with.
    /// </summary>
    private static IEnumerable<string> AddressesFor(Message m, string direction)
    {
        if (direction == "sender")
        {
            if (!string.IsNullOrWhiteSpace(m.FromAddr)) yield return m.FromAddr;
            yield break;
        }

        foreach (var a in m.ToAddrs)
            if (!string.IsNullOrWhiteSpace(a)) yield return a;

        foreach (var a in m.CcAddrs ?? [])
            if (!string.IsNullOrWhiteSpace(a)) yield return a;
    }

    private async Task RecordOneAsync(
        AppDbContext db, TenantContext tenant, Guid owner, Message m,
        string address, string direction, bool onNew, bool onKnown, CancellationToken ct)
    {
        var key = ContactMatching.NormaliseEmail(address);
        if (key.Length == 0 || !key.Contains('@')) return;

        // Never file the mailbox owner as their own contact. Their address is
        // on every Sent copy, and one "me" row appearing in everyone's address
        // book is the first thing anyone would report as a bug.
        var self = await db.Users.Where(u => u.Id == owner).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (self is not null && ContactMatching.NormaliseEmail(self) == key) return;

        // Existing contact for this address, INCLUDING a soft-deleted one.
        // Deleting a contact is how someone says "stop saving this person";
        // recreating it on the next message would ignore that.
        var existing = await db.Contacts
            .Where(c => c.OwnerUserId == owner &&
                        db.ContactEmails.Any(e => e.ContactId == c.Id && e.EmailNormalised == key))
            .Select(c => new { c.Id, c.DeletedAt })
            .FirstOrDefaultAsync(ct);

        if (existing?.DeletedAt is not null) return;

        var interactionType = direction == "sender" ? "email_received" : "email_sent";

        if (existing is not null)
        {
            if (!onKnown) return;

            // Already recorded — a re-ingest, not new correspondence.
            if (await db.ContactSources.AnyAsync(
                    s => s.ContactId == existing.Id &&
                         s.MailMessageId == m.Id &&
                         s.SourceType == direction, ct))
                return;

            var c = await db.Contacts.FirstAsync(x => x.Id == existing.Id, ct);
            if (c.LastContactedAt is null || m.ReceivedAt > c.LastContactedAt)
                c.LastContactedAt = m.ReceivedAt;
            c.InteractionCount++;
            c.UpdatedAt = DateTimeOffset.UtcNow;

            AddTrail(db, tenant, existing.Id, m, direction, interactionType);
            return;
        }

        if (!onNew) return;

        var contact = new Contact
        {
            TenantId = tenant.TenantId,
            CreatedByUserId = owner,
            OwnershipType = "personal",
            OwnerUserId = owner,
            DisplayName = ContactMatching.DisplayNameFromEmail(
                direction == "sender" ? m.FromName : null, address),
            Source = direction == "sender" ? "auto_received" : "auto_sent",
            LastContactedAt = m.ReceivedAt,
            InteractionCount = 1
        };
        db.Contacts.Add(contact);

        db.ContactEmails.Add(new ContactEmail
        {
            TenantId = tenant.TenantId,
            ContactId = contact.Id,
            Email = address.Trim(),
            EmailNormalised = key,
            Type = "work",
            IsPrimary = true,
            LastContactedAt = m.ReceivedAt
        });

        db.ContactAuditLogs.Add(new ContactAuditLog
        {
            TenantId = tenant.TenantId,
            ContactId = contact.Id,
            ActorUserId = owner,
            Operation = "create",
            Reason = direction == "sender"
                ? "Auto-saved from a received message"
                : "Auto-saved from a sent message"
        });

        AddTrail(db, tenant, contact.Id, m, direction, interactionType);
    }

    /// <summary>The interaction and the idempotency row, always together.</summary>
    private static void AddTrail(
        AppDbContext db, TenantContext tenant, Guid contactId, Message m,
        string direction, string interactionType)
    {
        db.ContactInteractions.Add(new ContactInteraction
        {
            TenantId = tenant.TenantId,
            ContactId = contactId,
            Type = interactionType,
            Subject = m.Subject,
            MailMessageId = m.Id,
            OccurredAt = m.ReceivedAt
        });

        db.ContactSources.Add(new ContactSource
        {
            TenantId = tenant.TenantId,
            ContactId = contactId,
            MailMessageId = m.Id,
            SourceType = direction
        });
    }
}
