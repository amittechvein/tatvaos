using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Data;

/// <summary>
/// The only database context.
///
/// ─────────────────────────────────────────────────────────────────────────
///  DEFENCE IN DEPTH — READ THIS BEFORE CHANGING ANYTHING HERE.
///
///  Tenant isolation is enforced twice, on purpose:
///
///   1. PostgreSQL row-level security, driven by app.tenant_id, which
///      TenantConnectionInterceptor sets on every connection. This is the
///      real control — it holds even if application code is wrong.
///
///   2. EF Core global query filters, below. These are a convenience and an
///      early-failure signal. They are NOT the guarantee, because a raw SQL
///      query bypasses them entirely.
///
///  If you ever find yourself removing a filter to "fix" a query, you are
///  about to write a cross-tenant read. Scope the tenant instead.
/// ─────────────────────────────────────────────────────────────────────────
///
/// The constructor requires a TenantContext. That is deliberate: there is no
/// way to obtain a DbContext without one, so "I forgot to set the tenant"
/// cannot happen through this type.
/// </summary>
public sealed class AppDbContext(DbContextOptions<AppDbContext> options, TenantContext tenant)
    : DbContext(options)
{
    // ---- core: routing. No RLS; the mail edge reads these cross-tenant ----
    public DbSet<Product> Products => Set<Product>();
    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<Domain> Domains => Set<Domain>();
    public DbSet<DkimKey> DkimKeys => Set<DkimKey>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Department> Departments => Set<Department>();

    // ---- core: commercial. RLS enabled and forced ----
    public DbSet<ProductAccess> ProductAccess => Set<ProductAccess>();
    public DbSet<Plan> Plans => Set<Plan>();
    public DbSet<Subscription> Subscriptions => Set<Subscription>();
    public DbSet<StoragePool> StoragePools => Set<StoragePool>();
    public DbSet<StorageAllocation> StorageAllocations => Set<StorageAllocation>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    /// <summary>
    /// Two-step recovery codes. NO query filter, deliberately — they are
    /// checked before the tenant is known, exactly like the refresh-token
    /// lookup. See the entity comment.
    /// </summary>
    public DbSet<MfaRecoveryCode> MfaRecoveryCodes => Set<MfaRecoveryCode>();
    public DbSet<UserAvatar> UserAvatars => Set<UserAvatar>();

    /// <summary>
    /// Unfinished signups. NOT tenant-scoped — a draft belongs to nobody yet,
    /// because the whole point is that no tenant exists until verification
    /// passes. Access is controlled by the endpoints, which take an
    /// unguessable id.
    /// </summary>
    public DbSet<SignupDraft> SignupDrafts => Set<SignupDraft>();

    /// <summary>Platform-wide, no tenant scope — see the entity's comment.</summary>
    public DbSet<PlatformSetting> PlatformSettings => Set<PlatformSetting>();

    // ---- mail ----
    public DbSet<Mailbox> Mailboxes => Set<Mailbox>();
    public DbSet<Alias> Aliases => Set<Alias>();
    public DbSet<MailboxPermission> MailboxPermissions => Set<MailboxPermission>();
    public DbSet<Folder> Folders => Set<Folder>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<BlockedSender> BlockedSenders => Set<BlockedSender>();
    public DbSet<FilterRule> FilterRules => Set<FilterRule>();
    public DbSet<Signature> Signatures => Set<Signature>();
    public DbSet<VacationResponder> VacationResponders => Set<VacationResponder>();
    public DbSet<VacationSend> VacationSends => Set<VacationSend>();

    // ---- family. RLS enabled and forced; see 19-family-schema.sql ----
    public DbSet<Contact> Contacts => Set<Contact>();
    public DbSet<ContactEmail> ContactEmails => Set<ContactEmail>();
    public DbSet<ContactPhone> ContactPhones => Set<ContactPhone>();
    public DbSet<ContactAddress> ContactAddresses => Set<ContactAddress>();
    public DbSet<ContactGroup> ContactGroups => Set<ContactGroup>();
    public DbSet<ContactGroupMember> ContactGroupMembers => Set<ContactGroupMember>();
    public DbSet<ContactInteraction> ContactInteractions => Set<ContactInteraction>();
    public DbSet<ContactAuditLog> ContactAuditLogs => Set<ContactAuditLog>();
    public DbSet<ContactSetting> ContactSettings => Set<ContactSetting>();
    public DbSet<ContactSource> ContactSources => Set<ContactSource>();

    // ---- space. RLS enabled and forced; see 25-space-schema.sql ----
    public DbSet<SpaceFolder> SpaceFolders => Set<SpaceFolder>();
    public DbSet<SpaceFile> SpaceFiles => Set<SpaceFile>();

    // ---- Calendar --------------------------------------------------------
    public DbSet<CalendarCalendar> Calendars => Set<CalendarCalendar>();
    public DbSet<CalendarMember> CalendarMembers => Set<CalendarMember>();
    public DbSet<CalendarEvent> CalendarEvents => Set<CalendarEvent>();
    public DbSet<CalendarEventException> CalendarEventExceptions => Set<CalendarEventException>();
    public DbSet<CalendarAttendee> CalendarAttendees => Set<CalendarAttendee>();
    public DbSet<CalendarReminder> CalendarReminders => Set<CalendarReminder>();
    public DbSet<CalendarReminderSend> CalendarReminderSends => Set<CalendarReminderSend>();

    // ---- Connect. RLS enabled and forced; see 20260901-connect.sql -------
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectMeeting> ConnectMeetings
        => Set<TatvaOS.Api.Modules.Connect.ConnectMeeting>();
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectParticipant> ConnectParticipants
        => Set<TatvaOS.Api.Modules.Connect.ConnectParticipant>();
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectLobbyRequest> ConnectLobbyRequests
        => Set<TatvaOS.Api.Modules.Connect.ConnectLobbyRequest>();
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectMeetingEvent> ConnectMeetingEvents
        => Set<TatvaOS.Api.Modules.Connect.ConnectMeetingEvent>();
    // ---- Connect recording. RLS enabled and forced; see
    //      20260902-connect-recording.sql -----------------------------------
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectRecording> ConnectRecordings
        => Set<TatvaOS.Api.Modules.Connect.ConnectRecording>();
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectTranscript> ConnectTranscripts
        => Set<TatvaOS.Api.Modules.Connect.ConnectTranscript>();
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes> ConnectMeetingNotes
        => Set<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>();
    // Added by 20260904-connect-minutes. Chat still travels over LiveKit's
    // data channel — that is the right transport and it is unchanged. A copy
    // is stored so it can be part of the minutes, because chat that lives
    // only in the browsers that were open is not a record of anything.
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectMeetingChat> ConnectMeetingChat
        => Set<TatvaOS.Api.Modules.Connect.ConnectMeetingChat>();
    // Who a host removed, so Remove survives a rejoin. RLS forced, scoped
    // through the meeting; see 20260905-connect-host-controls.sql.
    public DbSet<TatvaOS.Api.Modules.Connect.ConnectMeetingBlock> ConnectMeetingBlocks
        => Set<TatvaOS.Api.Modules.Connect.ConnectMeetingBlock>();
    public DbSet<SpaceShare> SpaceShares => Set<SpaceShare>();
    public DbSet<SpaceFileActivity> SpaceFileActivities => Set<SpaceFileActivity>();
    public DbSet<SpaceStar> SpaceStars => Set<SpaceStar>();
    public DbSet<SpacePublicLink> SpacePublicLinks => Set<SpacePublicLink>();
    public DbSet<SpaceTenantSetting> SpaceTenantSettings => Set<SpaceTenantSetting>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        // ---- Schemas -----------------------------------------------------
        // Explicit on every entity. There is no default schema, because a
        // default is exactly how a Mail table silently lands in core.
        b.Entity<Product>().ToTable("products", "core");
        b.Entity<Tenant>().ToTable("tenants", "core");
        b.Entity<Domain>().ToTable("domains", "core");
        // Missed when DkimKey was added, and EF then invented "DkimKeys" with
        // no schema — found in production, on the first click of "DNS records".
        // Every entity gets its ToTable line the moment its DbSet is added.
        b.Entity<DkimKey>().ToTable("dkim_keys", "core");
        b.Entity<User>().ToTable("users", "core");
        b.Entity<Department>().ToTable("departments", "core");
        b.Entity<ProductAccess>().ToTable("product_access", "core");
        b.Entity<Plan>().ToTable("plans", "core");
        b.Entity<Subscription>().ToTable("subscriptions", "core");
        b.Entity<StoragePool>().ToTable("storage_pools", "core");
        b.Entity<StorageAllocation>().ToTable("storage_allocations", "core");
        b.Entity<AuditLog>().ToTable("audit_logs", "core");
        b.Entity<RefreshToken>().ToTable("refresh_tokens", "core");
        b.Entity<MfaRecoveryCode>().ToTable("mfa_recovery_codes", "core");
        b.Entity<UserAvatar>().ToTable("user_avatars", "core");
        b.Entity<UserAvatar>().HasKey(a => a.UserId);
        b.Entity<SignupDraft>().ToTable("signup_drafts", "core");
        b.Entity<PlatformSetting>().ToTable("platform_settings", "core");
        b.Entity<PlatformSetting>().HasKey(s => s.Key);

        b.Entity<Mailbox>().ToTable("mailboxes", "mail");
        b.Entity<Alias>().ToTable("aliases", "mail");
        b.Entity<MailboxPermission>().ToTable("mailbox_permissions", "mail");
        b.Entity<Folder>().ToTable("folders", "mail");
        b.Entity<Message>().ToTable("messages", "mail");
        b.Entity<Attachment>().ToTable("attachments", "mail");
        b.Entity<BlockedSender>().ToTable("blocked_senders", "mail");
        b.Entity<FilterRule>().ToTable("filter_rules", "mail");
        b.Entity<Signature>().ToTable("signatures", "mail");
        b.Entity<VacationResponder>().ToTable("vacation_responders", "mail");
        b.Entity<VacationSend>().ToTable("vacation_sends", "mail");

        // core.user_storage() is a function, not a table. Keyless and viewless:
        // it is only ever reached through FromSqlRaw, and mapping it to a table
        // would invite somebody to write to it.
        b.Entity<UserStorageRow>().HasNoKey().ToView(null);

        b.Entity<Contact>().ToTable("contacts", "family");
        b.Entity<ContactEmail>().ToTable("contact_emails", "family");
        b.Entity<ContactPhone>().ToTable("contact_phones", "family");
        b.Entity<ContactAddress>().ToTable("contact_addresses", "family");
        b.Entity<ContactGroup>().ToTable("contact_groups", "family");
        b.Entity<ContactGroupMember>().ToTable("contact_group_members", "family");
        b.Entity<ContactInteraction>().ToTable("contact_interactions", "family");
        b.Entity<ContactAuditLog>().ToTable("contact_audit_logs", "family");
        b.Entity<ContactSetting>().ToTable("contact_settings", "family");
        b.Entity<ContactSource>().ToTable("contact_sources", "family");

        b.Entity<SpaceFolder>().ToTable("folders", "space");
        b.Entity<SpaceFile>().ToTable("files", "space");

        // ---- Calendar ----------------------------------------------------
        b.Entity<CalendarCalendar>().ToTable("calendars", "calendar");
        b.Entity<CalendarMember>().ToTable("calendar_members", "calendar");
        b.Entity<CalendarEvent>().ToTable("events", "calendar");
        b.Entity<CalendarEventException>().ToTable("event_exceptions", "calendar");
        b.Entity<CalendarAttendee>().ToTable("event_attendees", "calendar");
        b.Entity<CalendarReminder>().ToTable("event_reminders", "calendar");
        b.Entity<CalendarReminderSend>().ToTable("reminder_sends", "calendar");

        // ---- Connect -----------------------------------------------------
        // Explicit schema on every one, like everything else here: a default
        // is exactly how a Mail table once silently landed in core.
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeeting>().ToTable("meetings", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectParticipant>().ToTable("participants", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectLobbyRequest>().ToTable("lobby_requests", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingEvent>().ToTable("meeting_events", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectRecording>().ToTable("recordings", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectTranscript>().ToTable("transcripts", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>().ToTable("meeting_notes", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingChat>().ToTable("meeting_chat", "connect");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingBlock>().ToTable("meeting_blocks", "connect");

        // jsonb, not text. Npgsql maps a string property to `text` by default,
        // and `text` does not implicitly cast to `jsonb` on INSERT — the write
        // fails with 42804. Stated once, here, for the SEVEN json columns.
        //
        // It said six, and there were seven. connect.meeting_events.payload is
        // jsonb in 20260901-connect.sql and was never mapped, so EVERY insert
        // into that table failed with 42804 from the day the module shipped.
        // The webhook handler answered 500, LiveKit retried five times and
        // gave up, and connect.meeting_events stayed empty for the module's
        // entire life — which meant no attendance, no meeting ever reaching
        // 'active' or 'ended', and a notes worker reading a table that could
        // not have a row in it.
        //
        // It was invisible because the events the handler IGNORES answer 200
        // in two milliseconds, so LiveKit's log was full of healthy 200s. The
        // same trap as the one recorded in CONNECT_HANDOVER.md §5.5, one layer
        // down. If you add a jsonb column, add it here in the same commit, and
        // count the list against the schema rather than trusting the comment.
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingEvent>()
            .Property(e => e.Payload).HasColumnType("jsonb");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectTranscript>()
            .Property(t => t.Segments).HasColumnType("jsonb");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>()
            .Property(n => n.KeyPoints).HasColumnType("jsonb");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>()
            .Property(n => n.Decisions).HasColumnType("jsonb");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>()
            .Property(n => n.ActionItems).HasColumnType("jsonb");
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>()
            .Property(n => n.Speakers).HasColumnType("jsonb");
        // Added by 20260903-connect-notes-attendance: who came, and for how
        // long. Same jsonb rule as the five above — Npgsql maps a string to
        // `text` by default and `text` does not implicitly cast to `jsonb`.
        b.Entity<TatvaOS.Api.Modules.Connect.ConnectMeetingNotes>()
            .Property(n => n.Attendance).HasColumnType("jsonb");

        b.Entity<CalendarMember>().HasKey(m => new { m.CalendarId, m.UserId });
        b.Entity<CalendarReminderSend>().HasKey(r => new { r.ReminderId, r.OccurrenceStartsAt });

        // FKs declared so EF orders inserts correctly. An undeclared FK has
        // broken insert ordering here before — the parent went in after the
        // child and the whole SaveChanges failed on a constraint.
        b.Entity<CalendarMember>()
            .HasOne<CalendarCalendar>().WithMany()
            .HasForeignKey(m => m.CalendarId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<CalendarEvent>()
            .HasOne<CalendarCalendar>().WithMany()
            .HasForeignKey(e => e.CalendarId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<CalendarAttendee>()
            .HasOne<CalendarEvent>().WithMany()
            .HasForeignKey(a => a.EventId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<CalendarReminder>()
            .HasOne<CalendarEvent>().WithMany()
            .HasForeignKey(r => r.EventId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<CalendarEventException>()
            .HasOne<CalendarEvent>().WithMany()
            .HasForeignKey(x => x.EventId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<CalendarReminderSend>()
            .HasOne<CalendarReminder>().WithMany()
            .HasForeignKey(s => s.ReminderId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceShare>().ToTable("shares", "space");
        b.Entity<SpaceFileActivity>().ToTable("file_activity", "space");
        b.Entity<SpaceStar>().ToTable("stars", "space");
        b.Entity<SpacePublicLink>().ToTable("public_links", "space");
        b.Entity<SpaceTenantSetting>().ToTable("tenant_settings", "space");

        // ---- Column types Npgsql cannot infer ----------------------------
        // A string property maps to text by default, and PostgreSQL has no
        // implicit text -> jsonb cast, so every audit write would fail at
        // runtime while compiling perfectly. Stating the type makes Npgsql
        // send the parameter as jsonb.
        b.Entity<AuditLog>().Property(a => a.BeforeState).HasColumnType("jsonb");
        b.Entity<AuditLog>().Property(a => a.AfterState).HasColumnType("jsonb");

        // Same reason as the audit log's state columns: without this Npgsql
        // sends text and Postgres will not implicitly cast it to jsonb.
        b.Entity<FilterRule>().Property(r => r.Conditions).HasColumnType("jsonb");
        b.Entity<FilterRule>().Property(r => r.Actions).HasColumnType("jsonb");

        // The search vector belongs to the database: a trigger maintains it
        // (15-mail-search.sql). Telling EF it is store-generated stops it
        // writing NULL over the trigger's work on every update.
        b.Entity<Message>().Property(m => m.SearchVector).ValueGeneratedOnAddOrUpdate();

        // Same two reasons as above, for Family: jsonb needs stating, and the
        // contact search vector is trigger-maintained (19-family-schema.sql).
        b.Entity<ContactAuditLog>().Property(a => a.Changes).HasColumnType("jsonb");
        b.Entity<Contact>().Property(c => c.SearchVector).ValueGeneratedOnAddOrUpdate();

        // Space file names, same trigger arrangement (25-space-schema.sql).
        b.Entity<SpaceFile>().Property(f => f.SearchVector).ValueGeneratedOnAddOrUpdate();

        // ---- Keys --------------------------------------------------------
        b.Entity<Product>().HasKey(p => p.Code);
        b.Entity<ProductAccess>().HasKey(p => new { p.UserId, p.ProductCode });
        b.Entity<StoragePool>().HasKey(s => s.TenantId);
        b.Entity<StorageAllocation>().HasKey(s => new { s.TenantId, s.ProductCode });
        b.Entity<MailboxPermission>().HasKey(p => new { p.MailboxId, p.UserId, p.Permission });
        b.Entity<ContactGroupMember>().HasKey(m => new { m.GroupId, m.ContactId });
        b.Entity<SpaceFileActivity>().HasKey(a => new { a.UserId, a.FileId });
        b.Entity<SpaceTenantSetting>().HasKey(s => s.TenantId);
        // One token hash, one link — mirrors uq_space_public_links_token.
        b.Entity<SpacePublicLink>().HasIndex(l => l.TokenHash).IsUnique();

        // ---- Global tenant filters ---------------------------------------
        // Everything carrying a TenantId. Tenants are the boundary itself;
        // Products and Plans are platform-wide catalogue data.
        b.Entity<Domain>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<User>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Department>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ProductAccess>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Subscription>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<StoragePool>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<StorageAllocation>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<AuditLog>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<RefreshToken>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<UserAvatar>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Mailbox>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Alias>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Folder>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Message>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Attachment>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<BlockedSender>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<FilterRule>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Signature>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<VacationResponder>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<VacationSend>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<DkimKey>().HasQueryFilter(e => e.TenantId == tenant.TenantId);

        // Family. The contact filter carries the OWNERSHIP test as well as the
        // tenant one, because Family's boundary is the person, not only the
        // organisation — a colleague must not see my personal contacts. It
        // mirrors the RLS policy exactly; the policy is still the guarantee.
        //
        // Child rows are filtered by tenant here and scoped through the parent
        // contact by RLS. Repeating the ownership test on each child in C#
        // would be a second place for the two to drift apart.
        b.Entity<Contact>().HasQueryFilter(e =>
            e.TenantId == tenant.TenantId &&
            (e.OwnershipType == "organisational" || e.OwnerUserId == tenant.UserId));
        b.Entity<ContactEmail>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactPhone>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactAddress>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactGroup>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactGroupMember>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactInteraction>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactAuditLog>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ContactSetting>().HasQueryFilter(e =>
            e.TenantId == tenant.TenantId && e.UserId == tenant.UserId);
        b.Entity<ContactSource>().HasQueryFilter(e => e.TenantId == tenant.TenantId);

        // Space. Tenant-scoped ONLY here, deliberately weaker than the RLS
        // policy: visibility through shares and ancestor folders needs a
        // recursive walk no EF filter can express. RLS is the guarantee —
        // these filters just stop an accidental cross-tenant query from
        // compiling into something that looks like it worked.
        b.Entity<SpaceFolder>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<SpaceFile>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<SpaceShare>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        // Activity and stars are PER-USER, and unlike the tables above their
        // EF filters can say so fully — no share/ancestor walk involved. The
        // RLS policies (29-space-drive.sql) repeat the same test underneath.
        b.Entity<SpaceFileActivity>().HasQueryFilter(e =>
            e.TenantId == tenant.TenantId && e.UserId == tenant.UserId);
        b.Entity<SpaceStar>().HasQueryFilter(e =>
            e.TenantId == tenant.TenantId && e.UserId == tenant.UserId);
        b.Entity<SpacePublicLink>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<SpaceTenantSetting>().HasQueryFilter(e => e.TenantId == tenant.TenantId);

        // ---- Uniqueness ---------------------------------------------------
        // Domains are unique across the WHOLE platform, not per tenant. Two
        // organisations cannot both claim example.com — whoever verifies
        // ownership first holds it.
        b.Entity<Domain>().HasIndex(d => d.Fqdn).IsUnique();

        // One key per selector per domain. Rotation adds a row with a NEW
        // selector rather than replacing this one, so both can sign while DNS
        // propagates and no message in flight loses its signature.
        b.Entity<DkimKey>().HasIndex(k => new { k.DomainId, k.Selector }).IsUnique();

        // Declared explicitly, like every other relationship here. EF orders
        // inserts by the relationships it KNOWS about, not by the constraints
        // in the database — an undeclared FK is how the signup 500 happened.
        b.Entity<DkimKey>().HasOne<Domain>().WithMany()
            .HasForeignKey(k => k.DomainId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<DkimKey>().HasOne<Tenant>().WithMany()
            .HasForeignKey(k => k.TenantId).OnDelete(DeleteBehavior.Cascade);

        // Addresses likewise. A single address resolves to exactly one mailbox
        // anywhere on the platform, or delivery is ambiguous.
        b.Entity<Mailbox>().HasIndex(m => m.Address).IsUnique();
        b.Entity<Alias>().HasIndex(a => a.Address).IsUnique();
        b.Entity<User>().HasIndex(u => u.Email).IsUnique();

        b.Entity<Department>().HasIndex(c => new { c.TenantId, c.Name }).IsUnique();
        b.Entity<Folder>().HasIndex(f => new { f.MailboxId, f.Name }).IsUnique();
        // Both mirror UNIQUE constraints in the SQL (13-mail-blocklist.sql,
        // 17-mail-signatures.sql) so EF and the database agree about what a
        // duplicate is.
        b.Entity<BlockedSender>().HasIndex(x => new { x.MailboxId, x.Address }).IsUnique();
        b.Entity<Signature>().HasIndex(s => s.MailboxId).IsUnique();
        b.Entity<VacationResponder>().HasIndex(v => v.MailboxId).IsUnique();
        // Composite key, matching the table: one row per mailbox per
        // correspondent is the whole point of it.
        b.Entity<VacationSend>().HasKey(v => new { v.MailboxId, v.Address });

        b.Entity<ContactGroup>().HasIndex(g => new { g.TenantId, g.Name }).IsUnique();
        b.Entity<ContactSetting>().HasIndex(s => new { s.TenantId, s.UserId }).IsUnique();
        b.Entity<ContactSource>()
            .HasIndex(s => new { s.ContactId, s.MailMessageId, s.SourceType }).IsUnique();
        // The address lookup auto-save performs on every delivered message.
        b.Entity<ContactEmail>().HasIndex(e => new { e.TenantId, e.EmailNormalised });

        // ---- Read paths that matter ---------------------------------------
        b.Entity<Message>().HasIndex(m => new { m.MailboxId, m.ReceivedAt });
        b.Entity<Message>().HasIndex(m => new { m.FolderId, m.ImapUid });
        b.Entity<User>().HasIndex(u => new { u.TenantId, u.DepartmentId });
        b.Entity<AuditLog>().HasIndex(a => new { a.TenantId, a.OccurredAt });

        // ---- Relationships --------------------------------------------------
        b.Entity<Domain>()
            .HasOne(d => d.Tenant).WithMany(t => t.Domains)
            .HasForeignKey(d => d.TenantId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<User>()
            .HasOne(u => u.Department).WithMany()
            .HasForeignKey(u => u.DepartmentId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<User>()
            .HasOne(u => u.Domain).WithMany()
            .HasForeignKey(u => u.DomainId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<Mailbox>()
            .HasOne(m => m.Domain).WithMany()
            .HasForeignKey(m => m.DomainId).OnDelete(DeleteBehavior.Cascade);

        // SetNull, not Cascade. A departed employee's mailbox is retained for
        // the legal window after the person is removed — that retention is the
        // reason users and mailboxes are separate tables at all.
        b.Entity<Mailbox>()
            .HasOne(m => m.User).WithMany()
            .HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<Subscription>()
            .HasOne(s => s.Plan).WithMany()
            .HasForeignKey(s => s.PlanId).OnDelete(DeleteBehavior.Restrict);

        // ------------------------------------------------------------------
        //  Every remaining foreign key, declared even though no navigation
        //  property wants it.
        //
        //  EF orders INSERTs by the relationships it KNOWS about, not by the
        //  constraints the database has. ProductAccess carried a UserId with
        //  no configured relationship, so EF batched it BEFORE the user it
        //  points at and signup died on product_access_user_id_fkey — while
        //  the same save with the same data would have worked in a different
        //  arbitrary order. Undeclared FKs make insert ordering a coin toss.
        //
        //  Delete behaviours mirror the SQL exactly; the database enforces
        //  them regardless, this just keeps EF's view truthful.
        // ------------------------------------------------------------------
        b.Entity<ProductAccess>()
            .HasOne<User>().WithMany()
            .HasForeignKey(p => p.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<ProductAccess>()
            .HasOne<Tenant>().WithMany()
            .HasForeignKey(p => p.TenantId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<StoragePool>()
            .HasOne<Tenant>().WithMany()
            .HasForeignKey(s => s.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<StorageAllocation>()
            .HasOne<Tenant>().WithMany()
            .HasForeignKey(s => s.TenantId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<RefreshToken>()
            .HasOne<User>().WithMany()
            .HasForeignKey(t => t.UserId).OnDelete(DeleteBehavior.Cascade);

        // Declared for the same reason every other relationship here is: EF
        // orders inserts by the relationships it KNOWS about, and an undeclared
        // one is how a row gets written before the row it references. That
        // exact omission on refresh_tokens.replaced_by is what made every hard
        // reload sign people out.
        b.Entity<MfaRecoveryCode>()
            .HasOne<User>().WithMany()
            .HasForeignKey(c => c.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<MfaRecoveryCode>()
            .HasOne<Tenant>().WithMany()
            .HasForeignKey(c => c.TenantId).OnDelete(DeleteBehavior.Cascade);
        // The avatar's UserId is BOTH its primary key and its foreign key to
        // the person. Declared so EF inserts the user before the photo and lets
        // the DB cascade the delete when a person is removed.
        b.Entity<UserAvatar>()
            .HasOne<User>().WithOne()
            .HasForeignKey<UserAvatar>(a => a.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<RefreshToken>()
            .HasOne<Tenant>().WithMany()
            .HasForeignKey(t => t.TenantId).OnDelete(DeleteBehavior.Cascade);
        // The rotation self-reference. Without this declared, EF does not know
        // the UPDATE that stamps old.replaced_by depends on the INSERT of the
        // new row, orders them wrong inside one SaveChanges, and the database
        // rejects every token rotation with a 23503 — which presents as "F5
        // logs me out". Same lesson as department_id and DkimKeys: EF orders
        // writes by DECLARED relationships, and only migrations it generates
        // would have caught the omission. Ours come from SQL files.
        b.Entity<RefreshToken>()
            .HasOne<RefreshToken>().WithMany()
            .HasForeignKey(t => t.ReplacedBy).OnDelete(DeleteBehavior.SetNull);

        b.Entity<MailboxPermission>()
            .HasOne<Mailbox>().WithMany()
            .HasForeignKey(p => p.MailboxId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<MailboxPermission>()
            .HasOne<User>().WithMany()
            .HasForeignKey(p => p.UserId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<Alias>()
            .HasOne<Mailbox>().WithMany()
            .HasForeignKey(a => a.TargetMailboxId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Alias>()
            .HasOne<Domain>().WithMany()
            .HasForeignKey(a => a.DomainId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<Folder>()
            .HasOne<Mailbox>().WithMany()
            .HasForeignKey(f => f.MailboxId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<Message>()
            .HasOne<Mailbox>().WithMany()
            .HasForeignKey(m => m.MailboxId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Message>()
            .HasOne<Folder>().WithMany()
            .HasForeignKey(m => m.FolderId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<Attachment>()
            .HasOne<Message>().WithMany()
            .HasForeignKey(a => a.MessageId).OnDelete(DeleteBehavior.Cascade);

        // Self-reference. Cascade matches the SQL: deleting Engineering takes
        // Engineering > Backend with it, rather than orphaning the child to
        // top level — which would silently grant it whatever the root permits.
        b.Entity<Department>()
            .HasOne<Department>().WithMany()
            .HasForeignKey(d => d.ParentId).OnDelete(DeleteBehavior.Cascade);

        // ---- Family ------------------------------------------------------
        // Declared for the same reason as everywhere else in this file: EF
        // orders its writes by the relationships it knows about, and an
        // undeclared one produces a 23503 at runtime, not at build.
        b.Entity<Contact>().HasOne<Tenant>().WithMany()
            .HasForeignKey(c => c.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Contact>().HasOne<User>().WithMany()
            .HasForeignKey(c => c.OwnerUserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Contact>().HasOne<User>().WithMany()
            .HasForeignKey(c => c.CreatedByUserId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<ContactEmail>().HasOne<Contact>().WithMany(c => c.Emails)
            .HasForeignKey(e => e.ContactId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<ContactPhone>().HasOne<Contact>().WithMany(c => c.Phones)
            .HasForeignKey(e => e.ContactId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<ContactAddress>().HasOne<Contact>().WithMany(c => c.Addresses)
            .HasForeignKey(e => e.ContactId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<ContactGroupMember>().HasOne<ContactGroup>().WithMany()
            .HasForeignKey(m => m.GroupId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<ContactGroupMember>().HasOne<Contact>().WithMany()
            .HasForeignKey(m => m.ContactId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<ContactInteraction>().HasOne<Contact>().WithMany()
            .HasForeignKey(i => i.ContactId).OnDelete(DeleteBehavior.Cascade);
        // Set-null, not cascade: the fact of the exchange outlives the message.
        b.Entity<ContactInteraction>().HasOne<Message>().WithMany()
            .HasForeignKey(i => i.MailMessageId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<ContactAuditLog>().HasOne<Contact>().WithMany()
            .HasForeignKey(a => a.ContactId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<ContactAuditLog>().HasOne<User>().WithMany()
            .HasForeignKey(a => a.ActorUserId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<ContactSetting>().HasOne<User>().WithMany()
            .HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<ContactSource>().HasOne<Contact>().WithMany()
            .HasForeignKey(x => x.ContactId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<ContactSource>().HasOne<Message>().WithMany()
            .HasForeignKey(x => x.MailMessageId).OnDelete(DeleteBehavior.Cascade);

        // ---- Space -------------------------------------------------------
        // One blob, one row — mirrors uq_space_files_blob so EF and the
        // database agree what a duplicate is. Purging one row must never be
        // able to destroy another row's bytes.
        b.Entity<SpaceFile>().HasIndex(f => f.BlobKey).IsUnique();

        // Every FK declared, as everywhere in this file: EF orders writes by
        // the relationships it KNOWS about, and an undeclared one is a 23503
        // at runtime. Owner FKs are SetNull, not Cascade — the Family
        // departure lesson: files outlive their owner as retained rows.
        b.Entity<SpaceFolder>().HasOne<Tenant>().WithMany()
            .HasForeignKey(f => f.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceFolder>().HasOne<SpaceFolder>().WithMany()
            .HasForeignKey(f => f.ParentFolderId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceFolder>().HasOne<User>().WithMany()
            .HasForeignKey(f => f.OwnerUserId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<SpaceFolder>().HasOne<User>().WithMany()
            .HasForeignKey(f => f.CreatedByUserId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<SpaceFolder>().HasOne<User>().WithMany()
            .HasForeignKey(f => f.DeletedByUserId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<SpaceFile>().HasOne<Tenant>().WithMany()
            .HasForeignKey(f => f.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceFile>().HasOne<SpaceFolder>().WithMany()
            .HasForeignKey(f => f.FolderId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceFile>().HasOne<User>().WithMany()
            .HasForeignKey(f => f.OwnerUserId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<SpaceFile>().HasOne<User>().WithMany()
            .HasForeignKey(f => f.CreatedByUserId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<SpaceFile>().HasOne<User>().WithMany()
            .HasForeignKey(f => f.DeletedByUserId).OnDelete(DeleteBehavior.SetNull);

        b.Entity<SpaceShare>().HasOne<Tenant>().WithMany()
            .HasForeignKey(s => s.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceShare>().HasOne<SpaceFile>().WithMany()
            .HasForeignKey(s => s.FileId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceShare>().HasOne<SpaceFolder>().WithMany()
            .HasForeignKey(s => s.FolderId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceShare>().HasOne<User>().WithMany()
            .HasForeignKey(s => s.SharedByUserId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<SpaceShare>().HasOne<User>().WithMany()
            .HasForeignKey(s => s.SharedWithUserId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<SpaceFileActivity>().HasOne<Tenant>().WithMany()
            .HasForeignKey(a => a.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceFileActivity>().HasOne<User>().WithMany()
            .HasForeignKey(a => a.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceFileActivity>().HasOne<SpaceFile>().WithMany()
            .HasForeignKey(a => a.FileId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<SpaceStar>().HasOne<Tenant>().WithMany()
            .HasForeignKey(s => s.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceStar>().HasOne<User>().WithMany()
            .HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceStar>().HasOne<SpaceFile>().WithMany()
            .HasForeignKey(s => s.FileId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpaceStar>().HasOne<SpaceFolder>().WithMany()
            .HasForeignKey(s => s.FolderId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<SpacePublicLink>().HasOne<Tenant>().WithMany()
            .HasForeignKey(l => l.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpacePublicLink>().HasOne<SpaceFile>().WithMany()
            .HasForeignKey(l => l.FileId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<SpacePublicLink>().HasOne<User>().WithMany()
            .HasForeignKey(l => l.CreatedByUserId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<SpaceTenantSetting>().HasOne<Tenant>().WithOne()
            .HasForeignKey<SpaceTenantSetting>(s => s.TenantId).OnDelete(DeleteBehavior.Cascade);

        base.OnModelCreating(b);

        // ---- snake_case columns ---------------------------------------------
        // The schema is written by hand in local/postgres/init, in snake_case.
        // EF's default would look for a "TenantId" column and fail at runtime
        // on every single query while compiling perfectly — the worst kind of
        // mismatch. Done as a convention rather than 150 [Column] attributes,
        // and rather than a naming-convention package, which would tie the
        // build to a third party shipping an EF 10 target on time.
        foreach (var entity in b.Model.GetEntityTypes())
            foreach (var property in entity.GetProperties())
                property.SetColumnName(ToSnakeCase(property.Name));
    }

    internal static string ToSnakeCase(string name)
    {
        var sb = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c))
            {
                // Break before an upper-case letter that starts a new word, so
                // "ImapUid" becomes imap_uid and "Sha256" stays sha256.
                if (i > 0 && (char.IsLower(name[i - 1]) || char.IsDigit(name[i - 1]) ||
                              (i + 1 < name.Length && char.IsLower(name[i + 1]))))
                    sb.Append('_');
                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    /// <summary>
    /// Re-applies app.tenant_id to a connection that is ALREADY OPEN.
    ///
    /// TenantConnectionInterceptor sets the value when a connection opens. That
    /// covers the normal case, because EF returns the connection to the pool
    /// between operations and the interceptor runs again on the next open.
    ///
    /// It does NOT cover switching tenants mid-request while a connection is
    /// held — a platform admin iterating organisations inside a transaction.
    /// There the C# TenantContext would move on while the database session
    /// still enforced the previous tenant, and a write to an RLS-forced table
    /// would either fail or, worse, land under the wrong tenant.
    ///
    /// Call this immediately after EnterPlatformScope.
    /// </summary>
    public async Task SyncTenantAsync(CancellationToken ct = default)
    {
        var conn = Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) return;  // next open handles it
        if (!tenant.HasTenant) return;

        await using var cmd = conn.CreateCommand();
        cmd.Transaction = Database.CurrentTransaction?.GetDbTransaction();
        // Both settings, matching TenantConnectionInterceptor — Family's RLS
        // reads app.user_id and would otherwise see the previous scope's person.
        cmd.CommandText = "SELECT set_config('app.tenant_id', @tenant, false), " +
                          "       set_config('app.user_id',   @user,   false)";
        var p = cmd.CreateParameter();
        p.ParameterName = "@tenant";
        p.Value = tenant.TenantId.ToString();
        cmd.Parameters.Add(p);
        var u = cmd.CreateParameter();
        u.ParameterName = "@user";
        u.Value = tenant.UserId?.ToString() ?? string.Empty;
        cmd.Parameters.Add(u);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// Stamps TenantId on new rows so callers cannot forget, and cannot set it
    /// to another tenant.
    ///
    /// Note this does not weaken the database check — RLS WITH CHECK still
    /// rejects a mismatched row. This turns a database error into an
    /// impossibility, which is a better place to catch it.
    /// </summary>
    public override Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        if (tenant.HasTenant)
        {
            foreach (var entry in ChangeTracker.Entries())
            {
                if (entry.State != EntityState.Added) continue;

                var prop = entry.Metadata.FindProperty("TenantId");
                if (prop is null) continue;

                entry.CurrentValues["TenantId"] = tenant.TenantId;
            }
        }

        return base.SaveChangesAsync(ct);
    }
}
