using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Modules.Connect.Endpoints;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Plans;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// Connect's limits for a meeting whose host is a personal account (build
/// plan §4.5). THE HOST'S PLAN DECIDES (D2): a Free host's meeting holds five
/// people, whoever they are, and a Premium guest in it changes nothing.
///
/// Every rule here answers "no limit" (null) for an organisation's meeting,
/// so organisations are untouched by construction — the question is only
/// asked of EffectiveSettings when the meeting's tenant is the house.
/// </summary>
public static class PersonalMeetingRules
{
    public const string Full = "This meeting is full.";
    public const string RecordingIsPremium = "Recording is part of Premium.";

    /// <summary>The host's plan when the host is a personal account; null otherwise.</summary>
    public static async Task<EffectiveSettings.Answer?> HostPlanAsync(
        AppDbContext db, EffectiveSettings settings, ConnectMeeting meeting, CancellationToken ct)
    {
        if (meeting.CreatedByUserId is not Guid host) return null;
        if (!await PersonalHouse.IsHouseTenantAsync(db, meeting.TenantId, ct)) return null;
        var answer = await settings.ForUserAsync(host, ct);
        return answer is { Personal: true, Enforced: true } ? answer : null;
    }

    /// <summary>Null when recording is allowed (or this is not a personal meeting).</summary>
    public static string? RecordingRefusal(EffectiveSettings.Answer? host) =>
        host is null || host.Has("connect.recording") ? null : RecordingIsPremium;

    /// <summary>
    /// The host's limit if letting one more person in would pass it; null if
    /// there is room, or no limit. The person joining is not counted against
    /// themselves — a phone reconnecting, or someone on a second device, is
    /// the same seat.
    ///
    /// Counted from the room's own events (ConnectEndpoints.ConnectedPeopleAsync,
    /// the same derivation the participants list uses). Those arrive by
    /// webhook a moment after a person connects, so two people pressing Join
    /// in the same second can both get in — one over, briefly. Stated here
    /// rather than discovered: a hard ceiling would need LiveKit's own room
    /// max_participants, set when the room is created.
    /// </summary>
    public static async Task<long?> FullAtAsync(
        AppDbContext db, EffectiveSettings.Answer? host, Guid meetingId, string? joiningPerson, CancellationToken ct)
    {
        if (host?.Limit("connect.max_participants") is not long max) return null;
        var inRoom = await ConnectEndpoints.ConnectedPeopleAsync(db, meetingId, ct);
        if (joiningPerson is not null) inRoom.Remove(joiningPerson);
        return inRoom.Count + 1 > max ? max : null;
    }

    /// <summary>So the host can be told someone was turned away (the lobby poll reads it).</summary>
    public static async Task RecordRefusalAsync(AppDbContext db, ConnectMeeting meeting, long allowed, CancellationToken ct)
    {
        db.ConnectCapacityRefusals.Add(new ConnectCapacityRefusal
        {
            MeetingId = meeting.Id, TenantId = meeting.TenantId, Allowed = (int)allowed,
        });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The words the host sees.</summary>
    public static string HostNotice(long allowed) =>
        $"Someone couldn't join: your plan allows {allowed} {(allowed == 1 ? "person" : "people")}.";
}
