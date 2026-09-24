// Parity with the web's Mail work of 23 Sept 2026, on the phone.
//
// Amit, 24 Sept: "search in mail, reply in reply, fix all the things that
// fixed in web version yesterday". Two screens changed: the message screen
// answers a message INSIDE it (one response box, Reply / Reply all / Forward
// switching in place, the rest of the conversation above), and the list
// screen puts the web's search help and advanced form around the box.

const { mailApi } = require('./mailMocks');
const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react-native');

const MailMessage = require('../screens/MailMessage').default;
const Mail = require('../screens/Mail').default;

const session = { accessToken: 'AT' };
const inbox = { id: 'f1', name: 'Inbox', slug: 'inbox', unreadCount: 0 };

const msg = (over = {}) => ({
  id: 'm1', folderId: 'f1', threadId: 't1',
  from: { name: 'Ravi Kumar', email: 'ravi@example.com' },
  to: [{ email: 'amit@tatvaos.com' }, { email: 'priya@example.com' }],
  cc: [{ email: 'accounts@example.com' }],
  subject: 'Invoice for August', snippet: 'Please find attached',
  bodyText: 'Please find attached the invoice.', bodyHtml: '<p>Please find attached the invoice.</p>',
  receivedAt: '2026-09-23T10:00:00Z', sentAt: '2026-09-23T10:00:00Z', isRead: true, isFlagged: false,
  attachments: [], ...over,
});

beforeEach(() => {
  mailApi.getMessage = jest.fn(async () => msg());
  mailApi.setRead = jest.fn(async () => ({}));
  mailApi.send = jest.fn(async () => ({ id: 'sent1' }));
  mailApi.threadMessages = jest.fn(async () => [
    { id: 'm0', from: { name: 'Amit', email: 'amit@tatvaos.com' }, subject: 'Invoice for August', snippet: 'Sending the PO', receivedAt: '2026-09-22T09:00:00Z' },
    msg(),
    { id: 'm2', from: { name: 'Priya', email: 'priya@example.com' }, subject: 'Re: Invoice', snippet: 'Looks right to me', receivedAt: '2026-09-23T11:00:00Z' },
  ]);
  mailApi.bootstrap = jest.fn(async () => ({ mailbox: { id: 'mb1', address: 'amit@tatvaos.com' }, folders: [inbox], signature: '' }));
  mailApi.listMessages = jest.fn(async () => ({ total: 0, messages: [] }));
  mailApi.searchMessages = jest.fn(async () => ({ total: 0, messages: [] }));
  mailApi.listMailboxes = jest.fn(async () => [{ id: 'mb1', address: 'amit@tatvaos.com', label: 'My mailbox', isOwn: true, permissions: ['full'], canRead: true, canSend: true }]);
});

const openMessage = async (props = {}) => {
  const r = render(
    <MailMessage session={session} messageId="m1" myAddress="amit@tatvaos.com" signature="— Amit"
                 onBack={() => {}} onReply={() => {}} onChanged={() => {}} onOpen={() => {}} onSent={() => {}} {...props} />,
  );
  await waitFor(() => expect(r.getByLabelText('Reply')).toBeTruthy());
  return r;
};

describe('reply in reply — the conversation', () => {
  test('the other messages in the thread are shown, and one can be opened', async () => {
    const onOpen = jest.fn();
    const r = await openMessage({ onOpen });
    await waitFor(() => expect(r.getByText('2 other messages in this conversation')).toBeTruthy());
    // The message being read is NOT listed among "the others".
    expect(r.queryByLabelText(/Open the message from Ravi Kumar/)).toBeNull();
    fireEvent.press(r.getByLabelText(/Open the message from Priya/));
    expect(onOpen).toHaveBeenCalledWith('m2');
    expect(mailApi.threadMessages).toHaveBeenCalledWith('AT', 't1', null);
  });

  test('a message with no thread shows no strip', async () => {
    mailApi.getMessage = jest.fn(async () => msg({ threadId: null }));
    const r = await openMessage();
    expect(r.queryByText(/other message/)).toBeNull();
    expect(mailApi.threadMessages).not.toHaveBeenCalled();
  });
});

