// ============================================================================
//  Minutes of Meeting — the document, tested.
//
//  Run it:   bash infra/scripts/connect-minutes-test.sh
//        or  dotnet run --project tests/connect-minutes
//
//  Exit 0 = every assertion held. DUMP=1 also writes the rendered document to
//  a temp folder so you can open it and look at it, which catches everything
//  an assertion did not think to.
// ============================================================================
using TatvaOS.Api.Modules.Connect;
using System.Globalization;

int pass = 0, fail = 0;
void Ok(string what, bool cond)
{
    if (cond) { pass++; Console.WriteLine($"    ok  {what}"); }
    else { fail++; Console.WriteLine($"  FAIL  {what}"); }
}

var start = DateTimeOffset.Parse("2026-08-18T10:00:00Z", CultureInfo.InvariantCulture);
var end = start.AddMinutes(62);

ConnectMinutes.Input Make(
    ConnectNotesModel.Notes notes,
    IReadOnlyList<ConnectMinutes.ChatLine>? chat = null,
    bool hadTranscript = true,
    int unreachable = 0,
    string title = "Fee structure for 2026-27",
    string tz = "Asia/Kolkata",
    bool hadRecording = false)
    => new(title, start, end, "Asha Nair", tz, notes,
           chat ?? [], hadTranscript, unreachable,
           "https://connect.tatvaos.com", Guid.Parse("3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915"),
           hadRecording);

var full = new ConnectNotesModel.Notes(
    "model", "openai", "gpt-4o-mini",
    "The committee agreed the revised fee structure and set a communication date.",
    ["Transport fees rise 4%", "Scholarship pool unchanged"],
    ["Adopt the revised structure from 1 April"],
    ["Ravi to circulate the letter by Friday", "Asha to brief the front office"],
    [new("Asha Nair", 1450, 22), new("Ravi Kumar", 980, 15), new("Meera", 0, 0)],
    [new("Asha Nair", false, 3720, 1), new("Ravi Kumar", false, 1800, 2),
     new("Meera", true, 600, 1), new("Silent Sam", false, 0, 1)]);

var bare = new ConnectNotesModel.Notes(
    "digest", null, null, "", [], [], [], [],
    [new("Asha Nair", false, 3720, 1), new("A Parent", true, 300, 1)]);

var chat = new List<ConnectMinutes.ChatLine>
{
    new("Ravi Kumar", false, "Here is the draft: https://example.test/fees.pdf",
        start.AddMinutes(12)),
    new("Meera", true, "Can you repeat the transport figure?", start.AddMinutes(18)),
};

Console.WriteLine("\n  Minutes of Meeting\n  ═══════════════════════════════════════════════════");

Console.WriteLine("\n  the document says what it has");
var html = ConnectMinutes.Html(Make(full, chat, unreachable: 2));
Ok("the title is in it", html.Contains("Fee structure for 2026-27"));
Ok("the summary is in it", html.Contains("revised fee structure"));
Ok("decisions are in it", html.Contains("Adopt the revised structure"));
Ok("action items are in it", html.Contains("circulate the letter by Friday"));
Ok("attendance is in it", html.Contains("Silent Sam"));
Ok("chat is in it", html.Contains("Can you repeat the transport figure"));
Ok("and it links back to the meeting",
   html.Contains("/connect/meetings/3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915"));

Console.WriteLine("\n  it does not oversell itself");
Ok("a model summary names the model", html.Contains("gpt-4o-mini"));
Ok("and warns it can be wrong", html.Contains("can be wrong"));
var digest = ConnectMinutes.Html(Make(bare, hadTranscript: false));
Ok("a digest says nothing here was written by a person",
   digest.Contains("Nothing here was written by a person"));
Ok("and says plainly the meeting was not recorded",
   digest.Contains("this meeting was not recorded"));
