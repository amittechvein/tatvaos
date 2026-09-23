// Shared mailboxes: the client half.
//
// Amit, 23 Sept 2026: "able to access shared mailbox". The server has taken
// ?mailboxId= on every read route and as a form field on send all along; the
// app never passed one. These hold that it now does — on EVERY call, because
// one call that forgets is a message opened from support@ and then flagged in
// the person's own mailbox: a 404 at best.

jest.mock('../api', () => ({
  API_BASE: 'https://core.tatvaos.com',
  request: jest.fn(async () => ({})),
}));
const { request } = require('../api');
const mail = require('../lib/mail');

beforeEach(() => request.mockClear());
const lastPath = () => request.mock.calls.at(-1)[0];

describe('withMailbox', () => {
  test('nothing at all for my own mailbox — the request stays exactly as it was', () => {
    expect(mail.withMailbox('/api/mail/bootstrap', null)).toBe('/api/mail/bootstrap');
    expect(mail.withMailbox('/api/mail/bootstrap', undefined)).toBe('/api/mail/bootstrap');
    expect(mail.withMailbox('/api/mail/bootstrap', '')).toBe('/api/mail/bootstrap');
  });
  test('? when the path has no query, & when it already does', () => {
    expect(mail.withMailbox('/a', 'mb2')).toBe('/a?mailboxId=mb2');
    expect(mail.withMailbox('/a?skip=0', 'mb2')).toBe('/a?skip=0&mailboxId=mb2');
  });
});

describe('listMailboxes', () => {
  test('rows come back with the label and the grants worked out', async () => {
    request.mockResolvedValueOnce({ mailboxes: [
      { id: 'own', address: 'amit@tatvaos.com', localPart: 'amit', isOwn: true, permissions: ['full'] },
      { id: 'sup', address: 'support@tatvaos.com', localPart: 'support', isOwn: false, permissions: ['read', 'send_as'] },
      { id: 'ro', address: 'billing@tatvaos.com', localPart: 'billing', isOwn: false, permissions: ['read'] },
      { id: 'fu', address: 'hr@tatvaos.com', localPart: 'hr', isOwn: false, permissions: ['full'] },
    ] });
    const rows = await mail.listMailboxes('AT');
    expect(lastPath()).toBe('/api/mail/mailboxes');
    expect(rows.map((r) => r.label)).toEqual(['My mailbox', 'support', 'billing', 'hr']);
    expect(rows.map((r) => r.canSend)).toEqual([true, true, false, true]);
    expect(rows.map((r) => r.canRead)).toEqual([true, true, true, true]);
    expect(rows.map((r) => r.canAdminister)).toEqual([true, false, false, true]);
  });
  test('an empty or odd answer is an empty list, not a crash', async () => {
    request.mockResolvedValueOnce({});
    expect(await mail.listMailboxes('AT')).toEqual([]);
    request.mockResolvedValueOnce({ mailboxes: [{ id: 'x', isOwn: false }] });
    const [r] = await mail.listMailboxes('AT');
    expect(r.label).toBe('Shared mailbox');
    expect(r.canSend).toBe(false);
  });
});

describe('every read call names the mailbox', () => {
  const MB = 'mb-shared';
  test('bootstrap, folders', async () => {
    await mail.bootstrap('AT', MB);
    expect(lastPath()).toBe('/api/mail/bootstrap?mailboxId=mb-shared');
    await mail.listFolders('AT', MB);
    expect(lastPath()).toBe('/api/mail/folders?mailboxId=mb-shared');
  });
  test('messages and search, after their own query string', async () => {
    await mail.listMessages('AT', 'f1', { mailboxId: MB });
    expect(lastPath()).toBe('/api/mail/folders/f1/messages?skip=0&take=30&mailboxId=mb-shared');
    await mail.listMessages('AT', 'f1', { sort: 'oldest', mailboxId: MB });
    expect(lastPath()).toBe('/api/mail/folders/f1/messages?skip=0&take=30&sort=oldest&mailboxId=mb-shared');
    await mail.searchMessages('AT', 'invoice', { mailboxId: MB });
    expect(lastPath()).toBe('/api/mail/search?q=invoice&skip=0&take=30&mailboxId=mb-shared');
  });
  test('one message, read, flag, delete', async () => {
    await mail.getMessage('AT', 'm1', MB);
    expect(lastPath()).toBe('/api/mail/messages/m1?mailboxId=mb-shared');
    await mail.setRead('AT', 'm1', true, MB);
    expect(lastPath()).toBe('/api/mail/messages/m1/read?mailboxId=mb-shared');
    await mail.setFlag('AT', 'm1', true, MB);
    expect(lastPath()).toBe('/api/mail/messages/m1/flag?mailboxId=mb-shared');
    await mail.deleteMessage('AT', 'm1', MB);
    expect(lastPath()).toBe('/api/mail/messages/m1?mailboxId=mb-shared');
  });
  test('THE ATTACHMENT URL TOO — it is the one that 404s silently', () => {
    expect(mail.attachmentUrl('m1', 'a1', MB))
      .toBe('https://core.tatvaos.com/api/mail/messages/m1/attachments/a1?mailboxId=mb-shared');
    expect(mail.attachmentUrl('m1', 'a1'))
      .toBe('https://core.tatvaos.com/api/mail/messages/m1/attachments/a1');
  });
  test('and with no mailbox chosen, NONE of them carry the parameter', async () => {
    await mail.bootstrap('AT');
    await mail.listMessages('AT', 'f1');
    await mail.getMessage('AT', 'm1');
    await mail.setRead('AT', 'm1', true);
    await mail.deleteMessage('AT', 'm1');
    for (const [path] of request.mock.calls) expect(path).not.toMatch(/mailboxId/);
  });
});
