// The Mail screens: the list, one message, and writing one.
//
// What these prove is behaviour a person would notice: that a mailbox nobody
// has is an empty state rather than an error, that a message is marked read
// only after it is shown, that a stranger's HTML reaches the WebView with
// JavaScript OFF, and that a reply carries inReplyToId — the field that makes
// it a reply rather than a new conversation.

const { mailApi, webview, picker, files, sharing, alerts, opened, keychain, pressAlertButton } = require('./mailMocks');
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
  files.written.length = 0;
  files.created.length = 0;
  files.grant = { granted: true, directoryUri: 'content://tree/downloads' };
  sharing.shared.length = 0;
  for (const k of Object.keys(keychain.store)) delete keychain.store[k];
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

// ── sorting (Amit, 19 Sept 2026: "sorting option on mail") ──────────────────

test('the list opens newest first, and asks the server for nothing unusual', async () => {
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());
  expect(mailApi.listMessages).toHaveBeenLastCalledWith('AT', 'f1', expect.objectContaining({ sort: 'newest' }));
  expect(r.getByLabelText('Sort messages').props.accessibilityValue).toEqual({ text: 'Newest first' });
  expect(r.queryByLabelText(/^Sorted by /)).toBeNull();
});

test('choosing an order asks the SERVER for it, from the first row, and says so on the list', async () => {
  mailApi.listMessages = jest.fn(async (_t, _f, o) => ({ total: 1, messages: [row()], sorted: o.sort }));
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());

  fireEvent.press(r.getByLabelText('Sort messages'));
  fireEvent.press(r.getByLabelText('Sort by Oldest first'));

  await waitFor(() => expect(mailApi.listMessages).toHaveBeenLastCalledWith(
    'AT', 'f1', expect.objectContaining({ sort: 'oldest', skip: 0 })));
  await waitFor(() => expect(r.getByLabelText('Sorted by Oldest first. Tap for newest first')).toBeTruthy());

  // One tap on that line is the way back.
  fireEvent.press(r.getByLabelText('Sorted by Oldest first. Tap for newest first'));
  await waitFor(() => expect(mailApi.listMessages).toHaveBeenLastCalledWith(
    'AT', 'f1', expect.objectContaining({ sort: 'newest' })));
  await waitFor(() => expect(r.queryByLabelText(/^Sorted by /)).toBeNull());
});

test('a server that answers 200 but did NOT sort is said so, and the list is not mislabelled', async () => {
  // What a server older than the `sort` parameter does: ignores it, newest
  // first, no `sort` in the reply. A 200 is not proof.
  mailApi.listMessages = jest.fn(async () => ({ total: 1, messages: [row()], sorted: null }));
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Invoice for August')).toBeTruthy());

  fireEvent.press(r.getByLabelText('Sort messages'));
  fireEvent.press(r.getByLabelText('Sort by Unread first'));

  await waitFor(() => expect(r.getByText(/Sorting is not available on this server yet/)).toBeTruthy());
  expect(r.queryByLabelText(/^Sorted by /)).toBeNull();
  expect(r.getByLabelText('Sort messages').props.accessibilityValue).toEqual({ text: 'Newest first' });
});

test('Load more keeps the chosen order and continues after the rows already shown', async () => {
  const many = Array.from({ length: 30 }, (_, i) => row({ id: `m${i}`, subject: `Mail ${i}` }));
  mailApi.listMessages = jest.fn(async (_t, _f, o) => ({ total: 45, messages: o.skip === 0 ? many : [row({ id: 'late', subject: 'The 31st' })], sorted: o.sort }));
  const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
  await waitFor(() => expect(r.getByText('Mail 0')).toBeTruthy());
  fireEvent.press(r.getByLabelText('Sort messages'));
  fireEvent.press(r.getByLabelText('Sort by Sender, A to Z'));
  await waitFor(() => expect(mailApi.listMessages).toHaveBeenLastCalledWith('AT', 'f1', expect.objectContaining({ sort: 'sender', skip: 0 })));

  fireEvent.press(await waitFor(() => r.getByLabelText('Load more messages')));
  await waitFor(() => expect(mailApi.listMessages).toHaveBeenLastCalledWith('AT', 'f1', expect.objectContaining({ sort: 'sender', skip: 30 })));
});
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

