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
/// ── THE OFFICIAL BADGE, WITH THE TEXT AS ITS FALLBACK ───────────────────
///
///  It shipped first as a bordered text button, because every mail client
///  blocks remote images by default and a badge that does not load leaves an
///  empty box where the only thing to click used to be. Amit asked for the
///  real badge (23 Sept), and Google's brand guidelines want their artwork
///  rather than a lookalike.
///
///  Both, then: the badge is an `img` whose ALT TEXT is "Get it on Google
///  Play". With images on, it is the official badge. With images blocked —
///  the common case — the client renders the alt text inside the same link,
///  so the row still says what it is and still goes where it goes. The link
///  wraps the image, so the clickable target is identical either way.
///
///  The `img` carries TEXT styling (colour, weight, underline) that it can
///  never show itself. That is deliberate: most clients render alt text with
///  the image's own style, and without it the fallback drew as flat black
///  body text with nothing to say it was clickable — seen in the pane on
///  23 Sept by pointing the src at a missing file.
///
///  The PNG is SERVED BY US (apps/web/public/brand), not hotlinked from
///  Google: an email that reaches into a third party's CDN tells that third
///  party when the message was opened and from where.
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
    /// <param name="baseUrl">The web origin, for the badge's absolute src.</param>
    public static string Html(string baseUrl, string line) => $@"
          <tr>
            <td style=""padding:8px 32px 20px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
                <tr>
                  <td style=""padding:16px 18px;"">
                    <div style=""font-size:14px;font-weight:700;color:{Ink};"">TatvaOS on your phone</div>
                    <div style=""font-size:13px;line-height:1.5;color:{Muted};margin-top:2px;"">{line}</div>
                    <table role=""presentation"" cellpadding=""0"" cellspacing=""0"" style=""margin-top:12px;""><tr>
                      <td>
                        <a href=""{PlayStoreUrl}"" style=""display:inline-block;text-decoration:none;font-size:13px;font-weight:700;color:{Ink};"">
                          <img src=""{baseUrl.TrimEnd('/')}/brand/google-play-badge.png""
                               alt=""Get it on Google Play"" width=""162"" height=""63""
                               style=""display:block;border:0;color:{Ink};font-size:13px;font-weight:700;text-decoration:underline;"">
                        </a>
                      </td>
                    </tr></table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>";
}
