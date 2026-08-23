namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// One line of speech, as a participant's own browser heard it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY CAPTIONS AND NOT TRANSCRIPTION
///
///  Measured on a real 31-minute meeting, 22 August 2026: paid transcription
///  ₹16.6, the model that actually writes the minutes ₹0.40. Turning speech
///  into text was 97% of the bill — and the browser will do that part for
///  free, live, while the meeting is happening.
///
///  ─────────────────────────────────────────────────────────────────────────
///  WHAT A CAPTION TRANSCRIPT IS NOT
///
///  It is STRUCTURALLY PARTIAL, in a way a recording is not, and everything
///  that reads it has to say so:
///
///    · Chrome only. A participant on Firefox contributes nothing, and their
///      half of the conversation simply is not in the record.
///    · Each browser hears only ITS OWN microphone, so somebody who leaves
///      early takes their share of the transcript with them.
///    · Chrome's recognition SENDS THE AUDIO TO GOOGLE. This does not remove a
///      third party from the meeting; it changes which one, from a provider
///      under contract to one that is not. A hospital asking where its meeting
///      goes is owed that answer plainly.
///
///  The compensation is real: because each browser reports its own speech, we
///  learn WHO SAID WHAT — which paid transcription of a mixed room recording
///  does not give us at all. Attribution is most of what turns a wall of text
///  into minutes.
///
///  Mapped explicitly with ToTable(name, "connect") in AppDbContext, never by
///  default — the same rule as every other entity here.
/// </summary>
public sealed class ConnectCaptionLine
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }

    /// <summary>
    /// WHO SAID IT, resolved on the server from the caller's token — never
    /// taken from the request body.
    ///
    /// A caption endpoint that accepted a display name would let anybody in
    /// the meeting put words in anybody else's mouth, in a document that is
    /// later emailed to a board as the minutes of the meeting. Nullable only
    /// because removing a participant row must not delete the meeting's record
    /// of what was said.
    /// </summary>
    public Guid? ParticipantId { get; set; }

    public string Text { get; set; } = "";

    /// <summary>
    /// When the client observed it — CLIENT TIME, and that is stated rather
    /// than hidden. It exists to order lines from several browsers into one
    /// conversation, which it does well enough through a few seconds of clock
    /// skew. It is not evidence of when anything happened and nothing should
    /// treat it as such; created_at is the server's own record.
    /// </summary>
    public DateTimeOffset SpokenAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
