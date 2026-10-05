// lib/mail.js — the rules that decide what a row says and what a reply
// carries. The HTTP calls themselves are checked by the screens; these are the
// pure parts, where a mistake is silent (a wrong date, a lost "Re:", a reply
// that quotes nothing).

const {
  orderFolders, senderLabel, whenLabel, addressList, quoted, replySubject, forwardSubject,
  typingTerm, withRecipient, signatureFor, replyAllRecipients, forwardHeader,
  replyRecipients, otherMessages,
} = require('../lib/mail');

test('folders: Inbox first, then the known places, then the rest by name', () => {
  const ordered = orderFolders([
    { id: '1', name: 'Zebra', slug: null },
    { id: '2', name: 'Trash', slug: 'trash' },
    { id: '3', name: 'Inbox', slug: 'inbox' },
    { id: '4', name: 'Archive', slug: null },
    { id: '5', name: 'Sent', slug: 'sent' },
  ]).map((f) => f.name);
  expect(ordered).toEqual(['Inbox', 'Sent', 'Trash', 'Archive', 'Zebra']);
});

test('a sender with no name shows their address, never "undefined"', () => {
  expect(senderLabel({ from: { name: 'Ravi Kumar', email: 'r@x.com' } })).toBe('Ravi Kumar');
  expect(senderLabel({ from: { name: '   ', email: 'r@x.com' } })).toBe('r@x.com');
  expect(senderLabel({})).toBe('Unknown sender');
});

test('dates read as a mail app: time today, weekday this week, date beyond', () => {
  const now = new Date('2026-09-18T15:00:00');
  expect(whenLabel(new Date('2026-09-18T09:05:00').toISOString(), now)).toMatch(/^09:05$/);
  // Three days back is still this week -> a weekday name, not a date.
  expect(whenLabel(new Date('2026-09-15T09:05:00').toISOString(), now)).toMatch(/^[A-Z][a-z]{2}$/);
  expect(whenLabel(new Date('2026-08-02T09:05:00').toISOString(), now)).toMatch(/Aug/);
  expect(whenLabel(new Date('2025-08-02T09:05:00').toISOString(), now)).toMatch(/2025/);
  expect(whenLabel(null, now)).toBe('');
  expect(whenLabel('not a date', now)).toBe('');
});

test('addresses join with commas and drop the empties', () => {
  expect(addressList([{ email: 'a@x.com' }, { email: '' }, { email: 'b@y.com' }])).toBe('a@x.com, b@y.com');
  expect(addressList(undefined)).toBe('');
});

test('Re: does not stack, and a forward is marked once', () => {
  expect(replySubject('Invoice')).toBe('Re: Invoice');
  expect(replySubject('Re: Invoice')).toBe('Re: Invoice');
  expect(replySubject('RE: Invoice')).toBe('RE: Invoice');
  expect(forwardSubject('Invoice')).toBe('Fwd: Invoice');
  expect(forwardSubject('Fwd: Invoice')).toBe('Fwd: Invoice');
});

test('a reply quotes the original, every line marked', () => {
  const q = quoted({
    from: { name: 'Ravi', email: 'r@x.com' },
    sentAt: '2026-09-18T09:00:00Z',
    bodyText: 'line one\nline two',
  });
  expect(q).toContain('Ravi wrote:');
  expect(q).toContain('> line one');
  expect(q).toContain('> line two');
});

test('quoting a message with no text body does not produce "undefined"', () => {
  expect(quoted({ from: { email: 'r@x.com' } })).not.toMatch(/undefined/);
});

