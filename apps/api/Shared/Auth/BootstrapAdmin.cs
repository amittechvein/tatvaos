using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Auth;

/// <summary>
/// Creates the first super admin, once, from environment variables.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Why this exists at all.
///
///  A fresh database has no way in. Passwords are Argon2id, so an account
///  cannot be seeded from SQL — there is no way to write a valid hash by
///  hand. And seeding a known default password would put the SAME credential
///  on every install of this software, which is worse than having no login.
///
///  So the first account is created from BOOTSTRAP_ADMIN_EMAIL and
///  BOOTSTRAP_ADMIN_PASSWORD, and only when no super admin exists yet. On
///  every subsequent start one does, and this is a no-op — so leaving the
///  variables set does not re-create or reset anything. Removing them after
///  the first start is still the right habit.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class BootstrapAdmin
{
    public static async Task EnsureAsync(IServiceProvider services, ILogger logger)
    {
        var email = Environment.GetEnvironmentVariable("BOOTSTRAP_ADMIN_EMAIL")?.Trim().ToLowerInvariant();
        var password = Environment.GetEnvironmentVariable("BOOTSTRAP_ADMIN_PASSWORD");

        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
            return;

        if (password.Length < 12)
        {
            logger.LogWarning(
                "BOOTSTRAP_ADMIN_PASSWORD is shorter than 12 characters. Refusing to create " +
                "the platform administrator with it.");
            return;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

        try
        {
            // IgnoreQueryFilters: there is no request and therefore no tenant,
            // and this deliberately asks a platform-wide question.
            var exists = await db.Users.IgnoreQueryFilters()
                .AnyAsync(u => u.Role == "super_admin" && u.Status != "deleted");

            if (exists)
            {
                logger.LogInformation("Platform administrator already exists — bootstrap skipped.");
                return;
            }

            // The super admin belongs to the operator's own tenant. Techvein is
            // a customer of its own platform, which keeps one code path for
            // everyone rather than a privileged account that exists outside the
            // tenancy model and therefore outside its guarantees.
            var org = await db.Tenants.IgnoreQueryFilters()
                .OrderBy(t => t.CreatedAt)
                .FirstOrDefaultAsync();

            if (org is null)
            {
                logger.LogWarning(
                    "No organisation exists yet, so there is nothing to attach the platform " +
                    "administrator to. Apply the seed first.");
                return;
            }

            var taken = await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == email);
            if (taken)
            {
                logger.LogWarning(
                    "BOOTSTRAP_ADMIN_EMAIL {Email} is already in use. Not modifying the existing " +
                    "account — this task only ever creates, never overwrites.", email);
                return;
            }

            tenant.EnterPlatformScope(org.Id, Guid.Empty);
            await db.SyncTenantAsync();

            var admin = new User
            {
                TenantId = org.Id,
                Email = email,
                DisplayName = "Platform Administrator",
                Role = "super_admin",
                Status = "active",
                PasswordHash = hasher.Hash(password),
                // They chose this password from an environment variable, which
                // tends to mean it is in a shell history and a deploy log.
                MustChangePassword = true,
            };
            db.Users.Add(admin);
            db.Calendars.Add(TatvaOS.Api.Modules.Calendar.CalendarProvisioning.PrimaryFor(org.Id, admin.Id));

            await db.SaveChangesAsync();

            logger.LogWarning(
                "Created the platform administrator {Email}. It must change its password on " +
                "first sign-in. Unset BOOTSTRAP_ADMIN_PASSWORD now.", email);
        }
        catch (Exception ex)
        {
            // Never take the API down over this. A failure here means nobody
            // can sign in yet, which is visible and fixable; a crash loop means
            // nothing works at all and the reason is buried in container logs.
            logger.LogError(ex, "Bootstrap of the platform administrator failed.");
        }
    }
}