// The third sentence, learned on the module's first proven run: a Ready
// recording with transcription off used to render "this meeting was not
// recorded" — a false statement sitting beside the recordings list.
var recordedNoTranscript = ConnectMinutes.Html(
    Make(bare, hadTranscript: false, hadRecording: true));
Ok("recorded-but-untranscribed says the meeting WAS recorded",
   recordedNoTranscript.Contains("the meeting was recorded, but no transcript"));
Ok("and does NOT claim it was not recorded",
   !recordedNoTranscript.Contains("this meeting was not recorded"));
// Asserted WITHOUT the apostrophe: the renderer HTML-encodes everything,
// so "meeting's" arrives as "meeting&#39;s" and a raw-apostrophe substring
// can never match. (Found the honest way — this assertion failed.)
Ok("a transcript still wins over both",
   ConnectMinutes.Html(Make(bare, hadTranscript: true, hadRecording: true))
       .Contains("recording and transcript"));
Ok("an empty summary produces no Summary block at all, not an empty one",
   !digest.Contains(">Summary<"));
Ok("empty lists produce no headings",
   !digest.Contains(">Decisions<") && !digest.Contains(">Action items<"));

Console.WriteLine("\n  people who could not be told");
Ok("the count of unreachable guests is stated",
   html.Contains("2 people attended as a guest"));
Ok("one reads as singular",
   ConnectMinutes.Html(Make(full, unreachable: 1)).Contains("1 person attended as a guest"));
Ok("and nobody unreachable means no footnote",
   !ConnectMinutes.Html(Make(full)).Contains("attended as a guest and"));

Console.WriteLine("\n  durations a person can read");
Ok("an hour and two minutes", html.Contains("1h 02m"));
Ok("thirty minutes", html.Contains("30m"));
Ok("somebody who never spoke is 'joined', not '0s' and not blank",
   html.Contains("joined"));
Ok("a rejoin is noted", html.Contains("2 joins"));

Console.WriteLine("\n  the clock is the organisation's");
// InvariantCulture renders tt as "PM", not "pm". Worth pinning: the format
// is invariant on purpose, and a change to CurrentCulture here would move
// every timestamp in the document without any other test noticing.
Ok("10:00 UTC shows as 3:30 PM in Asia/Kolkata", html.Contains("3:30 PM"));
Ok("chat timestamps convert too — 10:12 UTC is 15:42", html.Contains("15:42"));
Ok("an unknown zone falls back to UTC rather than throwing",
   ConnectMinutes.Html(Make(full, tz: "Mars/Olympus")).Contains("10:00 AM"));

Console.WriteLine("\n  everything is encoded");
var nasty = new ConnectNotesModel.Notes(
    "digest", null, null, "<script>alert(1)</script>",
    ["<img src=x onerror=alert(1)>"], ["A & B <both>"], ["\"quoted\" & 'single'"],
    [], [new("<b>Bold</b> Person", false, 60, 1)]);
var nastyChat = new List<ConnectMinutes.ChatLine>
{
    new("</td></tr><script>x</script>", false, "<a href=\"javascript:alert(1)\">click</a>", start),
};
var escaped = ConnectMinutes.Html(Make(nasty, nastyChat, title: "<script>steal()</script>"));
Ok("no raw <script> survives anywhere in the document",
   !escaped.Contains("<script>"));
// NOT "the string onerror= is absent" — it is present, as TEXT, and that is
// correct: encoding is not deletion. What must not survive is the TAG it was
// an attribute of. Asserting the string would have to be relaxed the first
// time somebody legitimately discussed an onerror handler in a meeting.
// The document has ONE <img> of its own — the brand logo — so the assertion
// has to name the injected one. A blanket "no <img> anywhere" passed nothing
// and failed on our own header, which is the sort of test that gets deleted.
Ok("the tag an onerror attribute lived on does not survive",
   !escaped.Contains("<img src=x"));
Ok("though the text of it is still readable in the minutes",
   escaped.Contains("onerror=alert(1)&gt;"));