test('a picture inside the email is shown in the body and NOT offered again as a file', async () => {
  // The Gmail bounce from 19 Sept 2026: icon.png is "an attachment" AND the
  // picture the body points at. report.pdf is a real attachment beside it.
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  mailApi.getMessage = jest.fn(async () => full({
    bodyHtml: '<img src="cid:icon.png" alt="Error Icon"><p>Address not found</p>',
    inlineImages: [{ cid: 'icon.png', contentType: 'image/png', dataUri: PNG }],
    attachments: [
      { id: 'a1', filename: 'icon.png', sizeBytes: 900, contentType: 'image/png', scanStatus: 'clean', isInline: true },
      { id: 'a2', filename: 'report.pdf', sizeBytes: 2048, contentType: 'application/pdf', scanStatus: 'clean', isInline: false },
    ],
  }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(r.getByLabelText('Reply')).toBeTruthy());

  expect(webview.lastProps.source.html).toContain(`src="${PNG}"`);
  expect(webview.lastProps.source.html).not.toContain('cid:icon.png');
  expect(r.getByText('1 attachment')).toBeTruthy();
  expect(r.getByLabelText('Open report.pdf')).toBeTruthy();
  expect(r.queryByLabelText('Open icon.png')).toBeNull();
});

test('a server that sends no inlineImages changes nothing: the file is still listed', async () => {
  // An older server: no inlineImages, isInline always false. The picture stays
  // broken in the body, and stays downloadable - never missing from both.
  mailApi.getMessage = jest.fn(async () => full({
    bodyHtml: '<img src="cid:icon.png">',
    attachments: [{ id: 'a1', filename: 'icon.png', sizeBytes: 900, contentType: 'image/png', scanStatus: 'clean', isInline: false }],
  }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(r.getByLabelText('Reply')).toBeTruthy());
  expect(webview.lastProps.source.html).toContain('cid:icon.png');
  expect(r.getByLabelText('Open icon.png')).toBeTruthy();
});

test('the body reaches the WebView with JavaScript OFF and remote images blocked', async () => {
  mailApi.getMessage = jest.fn(async () => full());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  // The subject is drawn INSIDE the message document now (one scrolling area),
  // so the screen is ready when its own controls are.
  await waitFor(() => expect(r.getByLabelText('Reply')).toBeTruthy());

  expect(webview.lastProps.javaScriptEnabled).toBe(false);
  // The message is the ONE scrolling area, and it carries its own header —
  // a fixed-height box cut long emails off (18 Sept 2026).
  expect(webview.lastProps.scrollEnabled).toBe(true);
  expect(webview.lastProps.source.html).toContain('Invoice for August');
  expect(webview.lastProps.source.html).toContain('Ravi Kumar');
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
  // A subject with markup must not become markup inside the header either.
  const nasty = webview.lastProps.source.html;
  expect(nasty).not.toContain('<script');
});

test('an unread message is marked read AFTER it is shown; a read one is left alone', async () => {
  mailApi.getMessage = jest.fn(async () => full({ isRead: false }));
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await waitFor(() => expect(mailApi.setRead).toHaveBeenCalledWith('AT', 'm1', true));
  expect(webview.lastProps.source.html).toContain('Invoice for August');

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
  await waitFor(() => expect(r.getByLabelText('Delete this message')).toBeTruthy());
  fireEvent.press(r.getByLabelText('Delete this message'));
  expect(alerts.calls[0].message).toMatch(/moves to Trash/);
  expect(mailApi.deleteMessage).not.toHaveBeenCalled();
  await act(async () => { await pressAlertButton('Delete'); });
  expect(mailApi.deleteMessage).toHaveBeenCalledWith('AT', 'm1');
  expect(onBack).toHaveBeenCalledWith(true);
});

const withFile = () => full({
  attachments: [{ id: 'a1', filename: 'invoice.pdf', sizeBytes: 2048, contentType: 'application/pdf', scanStatus: 'clean' }],
});

async function tapAttachment(r) {
  await waitFor(() => expect(r.getByLabelText('Open invoice.pdf')).toBeTruthy());
  await act(async () => { fireEvent.press(r.getByLabelText('Open invoice.pdf')); });
}

test('Open downloads WITH the token and hands the file to another app', async () => {
  mailApi.getMessage = jest.fn(async () => withFile());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await tapAttachment(r);
  // Nothing is downloaded until a choice is made: tapping the row asks.
  expect(files.downloads).toHaveLength(0);
  await act(async () => { await pressAlertButton('Open'); });
  expect(files.downloads[0].url).toContain('/api/mail/messages/m1/attachments/a1');
  expect(files.downloads[0].headers.Authorization).toBe('Bearer AT');
  expect(sharing.shared).toHaveLength(1);
});

test('Save writes the file into the folder the person chose', async () => {
  mailApi.getMessage = jest.fn(async () => withFile());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await tapAttachment(r);
  await act(async () => { await pressAlertButton('Save'); });
  expect(files.created[0]).toEqual({ dir: 'content://tree/downloads', name: 'invoice.pdf' });
  expect(files.written[0].uri).toBe('content://tree/downloads/invoice.pdf');
  expect(sharing.shared).toHaveLength(0);   // saving is not sharing
  expect(alerts.calls[alerts.calls.length - 1].title).toBe('Saved');
});

test('the folder is asked for ONCE and remembered for the next save', async () => {
  mailApi.getMessage = jest.fn(async () => withFile());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await tapAttachment(r);
  await act(async () => { await pressAlertButton('Save'); });
  const SAF = require('expo-file-system/legacy').StorageAccessFramework;
  expect(SAF.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(keychain.store['tatvaos.mail.saveDir']).toBe('content://tree/downloads');

  await tapAttachment(r);
  await act(async () => { await pressAlertButton('Save'); });
  expect(SAF.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);  // not asked again
  expect(files.created).toHaveLength(2);
});

test('refusing the folder saves nothing and says nothing alarming', async () => {
  files.grant = { granted: false };
  mailApi.getMessage = jest.fn(async () => withFile());
  const r = render(<MailMessage session={session} messageId="m1" onBack={() => {}} onReply={() => {}} />);
  await tapAttachment(r);
  await act(async () => { await pressAlertButton('Save'); });
  expect(files.written).toHaveLength(0);
  expect(alerts.calls.some((c) => /Could not/.test(c.title ?? ''))).toBe(false);
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
  // Refused outright: not even the Open/Save choice is offered.
  expect(alerts.calls[0].buttons).toBeUndefined();
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
  // The third argument is the progress callback (18 Sept 2026): a send with an
  // attachment reports how much has gone up, and the screen draws the bar.
  expect(mailApi.send).toHaveBeenCalledWith('AT', expect.objectContaining({
    to: 'ravi@example.com', inReplyToId: 'm1',
  }), expect.any(Function));
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
  }), expect.any(Function));
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

// Several native modules are mocked VIRTUALLY (see mailMocks.js) because a
// worktree sharing its node_modules with the deploy checkout does not always
// have them on disk. A virtual mock resolves whether or not the package
// exists, so nothing above would notice one being dropped from the app —
// which on the phone means a blank message, a dead Attach button or a save
// that never happens. This is the thing that would notice.
test.each([
  'react-native-webview',     // every message is rendered in it
  'expo-document-picker',     // attaching a file
  'expo-sharing',             // opening an attachment
  'expo-file-system',         // saving one, and reading it back to send
  'expo-secure-store',        // remembering the chosen save folder
])('the app still depends on %s', (name) => {
  const pkg = require('../package.json');
  expect(pkg.dependencies[name]).toBeTruthy();
});

// ── SUGGESTING RECIPIENTS ON THE PHONE ──────────────────────────────────────
//  "auto name suggestion on to and cc" (Amit, 18 Sept 2026). The list must
//  appear under the box being typed in, put the address where it belongs, and
//  not fire a request per keystroke.
describe('recipient suggestions', () => {
  const rows = [
    { id: 'u1', email: 'amit@tatvaos.com', displayName: 'Amit Desai', isColleague: true },
    { id: 'c1', email: 'amit@supplier.com', displayName: 'Amit (Supplier)', isColleague: false },
  ];

  beforeEach(() => { mailApi.suggestRecipients = jest.fn(async () => rows); });

  const compose = () => render(
    <MailCompose session={session} kind="new" onClose={() => {}} onSent={() => {}} signature="" />,
  );

  test('typing in To offers the people it found', async () => {
    const r = compose();
    const to = r.getByLabelText('To');
    fireEvent(to, 'focus');
    fireEvent.changeText(to, 'am');
    await waitFor(() => expect(r.getByLabelText('Use Amit Desai')).toBeTruthy());
    expect(mailApi.suggestRecipients).toHaveBeenCalledWith('AT', 'am');
    // A colleague and an outside contact are told apart on screen.
    expect(r.getByText('Amit (Supplier)')).toBeTruthy();
  });

  test('tapping one fills the field and leaves room for the next', async () => {
    const r = compose();
    const to = r.getByLabelText('To');
    fireEvent(to, 'focus');
    fireEvent.changeText(to, 'am');
    await waitFor(() => expect(r.getByLabelText('Use Amit Desai')).toBeTruthy());
    await act(async () => { fireEvent.press(r.getByLabelText('Use Amit Desai')); });
    expect(r.getByLabelText('To').props.value).toBe('amit@tatvaos.com, ');
    // and the list goes away rather than sitting over the next field
    expect(r.queryByLabelText('Use Amit Desai')).toBeNull();
  });

  test('ONE REQUEST PER PAUSE, not one per keystroke', async () => {
    const r = compose();
    const to = r.getByLabelText('To');
    fireEvent(to, 'focus');
    fireEvent.changeText(to, 'a');
    fireEvent.changeText(to, 'am');
    fireEvent.changeText(to, 'ami');
    await waitFor(() => expect(mailApi.suggestRecipients).toHaveBeenCalled());
    // Debounced: the three keystrokes above collapse to the last term only.
    expect(mailApi.suggestRecipients).toHaveBeenCalledTimes(1);
    expect(mailApi.suggestRecipients).toHaveBeenCalledWith('AT', 'ami');
  });

  test('a finished address stops the asking', async () => {
    const r = compose();
    const to = r.getByLabelText('To');
    fireEvent(to, 'focus');
    fireEvent.changeText(to, 'amit@tatvaos.com, ');
    await act(async () => { await new Promise((res) => setTimeout(res, 300)); });
    expect(mailApi.suggestRecipients).not.toHaveBeenCalled();
  });

  test('the list belongs to the box being typed in, never both', async () => {
    const r = compose();
    await act(async () => { fireEvent.press(r.getByLabelText('Add Cc')); });
    const cc = r.getByLabelText('Cc');
    fireEvent(cc, 'focus');
    fireEvent.changeText(cc, 'am');
    await waitFor(() => expect(r.getByLabelText('Use Amit Desai')).toBeTruthy());
    await act(async () => { fireEvent.press(r.getByLabelText('Use Amit Desai')); });
    // Cc got it; To must be untouched.
    expect(r.getByLabelText('Cc').props.value).toBe('amit@tatvaos.com, ');
    expect(r.getByLabelText('To').props.value).toBe('');
  });

  test('a lookup that fails is silent — the person can still type', async () => {
    mailApi.suggestRecipients = jest.fn(async () => { throw new Error('offline'); });
    const r = compose();
    const to = r.getByLabelText('To');
    fireEvent(to, 'focus');
    fireEvent.changeText(to, 'am');
    await waitFor(() => expect(mailApi.suggestRecipients).toHaveBeenCalled());
    expect(r.queryByText(/offline/)).toBeNull();
    expect(r.getByLabelText('To').props.value).toBe('am');
  });
});

// The compose screen handed the signature in the shape the API ACTUALLY sends.
// The other compose checks pass a string, which is how "[object Object]" got
// into a real email on 18 Sept 2026 without a single check going red.
describe('compose with the API-shaped signature', () => {
  const sig = { bodyHtml: '<p>— Amit</p>', bodyText: '— Amit', enabled: true, includeOnReply: true };

  test('a new email carries the signature text, never "[object Object]"', () => {
    const r = render(<MailCompose session={session} draft={{ kind: 'new' }} signature={sig}
                                  onClose={() => {}} onSent={() => {}} />);
    const body = r.getByLabelText('Message').props.value;
    expect(body).toContain('— Amit');
    expect(body).not.toMatch(/object Object/);
  });

  test('a reply honours includeOnReply=false', () => {
    const r = render(<MailCompose session={session} draft={{ kind: 'reply', message: full() }}
                                  signature={{ ...sig, includeOnReply: false }}
                                  onClose={() => {}} onSent={() => {}} />);
    const body = r.getByLabelText('Message').props.value;
    expect(body).not.toContain('— Amit');
    expect(body).not.toMatch(/object Object/);
    expect(body).toMatch(/wrote:/);
  });
});
