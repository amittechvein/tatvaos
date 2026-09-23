namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "Get the app" — the Google Play row that several branded emails carry.
///
/// Amit, 23 September 2026: add the Play Store link to the welcome mail and
/// the password email. ONE definition rather than a copy in each file: the
/// store URL contains the package id, and a second copy is a second thing to
/// forget when an app is renamed or an App Store link is added beside it.
/// WelcomeEmail and ResetEmail both call this.
///
/// Same construction rules as the emails that use it — a nested table with
/// inline styles, no background image, and readable with remote images
/// blocked, which is the default in every client. That is why this is a
/// bordered text button rather than the official Play badge PNG: a badge is
/// an image, and an image that does not load leaves an empty box where the
/// only call to action was. The text says where it goes.
///
/// The package id is the one in apps/mobile/app.json (com.techvein.tatvaos),
/// which is what Google Play serves — the listing went live on 22 September
/// 2026.
/// </summary>
public static class GetTheAppRow
{
    public const string PlayStoreUrl =
        "https://play.google.com/store/apps/details?id=com.techvein.tatvaos";

    private const string Ink = "#0a0a0a";
    private const string Muted = "#8d9eb5";
    private const string Border = "#e6e9ee";
    private const string Canvas = "#f2f4f9";

    /// <summary>
    /// A full &lt;tr&gt;, so a caller drops it between its own rows.
    /// </summary>
    /// <param name="line">
    /// The sentence above the button. It differs by email — a new person is
    /// being invited in, somebody resetting a password already has the app.
    /// </param>
    public static string Html(string line) => $@"
          <tr>
            <td style=""padding:8px 32px 20px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
                <tr>
                  <td style=""padding:16px 18px;"">
                    <div style=""font-size:14px;font-weight:700;color:{Ink};"">TatvaOS on your phone</div>
                    <div style=""font-size:13px;line-height:1.5;color:{Muted};margin-top:2px;"">{line}</div>
                    <table role=""presentation"" cellpadding=""0"" cellspacing=""0"" style=""margin-top:12px;""><tr>
                      <td style=""border:1px solid {Border};border-radius:8px;background:#ffffff;"">
                        <a href=""{PlayStoreUrl}""
                           style=""display:inline-block;padding:10px 18px;font-size:13px;font-weight:700;color:{Ink};text-decoration:none;"">
                          Get it on Google Play
                        </a>
                      </td>
                    </tr></table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>";
}
