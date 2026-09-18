// The Mail screens: the list, one message, and writing one.
//
// What these prove is behaviour a person would notice: that a mailbox nobody
// has is an empty state rather than an error, that a message is marked read
// only after it is shown, that a stranger's HTML reaches the WebView with
// JavaScript OFF, and that a reply carries inReplyToId — the field that makes
// it a reply rather than a new conversation.

const { mailApi, webview, picker, files, sharing, alerts, opened, pressAlertButton } = require('./mailMocks');
const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react-native');

const Mail = require('../screens/Mail').default;
const MailMessage = require('../screens/MailMessage').default;
const MailCompose = require('../screens/MailCompose').default;

const session = { accessToken: 'AT' };
const inbox = { id: 'f1', name: 'Inbox', slug: 'inbox', unreadCount: 2 };
const sent = { id: 'f2', name: 'Sent', slug: 'sent', unreadCount: 0 };

const row = (over = {}) => ({
  id: 'm1', folderId: 'f1', threadId: 't1',
  from: { name: 'Ravi Kumar', email: 'ravi@example.com' },
  to: [{ email: 'amit@tatvaos.com' }],
  subject: 'Invoice for August', snippet: 'Please find attached',
  receivedAt: new Date().toISOString(), isRead: false, isFlagged: false,
  hasAttachments: true, ...over,
});

beforeEach(() => {
  alerts.calls.length = 0;
  files.downloads.length = 0;
  sharing.shared.length = 0;
  picker.next = { canceled: true };
  mailApi.bootstrap = jest.fn(async () => ({
    mailbox: { id: 'mb1', address: 'amit@tatvaos.com' },
    folders: [sent, inbox],
    signature: '— Amit',
  }));
  mailApi.listMessages = jest.fn(async () => ({ total: 1, messages: [row()] }));
  mailApi.searchMessages = jest.fn(async () => ({ total: 0, messages: [] }));
  mailApi.setRead = jest.fn(async () => ({}));
  mailApi.setFlag = jest.fn(async () => ({}));
  mailApi.deleteMessage = jest.fn(async () => ({ deleted: false, movedTo: 'f3' }));
  mailApi.send = jest.fn(async () => ({ id: 'sent1' }));
});

// ── the list ───────────────────────────────────────────────────────────────
test('opens on Inbox even when the server lists another folder first', async () => {
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  // The list arrives after the folders; waiting for the header alone raced it.
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());
  expect(r.getByText('Inbox')).toBeTruthy();
  expect(mailApi.listMessages).toHaveBeenCalledWith('AT', 'f1', expect.anything());
  expect(r.getByText('amit@tatvaos.com')).toBeTruthy();
});

test('no mailbox is an empty state, not an error', async () => {
  mailApi.bootstrap = jest.fn(async () => ({ mailbox: null, folders: [], signature: '' }));
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('No mailbox on this account')).toBeTruthy());
  expect(mailApi.listMessages).not.toHaveBeenCalled();
});

test('an unread row is announced as unread; tapping opens that message', async () => {
  const onOpen = jest.fn();
  const r = render(<Mail session={session} onBack={() => {}} onOpen={onOpen} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());
  const item = r.getByLabelText(/^Unread\. Ravi Kumar\./);
  fireEvent.press(item);
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
});

test('a read message carries no unread mark (isRead is not inverted)', async () => {
  mailApi.listMessages = jest.fn(async () => ({ total: 1, messages: [row({ isRead: true })] }));
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());
  expect(r.queryByLabelText(/^Unread\./)).toBeNull();
});

test('search asks the search endpoint, and clearing goes back to the folder', async () => {
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());
  const box = r.getByLabelText('Search mail');
  fireEvent.changeText(box, 'invoice');
  await act(async () => { fireEvent(box, 'submitEditing'); });
  expect(mailApi.searchMessages).toHaveBeenCalledWith('AT', 'invoice', expect.anything());
  await waitFor(() => expect(r.getByText('Nothing matched that search.')).toBeTruthy());
  const before = mailApi.listMessages.mock.calls.length;
  await act(async () => { fireEvent.press(r.getByLabelText('Clear search')); });
  expect(mailApi.listMessages.mock.calls.length).toBe(before + 1);
});