// ── QUOTING A MESSAGE THAT HAS NO TEXT PART ─────────────────────────────────
//  Amit, 18 Sept 2026: "reply on html designed mail did not pick the content".
//  Every newsletter and every automated notification is HTML-only, so the
//  quote was a "wrote:" line with nothing under it.
describe('quoted, for an HTML-only message', () => {
  const html = {
    from: { email: 'news@example.com', name: 'The Times' },
    sentAt: '2026-09-18T06:00:00Z',
    bodyHtml: '<table width="600"><tr><td><p>Rates held at 6%.</p>'
      + '<p>Full story inside.</p></td></tr></table>',
  };

  test('the words come from the HTML when there is no bodyText', () => {
    const out = quoted(html);
    expect(out).toMatch(/> Rates held at 6%\./);
    expect(out).toMatch(/> Full story inside\./);
  });

  test('every line of the quote is marked as quoted', () => {
    const body = quoted(html).split('\n').slice(3);        // past the blank lines + "wrote:"
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) expect(line.startsWith('>')) .toBe(true);
  });

  test('no markup survives into the reply', () => {
    expect(quoted(html)).not.toMatch(/<table|<p>|width="600"/);
  });

  test('bodyText still wins when it exists — it is what the sender wrote', () => {
    const both = { ...html, bodyText: 'Rates held.' };
    expect(quoted(both)).toMatch(/> Rates held\.$/);
    expect(quoted(both)).not.toMatch(/Full story/);
  });

  test('a message with neither says so instead of trailing off', () => {
    // A bare "wrote:" with nothing after it reads like the app broke.
    expect(quoted({ from: { email: 'a@b.com' }, sentAt: '2026-09-18T06:00:00Z' }))
      .toMatch(/> \(no text content\)/);
  });

  test('whitespace-only HTML counts as nothing, not as an empty quote', () => {
    expect(quoted({ from: { email: 'a@b.com' }, bodyHtml: '<div> </div><p></p>' }))
      .toMatch(/> \(no text content\)/);
  });
});

// ── SUGGESTING RECIPIENTS ───────────────────────────────────────────────────
//  Amit, 18 Sept 2026: "auto name suggestion on to and cc". The fiddly part is
//  not the request, it is knowing WHICH address is being typed in a field that
//  holds several, and putting the chosen one back without eating the others.
describe('typingTerm', () => {
  test('the fragment after the last comma is the query', () => {
    expect(typingTerm('ravi@example.com, am')).toBe('am');
  });

  test('a single unfinished address is the query', () => {
    expect(typingTerm('am')).toBe('am');
  });

  test('nothing typed yet is not a query', () => {
    expect(typingTerm('')).toBe('');
    expect(typingTerm(null)).toBe('');
    expect(typingTerm(undefined)).toBe('');
  });

  test('a finished list stops asking — no query after a comma', () => {
    // Otherwise the list hangs about under an address already chosen.
    expect(typingTerm('ravi@example.com, ')).toBe('');
    expect(typingTerm('ravi@example.com,')).toBe('');
  });

  test('a trailing space means done with that one', () => {
    expect(typingTerm('ravi@example.com ')).toBe('');
  });
});

describe('withRecipient', () => {
  test('the half-typed address is replaced, the chosen ones kept', () => {
    expect(withRecipient('ravi@example.com, am', 'amit@tatvaos.com'))
      .toBe('ravi@example.com, amit@tatvaos.com, ');
  });

  test('the first pick on an empty field', () => {
    expect(withRecipient('', 'amit@tatvaos.com')).toBe('amit@tatvaos.com, ');
    expect(withRecipient('am', 'amit@tatvaos.com')).toBe('amit@tatvaos.com, ');
  });

  test('it ends ready for the next address', () => {
    // The trailing ", " is what lets someone keep typing without punctuation.
    expect(withRecipient('a', 'x@y.com').endsWith(', ')).toBe(true);
  });

  test('THE SAME ADDRESS IS NOT ADDED TWICE', () => {
    // Some clients send twice; on screen it just looks like the tap failed.
    expect(withRecipient('amit@tatvaos.com, am', 'amit@tatvaos.com'))
      .toBe('amit@tatvaos.com, ');
    expect(withRecipient('Amit@TatvaOS.com, am', 'amit@tatvaos.com'))
      .toBe('Amit@TatvaOS.com, ');
  });

  test('stray whitespace and empty entries are tidied, not preserved', () => {
    expect(withRecipient('  a@x.com ,, b@y.com , cc', 'c@z.com'))
      .toBe('a@x.com, b@y.com, c@z.com, ');
  });
});

