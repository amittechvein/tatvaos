using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Core;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Abandoned domain claims, swept.
///
/// ── WHY ──────────────────────────────────────────────────────────────────
///
///  Mr. Singh, 24 September 2026, on domain squatting: "expire pending
///  claims — an unverified claim older than thirty days is abandoned and
///  should be swept, which shrinks the squatting surface even before anyone
///  verifies."
///
///  Since the same day, a pending claim no longer blocks anyone else from
///  claiming the same name, so a stale claim is untidiness rather than a
///  weapon. It is still worth removing: it holds a DKIM key the platform
///  signs nothing with, it clutters the owner's console, and a thousand of
///  them left by a script are a thousand rows nobody will ever look at.
///
/// ── WHAT IT WILL NOT TOUCH ───────────────────────────────────────────────
///
///  Verified domains, ever — those are somebody's live mail.
///  Superseded rows, ever — those are the record of why a claim ended, and
///  the only thing that can still tell that organisation what happened.
///  Platform domains, ever.
///
///  It deletes the row, which cascades to the domain's DKIM key rows. That
///  is safe for exactly the reason the endpoint may close a losing claim:
///  nothing can attach to an unverified domain — both mailbox paths refuse
///  unless it is verified AND active. If that ever changes, this worker has
///  to check before deleting, and the test below is where that belief is
///  written down.
/// </summary>
public sealed class DomainClaimSweepWorker(
    IServiceScopeFactory scopes, ILogger<DomainClaimSweepWorker> log) : BackgroundService
{
    /// <summary>Daily. An abandoned claim is not an emergency.</summary>
    private static readonly TimeSpan Every = TimeSpan.FromHours(24);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        // Not on the first tick: a deploy restarts every container, and a
        // sweep racing the API's own startup buys nothing.
        await Task.Delay(TimeSpan.FromMinutes(10), ct);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                // Never fatal: a failed sweep must not take the API down, and
                // the next tick tries again. Logged so a sweep that has been
                // failing for a month is a fact somewhere.
                log.LogError(ex, "Domain claim sweep failed; will try again in {Hours}h", Every.TotalHours);
            }

            await Task.Delay(Every, ct);
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var cutoff = DateTimeOffset.UtcNow - DomainClaims.PendingClaimLifetime;

        // IgnoreQueryFilters: this runs for the whole platform, with no tenant.
        var stale = await db.Domains.IgnoreQueryFilters()
            .Where(d => d.OwnershipVerifiedAt == null
                     && d.SupersededAt == null
                     && !d.IsPlatform
                     && d.CreatedAt < cutoff)
            .Select(d => new { d.Id, d.Fqdn })
            .ToListAsync(ct);

        if (stale.Count == 0) return;

        var ids = stale.Select(s => s.Id).ToList();
        await db.Domains.IgnoreQueryFilters().Where(d => ids.Contains(d.Id)).ExecuteDeleteAsync(ct);

        // Named, not counted: a sweep that removed someone's claim should be
        // answerable later with "which one, and when".
        log.LogInformation("Swept {Count} domain claim(s) unverified for more than {Days} days: {Fqdns}",
                           stale.Count, DomainClaims.PendingClaimLifetime.TotalDays,
                           string.Join(", ", stale.Select(s => s.Fqdn)));
    }
}
