// Pictures in outgoing mail (OutgoingInlineImages).
// Run: dotnet run --project tests/mail-inline-images
//
// Why each check exists is in the source file; the short version: a picture
// sent as a data: URI is a gap in Gmail.
//
// NOT TESTED HERE, ON PURPOSE: a form-value size limit. The first version of
// this change assumed ASP.NET refuses any multipart form value over 4 MB
// (FormOptions.ValueLengthLimit) and "fixed" it. Its calibration check --
// default options must refuse a 5 MB bodyHtml -- FAILED: the defaults read it.
// That limit applies to url-encoded forms; the composer sends multipart. The
// fix was removed rather than shipped for a bug that does not exist. The real
// ceilings are the 25 MB gate in SendAsync and Kestrel's 30 MB request limit.

using System.Diagnostics;
using TatvaOS.Api.Modules.Mail;

var pass = 0; var fail = 0;
void Check(string what, bool ok, string detail = "")
{
    if (ok) { pass++; Console.WriteLine($"    ok  {what}"); }
    else { fail++; Console.WriteLine($"  FAIL  {what}{(detail.Length > 0 ? $"\n          {detail}" : "")}"); }
}

// A real 1x1 PNG, and a different one (red instead of transparent).
const string Png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const string Png2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const string Domain = "tatvaos.com";
string Img(string b64, string type = "png", char q = '"') => $"<img alt=\"x\" src={q}data:image/{type};base64,{b64}{q}>";

Console.WriteLine("\n  outgoing inline images\n  ======================\n");

// 1. Nothing to do.
{
    var html = "<p>hello</p><img src=\"https://example.com/a.png\">";
    var (h, imgs) = OutgoingInlineImages.Extract(html, Domain);
    Check("no data: image -> HTML untouched, nothing attached", h == html && imgs.Count == 0);
}

// 2. One picture becomes cid:, and the attached bytes ARE the picture.
{
    var (h, imgs) = OutgoingInlineImages.Extract($"<p>see</p>{Img(Png1)}", Domain);
    var cid = imgs.Count == 1 ? imgs[0].ContentId : "";
    Check("one data: image -> one attachment", imgs.Count == 1);
    Check("...its src is now cid:<that Content-ID>", h.Contains($"src=\"cid:{cid}\"") && !h.Contains("data:image"), h);
    Check("...the attached bytes are the decoded picture", imgs.Count == 1 && imgs[0].Bytes.SequenceEqual(Convert.FromBase64String(Png1)));
    Check("...Content-ID is on the sender's domain", cid.EndsWith("@" + Domain));
    Check("...png subtype and a .png file name", imgs.Count == 1 && imgs[0].Subtype == "png" && imgs[0].FileName(1) == "image1.png");
}

// 3. The same picture twice is attached once.
{
    var (h, imgs) = OutgoingInlineImages.Extract(Img(Png1) + "<br>" + Img(Png1), Domain);
    var cid = imgs.Count == 1 ? imgs[0].ContentId : "?";
    Check("the same picture twice -> attached ONCE, both point at it",
          imgs.Count == 1 && h.Split($"cid:{cid}").Length == 3, $"attached {imgs.Count}");
}

// 4. Two different pictures -> two parts, two ids.
{
    var (_, imgs) = OutgoingInlineImages.Extract(Img(Png1) + Img(Png2), Domain);
    Check("two different pictures -> two attachments, two Content-IDs",
          imgs.Count == 2 && imgs[0].ContentId != imgs[1].ContentId);
}

// 5. The shapes real editors produce.
{
    var single = OutgoingInlineImages.Extract(Img(Png1, q: '\''), Domain);
    Check("single-quoted src", single.Images.Count == 1 && single.Html.Contains("src='cid:"));
    var upper = OutgoingInlineImages.Extract($"<IMG WIDTH=10 SRC=\"DATA:IMAGE/PNG;BASE64,{Png1}\">", Domain);
    Check("upper-case tag, attribute and scheme; src not first", upper.Images.Count == 1, upper.Html);
    var wrapped = OutgoingInlineImages.Extract(Img(Png1[..20] + "\r\n  " + Png1[20..]), Domain);
    Check("base64 wrapped across lines still decodes", wrapped.Images.Count == 1 && wrapped.Images[0].Bytes.SequenceEqual(Convert.FromBase64String(Png1)));
    var jpg = OutgoingInlineImages.Extract(Img(Png1, "jpg"), Domain);
    Check("image/jpg is sent as image/jpeg, file named .jpg", jpg.Images.Count == 1 && jpg.Images[0].Subtype == "jpeg" && jpg.Images[0].FileName(1) == "image1.jpg");
}

// 6. What must NOT be touched.
{
    var bad = Img("!!!not-base64!!!");
    var r = OutgoingInlineImages.Extract(bad, Domain);
    Check("undecodable base64 -> left exactly as it was, nothing attached", r.Html == bad && r.Images.Count == 0);

    // SVG can carry script. It is never turned into an attachment a client
    // might render; the composer's sanitiser does not produce it either.
    var svg = "<img src=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\">";
    var s = OutgoingInlineImages.Extract(svg, Domain);
    Check("data:image/svg+xml is NOT attached", s.Html == svg && s.Images.Count == 0);

    var link = $"<a href=\"data:image/png;base64,{Png1}\">x</a>";
    var l = OutgoingInlineImages.Extract(link, Domain);
    Check("a data: image in a LINK, not an <img>, is left alone", l.Html == link && l.Images.Count == 0);
}

// 7. Size: a picture of a realistic size is linear, not catastrophic.
{
    var big = Convert.ToBase64String(new byte[5 * 1024 * 1024]);   // 5 MB of picture
    var sw = Stopwatch.StartNew();
    var r = OutgoingInlineImages.Extract($"<p>x</p>{Img(big)}", Domain);
    sw.Stop();
    Check($"a 5 MB picture converts in {sw.ElapsedMilliseconds} ms (< 2000)", r.Images.Count == 1 && sw.ElapsedMilliseconds < 2000);
}

Console.WriteLine($"\n  ======================\n  {(fail == 0 ? "PASS" : "FAIL")}  {pass} passed, {fail} failed\n");
return fail == 0 ? 0 : 1;
