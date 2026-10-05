//
// Who a reply goes to - above all, when the message being answered is your own.
//
// WHY THIS EXISTS. A client of ShippingXpress, 28 September 2026: he pressed
// Reply all on a message HE had sent, to chase it. The composer addressed the
// reminder "to vipin" - himself - with the three real recipients on Cc. His
// own copy came back to his Inbox, the conversation showed the reminder twice,
// and he reported that two mails were being sent.
//
// THE FIRST BLOCK IS THE CALIBRATION: `before()` is the rule the composer ran
// until that day, kept here word for word. The checks show it producing the
// reported header, so the checks on the new rule have something to differ
// from - without it, "to is not vipin" would pass on an empty string too.
//
// Usage: bash tests/mail-reply-recipients/run.sh
//
const { replyRecipients } = require('./.built/replyRecipients.js');
let pass = 0, fail = 0;
function is(what, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`    ok  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}\n          got  ${g}\n          want ${w}`); }
}
const P = (...emails) => emails.map((email) => ({ email }));

// Composer.tsx as it stood on main at 4ac40f8.
function before(original, mode, self) {
  const to = mode === 'forward' ? '' : original ? original.from.email : '';
  const cc = mode !== 'replyAll' ? '' : [...new Set([...(original.to ?? []), ...(original.cc ?? [])]
    .map((a) => a.email)
    .filter((e) => e && e.toLowerCase() !== self.toLowerCase()
      && e.toLowerCase() !== original.from.email.toLowerCase()))].join(', ');
  return { to, cc };
}

console.log('\n  mail reply recipients\n  =====================\n');

const me = 'vipin@shippingxpress.in';
// His first message: to the team.
const first = { from: { email: me }, to: P('kunal@c.in', 'ajeet@c.in', 'amit@c.in'), cc: [] };
// The reminder as it actually went: to himself, the team on Cc.
const reminder = { from: { email: me }, to: P(me), cc: P('kunal@c.in', 'ajeet@c.in', 'amit@c.in') };

// ── calibration: the old rule reproduces the report ───────────────────────
is('BEFORE: reply all on my own message put ME in To',
   before(first, 'replyAll', me), { to: me, cc: 'kunal@c.in, ajeet@c.in, amit@c.in' });

// ── my own message ────────────────────────────────────────────────────────
is('reply all on my own message goes to the people I wrote to',
   replyRecipients(first, 'replyAll', me), { to: 'kunal@c.in, ajeet@c.in, amit@c.in', cc: '' });
is('plain reply on my own message goes to them too, not to me',
   replyRecipients(first, 'reply', me), { to: 'kunal@c.in, ajeet@c.in, amit@c.in', cc: '' });
is('my To and my Cc keep their places',
   replyRecipients({ from: { email: me }, to: P('a@c.in'), cc: P('b@c.in', 'c@c.in') }, 'replyAll', me),
   { to: 'a@c.in', cc: 'b@c.in, c@c.in' });
is('plain reply on my own message leaves Cc out',
   replyRecipients({ from: { email: me }, to: P('a@c.in'), cc: P('b@c.in') }, 'reply', me),
   { to: 'a@c.in', cc: '' });
is('THE REPORTED MAIL: reply all on the to-myself reminder moves the team up to To',
   replyRecipients(reminder, 'replyAll', me), { to: 'kunal@c.in, ajeet@c.in, amit@c.in', cc: '' });
is('a note sent only to myself is still answerable to myself',
   replyRecipients({ from: { email: me }, to: P(me), cc: [] }, 'reply', me), { to: me, cc: '' });
is('my address in another case is still me',
   replyRecipients({ from: { email: 'Vipin@ShippingXpress.in' }, to: P('a@c.in'), cc: [] }, 'reply', me),
   { to: 'a@c.in', cc: '' });
is('somebody on both To and Cc is written to once',
   replyRecipients({ from: { email: me }, to: P('a@c.in'), cc: P('A@c.in', 'b@c.in') }, 'replyAll', me),
   { to: 'a@c.in', cc: 'b@c.in' });

// ── somebody else's message: unchanged, and shown to be unchanged ─────────
const theirs = { from: { email: 'kunal@c.in' }, to: P(me, 'ajeet@c.in'), cc: P('amit@c.in', 'kunal@c.in') };
is('reply to somebody else answers them',
   replyRecipients(theirs, 'reply', me), { to: 'kunal@c.in', cc: '' });
is('reply all copies the others - not me, not the sender twice',
   replyRecipients(theirs, 'replyAll', me), { to: 'kunal@c.in', cc: 'ajeet@c.in, amit@c.in' });
for (const mode of ['reply', 'replyAll', 'forward'])
  is(`somebody else's message, ${mode}: same answer as before the change`,
     replyRecipients(theirs, mode, me), before(theirs, mode, me));

// ── the edges ─────────────────────────────────────────────────────────────
is('a forward starts with nobody', replyRecipients(first, 'forward', me), { to: '', cc: '' });
is('a new message starts with nobody', replyRecipients(null, 'new', me), { to: '', cc: '' });
is('no address of my own known: nothing is treated as mine',
   replyRecipients(first, 'reply', ''), { to: me, cc: '' });
is('missing To and Cc lists do not throw',
   replyRecipients({ from: { email: 'kunal@c.in' } }, 'replyAll', me), { to: 'kunal@c.in', cc: '' });

console.log(fail === 0 ? `\n  PASSED  ${pass} checks\n` : `\n  FAILED  ${fail} of ${pass + fail} checks\n`);
process.exit(fail === 0 ? 0 : 1);
