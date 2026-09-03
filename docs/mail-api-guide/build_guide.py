"""TatvaOS Mail API - integration guide (PDF).

Source for apps/web/public/docs/TatvaOS-Mail-API-Integration-Guide.pdf.
Regenerate after any change to the send endpoint:

    pip install reportlab
    python docs/mail-api-guide/build_guide.py

Everything in here was verified against production on 3 September 2026:
the endpoint path, every field, every response body, and the headers Gmail
received. Keep it that way - nothing described that has not been observed.
"""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, Preformatted,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

import os
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "web", "public", "docs", "TatvaOS-Mail-API-Integration-Guide.pdf")

INK = colors.HexColor("#1f2933")
MUTED = colors.HexColor("#6b7280")
ACCENT = colors.HexColor("#0f766e")
LINE = colors.HexColor("#e5e7eb")
CODE_BG = colors.HexColor("#f3f4f6")
OK = colors.HexColor("#047857")
WARN = colors.HexColor("#b45309")
BAD = colors.HexColor("#b91c1c")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=20,
                    leading=24, textColor=INK, spaceBefore=6, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=13.5,
                    leading=17, textColor=ACCENT, spaceBefore=14, spaceAfter=5)
H3 = ParagraphStyle("H3", parent=ss["Heading3"], fontName="Helvetica-Bold", fontSize=10.5,
                    leading=14, textColor=INK, spaceBefore=8, spaceAfter=3)
BODY = ParagraphStyle("Body", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.6,
                      leading=14, textColor=INK, spaceAfter=6, alignment=TA_LEFT)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8.4, leading=11.5, textColor=MUTED)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=8.8, leading=12, spaceAfter=0)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold")
CODE = ParagraphStyle("Code", parent=ss["Code"], fontName="Courier", fontSize=8.2, leading=10.6,
                      textColor=INK, backColor=CODE_BG, borderPadding=(6, 8, 6, 8),
                      leftIndent=0, spaceBefore=4, spaceAfter=8)
TITLE = ParagraphStyle("Title", parent=H1, fontSize=26, leading=30, spaceAfter=4)
SUB = ParagraphStyle("Sub", parent=BODY, fontSize=11.5, leading=15, textColor=MUTED, spaceAfter=18)


def code(text: str):
    return Preformatted(text.strip("\n"), CODE)


def table(rows, widths, header=True):
    data = [[Paragraph(c, CELLB if header and i == 0 else CELL) for c in r] for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), CODE_BG), ("LINEBELOW", (0, 0), (-1, 0), 0.8, MUTED)]
    t.setStyle(TableStyle(style))
    return t


def p(text, style=BODY):
    return Paragraph(text, style)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(20 * mm, 12 * mm, "TatvaOS Mail API — Integration Guide v1.0 — 3 September 2026")
    canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, f"Page {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.line(20 * mm, 16 * mm, A4[0] - 20 * mm, 16 * mm)
    canvas.restoreState()


doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                        topMargin=18 * mm, bottomMargin=22 * mm,
                        title="TatvaOS Mail API — Integration Guide",
                        author="TatvaOS", subject="Sending mail from your own software through TatvaOS")
W = A4[0] - 40 * mm
s = []

# ---------------------------------------------------------------- cover / overview
s += [p("TatvaOS Mail API", TITLE),
      p("Integration guide for developers — send mail from your own software, as your own organisation.", SUB)]

s += [p("What this is", H2),
      p("One HTTPS request that sends an email as one of your organisation's mailboxes. TatvaOS signs it "
        "(DKIM), delivers it from your organisation's verified domain (SPF, DMARC), and keeps a record of every "
        "send. You do not run a mail server, manage keys for DKIM, or deal with SMTP — you make a POST."),
      p("It is deliberately small. There is one endpoint, one authentication method, and six fields. A developer "
        "who has used any transactional mail API (Resend, Postmark, SendGrid) will recognise the shape."),
      p("At a glance", H3)]
s += [table([
    ["Endpoint", "<font face='Courier'>POST https://core.tatvaos.com/api/v1/mail/send</font>"],
    ["Authentication", "<font face='Courier'>Authorization: Bearer tvos_…</font> — an organisation API key"],
    ["Body", "JSON: <font face='Courier'>from, to, subject, text, html, replyTo</font>"],
    ["Recipients", "Up to 5 per request, comma-separated in <font face='Courier'>to</font>"],
    ["Sender", "Must be a mailbox in your organisation, on a domain you have verified"],
    ["Success", "<font face='Courier'>202 Accepted</font> — accepted for delivery by TatvaOS"],
], [38 * mm, W - 38 * mm], header=False)]

