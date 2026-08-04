import type { Folder, Mailbox, Message, Session, Tenant } from '@tatvaos/types';

/**
 * Mock data layer.
 *
 * The API does not exist yet, so the web app runs against this. It mirrors the
 * seeded local database exactly - same tenants, same addresses - so switching
 * to the real API is a change of data source, not a change of shape.
 *
 * DELETE THIS when packages/api-client lands. Nothing else should import it.
 */

export const MOCK_TENANT: Tenant = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Techvein',
  status: 'active',
};

export const MOCK_MAILBOX: Mailbox = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  tenantId: MOCK_TENANT.id,
  address: 'amit@techvein.local',
  displayName: 'Amit Dadhich',
  type: 'user',
  quotaBytes: 15 * 1024 * 1024 * 1024,
  usedBytes: 4.2 * 1024 * 1024 * 1024,
};

export const MOCK_SESSION: Session = {
  userId: 'bbbbbbbb-0000-0000-0000-000000000001',
  tenantId: MOCK_TENANT.id,
  tenantName: MOCK_TENANT.name,
  mailbox: MOCK_MAILBOX,
  role: 'org_owner',
};

export const MOCK_FOLDERS: Folder[] = [
  { id: 'f-inbox',  mailboxId: MOCK_MAILBOX.id, name: 'Inbox',   specialUse: '\\Inbox',  unreadCount: 6, totalCount: 24 },
  { id: 'f-sent',   mailboxId: MOCK_MAILBOX.id, name: 'Sent',    specialUse: '\\Sent',   unreadCount: 0, totalCount: 12 },
  { id: 'f-drafts', mailboxId: MOCK_MAILBOX.id, name: 'Drafts',  specialUse: '\\Drafts', unreadCount: 0, totalCount: 2 },
  { id: 'f-junk',   mailboxId: MOCK_MAILBOX.id, name: 'Junk',    specialUse: '\\Junk',   unreadCount: 3, totalCount: 8 },
  { id: 'f-trash',  mailboxId: MOCK_MAILBOX.id, name: 'Trash',   specialUse: '\\Trash',  unreadCount: 0, totalCount: 5 },
];

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function msg(p: Partial<Message> & Pick<Message, 'id' | 'from' | 'subject' | 'snippet'>): Message {
  return {
    tenantId: MOCK_TENANT.id,
    mailboxId: MOCK_MAILBOX.id,
    folderId: 'f-inbox',
    threadId: null,
    to: [{ name: 'Amit Dadhich', email: 'amit@techvein.local' }],
    bodyText: p.snippet,
    sentAt: hoursAgo(2),
    receivedAt: hoursAgo(2),
    sizeBytes: 4200,
    isRead: true,
    isFlagged: false,
    hasAttachments: false,
    ...p,
  } as Message;
}

