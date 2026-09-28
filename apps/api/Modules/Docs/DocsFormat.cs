using System.Net;
using System.Text;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// What makes a Space file a TatvaOS document, and what its blob looks like.
///
/// The mime type is the ONE marker. Space's overwrite handler refuses files
/// carrying it, and the Space web client opens them in Docs instead of
/// downloading them; both compare against this constant (and the web's copy
/// in apps/web/lib/docs.ts, which is marked as a copy of this one).
/// </summary>
public static class DocsFormat
{
    public const string MimeType = "application/vnd.tatvaos.document";

    /// <summary>
    /// A TatvaOS spreadsheet (Sheets). Same storage, same live channel, same
    /// versions and comments as a document — docs.* holds its Yjs state
    /// exactly as it holds a document's; only the browser editor differs.
    /// Its blob is an .xlsx the editor writes at each checkpoint, so a
    /// download from Space opens in Excel.
    /// </summary>
    public const string SpreadsheetMimeType = "application/vnd.tatvaos.spreadsheet";

    public const string XlsxMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    public const string DefaultTitle = "Untitled document";
    public const string DefaultSpreadsheetTitle = "Untitled spreadsheet";

    /// <summary>
    /// The type to STORE for a type a client (or an email's sender) claims.
    /// The two live types are the server's alone: only DocsEndpoints.CreateAsync
    /// sets them, and Space refuses to overwrite a file carrying one. Every
    /// other way a type enters Space — upload, overwrite, a mail attachment
    /// saved to Space — goes through here, so no client can make a file
    /// claim to be a document or a spreadsheet. That matters because each
    /// kind answers to its own product switch (LiveSwitch): a type a client
    /// could set would let it choose which switch is consulted (Mr. Singh,
    /// 24 Sept 2026). Measured before this existed: an upload claiming the
    /// spreadsheet type was stored as one and listed in Sheets.
    /// </summary>
    public static string ClientType(string? claimed)
    {
        if (string.IsNullOrWhiteSpace(claimed)) return "application/octet-stream";
        // Compare on the bare media type: "…spreadsheet; charset=x" and odd
        // casing must not slip past.
        var bare = claimed.Split(';')[0].Trim();
        return IsLive(bare.ToLowerInvariant()) ? "application/octet-stream" : claimed;
    }

    /// <summary>Is this a file the live editors own (a document or a spreadsheet)?</summary>
    public static bool IsLive(string? mimeType) =>
        mimeType is MimeType or SpreadsheetMimeType;

    /// <summary>
    /// How a Space file is named and typed when it is DOWNLOADED from Space. A
    /// document's blob is its HTML rendering, so it downloads as "Title.html",
    /// text/html; a spreadsheet's is an .xlsx; every other file is untouched.
    ///
    /// NOT for a document going by mail. Mr. Singh, 24 Sept, on PR 274: HTML
    /// attachments are a phishing carrier that corporate gateways quarantine
    /// and Gmail distrusts, and this domain is still earning its reputation.
    /// A document leaving by mail must be a PDF; until the server can make
    /// one, documents are not attachable at all (SpaceContentGateway,
    /// NotAttachable below).
    /// </summary>
    public static (string Name, string MimeType) AsDownload(string name, string mimeType) => mimeType switch
    {
        MimeType => (name + ".html", "text/html; charset=utf-8"),
        SpreadsheetMimeType => (name + ".xlsx", XlsxMimeType),
        _ => (name, mimeType),
    };

    /// <summary>What a person is told when they try to attach a document to mail.</summary>
    public const string NotAttachable =
        "A TatvaOS document can't be attached yet. Open it in Docs, download it as a PDF (File > Download as PDF), and attach that.";

    /// <summary>What a person is told when they try to attach a spreadsheet to mail.</summary>
    public const string SpreadsheetNotAttachable =
        "A TatvaOS spreadsheet can't be attached yet. Open it in Sheets, download it as Excel (File > Download as Excel), and attach that.";

    /// <summary>
    /// Wrap the editor's HTML into a standalone page — the file's blob. It is
    /// what Space downloads, what a public link serves, and what Mail attaches
    /// from Space, so it must read correctly with nothing else around it.
    ///
    /// THE BODY IS UNTRUSTED. An honest editor can only emit the nodes and
    /// marks its schema knows, but the checkpoint endpoint accepts whatever
    /// an editor-level caller POSTs. So nothing here renders it inline on our
    /// origin: Space serves the blob as an attachment, the editor never
    /// renders stored HTML (a version is previewed by rebuilding it from its
    /// Yjs state through the editor's schema), and this page carries a CSP
    /// forbidding every script for the one case left — somebody opening the
    /// downloaded file.
    /// </summary>
    public static byte[] RenderHtml(string title, string bodyHtml)
    {
        var sb = new StringBuilder();
        sb.Append("<!doctype html>\n<html><head><meta charset=\"utf-8\">");
        sb.Append("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: https: 'self'; style-src 'unsafe-inline'\">");
        sb.Append("<title>").Append(WebUtility.HtmlEncode(title)).Append("</title>");
        sb.Append("<style>body{font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;line-height:1.5;color:#1f1f1f}")
          .Append("table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}img{max-width:100%}</style>");
        sb.Append("</head><body>\n");
        sb.Append(bodyHtml);
        sb.Append("\n</body></html>\n");
        return Encoding.UTF8.GetBytes(sb.ToString());
    }
}