# ---------------------------------------------------------------- keys
s += [p("1. Getting an API key", H2),
      p("An organisation administrator creates keys in the TatvaOS admin: <b>Organisation → API keys</b>. "
        "The administrator names the key for the program that will use it (\"Website contact form\", "
        "\"Billing notifications\") and hands you the key. It looks like this:"),
      code("tvos_k7Qm2ZpR4wN9tV1cH6xB8sL3yD5fG0jA"),
      p("Three things to know about it:"),
      p("<b>It is shown once.</b> TatvaOS stores only a hash. If it is lost, the administrator revokes it and "
        "creates another; nobody can read it back."),
      p("<b>It belongs to the organisation, not to a mailbox.</b> One key can send as any mailbox in the "
        "organisation. Choose the sender per request with the <font face='Courier'>from</font> field."),
      p("<b>It can send and nothing else.</b> A key cannot read mail, list mailboxes, or change settings. "
        "If it leaks, the worst outcome is unwanted mail from your domain — which is why you still keep it secret."),
      p("Keep it server-side", H3),
      p("Never put the key in browser JavaScript, a mobile app, or a public repository. Read it from an "
        "environment variable or a secrets store on your server, and call the API from there. If a key is ever "
        "exposed, ask the administrator to revoke it — revocation takes effect on the next request.")]

# ---------------------------------------------------------------- sender
s += [p("2. Choosing the sender", H2),
      p("The <font face='Courier'>from</font> address must be an active mailbox in your organisation, on a domain "
        "the administrator has verified under <b>Organisation → Domains</b>. This is what lets TatvaOS sign the "
        "message and pass SPF and DMARC at the receiving end — mail from an unverified domain would be refused or "
        "junked by every major provider, so TatvaOS refuses it first, with a clear message."),
      p("For software, use a <b>shared mailbox</b> (for example <font face='Courier'>website@</font>, "
        "<font face='Courier'>noreply@</font>, <font face='Courier'>billing@</font>). Replies then reach a team "
        "rather than one person's inbox. The administrator creates these under <b>Organisation → Shared mailboxes</b>."),
      p("If you want replies to go somewhere other than the sender, set <font face='Courier'>replyTo</font>.")]

# ---------------------------------------------------------------- request
s += [p("3. The request", H2),
      p("One POST, JSON body, key in the Authorization header. Everything is UTF-8."),
      code("""
POST /api/v1/mail/send HTTP/1.1
Host: core.tatvaos.com
Authorization: Bearer tvos_k7Qm2ZpR4wN9tV1cH6xB8sL3yD5fG0jA
Content-Type: application/json

{
  "from":    "website@your-domain.com",
  "to":      "customer@example.com",
  "subject": "Thanks for getting in touch",
  "text":    "We received your message and will reply within one working day.",
  "html":    "<p>We received your message and will reply within <b>one working day</b>.</p>",
  "replyTo": "support@your-domain.com"
}
"""),
      p("Fields", H3)]
s += [table([
    ["Field", "Required", "Meaning"],
    ["from", "yes", "A mailbox in your organisation, on a verified domain. Plain address, no display name."],
    ["to", "yes", "One address, or up to five separated by commas: <font face='Courier'>\"a@x.com, b@y.com\"</font>. "
                  "Each recipient gets their own copy and their own log entry."],
    ["subject", "yes", "The subject line."],
    ["text", "one of", "Plain-text body. Provide <font face='Courier'>text</font>, <font face='Courier'>html</font>, "
                       "or both — both is best; the receiver's client picks."],
    ["html", "one of", "HTML body. Keep it simple: inline styles, no scripts, no remote images you don't control."],
    ["replyTo", "no", "Where replies go. Defaults to <font face='Courier'>from</font>."],
], [24 * mm, 20 * mm, W - 44 * mm])]
s += [Spacer(1, 4),
      p("Limits", H3),
      p("Five recipients per request. To reach more people, make more requests. A bulk endpoint is planned; it is "
        "not available yet, and a request with more than five recipients is refused with a 400 rather than partly sent."),
      p("Attachments are not supported in this version.")]

# ---------------------------------------------------------------- responses
s += [p("4. Responses", H2),
      p("Every response is JSON. Read the status code first, then the body.")]