export const MOCK_MESSAGES: Message[] = [
  msg({
    id: 'm-001',
    from: { name: 'Priya Nair', email: 'priya@acmesupplies.in' },
    subject: 'Re: Purchase order PO-4471 — revised quantities',
    snippet:
      'Thanks Amit. I have updated the order to 240 units and pushed delivery to the 18th. Invoice attached.',
    sentAt: hoursAgo(0.4),
    receivedAt: hoursAgo(0.4),
    isRead: false,
    hasAttachments: true,
    threadId: 't-po4471',
    attachments: [
      { id: 'a-1', filename: 'invoice-4471.pdf', contentType: 'application/pdf', sizeBytes: 184_320, isInline: false },
    ],
    bodyHtml: `<p>Thanks Amit.</p>
      <p>I have updated the order to <strong>240 units</strong> and pushed delivery to the 18th.
      Invoice attached.</p>
      <p>Let me know if the revised schedule causes any problem at your end.</p>
      <p>Regards,<br>Priya Nair<br>Acme Supplies</p>
      <img src="https://tracker.example.com/pixel.gif?id=4471" width="1" height="1">`,
  }),
  msg({
    id: 'm-002',
    from: { name: 'Rahul Mehta', email: 'rahul@techvein.com' },
    subject: 'Standup notes — Tuesday',
    snippet: 'Short one today. Deployment went out at 09:20, no rollbacks. Two items need your call.',
    sentAt: hoursAgo(3),
    receivedAt: hoursAgo(3),
    isRead: false,
    bodyHtml: `<p>Short one today.</p>
      <ul><li>Deployment went out at 09:20, no rollbacks</li>
      <li>Two items need your call — pricing tiers and the migration cutover date</li></ul>
      <p>— Rahul</p>`,
  }),
  msg({
    id: 'm-003',
    from: { name: 'Linode Support', email: 'support@linode.com' },
    subject: '[Ticket #8821449] Request to lift outbound SMTP restrictions',
    snippet:
      'Thank you for contacting Akamai Cloud Support. We have received your request and are reviewing it.',
    sentAt: hoursAgo(5),
    receivedAt: hoursAgo(5),
    isRead: false,
    isFlagged: true,
  }),
  msg({
    id: 'm-004',
    from: { name: 'Sunita Rao', email: 'principal@abcschool.edu.in' },
    subject: 'Enquiry — email hosting for 60 staff accounts',
    snippet:
      'We are looking to move away from our current provider before the new academic year. Could you send pricing?',
    sentAt: hoursAgo(20),
    receivedAt: hoursAgo(20),
    isRead: false,
  }),
  msg({
    id: 'm-005',
    from: { name: 'Amit Dadhich', email: 'amit@techvein.local' },
    subject: 'Re: Purchase order PO-4471 — revised quantities',
    snippet: 'Priya — 240 works. The 18th is fine as long as the documentation ships with it.',
    sentAt: hoursAgo(1),
    receivedAt: hoursAgo(1),
    folderId: 'f-sent',
    threadId: 't-po4471',
    to: [{ name: 'Priya Nair', email: 'priya@acmesupplies.in' }],
  }),
  msg({
    id: 'm-006',
    from: { name: 'GST Portal', email: 'noreply@gst.gov.in' },
    subject: 'GSTR-3B filing due 20 August 2026',
    snippet: 'This is a reminder that your GSTR-3B return for July 2026 is due on 20 August 2026.',
    sentAt: hoursAgo(28),
    receivedAt: hoursAgo(28),
  }),
  msg({
    id: 'm-007',
    from: { name: 'Neha Kulkarni', email: 'neha@designstudio.co' },
    subject: 'Logo concepts — round 2',
    snippet: 'Three directions attached. My preference is the second, it reads better at small sizes.',
    sentAt: hoursAgo(30),
    receivedAt: hoursAgo(30),
    hasAttachments: true,
    attachments: [
      { id: 'a-2', filename: 'concepts-r2.pdf', contentType: 'application/pdf', sizeBytes: 2_411_724, isInline: false },
    ],
  }),
  msg({
    id: 'm-008',
    from: { email: 'winner@lottery-claim-now.biz' },
    subject: 'CONGRATULATIONS!!! YOU HAVE WON $5,000,000 USD',
    snippet: 'Dear Lucky Winner, your email address was selected in our international draw. Reply urgently.',
    sentAt: hoursAgo(9),
    receivedAt: hoursAgo(9),
    folderId: 'f-junk',
    isRead: false,
    bodyHtml: `<div style="background:#ff0;padding:20px">
      <h1 style="color:red">CONGRATULATIONS!!!</h1>
      <p>Click <a href="http://definitely-not-a-scam.example/claim">HERE</a> to claim.</p>
      <script>alert('this must never execute')</script>
      </div>`,
  }),
];

/** Simulated network latency, so loading states are visible during development. */
function delay<T>(value: T, ms = 180): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export const mockApi = {
  getSession: () => delay(MOCK_SESSION),
  getFolders: () => delay(MOCK_FOLDERS),
  getMessages: (folderId: string) =>
    delay(
      MOCK_MESSAGES.filter((m) => m.folderId === folderId).sort(
        (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
      ),
    ),
  getMessage: (id: string) => delay(MOCK_MESSAGES.find((m) => m.id === id) ?? null),
};