describe('reply in reply — the response box', () => {
  test('Reply opens the box addressed to the sender; the quote goes under the typed text', async () => {
    const onSent = jest.fn();
    const r = await openMessage({ onSent });
    fireEvent.press(r.getByLabelText('Reply'));
    expect(r.getByText(/To: ravi@example.com/)).toBeTruthy();
    fireEvent.changeText(r.getByLabelText('Your reply'), 'Thanks, received.');
    await act(async () => { fireEvent.press(r.getByLabelText('Send reply')); });

    expect(mailApi.send).toHaveBeenCalledTimes(1);
    const [, fields] = mailApi.send.mock.calls[0];
    expect(fields.to).toBe('ravi@example.com');
    expect(fields.cc).toBe('');
    expect(fields.subject).toBe('Re: Invoice for August');
    expect(fields.inReplyToId).toBe('m1');
    expect(fields.bodyText).toMatch(/^Thanks, received\./);
    expect(fields.bodyText).toMatch(/— Amit/);
    expect(fields.bodyText).toMatch(/Ravi Kumar wrote:\n> Please find attached the invoice\./);
    expect(onSent).toHaveBeenCalled();
    // The box closes after sending.
    expect(r.queryByLabelText('Send reply')).toBeNull();
  });

  test('switching Reply → Reply all recomputes recipients and KEEPS what was typed', async () => {
    const r = await openMessage();
    fireEvent.press(r.getByLabelText('Reply'));
    fireEvent.changeText(r.getByLabelText('Your reply'), 'draft text');
    fireEvent.press(r.getByLabelText('Reply all'));
    expect(r.getByText(/To: ravi@example.com/)).toBeTruthy();
    // Me is left out; the other To and the Cc are copied.
    expect(r.getByText('Cc: priya@example.com, accounts@example.com')).toBeTruthy();
    expect(r.getByLabelText('Your reply').props.value).toBe('draft text');
    await act(async () => { fireEvent.press(r.getByLabelText('Send reply')); });
    const [, fields] = mailApi.send.mock.calls[0];
    expect(fields.cc).toBe('priya@example.com, accounts@example.com');
    expect(fields.inReplyToId).toBe('m1');
  });

  test('Forward asks who to, carries the web header, and is NOT a reply', async () => {
    const r = await openMessage();
    fireEvent.press(r.getByLabelText('Forward'));
    await act(async () => { fireEvent.press(r.getByLabelText('Send forward')); });
    expect(r.getByText('Say who to forward this to.')).toBeTruthy();
    expect(mailApi.send).not.toHaveBeenCalled();

    fireEvent.changeText(r.getByLabelText('Forward to'), 'suresh@example.com');
    await act(async () => { fireEvent.press(r.getByLabelText('Send forward')); });
    const [, fields] = mailApi.send.mock.calls[0];
    expect(fields.to).toBe('suresh@example.com');
    expect(fields.subject).toBe('Fwd: Invoice for August');
    expect(fields.inReplyToId).toBeUndefined();
    expect(fields.bodyText).toMatch(/---------- Forwarded message ----------\nFrom: Ravi Kumar/);
    expect(fields.bodyText).toMatch(/\nDate: /);
    expect(fields.bodyText).toMatch(/\nCc: accounts@example.com\n/);
    expect(fields.bodyText).toMatch(/Please find attached the invoice\.$/);
  });

  test('an empty reply is refused before any request; the server sentence is shown on failure', async () => {
    const r = await openMessage();
    fireEvent.press(r.getByLabelText('Reply'));
    await act(async () => { fireEvent.press(r.getByLabelText('Send reply')); });
    expect(r.getByText('Write something first.')).toBeTruthy();
    expect(mailApi.send).not.toHaveBeenCalled();

    mailApi.send = jest.fn(async () => { throw new Error('This message is over the 25 MB limit.'); });
    fireEvent.changeText(r.getByLabelText('Your reply'), 'x');
    await act(async () => { fireEvent.press(r.getByLabelText('Send reply')); });
    expect(r.getByText('This message is over the 25 MB limit.')).toBeTruthy();
  });

  test('the full editor is one tap away and receives the text so far', async () => {
    const onReply = jest.fn();
    const r = await openMessage({ onReply });
    fireEvent.press(r.getByLabelText('Reply all'));
    fireEvent.changeText(r.getByLabelText('Your reply'), 'longer thing');
    fireEvent.press(r.getByLabelText('Open in the full editor'));
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ kind: 'replyAll', body: 'longer thing' }));
  });
});

describe('search, the way the web searches', () => {
  const openList = async () => {
    const r = render(<Mail session={session} onBack={() => {}} onOpen={() => {}} onCompose={() => {}} />);
    await waitFor(() => expect(r.getByLabelText('Search help')).toBeTruthy());
    return r;
  };

  test('the help lists the operators the server knows, and a tap adds one', async () => {
    const r = await openList();
    fireEvent.press(r.getByLabelText('Search help'));
    expect(r.getByText('has:attachment')).toBeTruthy();
    expect(r.getByText(/Deleted and junk mail stay out/)).toBeTruthy();
    fireEvent.press(r.getByLabelText('Add is:unread'));
    expect(r.getByLabelText('Search mail').props.value).toBe('is:unread');
  });

  test('the advanced form writes the query and runs it', async () => {
    const r = await openList();
    fireEvent.press(r.getByLabelText('Advanced search'));
    fireEvent.changeText(r.getByLabelText('From'), 'priya');
    fireEvent.changeText(r.getByLabelText('Subject'), 'q3 report');
    fireEvent(r.getByLabelText('Unread only'), 'valueChange', true);
    fireEvent.press(r.getByLabelText('Search in: Inbox'));
    // Shown before it runs, and a multi-word value is grouped, not quoted.
    expect(r.getByText('from:priya subject:(q3 report) in:inbox is:unread')).toBeTruthy();
    await act(async () => { fireEvent.press(r.getByLabelText('Run this search')); });
    expect(mailApi.searchMessages).toHaveBeenCalledWith('AT', 'from:priya subject:(q3 report) in:inbox is:unread', expect.anything());
  });

  test('a search with operators shows chips and the trash note; one that asks for trash does not', async () => {
    const r = await openList();
    const box = r.getByLabelText('Search mail');
    fireEvent.changeText(box, 'from:priya has:attachment');
    await act(async () => { fireEvent(box, 'submitEditing'); });
    expect(r.getByText('from priya')).toBeTruthy();
    expect(r.getByText('has attachment')).toBeTruthy();
    expect(r.getByText(/stay out unless you add in:trash/)).toBeTruthy();

    fireEvent.changeText(box, 'from:priya in:trash');
    await act(async () => { fireEvent(box, 'submitEditing'); });
    expect(r.queryByText(/stay out unless/)).toBeNull();
  });
});
