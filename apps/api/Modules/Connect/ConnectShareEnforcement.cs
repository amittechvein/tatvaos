using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Puts the room's publishing grants into line with the meeting's share policy
/// AND share mode. One implementation, called from every place that can change
/// who may share right now:
///
///   • the track_published / track_unpublished webhooks (somebody started or
///     stopped presenting),
///   • PATCH /meetings/{id} when share_policy or share_mode changes,
///   • a role change, which can widen one person's policy.
///
/// Before this existed each of those computed grants from the policy alone.
/// In a 'single' meeting that is wrong the moment anybody is sharing: promoting
/// a co-host, or editing the policy, would quietly hand everyone back the
/// ability to start a second share. A second copy of this logic is how one of
/// those three paths ends up forgetting the mode (house rule 10).
///
/// ── FIRST ONE WINS ───────────────────────────────────────────────────────
///  Two people can press Share within the same second, before any grant has
///  been narrowed. When a publish event arrives and somebody ELSE is already
///  sharing, the newcomer's screen is stopped — the person already presenting
///  keeps the room. Narrowing everyone else's grant then makes LiveKit refuse
///  the next attempt outright, so the race only ever needs settling once.
///
/// ── BEST EFFORT, AND IT SAYS SO ──────────────────────────────────────────
///  The meeting row is the truth; the grants are its enforcement. If LiveKit
///  does not answer, this logs a warning naming the meeting and leaves the
///  grants as they were — it does not throw, because every caller has already
///  saved the row and a thrown exception would turn a saved setting into an
///  error page.
/// </summary>
public static class ConnectShareEnforcement
{
    public static async Task ApplyAsync(
        AppDbContext db, LiveKitRoomClient rooms, ConnectMeeting meeting,
        string? justPublishedBy, ILogger log, CancellationToken ct)
    {
        var present = await rooms.TryListParticipantsAsync(meeting.Id, ct);
        if (present is null)
        {
            log.LogWarning(
                "Share enforcement, meeting {MeetingId}: LiveKit did not answer the participant list. "
                + "Grants were NOT updated — in a single-sharer meeting a second share is possible until the next event.",
                meeting.Id);
            return;
        }
        if (present.Count == 0) return;

        var sharing = present
            .Where(p => p.Identity is { Length: > 0 } && p.Tracks?.Any(IsLiveScreenShare) == true)
            .Select(p => p.Identity!)
            .ToList();

        var single = meeting.ShareMode == ConnectShare.ModeSingle;

        if (single && justPublishedBy is not null
            && sharing.Contains(justPublishedBy)
            && ConnectShare.NewcomerMustStop(justPublishedBy, sharing))
        {
            await rooms.MuteAsync(meeting.Id, justPublishedBy, "screen", ct);
            sharing.Remove(justPublishedBy);
            // No names: identities are personal data and this is a log file.
            log.LogInformation(
                "Share enforcement, meeting {MeetingId}: single-sharer mode stopped a second screen share.",
                meeting.Id);
        }

        var current = single ? sharing.FirstOrDefault() : null;

        // Roles from OUR rows, never from what LiveKit believes. Grouped rather
        // than ToDictionary'd: a duplicated identity row should cost one grant
        // being computed from the first role, not an exception that stops every
        // grant in the room from being written.
        var roleOf = (await db.ConnectParticipants.AsNoTracking()
                .Where(p => p.MeetingId == meeting.Id)
                .Select(p => new { p.Identity, p.Role })
                .ToListAsync(ct))
            .GroupBy(r => r.Identity)
            .ToDictionary(g => g.Key, g => g.First().Role);

        foreach (var person in present)
        {
            if (person.Identity is not { Length: > 0 } who) continue;
            var role = roleOf.GetValueOrDefault(ConnectCodes.PersonOf(who));
            var sources = single
                ? ConnectShare.SourcesInSingleMode(meeting.SharePolicy, role,
                    isTheSharer: who == current, someoneIsSharing: current is not null)
                : ConnectShare.SourcesFor(meeting.SharePolicy, role);
            await rooms.SetPublishSourcesAsync(meeting.Id, who, sources, ct);
        }
    }

    // Muted counts as not sharing: a share the host has muted, or one this
    // class has just stopped, must not keep the room closed to everyone else.
    private static bool IsLiveScreenShare(LkTrack t) =>
        string.Equals(t.Source, "SCREEN_SHARE", StringComparison.OrdinalIgnoreCase) && !t.Muted;
}