// ── one message ────────────────────────────────────────────────────────────
const full = (over = {}) => ({
  ...row(), bodyHtml: '<p>Hello</p><img src="https://track.example/o.gif">',
  bodyText: 'Hello', attachments: [], cc: [], ...over,
});

test('the body reaches the WebView with JavaScript OFF and remote images blocked', async () => {
  mailApi.getMessage = jest.fn(async () => full());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());

  expect(webview.lastProps.javaScriptEnabled).toBe(false);
  expect(webview.lastProps.source.html).toContain("default-src 'none'");
  expect(webview.lastProps.source.html).toContain('data-blocked-src="https://track.example/o.gif"');
  expect(r.getByLabelText('Show images in this message')).toBeTruthy();

  // Links leave the app rather than navigating inside the message.
  expect(webview.lastProps.onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false);
  expect(opened.urls).toContain('https://example.com');
  expect(webview.lastProps.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true);
});

test('Show images widens the policy for that message only', async () => {
  mailApi.getMessage = jest.fn(async () => full());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(r.getByLabelText('Show images in this message')).toBeTruthy());
  await act(async () => { fireEvent.press(r.getByLabelText('Show images in this message')); });
  expect(webview.lastProps.source.html).toContain('img-src data: cid: https:');
  expect(webview.lastProps.source.html).toContain("default-src 'none'");
});

test('an unread message is marked read AFTER it is shown; a read one is left alone', async () => {
  mailApi.getMessage = jest.fn(async () => full({ isRead: false }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(mailApi.setRead).toHaveBeenCalledWith('AT', 'm1', true));
  expect(r.getByText('Invoice for August')).toBeTruthy();

  mailApi.setRead.mockClear();
  mailApi.getMessage = jest.fn(async () => full({ isRead: true }));
  render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(mailApi.getMessage).toHaveBeenCalled());
  expect(mailApi.setRead).not.toHaveBeenCalled();
});

