// ============================================================================
//  Ready-made signatures
// ============================================================================
//
//  Amit, 24 September 2026: "add some predefined structure of rich signature
//  in the signature section."
//
//  The rich editor landed the day before and started people on an empty box.
//  An empty box is the worst place to design a signature from: the person who
//  asked for this was a customer who knew exactly what they wanted and could
//  not build it, and most people do not even know what is possible. So these
//  are whole layouts to start from, not a colour picker.
//
//  ── THE RULES EVERY TEMPLATE HERE FOLLOWS, AND WHY ────────────────────────
//
//  1. TABLES FOR LAYOUT, never flex or grid. Outlook on Windows renders mail
//     through Word, which has neither. A two-column signature built with flex
//     looks right in our composer and stacks into a heap in the client half
//     of Indian business uses.
//
//  2. INLINE STYLES ONLY. A <style> block is stripped by Gmail and most
//     webmail; a class attribute means nothing once the markup leaves us.
//     cleanSignatureHtml drops both anyway.
//
//  3. NOTHING THAT MOVES OR POSITIONS. transform, position, float and friends
//     are in the sanitiser's blocklist (lib/signatureHtml.ts) after a pasted
//     Google result arrived upside down. A template written with them would
//     be silently flattened on save, which is worse than refusing it.
//
//  4. PIXEL FONT SIZES, not rem or em. There is no root element in a mail
//     client's rendering of your message, so relative units inherit from
//     something you cannot see.
//
//  5. SQUARE BRACKETS FOR WHAT WE DO NOT KNOW. [Your role], [Phone]. They
//     look obviously unfinished, so a half-edited template reads as a mistake
//     at a glance rather than going out looking deliberate. Anything we DO
//     know — name, mailbox address, organisation — is filled in already.
//
//  6. NO IMAGE SRC. A logo needs an https address that the RECIPIENT'S mail
//     client can fetch days later; we have no such address until the person
//     supplies one. Templates that want a logo leave a marked placeholder and
//     the toolbar's Insert image puts the real one in. A data: URI would look
//     perfect here and be stripped by Gmail — see signatureHtml.ts.
//
//  Colours are plain hex, not design tokens, for the same reason as the
//  inline styles: this markup is read by Outlook, not by our stylesheet.
// ============================================================================

/**
 * What a template fills in for you.
 *
 * `email` is the MAILBOX address, never the sign-in email — those are
 * commonly different, and a signature advertising the wrong address is the
 * kind of error nobody proofreads.
 */
export interface SignatureIdentity {
  name: string;
  email: string;
  org: string;
}

export interface SignatureTemplate {
  id: string;
  label: string;
  /** One line under the name in the gallery: when you would pick this one. */
  hint: string;
  /** Whether the layout expects a logo, so the gallery can say so. */
  wantsLogo?: boolean;
  build: (i: SignatureIdentity) => string;
}

/** A value of ours going into markup of ours. Someone's name may hold an &. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The one green the rest of TatvaOS uses for accents, written as hex. */
const GREEN = '#0a6b3d';
const GREY = '#6b7280';
const INK = '#111827';
const LINK = '#1a73e8';

/** The wrapper every template shares: one font, one size, one colour. */
function frame(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:${INK}">${inner}</div>`;
}

/** The marker an Insert image replaces. Deliberately wordy — it is an instruction. */
const LOGO_SLOT = `<span style="color:${GREY}">[Insert image — your logo]</span>`;