Ok("a javascript: href does not survive as markup",
   !escaped.Contains("<a href=\"javascript:"));
Ok("a chat name cannot break out of the table",
   !escaped.Contains("</td></tr><script"));
Ok("ampersands are encoded, so '&' is not the start of an entity",
   escaped.Contains("A &amp; B"));
Ok("but the text is still THERE — encoding is not deletion",
   escaped.Contains("&lt;script&gt;alert(1)&lt;/script&gt;"));

Console.WriteLine("\n  newlines survive as line breaks");
var multi = new ConnectNotesModel.Notes(
    "digest", null, null, "Line one\nLine two", [], [], ["Do A\nthen B"], [], []);
var br = ConnectMinutes.Html(Make(multi));
Ok("a two-line summary does not run together", br.Contains("Line one<br>Line two"));
Ok("a two-line action item does not either", br.Contains("Do A<br>then B"));

Console.WriteLine("\n  email-safe construction");
Ok("no <style> block — Gmail strips them", !html.Contains("<style"));
Ok("no flexbox or grid — Outlook renders through Word",
   !html.Contains("display:flex") && !html.Contains("display:grid"));
Ok("layout is tables", html.Contains("role=\"presentation\""));
Ok("it is a complete document, so it also opens as a file",
   html.StartsWith("<!DOCTYPE html>") && html.TrimEnd().EndsWith("</html>"));

Console.WriteLine("\n  the plain-text version carries the same facts");
var text = ConnectMinutes.Text(Make(full, chat, unreachable: 2));
Ok("summary", text.Contains("revised fee structure"));
Ok("decisions", text.Contains("Adopt the revised structure"));
Ok("actions", text.Contains("circulate the letter"));
Ok("attendance with durations", text.Contains("Asha Nair — 1h 02m"));
Ok("a guest is marked", text.Contains("Meera (guest)"));
Ok("chat with timestamps", text.Contains("Ravi Kumar: Here is the draft"));
Ok("and no HTML leaks into it", !text.Contains("<td") && !text.Contains("&amp;"));

Console.WriteLine("\n  subject and filename");
var m = Make(full);
Ok("the subject leads with the word people search for",
   ConnectMinutes.Subject(m).StartsWith("Minutes: "));
Ok("and carries the date", ConnectMinutes.Subject(m).Contains("18 Aug 2026"));
var name = ConnectMinutes.FileName(m);
Ok("the filename is sortable by date", name.Contains("2026-08-18"));
Ok("and has no characters a filesystem will refuse",
   !ConnectMinutes.FileName(Make(full, title: "Q3/Q4: review \"final\"?"))
       .Any(c => c is '/' or '\\' or ':' or '?' or '"' or '<' or '>' or '|' or '*'));
Ok("a title of nothing but punctuation still produces a name",
   ConnectMinutes.FileName(Make(full, title: "???")).Contains("Meeting"));

Console.WriteLine($"\n  ═══════════════════════════════════════════════════\n  {pass} ok, {fail} failed\n");

// DUMP=1 writes the rendered document out so a person can LOOK at it.
// Assertions catch what you thought to assert; opening the file in a browser
// catches the rest.
if (Environment.GetEnvironmentVariable("DUMP") == "1")
{
    var dir = Path.Combine(Path.GetTempPath(), "connect-minutes");
    Directory.CreateDirectory(dir);
    File.WriteAllText(Path.Combine(dir, "minutes.html"),
                      ConnectMinutes.Html(Make(full, chat, unreachable: 2)));
    File.WriteAllText(Path.Combine(dir, "minutes-hostile.html"), escaped);
    File.WriteAllText(Path.Combine(dir, "minutes.txt"),
                      ConnectMinutes.Text(Make(full, chat, unreachable: 2)));
    Console.WriteLine($"  wrote a rendered sample to {dir}\n");
}

return fail == 0 ? 0 : 1;
