// lib/mail.js — the rules that decide what a row says and what a reply
// carries. The HTTP calls themselves are checked by the screens; these are the
// pure parts, where a mistake is silent (a wrong date, a lost "Re:", a reply
// that quotes nothing).

const {
  orderFolders, senderLabel, whenLabel, addressList, quoted, replySubject, forwardSubject,
  typingTerm, withRecipient,
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
