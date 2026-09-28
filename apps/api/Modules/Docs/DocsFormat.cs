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

    public const string DefaultTitle = "Untitled document";

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
