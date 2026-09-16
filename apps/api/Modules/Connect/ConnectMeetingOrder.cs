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
            //
            // No status term here on purpose. Nothing 'active' reaches the
            // past filter, and adding a term for a row that cannot arrive
            // would be a rule with no failure mode — it would only ever fire
            // if something else were already broken, and then it would hide it.
            ? meetings.OrderByDescending(m => m.EndedAt ?? m.ScheduledStart ?? m.CreatedAt)

            // ── LIVE MEETINGS FIRST. THIS LINE IS THE WHOLE POINT. ─────────
            //
            // A meeting that is happening right now is the thing the person
            // asking is most likely to want, and until 16 September 2026 it
            // was not what they got. The order was the ThenBy below and
            // nothing else, so a scheduled meeting nobody ever opened — due
            // an hour ago, still inside ListMeetingsAsync's two-hour grace
            // window, still 'scheduled' because status only moves when
            // LiveKit reports a join — sorted ABOVE a meeting that was live.
            // The phone's Meetings screen showed the dead one at the top.
            //
            // docs/CONNECT_API.md had promised active-first since the
            // endpoint shipped, and the comment above the upcoming filter in
            // ConnectEndpoints.cs said "Live meetings first". Both described
            // this line before it existed. It went four weeks unnoticed
            // because reading the rule is what everybody did and reading is
            // what missed it — so it is now in a file tests/connect-order can
            // execute, and that check fails if this term is removed.
            //
            // 'today' gets the same term rather than only 'upcoming'. The
            // inversion is milder there (the filter admits nothing without a
            // ScheduledStart, so no instant meeting), but a 09:00 nobody
            // joined still outranks the 11:00 that is running, and two arms
            // with two rules is how one of them drifts.
            : meetings.OrderBy(m => m.Status == "active" ? 0 : 1)
                      .ThenBy(m => m.ScheduledStart ?? m.CreatedAt);
}
