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
    public DbSet<User> Users => Set<User>();
    public DbSet<UserCategory> UserCategories => Set<UserCategory>();

    // ---- core: commercial. RLS enabled and forced ----
    public DbSet<ProductAccess> ProductAccess => Set<ProductAccess>();
    public DbSet<Plan> Plans => Set<Plan>();
    public DbSet<Subscription> Subscriptions => Set<Subscription>();
    public DbSet<StoragePool> StoragePools => Set<StoragePool>();
    public DbSet<StorageAllocation> StorageAllocations => Set<StorageAllocation>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

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

    protected override void OnModelCreating(ModelBuilder b)
    {
        // ---- Schemas -----------------------------------------------------
        // Explicit on every entity. There is no default schema, because a
        // default is exactly how a Mail table silently lands in core.
        b.Entity<Product>().ToTable("products", "core");
        b.Entity<Tenant>().ToTable("tenants", "core");
        b.Entity<Domain>().ToTable("domains", "core");
        b.Entity<User>().ToTable("users", "core");
        b.Entity<UserCategory>().ToTable("user_categories", "core");
        b.Entity<ProductAccess>().ToTable("product_access", "core");
        b.Entity<Plan>().ToTable("plans", "core");
        b.Entity<Subscription>().ToTable("subscriptions", "core");
        b.Entity<StoragePool>().ToTable("storage_pools", "core");
        b.Entity<StorageAllocation>().ToTable("storage_allocations", "core");
        b.Entity<AuditLog>().ToTable("audit_logs", "core");
        b.Entity<RefreshToken>().ToTable("refresh_tokens", "core");
        b.Entity<SignupDraft>().ToTable("signup_drafts", "core");
        b.Entity<PlatformSetting>().ToTable("platform_settings", "core");
        b.Entity<PlatformSetting>().HasKey(s => s.Key);

        b.Entity<Mailbox>().ToTable("mailboxes", "mail");
        b.Entity<Alias>().ToTable("aliases", "mail");
        b.Entity<MailboxPermission>().ToTable("mailbox_permissions", "mail");
        b.Entity<Folder>().ToTable("folders", "mail");
        b.Entity<Message>().ToTable("messages", "mail");
        b.Entity<Attachment>().ToTable("attachments", "mail");

        // ---- Column types Npgsql cannot infer ----------------------------
        // A string property maps to text by default, and PostgreSQL has no
        // implicit text -> jsonb cast, so every audit write would fail at
        // runtime while compiling perfectly. Stating the type makes Npgsql
        // send the parameter as jsonb.
        b.Entity<AuditLog>().Property(a => a.BeforeState).HasColumnType("jsonb");
        b.Entity<AuditLog>().Property(a => a.AfterState).HasColumnType("jsonb");

        // ---- Keys --------------------------------------------------------
        b.Entity<Product>().HasKey(p => p.Code);
        b.Entity<ProductAccess>().HasKey(p => new { p.UserId, p.ProductCode });
        b.Entity<StoragePool>().HasKey(s => s.TenantId);
        b.Entity<StorageAllocation>().HasKey(s => new { s.TenantId, s.ProductCode });
        b.Entity<MailboxPermission>().HasKey(p => new { p.MailboxId, p.UserId, p.Permission });

        // ---- Global tenant filters ---------------------------------------
        // Everything carrying a TenantId. Tenants are the boundary itself;
        // Products and Plans are platform-wide catalogue data.
        b.Entity<Domain>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<User>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<UserCategory>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<ProductAccess>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Subscription>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<StoragePool>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<StorageAllocation>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<AuditLog>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<RefreshToken>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Mailbox>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Alias>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Folder>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Message>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Attachment>().HasQueryFilter(e => e.TenantId == tenant.TenantId);

        // ---- Uniqueness ---------------------------------------------------
        // Domains are unique across the WHOLE platform, not per tenant. Two
        // organisations cannot both claim example.com — whoever verifies
        // ownership first holds it.
        b.Entity<Domain>().HasIndex(d => d.Fqdn).IsUnique();

        // Addresses likewise. A single address resolves to exactly one mailbox
        // anywhere on the platform, or delivery is ambiguous.
        b.Entity<Mailbox>().HasIndex(m => m.Address).IsUnique();
        b.Entity<Alias>().HasIndex(a => a.Address).IsUnique();
        b.Entity<User>().HasIndex(u => u.Email).IsUnique();

        b.Entity<UserCategory>().HasIndex(c => new { c.TenantId, c.Name }).IsUnique();
        b.Entity<Folder>().HasIndex(f => new { f.MailboxId, f.Name }).IsUnique();

        // ---- Read paths that matter ---------------------------------------
        b.Entity<Message>().HasIndex(m => new { m.MailboxId, m.ReceivedAt });
        b.Entity<Message>().HasIndex(m => new { m.FolderId, m.ImapUid });
        b.Entity<User>().HasIndex(u => new { u.TenantId, u.CategoryId });
        b.Entity<AuditLog>().HasIndex(a => new { a.TenantId, a.OccurredAt });

        // ---- Relationships --------------------------------------------------
        b.Entity<Domain>()
            .HasOne(d => d.Tenant).WithMany(t => t.Domains)
            .HasForeignKey(d => d.TenantId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<User>()
            .HasOne(u => u.Category).WithMany()
            .HasForeignKey(u => u.CategoryId).OnDelete(DeleteBehavior.SetNull);

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
        cmd.CommandText = "SELECT set_config('app.tenant_id', @tenant, false)";
        var p = cmd.CreateParameter();
        p.ParameterName = "@tenant";
        p.Value = tenant.TenantId.ToString();
        cmd.Parameters.Add(p);
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