s += [table([
    ["Status", "Meaning", "Body"],
    [f"<font color='{OK.hexval()}'><b>202 Accepted</b></font>",
     "TatvaOS has the message and will deliver it. <b>This is not confirmation of arrival</b> — no mail API can "
     "promise that. The receiving server may still defer, reject, or file it as spam.",
     "<font face='Courier' size='7.5'>{\"outcome\":\"accepted\",<br/>\"recipients\":1,<br/>\"note\":\"Accepted for delivery. This is not confirmation of arrival.\"}</font>"],
    [f"<font color='{WARN.hexval()}'><b>400 Bad Request</b></font>",
     "Something in the request. The message says exactly which field — a missing subject, a sender that is not "
     "one of your mailboxes, more than five recipients, an address that does not parse.",
     "<font face='Courier' size='7.5'>{\"error\":\"website@x.com is not a mailbox on this organisation. Create it under Mailboxes, on a domain you have verified.\"}</font>"],
    [f"<font color='{WARN.hexval()}'><b>401 Unauthorized</b></font>",
     "The key is missing, malformed, unknown, or revoked. All of these get the same answer on purpose — the "
     "response never reveals whether a key once existed.",
     "<font face='Courier' size='7.5'>{\"error\":\"That API key is not valid.\"}</font>"],
    [f"<font color='{BAD.hexval()}'><b>502 Bad Gateway</b></font>",
     "TatvaOS's own mail server refused the message. The body carries its exact reason. Most often the sender's "
     "domain has lost verification. Nothing was sent; it is safe to retry after fixing the cause.",
     "<font face='Courier' size='7.5'>{\"error\":\"…the mail server's reason…\",<br/>\"outcome\":\"refused\"}</font>"],
], [30 * mm, 68 * mm, W - 98 * mm])]
s += [Spacer(1, 4),
      p("Retries", H3),
      p("Retry a <b>502</b> after fixing the reason it gives, and a network failure at once. Do not retry a <b>202</b> — "
        "the message is already on its way, and a retry sends it twice. Do not retry a <b>400</b> or <b>401</b> "
        "unchanged; the same request gets the same answer.")]

# ---------------------------------------------------------------- examples
s += [p("5. Code examples", H2),
      p("Each of these sends the same message. Replace the key, and the two addresses."),
      p("curl", H3),
      code("""
curl -X POST https://core.tatvaos.com/api/v1/mail/send \\
  -H "Authorization: Bearer $TATVAOS_MAIL_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"website@your-domain.com","to":"customer@example.com","subject":"Thanks for getting in touch","text":"We received your message and will reply within one working day."}'
"""),
      p("Node.js (18+, built-in fetch)", H3),
      code("""
const res = await fetch("https://core.tatvaos.com/api/v1/mail/send", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.TATVAOS_MAIL_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: "website@your-domain.com",
    to: "customer@example.com",
    subject: "Thanks for getting in touch",
    text: "We received your message and will reply within one working day.",
  }),
});
const body = await res.json();
if (res.status !== 202) throw new Error(`${res.status}: ${body.error}`);
"""),
      p("Python (requests)", H3),
      code("""
import os, requests

r = requests.post(
    "https://core.tatvaos.com/api/v1/mail/send",
    headers={"Authorization": f"Bearer {os.environ['TATVAOS_MAIL_KEY']}"},
    json={
        "from": "website@your-domain.com",
        "to": "customer@example.com",
        "subject": "Thanks for getting in touch",
        "text": "We received your message and will reply within one working day.",
    },
    timeout=30,
)
if r.status_code != 202:
    raise RuntimeError(f"{r.status_code}: {r.json().get('error')}")
"""),
      p("PHP (cURL)", H3),
      code("""
<?php
$payload = json_encode([
  "from"    => "website@your-domain.com",
  "to"      => "customer@example.com",
  "subject" => "Thanks for getting in touch",
  "text"    => "We received your message and will reply within one working day.",
]);
$ch = curl_init("https://core.tatvaos.com/api/v1/mail/send");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => $payload,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer " . getenv("TATVAOS_MAIL_KEY"),
    "Content-Type: application/json",
  ],
]);
$body = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
if ($status !== 202) throw new Exception("$status: " . $body["error"]);
"""),
      p("A website contact form, end to end", H3),
      p("The pattern every integration follows: the visitor submits the form to <b>your</b> server; your server "
        "validates it, then calls TatvaOS with the key from its environment. The browser never sees the key. Send "
        "the notification to your team from <font face='Courier'>website@</font>, and set "
        "<font face='Courier'>replyTo</font> to the visitor's address so a reply from your inbox goes straight back to them.")]

