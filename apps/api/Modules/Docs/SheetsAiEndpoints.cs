using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// TatvaOS AI for spreadsheets: POST /api/sheets/{id}/ai.
///
/// ─────────────────────────────────────────────────────────────────────────
///  A spreadsheet is a Docs file with a different editor (DocsFormat
///  .SpreadsheetMimeType), so loading and permission are DocsEndpoints'
///  own LoadAsync — one rule for who may open what, not two.
///
///  The cells come from the BROWSER, which holds the live spreadsheet; the
///  server's copy is only as fresh as the last checkpoint. They are passed
///  to the gateway as its INPUT (data), never folded into the instruction —
///  a cell that says "ignore the above" is somebody's text, not an order.
///  The person's own request ("total fees for class 10") IS an instruction,
///  from the person entitled to give it.
///
///  Nothing here writes to the spreadsheet. A formula comes back as text;
///  the person sees it and chooses to insert it, and the insertion is an
///  ordinary edit over the live channel, which enforces edit access. So
///  every action needs only view access — the same as reading the cells.
///
///  Actions:  formula  the person describes a calculation → one formula
///            explain  a formula → what it does, in plain words
///            analyze  a selection → totals, patterns, observations
///            clean    a selection → problems found (duplicates, blanks,
///                     inconsistent spellings), listed, never fixed silently
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class SheetsAiEndpoints
{
    /// <summary>Cells sent with a request. Past this the browser samples; the server refuses.</summary>
    private const int MaxInputChars = 200_000;

    public sealed record SheetsAiRequest(string? Action, string? Prompt, string? Context, string? Formula, string? Cell);

    public static void MapSheetsAiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/sheets/{id:guid}/ai", AiAsync)
            .RequireAuthorization("User")
            .WithTags("Sheets");
    }

    private static IResult Error(int status, string message) =>
        Results.Json(new { error = message }, statusCode: status);

    private const string Setting =
        "You help people using TatvaOS Sheets, a spreadsheet like Google Sheets, used by schools and" +
        " organisations in India. Amounts are usually rupees; dates are written day/month/year.";

    private static async Task<IResult> AiAsync(
        Guid id, SheetsAiRequest req, AppDbContext db, TenantContext tenant, IAiGateway ai, CancellationToken ct)
    {
        var (err, file, _, _) = await DocsEndpoints.LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;
        if (file.MimeType != DocsFormat.SpreadsheetMimeType) return Error(404, "No such spreadsheet.");

        if (!ai.IsConfigured) return Error(503, "AI is not set up on this TatvaOS installation.");
        if (!await ai.EnabledForTenantAsync(ct))
            return Error(403, "AI is switched off for your organisation. An administrator can turn it on.");

        var context = req.Context ?? "";
        if (context.Length > MaxInputChars)
            return Error(413, "That selection is too large to send to TatvaOS AI. Select fewer rows.");
        var cell = Clean(req.Cell, 20);

        string instruction;
        string input;
        switch (req.Action)
        {
            case "formula":
            {
                var prompt = (req.Prompt ?? "").Trim();
                if (prompt.Length == 0) return Error(400, "Say what you would like the formula to calculate.");
                if (prompt.Length > 2000) prompt = prompt[..2000];
                instruction = Setting +
                    " Write ONE spreadsheet formula that does what the person asks. The input you are given" +
                    " describes the sheet: its name, column headings with their letters, and some sample rows." +
                    $" The formula will go in cell {(cell.Length > 0 ? cell : "the selected cell")}." +
                    " Use only these functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, COUNTIF," +
                    " COUNTIFS, SUMIF, SUMIFS, AVERAGEIF, AVERAGEIFS, MAXIFS, MINIFS, IF, IFS, AND, OR, NOT," +
                    " IFERROR, IFNA, SWITCH, VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, ROUND, ROUNDUP, ROUNDDOWN," +
                    " SUMPRODUCT, TEXT, LEFT, RIGHT, MID, LEN, UPPER, LOWER, PROPER, TRIM, CONCAT, TEXTJOIN," +
                    " TODAY, DATE, DAY, MONTH, YEAR, DATEDIF, NETWORKDAYS, EDATE, EOMONTH, MEDIAN, RANK, LARGE, SMALL." +
                    " Refer to whole columns within the data's rows (for example C2:C500), not whole-sheet columns," +
                    " unless the person asks otherwise. Reply with the formula only, starting with =, on one line," +
                    " with no explanation and no quotation marks or code fences around it." +
                    "\n\nThe person asks: " + prompt;
                input = context;
                break;
            }
            case "explain":
            {
                var formula = (req.Formula ?? "").Trim();
                if (!formula.StartsWith('=')) return Error(400, "Select a cell with a formula to explain it.");
                if (formula.Length > 8000) return Error(400, "That formula is too long to explain.");
                instruction = Setting +
                    " Explain the formula you are given in plain, friendly words a school office clerk would follow:" +
                    " first one sentence on what it calculates, then a short bulleted list ('- ') walking through" +
                    " each part. The input also describes the sheet so you can name the columns it uses." +
                    " Plain text only, no other formatting.";
                input = $"Formula in {cell}: {formula}\n\n{context}";
                break;
            }
            case "analyze":
                if (string.IsNullOrWhiteSpace(context)) return Error(400, "Select some cells to analyse.");
                instruction = Setting +
                    " Analyse the table you are given (tab-separated; the first row is usually headings)." +
                    " Start with the key figures — counts, totals, averages, highest and lowest — then list" +
                    " 3 to 6 observations or trends worth knowing. Use numbers from the data only; never invent" +
                    " any. Write amounts in Indian style (1,25,000). Plain text: '- ' for bullet points, no other" +
                    " formatting.";
                input = context;
                break;
            case "clean":
                if (string.IsNullOrWhiteSpace(context)) return Error(400, "Select some cells to check.");
                instruction = Setting +
                    " Check the table you are given (tab-separated; the first row is usually headings; each row" +
                    " starts with its row number) for data problems: duplicate records, the same name spelt or" +
                    " spaced differently, missing values, impossible or wrongly formatted dates, numbers stored" +
                    " as text, stray spaces. List each problem with the row numbers it affects and what you would" +
                    " change, most important first. Say plainly if you find nothing. Do not rewrite the table." +
                    " Plain text: '- ' for bullet points, no other formatting.";
                input = context;
                break;
            default:
                return Error(400, "action must be formula, explain, analyze or clean.");
        }

        var result = await ai.CompleteAsync(instruction, input, ct);
        if (result.Error is not null) return Error(502, result.Error);
        var text = result.Text.Trim();

        if (req.Action == "formula")
        {
            // Models wrap answers in fences or add a sentence despite being
            // told not to. Take the first line that is a formula; if there is
            // none, say so rather than inserting prose into a cell.
            var line = text.Replace("```", "\n")
                .Split('\n')
                .Select(l => l.Trim().Trim('`').Trim())
                .FirstOrDefault(l => l.StartsWith('='));
            if (line is null) return Error(502, "TatvaOS AI did not come back with a formula. Try describing it differently.");
            text = line.Length > 4000 ? line[..4000] : line;
        }

        return Results.Ok(new { text, truncated = result.Truncated });
    }

    private static string Clean(string? s, int max)
    {
        var t = (s ?? "").Trim();
        t = new string(t.Where(ch => char.IsLetterOrDigit(ch) || ch is '$' or ':' or '!' or ' ' or '\'' or '_').ToArray());
        return t.Length > max ? t[..max] : t;
    }
}
