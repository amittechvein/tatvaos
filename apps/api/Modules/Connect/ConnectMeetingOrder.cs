namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// The order rows come back in from GET /api/connect/meetings.
///
/// IT LIVES IN ITS OWN FILE SO THAT SOMETHING CAN RUN IT. It was three
/// lines inside ListMeetingsAsync, wrapped in a DbContext, a tenant and an
/// HTTP route, and the only way to find out what it did was to read it —
/// which is how it went four weeks saying one thing in a comment and doing
/// another. tests/connect-order compiles THIS file (linked, not copied) and
/// drives it with ordinary objects, so the rule can be executed in under a
/// second by anybody, on any box, with no database.
///
/// Keep it free of EF, of ASP.NET and of DateTimeOffset.UtcNow: it must
/// compose into an IQueryable that Npgsql can translate AND run on a plain
/// List. Everything it needs is on the row.
/// </summary>
public static class ConnectMeetingOrder
{
    /// <param name="which">The validated range: upcoming, today or past.</param>
    public static IOrderedQueryable<ConnectMeeting> Sort(
        IQueryable<ConnectMeeting> meetings, string which) =>
        which == "past"
            // ScheduledStart before CreatedAt in the Past ordering: a meeting
            // that was never joined has no EndedAt, and sorting it by when it
            // was CREATED puts a meeting booked for next Tuesday and made in
            // January half a year away from the day it was supposed to happen.
            ? meetings.OrderByDescending(m => m.EndedAt ?? m.ScheduledStart ?? m.CreatedAt)
            : meetings.OrderBy(m => m.ScheduledStart ?? m.CreatedAt);
}