# ---------------------------------------------------------------- deliverability
s += [p("6. Getting into the inbox", H2),
      p("TatvaOS handles the technical side: every message is DKIM-signed for your domain, sent from an IP your "
        "SPF record authorises, and passes DMARC. Those are necessary and they are done. They are not sufficient. "
        "Whether a message lands in the inbox or in spam is decided by the receiver's reputation model, and "
        "reputation is earned by the address, over time, with real mail."),
      p("What helps", H3),
      p("<b>Send from an address you keep using.</b> Reputation attaches to the address and the domain. A new "
        "address has none; its first messages often go to spam regardless of content. That improves as people "
        "open and reply."),
      p("<b>Write like a person.</b> A greeting, a reason for the message, a signature with a name. One-line "
        "messages with subjects like \"test\" are the shape of spam, and filters know it."),
      p("<b>Send both text and html.</b> HTML-only mail scores worse. Keep HTML simple."),
      p("<b>Only send to people who expect it.</b> Mail that gets marked as spam by recipients damages the "
        "address for everyone. A contact-form confirmation to the person who filled it in is expected; a "
        "newsletter to a bought list is not, and this API is not built for it."),
      p("<b>Start small.</b> Tens a day, not thousands, until the address has a history."),
      p("What a receiver sees", H3),
      p("The authentication lines Gmail attached to a message sent through this API on 3 September 2026, "
        "unedited. This is what TatvaOS does for you on every message:"),
      code("""
Authentication-Results: mx.google.com;
       dkim=pass header.i=@techvein.com header.s=tv2026a;
       spf=pass (google.com: domain of website_support@techvein.com
                 designates 172.105.57.198 as permitted sender);
       dmarc=pass header.from=techvein.com
Received: from mx.tatvaos.com (mx.tatvaos.com. [172.105.57.198])
       by mx.google.com with ESMTPS (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384)
"""),
      p("What \"accepted\" means", H3),
      p("A 202 means TatvaOS's server took the message and will attempt delivery. It says nothing about what the "
        "receiving server did with it. If you need to know whether a message reached a specific inbox, the "
        "honest answer is that no sender can know that — not TatvaOS, not any provider. What a later version will "
        "add is the receiving server's own response (accepted, deferred, bounced) per recipient; see section 8.")]

# ---------------------------------------------------------------- security
s += [p("7. Security checklist", H2)]
s += [table([
    ["Do", "Don't"],
    ["Keep the key in a server-side secret store or environment variable.", "Embed it in browser code, a mobile app, or a public repository."],
    ["Use one key per program, named for what it does.", "Share one key across your website, billing, and a partner's system."],
    ["Ask the administrator to revoke a key the moment you suspect exposure.", "Keep using a key that has been in a chat, a ticket, or a log."],
    ["Validate form input on your server before sending.", "Let a form visitor choose the <font face='Courier'>to</font> or <font face='Courier'>from</font> address."],
    ["Rate-limit your own form to stop abuse.", "Assume TatvaOS will rate-limit for you — it does not yet."],
], [W / 2, W / 2])]

# ---------------------------------------------------------------- roadmap
s += [p("8. What is not in this version", H2),
      p("Stated so you can plan around it rather than discover it. All of these are designed and scheduled; none "
        "is available today."),
      table([
          ["Not yet", "What it will be"],
          ["Delivery status", "Per-recipient outcome from the receiving server — accepted, deferred, bounced with reason — in the admin log and, later, via API."],
          ["Bounce handling", "Automatic suppression of addresses that hard-bounce, so a bad address is never sent to twice."],
          ["Bulk sending", "One request, many recipients, expanded server-side. Until then: five per request, more requests."],
          ["Rate limits", "Per-organisation limits with clear 429 responses. Today there are none; be a good neighbour."],
          ["Attachments", "Not supported. Link to a file instead."],
          ["Key scopes", "Keys that can only send from certain mailboxes. Today a key can send as any mailbox in the organisation."],
          ["Open / click tracking", "Not planned. TatvaOS does not insert tracking pixels or rewrite links."],
      ], [32 * mm, W - 32 * mm])]

s += [Spacer(1, 10),
      p("Version 1.0 — 3 September 2026. Every request, field and response in this guide was exercised against "
        "production on the day it was written; the sample headers in section 6 are from a message Gmail received.", SMALL),
      p("Questions: your organisation's TatvaOS administrator, who can see the send log for every key.", SMALL)]

doc.build(s, onFirstPage=footer, onLaterPages=footer)
print("built", OUT)