export const SIGNATURE_TEMPLATES: SignatureTemplate[] = [
  // ---- Plain ------------------------------------------------------------
  {
    id: 'name',
    label: 'Just your name',
    hint: 'Internal mail, where everyone already knows who you are.',
    build: (i) => frame(`<div>${esc(i.name)}</div>`),
  },
  {
    id: 'role',
    label: 'Name and role',
    hint: 'The usual choice.',
    build: (i) => frame(
      `<div><b>${esc(i.name)}</b></div>`
      + `<div style="color:${GREY}">[Your role]</div>`
      + `<div style="color:${GREY}">${esc(i.org)}</div>`,
    ),
  },
  {
    id: 'contact',
    label: 'Full contact',
    hint: 'For mail that leaves the organisation.',
    build: (i) => frame(
      `<div><b>${esc(i.name)}</b></div>`
      + `<div style="color:${GREY}">[Your role] | ${esc(i.org)}</div>`
      + `<div><a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`
      + `<div>[Phone]</div>`,
    ),
  },
  {
    id: 'closing',
    label: 'With a sign-off',
    hint: 'Adds the closing line, so you stop typing it every time.',
    build: (i) => frame(
      `<div>Warm regards,</div><div><br></div>`
      + `<div><b>${esc(i.name)}</b></div>`
      + `<div style="color:${GREY}">[Your role] | ${esc(i.org)}</div>`
      + `<div><a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`,
    ),
  },

  // ---- Rich -------------------------------------------------------------
  {
    id: 'card',
    label: 'Card, with a logo beside it',
    hint: 'Details on the left, logo on the right. The layout customers ask for most.',
    wantsLogo: true,
    build: (i) => frame(
      `<table cellpadding="0" cellspacing="0" border="0"><tbody><tr>`
      + `<td valign="top" style="padding-right:18px">`
      + `<div><b style="color:${GREEN};font-size:15px">${esc(i.name)}</b> <span style="color:${GREY}">| [Your role]</span></div>`
      + `<div style="padding-top:8px"><b style="color:${GREEN}">M:</b> [Phone]</div>`
      + `<div><b style="color:${GREEN}">E:</b> <a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`
      + `<div style="padding-top:4px"><b>[www.your-website.com]</b></div>`
      + `</td>`
      + `<td valign="top">${LOGO_SLOT}</td>`
      + `</tr><tr><td colspan="2" style="padding-top:12px">`
      + `<div style="font-size:12px;color:${GREY}">${esc(i.org)}, [Registered address]</div>`
      + `</td></tr></tbody></table>`,
    ),
  },
  {
    id: 'logo-left',
    label: 'Logo first, details beside it',
    hint: 'The mirror of the card — logo on the left, separated by a rule.',
    wantsLogo: true,
    // The rule is a bordered CELL, not an <hr> turned sideways: a vertical hr
    // does not exist, and border-right on a td is the one divider every mail
    // client draws.
    build: (i) => frame(
      `<table cellpadding="0" cellspacing="0" border="0"><tbody><tr>`
      + `<td valign="middle" style="padding-right:16px;border-right:2px solid ${GREEN}">${LOGO_SLOT}</td>`
      + `<td valign="middle" style="padding-left:16px">`
      + `<div><b style="font-size:15px">${esc(i.name)}</b></div>`
      + `<div style="color:${GREY}">[Your role], ${esc(i.org)}</div>`
      + `<div style="padding-top:6px">[Phone] &nbsp;·&nbsp; <a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`
      + `</td></tr></tbody></table>`,
    ),
  },
  {
    id: 'accent',
    label: 'Accent bar',
    hint: 'A coloured line down the left. Quiet, and it survives everywhere.',
    // border-left on a td rather than on a div: Outlook ignores borders on a
    // div often enough that the table cell is the reliable one.
    build: (i) => frame(
      `<table cellpadding="0" cellspacing="0" border="0"><tbody><tr>`
      + `<td style="border-left:3px solid ${GREEN};padding-left:12px">`
      + `<div><b style="font-size:15px">${esc(i.name)}</b></div>`
      + `<div style="color:${GREY};padding-bottom:6px">[Your role] · ${esc(i.org)}</div>`
      + `<div style="font-size:12px">[Phone] &nbsp;|&nbsp; <a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a> &nbsp;|&nbsp; [www.your-website.com]</div>`
      + `</td></tr></tbody></table>`,
    ),
  },
  {
    id: 'banner',
    label: 'Name on a coloured band',
    hint: 'A solid header strip with your name, details underneath.',
    build: (i) => frame(
      `<table cellpadding="0" cellspacing="0" border="0"><tbody>`
      + `<tr><td bgcolor="${GREEN}" style="background-color:${GREEN};padding:8px 14px">`
      + `<span style="color:#ffffff;font-size:15px"><b>${esc(i.name)}</b></span>`
      + `<span style="color:#cfe6da"> &nbsp;|&nbsp; [Your role]</span>`
      + `</td></tr>`
      + `<tr><td style="padding:10px 14px 0 14px">`
      + `<div>${esc(i.org)}</div>`
      + `<div style="padding-top:4px">[Phone] &nbsp;·&nbsp; <a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`
      + `</td></tr></tbody></table>`,
    ),
  },
  {
    id: 'centred',
    label: 'Centred, under a rule',
    hint: 'A quiet divider, then everything centred. Reads well on a phone.',
    build: (i) => frame(
      `<div><hr style="border:0;border-top:1px solid #e5e7eb"></div>`
      + `<div style="text-align:center;padding-top:8px">`
      + `<div><b style="font-size:15px">${esc(i.name)}</b></div>`
      + `<div style="color:${GREY}">[Your role] · ${esc(i.org)}</div>`
      + `<div style="padding-top:4px;font-size:12px">[Phone] &nbsp;·&nbsp; <a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`
      + `</div>`,
    ),
  },
  {
    id: 'oneline',
    label: 'One line',
    hint: 'Everything on a single line. For people who reply all day.',
    build: (i) => frame(
      `<div style="font-size:12px;color:${GREY}">`
      + `<b style="color:${INK}">${esc(i.name)}</b> · [Your role], ${esc(i.org)} · [Phone] · `
      + `<a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a>`
      + `</div>`,
    ),
  },
  {
    id: 'confidentiality',
    label: 'With a confidentiality note',
    hint: 'Contact details, then the small print. For legal and finance mail.',
    // The note is 11px grey ON PURPOSE. It is a disclaimer, and a disclaimer
    // that competes with the sender's name for attention is a worse signature
    // and no more binding.
    build: (i) => frame(
      `<div><b>${esc(i.name)}</b></div>`
      + `<div style="color:${GREY}">[Your role] | ${esc(i.org)}</div>`
      + `<div>[Phone] &nbsp;·&nbsp; <a href="mailto:${esc(i.email)}" style="color:${LINK};text-decoration:none">${esc(i.email)}</a></div>`
      + `<div style="padding-top:10px;font-size:11px;color:#9ca3af;line-height:1.45">`
      + `This message and any attachments are confidential and intended only for the `
      + `addressee. If you have received it in error, please tell the sender and delete it. `
      + `[Check this wording with whoever signs off your legal text.]`
      + `</div>`,
    ),
  },
];
