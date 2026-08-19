namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// What a set of meeting notes IS, with nothing attached to it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THESE THREE RECORDS USED TO BE NESTED INSIDE ConnectNotesComposer, AND
///  MOVING THEM OUT IS THE WHOLE REASON THIS FILE EXISTS.
///
///  ConnectNotesComposer takes an HttpClient, options and a logger, because it
///  may call a model over the network. ConnectMinutes takes nothing, because
///  it turns notes into a document. The DATA between them needs neither. While
///  it lived inside the composer, anything that wanted to test the renderer had
///  to either drag ASP.NET in or hand-copy the record shapes — and a hand-copy
///  is a second definition that compiles happily while it drifts, which is
///  precisely the failure this module has already paid for once.
///
///  So the shape lives here, alone, with no dependencies. A test links this
///  file and the renderer and gets the REAL types; the day a field is added,
///  the test stops compiling instead of quietly testing last month's shape.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectNotesModel
{
    /// <summary>How long one person talked, from the transcript. Zero for
    /// everybody when there is no transcript — which is why the document only
    /// shows this section if somebody actually spoke.</summary>
    public sealed record SpeakerTime(string Name, long Seconds, int Turns);

    /// <summary>
    /// One person's attendance, as connect.attendance() returns it.
    ///
    /// Seconds is TIME IN THE ROOM, paired join-to-leave — not last_seen minus
    /// first_joined. Somebody who joins, leaves for twenty minutes and comes
    /// back was not there for those twenty minutes, and a school checking
    /// attendance is asking exactly that question.
    ///
    /// Zero seconds is a real answer, not a missing one: it means they were
    /// there and no leave event ever arrived, or they were there for under a
    /// second. Both are "present".
    /// </summary>
    public sealed record Attendee(string Name, bool Guest, long Seconds, int Joins);

    /// <summary>
    /// The notes themselves.
    ///
    /// Kind is 'digest' or 'model' and it is load-bearing, not decoration:
    /// every surface that shows these notes has to say which one it is
    /// looking at. A mechanical digest presented as a summary somebody wrote
    /// is the one way this feature can actively mislead a person.
    /// </summary>
    public sealed record Notes(
        string Kind,                 // digest | model
        string? Provider,
        string? Model,
        string Summary,
        IReadOnlyList<string> KeyPoints,
        IReadOnlyList<string> Decisions,
        IReadOnlyList<string> ActionItems,
        IReadOnlyList<SpeakerTime> Speakers,
        IReadOnlyList<Attendee> Attendance);
}
