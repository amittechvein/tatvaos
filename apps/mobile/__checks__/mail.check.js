// lib/mail.js — the rules that decide what a row says and what a reply
// carries. The HTTP calls themselves are checked by the screens; these are the
// pure parts, where a mistake is silent (a wrong date, a lost "Re:", a reply
// that quotes nothing).

const {
  orderFolders, senderLabel, whenLabel, addressList, quoted, replySubject, forwardSubject,
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