// ── THE SIGNATURE IS AN OBJECT, NOT A STRING ────────────────────────────────
//  19 Sept 2026: an email Amit sent from the phone began "[object Object]".
//  Bootstrap returns { bodyHtml, bodyText, enabled, includeOnReply } and the
//  compose screen pasted it as text. These use the API's REAL shape.
describe('signatureFor', () => {
  const api = { bodyHtml: '<p>— Amit</p>', bodyText: '— Amit', enabled: true, includeOnReply: true };

  test('the API shape becomes its text', () => {
    expect(signatureFor(api)).toBe('— Amit');
    expect(signatureFor(api, 'reply')).toBe('— Amit');
  });

  test('NEVER "[object Object]", whatever is passed', () => {
    for (const v of [api, { enabled: true }, {}, { bodyText: 42 }, [], 7, true]) {
      expect(signatureFor(v)).not.toMatch(/object/i);
      expect(signatureFor(v, 'reply')).not.toMatch(/object/i);
    }
  });

  test('a disabled signature is no signature', () => {
    expect(signatureFor({ ...api, enabled: false })).toBe('');
  });

  test('includeOnReply=false keeps it off replies and forwards, not new mail', () => {
    const s = { ...api, includeOnReply: false };
    expect(signatureFor(s, 'new')).toBe('— Amit');
    expect(signatureFor(s, 'reply')).toBe('');
    expect(signatureFor(s, 'forward')).toBe('');
  });

  test('a plain string still works, trimmed', () => {
    expect(signatureFor('  — Amit \n')).toBe('— Amit');
    expect(signatureFor('')).toBe('');
    expect(signatureFor(null)).toBe('');
  });
});

test('a weekday name never means a week ago: last Saturday evening, seen on Saturday, is a date', () => {
  // Seen on the Samsung, 19 Sept 2026: 6.8 days is "under a week", so a message
  // from Sat 12 Sept read "Sat" on Sat 19 Sept, above "Fri" rows that meant yesterday.
  const now = new Date('2026-09-19T14:00:00');
  expect(whenLabel(new Date('2026-09-12T19:30:00').toISOString(), now)).toMatch(/12/);
  expect(whenLabel(new Date('2026-09-12T19:30:00').toISOString(), now)).not.toMatch(/^[A-Z][a-z]{2}$/);
  // Six calendar days back is still a weekday, and it is not today's.
  expect(whenLabel(new Date('2026-09-13T23:50:00').toISOString(), now)).toMatch(/^[A-Z][a-z]{2}$/);
  // Yesterday late, under 24 hours ago, is a weekday and not a time.
  expect(whenLabel(new Date('2026-09-18T23:50:00').toISOString(), now)).toMatch(/^[A-Z][a-z]{2}$/);
});

// ── REPLY ALL, THE FORWARD HEADER, THE THREAD ───────────────────────────────
//  Amit, 24 Sept 2026: "reply in reply" — parity with the web's reply work
//  (PRs 233, 237, 239, 245). Reply all is the rule the web uses; the forward
//  header is the one the web writes; the thread route has existed since
//  August and the phone never called it.
describe('replyAllRecipients', () => {
  const msg = {
    from: { name: 'Ravi', email: 'ravi@example.com' },
    to: [{ email: 'amit@tatvaos.com' }, { email: 'priya@example.com' }],
    cc: [{ email: 'accounts@example.com' }, { email: 'RAVI@example.com' }],
  };
  test('sender goes in To; everyone else in Cc; me and duplicates left out', () => {
    expect(replyAllRecipients(msg, 'amit@tatvaos.com')).toEqual({
      to: 'ravi@example.com',
      cc: 'priya@example.com, accounts@example.com',
    });
  });
  test('me is matched without regard to case, and a shared mailbox address counts as me', () => {
    expect(replyAllRecipients(msg, 'AMIT@tatvaos.com').cc).not.toMatch(/amit@/i);
    expect(replyAllRecipients({ ...msg, to: [{ email: 'support@tatvaos.com' }] }, 'support@tatvaos.com').cc).not.toMatch(/support@/);
  });
  test('replying to my own message sends to everyone else, in To', () => {
    const mine = { from: { email: 'amit@tatvaos.com' }, to: [{ email: 'ravi@example.com' }], cc: [{ email: 'priya@example.com' }] };
    expect(replyAllRecipients(mine, 'amit@tatvaos.com')).toEqual({ to: 'ravi@example.com, priya@example.com', cc: '' });
  });
  test('nothing crashes on a bare message', () => {
    expect(replyAllRecipients({}, 'amit@tatvaos.com')).toEqual({ to: '', cc: '' });
    expect(replyAllRecipients(null, '')).toEqual({ to: '', cc: '' });
  });
});

