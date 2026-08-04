using Microsoft.EntityFrameworkCore;
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
    // Routing — no RLS, read cross-tenant by the mail edge
    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<Domain> Domains => Set<Domain>();
    public DbSet<Mailbox> Mailboxes => Set<Mailbox>();
    public DbSet<Alias> Aliases => Set<Alias>();
    public DbSet<UserCategory> UserCategories => Set<UserCategory>();
    public DbSet<Plan> Plans => Set<Plan>();

    // Content — RLS enabled and forced
    public DbSet<Folder> Folders => Set<Folder>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        // ---- Global tenant filters -------------------------------------
        // Applied to everything carrying a TenantId. Plans are global and
        // Tenants are the boundary itself, so neither is filtered.
        b.Entity<Domain>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Mailbox>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Alias>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<UserCategory>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Folder>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<Message>().HasQueryFilter(e => e.TenantId == tenant.TenantId);
        b.Entity<AuditLog>().HasQueryFilter(e => e.TenantId == tenant.TenantId);

        // ---- Table and column naming -----------------------------------
        // snake_case to match the SQL written by hand in local/postgres.
        b.Entity<Tenant>().ToTable("tenants");
        b.Entity<Domain>().ToTable("domains");
        b.Entity<Mailbox>().ToTable("mailboxes");
        b.Entity<Alias>().ToTable("aliases");
        b.Entity<UserCategory>().ToTable("user_categories");
        b.Entity<Folder>().ToTable("folders");
        b.Entity<Message>().ToTable("messages");
        b.Entity<AuditLog>().ToTable("audit_logs");
        b.Entity<Plan>().ToTable("plans");

        // ---- Uniqueness -------------------------------------------------
        // Domains are unique across the WHOLE platform, not per tenant. Two
        // organisations cannot both claim example.com — whoever verifies
        // ownership first holds it.
        b.Entity<Domain>().HasIndex(d => d.Fqdn).IsUnique();

        // Addresses likewise. A single address resolves to exactly one
        // mailbox anywhere on the platform, or delivery is ambiguous.
        b.Entity<Mailbox>().HasIndex(m => m.Address).IsUnique();
        b.Entity<Alias>().HasIndex(a => a.Address).IsUnique();

        b.Entity<UserCategory>().HasIndex(c => new { c.TenantId, c.Name }).IsUnique();
        b.Entity<Folder>().HasIndex(f => new { f.MailboxId, f.Name }).IsUnique();

        // ---- Read paths that matter --------------------------------------
        b.Entity<Message>().HasIndex(m => new { m.MailboxId, m.ReceivedAt });
        b.Entity<Message>().HasIndex(m => new { m.FolderId, m.ImapUid });
        b.Entity<Mailbox>().HasIndex(m => new { m.TenantId, m.CategoryId });
        b.Entity<AuditLog>().HasIndex(a => new { a.TenantId, a.OccurredAt });

        // ---- Relationships ------------------------------------------------
        b.Entity<Domain>()
            .HasOne(d => d.Tenant).WithMany(t => t.Domains)
            .HasForeignKey(d => d.TenantId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<Mailbox>()
            .HasOne(m => m.Domain).WithMany()
            .HasForeignKey(m => m.DomainId).OnDelete(DeleteBehavior.Cascade);

        b.Entity<Mailbox>()
            .HasOne(m => m.Category).WithMany()
            .HasForeignKey(m => m.CategoryId).OnDelete(DeleteBehavior.SetNull);

        base.OnModelCreating(b);
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
