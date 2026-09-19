using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// Every person gets a primary calendar, made where the person is made.
///
/// ── THE GAP THIS CLOSES (CTO review of PR 176, 18 September 2026) ────────
///
///  20260816-calendar.sql backfills "My calendar" for every user and, until
///  this file, its comment said the API created one for anybody made after
///  that. Nothing did. The gap was invisible because every file in
///  local/postgres/init/ re-runs on every deploy, so the backfill caught up
///  each time — production read 0 users without one. A person created
///  between two deploys had none until the next.
///
///  The first fix put a guard in the meetings path, where the gap was
///  noticed. The CTO's ruling: fix it where people are CREATED, or the next
///  feature that assumes a calendar exists writes the same guard a third
///  time and the one after that forgets. So this is called from all four
///  places a User row is added — the console's single and bulk paths, signup,
///  and the bootstrap administrator — and the migration stays as a net.
///
///  The name and kind match the migration's backfill exactly, so a re-run
///  finds this calendar and inserts nothing.
/// </summary>
public static class CalendarProvisioning
{
    public const string PrimaryName = "My calendar";

    /// <summary>
    /// The primary calendar for a person who does not have one yet. Pure:
    /// the caller adds it to the context beside the new User, in the same
    /// transaction, exactly as ProductAccess rows are.
    /// </summary>
    public static CalendarCalendar PrimaryFor(Guid tenantId, Guid userId) => new()
    {
        TenantId = tenantId,
        OwnerUserId = userId,
        Name = PrimaryName,
        Kind = "personal",
        IsPrimary = true,
    };

    /// <summary>
    /// The person's primary calendar id, creating one if they have none.
    /// For code that runs long after the person was made and cannot assume
    /// PrimaryFor was called — belt and braces on a path that matters.
    /// </summary>
    public static async Task<Guid> EnsurePrimaryAsync(
        AppDbContext db, Guid tenantId, Guid userId, CancellationToken ct)
    {
        var existing = await db.Calendars
            .Where(c => c.OwnerUserId == userId && c.IsPrimary && c.DeletedAt == null)
            .Select(c => (Guid?)c.Id)
            .FirstOrDefaultAsync(ct);
        if (existing is Guid id) return id;

        var cal = PrimaryFor(tenantId, userId);
        db.Calendars.Add(cal);
        return cal.Id;
    }
}