// ── A REPLY TO MY OWN MESSAGE, AND ONE MAIL STORED TWICE ────────────────────
//  Client report, 28 Sept 2026 ("two mails are going out"): one mail went
//  out. He had replied to his OWN message, the reply was addressed to him,
//  and the copy that came back to his Inbox showed up beside the Sent copy.
describe('replyRecipients', () => {
  const me = 'amit@tatvaos.com';
  const theirs = { from: { email: 'ravi@example.com' }, to: [{ email: me }], cc: [{ email: 'priya@example.com' }] };
  const mine = { from: { email: me }, to: [{ email: 'ravi@example.com' }, { email: 'priya@example.com' }], cc: [{ email: 'accounts@example.com' }] };

  test('somebody else\'s message: the sender, as it always was', () => {
    expect(replyRecipients(theirs, me)).toEqual({ to: 'ravi@example.com', cc: '' });
  });
  test('my own message: the people I wrote to, never me, and no Cc on a plain reply', () => {
    expect(replyRecipients(mine, me)).toEqual({ to: 'ravi@example.com, priya@example.com', cc: '' });
    expect(replyRecipients(mine, 'AMIT@TatvaOS.com').to).toBe('ravi@example.com, priya@example.com');
  });
  test('the old rule, for comparison: it answered ME', () => {
    // What MailMessage.js did until 28 Sept - kept so the check above has
    // something to differ from.
    const before = (m) => ({ to: m.from?.email ?? '', cc: '' });
    expect(before(mine)).toEqual({ to: me, cc: '' });
    expect(replyRecipients(mine, me)).not.toEqual(before(mine));
  });
  test('a note sent only to myself is still answerable to myself', () => {
    expect(replyRecipients({ from: { email: me }, to: [{ email: me }], cc: [{ email: 'ravi@example.com' }] }, me))
      .toEqual({ to: me, cc: '' });
  });
  test('with no address of my own known, nothing is treated as mine', () => {
    expect(replyRecipients(mine, '')).toEqual({ to: me, cc: '' });
  });
  test('nothing crashes on a bare message', () => {
    expect(replyRecipients({}, me)).toEqual({ to: '', cc: '' });
    expect(replyRecipients(null, '')).toEqual({ to: '', cc: '' });
  });
});

describe('otherMessages', () => {
  const rows = [
    { id: 'a' },
    { id: 'b-sent', copyIds: ['b-inbox'] },
    { id: 'c', copyIds: [] },
  ];
  const ids = (list) => list.map((r) => r.id).join(',');
  test('the open message is left out by id', () => {
    expect(ids(otherMessages(rows, 'a'))).toBe('b-sent,c');
  });
  test('...and by copy: the row that STANDS FOR the open message is left out too', () => {
    expect(ids(otherMessages(rows, 'b-inbox'))).toBe('a,c');
  });
  test('an id that is nobody\'s leaves everything in', () => {
    expect(ids(otherMessages(rows, 'zz'))).toBe('a,b-sent,c');
  });
  test('an older server sends no copyIds at all, and nothing breaks', () => {
    expect(ids(otherMessages([{ id: 'a' }, { id: 'b' }], 'a'))).toBe('b');
  });
  test('not a list, or holes in it: empty, not a crash', () => {
    expect(otherMessages(null, 'a')).toEqual([]);
    expect(ids(otherMessages([null, { id: 'b' }], 'a'))).toBe('b');
  });
});

describe('forwardHeader', () => {
  test('From, Date, Subject, To — and Cc only when there was one', () => {
    const h = forwardHeader({ from: { name: 'Ravi Kumar', email: 'ravi@example.com' }, sentAt: '2026-09-23T10:00:00Z',
      subject: 'Invoice', to: [{ email: 'amit@tatvaos.com' }], cc: [{ email: 'accounts@example.com' }] });
    expect(h).toMatch(/^---------- Forwarded message ----------\n/);
    expect(h).toMatch(/\nFrom: Ravi Kumar/);
    expect(h).toMatch(/\nDate: .+\n/);
    expect(h).toMatch(/\nSubject: Invoice\n/);
    expect(h).toMatch(/\nTo: amit@tatvaos.com\n/);
    expect(h).toMatch(/\nCc: accounts@example.com\n\n$/);
    expect(forwardHeader({ from: { email: 'r@x.com' }, to: [] })).not.toMatch(/Cc:/);
  });
});