test('going back says whether anything changed, so the list reloads only then', async () => {
  const onBack = jest.fn();
  mailApi.getMessage = jest.fn(async () => full({ isRead: false }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={onBack} onReply={() => {}} />);
  await waitFor(() => expect(mailApi.setRead).toHaveBeenCalled());
  await act(async () => { fireEvent.press(r.getByLabelText('Back')); });
  expect(onBack).toHaveBeenCalledWith(true);
});

test('delete asks first, and says Trash rather than gone', async () => {
  mailApi.getMessage = jest.fn(async () => full());
  const onBack = jest.fn();
  const r = render(<MailMessage session={session} messageId="m1" onBack={onBack} onReply={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());
  fireEvent.press(r.getByLabelText('Delete this message'));
  expect(alerts.calls[0].message).toMatch(/moves to Trash/);
  expect(mailApi.deleteMessage).not.toHaveBeenCalled();
  await act(async () => { await pressAlertButton('Delete'); });
  expect(mailApi.deleteMessage).toHaveBeenCalledWith('AT', 'm1');
  expect(onBack).toHaveBeenCalledWith(true);
});

test('an attachment downloads WITH the token and is handed to the share sheet', async () => {
  mailApi.getMessage = jest.fn(async () => full({
    attachments: [{ id: 'a1', filename: 'invoice.pdf', sizeBytes: 2048, scanStatus: 'clean' }],
  }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(r.getByLabelText('Open invoice.pdf')).toBeTruthy());
  await act(async () => { fireEvent.press(r.getByLabelText('Open invoice.pdf')); });
  expect(files.downloads[0].url).toContain('/api/mail/messages/m1/attachments/a1');
  expect(files.downloads[0].headers.Authorization).toBe('Bearer AT');
  expect(sharing.shared).toHaveLength(1);
});

test('an infected attachment is refused without downloading anything', async () => {
  mailApi.getMessage = jest.fn(async () => full({
    attachments: [{ id: 'a1', filename: 'bad.exe', sizeBytes: 10, scanStatus: 'infected' }],
  }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(r.getByLabelText('Open bad.exe')).toBeTruthy());
  await act(async () => { fireEvent.press(r.getByLabelText('Open bad.exe')); });
  expect(files.downloads).toHaveLength(0);
  expect(alerts.calls[0].title).toBe('Blocked');
});

// ── writing one ────────────────────────────────────────────────────────────
test('a reply is addressed to the sender, subject Re:, and carries inReplyToId', async () => {
  const onSent = jest.fn();
  const message = full();
  const r = render(
    <MailCompose session={session} draft={{ kind: 'reply', message }} signature="— Amit"
                 onClose={() => {}} onSent={onSent} />,
  );
  expect(r.getByLabelText('To').props.value).toBe('ravi@example.com');
  expect(r.getByLabelText('Subject').props.value).toBe('Re: Invoice for August');
  expect(r.getByLabelText('Message').props.value).toContain('> Hello');

  await act(async () => { fireEvent.press(r.getByLabelText('Send this email')); });
  expect(mailApi.send).toHaveBeenCalledWith('AT', expect.objectContaining({
    to: 'ravi@example.com', inReplyToId: 'm1',
  }));
  expect(onSent).toHaveBeenCalled();
});

test('a forward starts with nobody in To and quotes the original', () => {
  const r = render(
    <MailCompose session={session} draft={{ kind: 'forward', message: full() }} signature=""
                 onClose={() => {}} onSent={() => {}} />,
  );
  expect(r.getByLabelText('To').props.value).toBe('');
  expect(r.getByLabelText('Subject').props.value).toBe('Fwd: Invoice for August');
  expect(r.getByLabelText('Message').props.value).toContain('Forwarded message');
});

test('sending with nobody in To is refused before any request', async () => {
  const r = render(<MailCompose session={session} draft={{ kind: 'new' }} signature=""
                                onClose={() => {}} onSent={() => {}} />);
  await act(async () => { fireEvent.press(r.getByLabelText('Send this email')); });
  expect(mailApi.send).not.toHaveBeenCalled();
  expect(r.getByText('Say who this is going to.')).toBeTruthy();
});

test('files over 25 MB are refused here, not after the upload', async () => {
  picker.next = { canceled: false, assets: [{ uri: 'file:///big.zip', name: 'big.zip', size: 26 * 1024 * 1024 }] };
  const r = render(<MailCompose session={session} draft={{ kind: 'new' }} signature=""
                                onClose={() => {}} onSent={() => {}} />);
  await act(async () => { fireEvent.press(r.getByLabelText('Attach a file')); });
  expect(r.getByText(/more than 25 MB/)).toBeTruthy();
  expect(r.queryByLabelText('Remove big.zip')).toBeNull();
});

test('an attached file is listed, removable, and sent with the message', async () => {
  picker.next = { canceled: false, assets: [{ uri: 'file:///a.pdf', name: 'a.pdf', size: 1024, mimeType: 'application/pdf' }] };
  const r = render(<MailCompose session={session} draft={{ kind: 'new' }} signature=""
                                onClose={() => {}} onSent={() => {}} />);
  await act(async () => { fireEvent.press(r.getByLabelText('Attach a file')); });
  expect(r.getByLabelText('Remove a.pdf')).toBeTruthy();

  fireEvent.changeText(r.getByLabelText('To'), 'ravi@example.com');
  await act(async () => { fireEvent.press(r.getByLabelText('Send this email')); });
  expect(mailApi.send).toHaveBeenCalledWith('AT', expect.objectContaining({
    files: [expect.objectContaining({ name: 'a.pdf' })],
  }));
});

test('closing a written-in email asks before throwing it away', async () => {
  const onClose = jest.fn();
  const r = render(<MailCompose session={session} draft={{ kind: 'new' }} signature=""
                                onClose={onClose} onSent={() => {}} />);
  fireEvent.changeText(r.getByLabelText('Message'), 'half a thought');
  fireEvent.press(r.getByLabelText('Close'));
  expect(onClose).not.toHaveBeenCalled();
  expect(alerts.calls[0].title).toBe('Discard this email?');
  await act(async () => { await pressAlertButton('Discard'); });
  expect(onClose).toHaveBeenCalled();
});

test('closing an untouched email just closes', () => {
  const onClose = jest.fn();
  const r = render(<MailCompose session={session} draft={{ kind: 'new' }} signature=""
                                onClose={onClose} onSent={() => {}} />);
  fireEvent.press(r.getByLabelText('Close'));
  expect(onClose).toHaveBeenCalled();
  expect(alerts.calls).toHaveLength(0);
});
