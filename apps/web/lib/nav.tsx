import type { NavSection } from '@/components/shell/Sidebar';

// ============================================================================
//  Navigation
// ============================================================================
//
//  One definition, used by both consoles. Written here rather than inline in
//  each page so that adding a route means editing one file — the previous
//  version guessed an icon from the label, which worked until two labels
//  started with the same word.
//
//  Future products appear, disabled. That is deliberate: a customer looking at
//  the rail should be able to see that Drive and Payroll are coming without
//  being able to click into a screen that does not exist. Hiding them entirely
//  makes TatvaOS look like a mail product, which is precisely the impression
//  the Core/product split exists to avoid.
// ============================================================================

// `colour` paints an individual rail icon. The svg strokes with currentColor,
// so an inline colour on the element overrides the colour YZEN's stylesheet
// sets on the .side-menu__icon wrapper — none of those rules use !important,
// so the inline value wins cleanly and the label keeps the rail's own colour.
const Icon = ({ d, colour }: { d: string; colour?: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
       style={colour ? { color: colour } : undefined}>
    <path d={d} />
  </svg>
);

const PATHS = {
  dashboard: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z',
  building:  'M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 9h.01M15 9h.01M9 13h.01M15 13h.01',
  users:     'M17 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7M22 20v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  globe:     'M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18a15 15 0 010-18',
  database:  'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  card:      'M3 7h18v10H3zM3 11h18M7 15h3',
  // Shield-and-tick: the audit trail is read to answer "who did this", which
  // is a security question before it is an administrative one.
  audit:     'M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6l7-3zM9 12l2 2 4-4',
  inbox:     'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4v-6z',
  gear:      'M10.3 3h3.4l.5 2.3 1.9 1.1 2.2-.8 1.7 3-1.7 1.6v2.2l1.7 1.6-1.7 3-2.2-.8-1.9 1.1-.5 2.3h-3.4l-.5-2.3-1.9-1.1-2.2.8-1.7-3 1.7-1.6v-2.2L4 8.6l1.7-3 2.2.8 1.9-1.1.5-2.3zM12 14.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z',
  mail:      'M3 7l9 6 9-6M3 7h18v10H3z',
  drive:     'M12 3l8 14H4L12 3zM9 17l-3 4M15 17l3 4',
  // People, Payroll, Sheet and Word left the catalogue with their tiles —
  // when one is actually started, its path comes back in the same commit as
  // its product row. An icon for a product nobody is building is dead code.
  calendar:  'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4M8 14h3M8 17h3',
  connect:   'M3 7h11v10H3zM14 11l7-4v10l-7-4',
  // Mail folder icons for the shell rail (mailNav).
  sent: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  draft: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  junk: 'M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
  compose: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
};

// ============================================================================
//  The product rail — tier one of the navigation
// ============================================================================
//
//  One entry per product, plus the consoles. This is the list the narrow
//  coloured rail renders, and `match` is how it works out which entry owns the
//  current URL so the right one lights up.
//
//  Future products appear disabled rather than hidden. A customer looking at
//  the rail should be able to see that Drive and Payroll are coming without
//  being able to click into a screen that does not exist — hiding them makes
//  TatvaOS look like a mail product, which is exactly the impression the
//  Core/product split exists to avoid.
// ============================================================================
export interface RailProduct {
  code: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  live: boolean;
  /** Path prefixes this entry owns. */
  match: string[];
  /** Tile colour in the app launcher. Each product owns one, the way Gmail
   *  is red and Drive is green — it is how people find an app in a grid
   *  without reading. */
  colour: string;
}

export const RAIL_PRODUCTS: RailProduct[] = [
  { code: 'core', label: 'Core', href: '/org', icon: <Icon d={PATHS.building} />,
    live: true, colour: '#7367f0', match: ['/org', '/account'] },
  { code: 'mail', label: 'Mail', href: '/mail/inbox', icon: <Icon d={PATHS.mail} />,
    live: true, colour: '#ff4c51', match: ['/mail'] },
  { code: 'family', label: 'Family', href: '/family/contacts', icon: <Icon d={PATHS.users} />,
    live: true, colour: '#00b8d9', match: ['/family'] },
  // Product CODE stays 'drive' — the catalogue row, allocations and audit
  // entries were bought under that code — but the product's NAME is Space.
  { code: 'drive', label: 'Space', href: '/space/personal', icon: <Icon d={PATHS.drive} />,
    live: true, colour: '#28c76f', match: ['/space'] },
  // Being built. It stays in the grid because it is genuinely next and the
  // tile sets the expectation; products nobody has STARTED were removed —
  // a wall of greyed tiles reads as a suite that does not exist.
  { code: 'calendar', label: 'Calendar', href: '/calendar/week', icon: <Icon d={PATHS.calendar} />,
    live: true, colour: '#4285f4', match: ['/calendar'] },
  // Meetings. BUILT, not yet launched: live stays false until Core has read
  // the guest path line by line (brief §8). Flipping it is the launch switch
  // — it puts the tile in every person's launcher — so it belongs in the same
  // commit that deletes /connect/dev, and not before.
  //
  // Deep blue, sampled from the darkest stop of the mark's own gradient. NOT
  // the cyan end: that is #00b8d9, which is Family's exactly — and tile colour
  // is how people find an app in a grid without reading it, so two products
  // sharing one is the same as neither having one.
  { code: 'connect', label: 'Connect', href: '/connect', icon: <Icon d={PATHS.connect} />,
    live: false, colour: '#003cf0', match: ['/connect'] },
  // Techvein only. The panel it opens is a different world from a customer's,
  // which is why it sits apart at the end rather than among the products.
  { code: 'platform', label: 'Platform admin', href: '/admin',
    icon: <Icon d={PATHS.gear} />, live: true, colour: '#5c5c72', match: ['/admin'] },
];

/** Techvein running the platform. */
export function platformNav(): NavSection[] {
  return [
    {
      heading: 'Platform',
      items: [
        { href: '/admin', label: 'Dashboard', icon: <Icon d={PATHS.dashboard} /> },
        {
          href: '/admin/organisations',
          label: 'Organisations',
          icon: <Icon d={PATHS.building} />,
          children: [
            { href: '/admin/organisations', label: 'All organisations' },
            { href: '/admin/organisations/new', label: 'Onboard new' },
          ],
        },
        // High in the list on purpose. A sales queue buried under settings is a
        // sales queue nobody opens, and this one is what makes gating access on
        // domain verification defensible.
        { href: '/admin/drafts', label: 'Signups in progress', icon: <Icon d={PATHS.inbox} /> },
        { href: '/admin/plans', label: 'Plans', icon: <Icon d={PATHS.card} /> },
        { href: '/admin/storage', label: 'Storage', icon: <Icon d={PATHS.database} /> },
        { href: '/admin/settings', label: 'Settings', icon: <Icon d={PATHS.gear} /> },
      ],
    },
  ];
}

/** A customer administering their own organisation. */
export function organisationNav(): NavSection[] {
  return [
    {
      heading: 'Organisation',
      items: [
        { href: '/org', label: 'Dashboard', icon: <Icon d={PATHS.dashboard} /> },
        {
          href: '/org/users',
          label: 'People',
          icon: <Icon d={PATHS.users} />,
          children: [
            { href: '/org/users', label: 'All people' },
            { href: '/org/departments', label: 'Departments' },
          ],
        },
        { href: '/org/domains', label: 'Domains', icon: <Icon d={PATHS.globe} /> },
        { href: '/org/mailboxes', label: 'Shared mailboxes', icon: <Icon d={PATHS.mail} /> },
        { href: '/org/storage', label: 'Storage', icon: <Icon d={PATHS.database} /> },
        // Org-wide policy over what leaves by link. One switch today (Space's
        // public links); Connect's recording-retention choice lands here next,
        // which is why it is a page and not a checkbox on the Storage screen.
        { href: '/org/sharing', label: 'Sharing', icon: <Icon d={PATHS.sent} /> },
        { href: '/org/audit', label: 'Audit trail', icon: <Icon d={PATHS.audit} /> },
        { href: '/org/billing', label: 'Billing', icon: <Icon d={PATHS.card} /> },
      ],
    },
  ];
}


/** A person inside the Mail app.
 *
 *  Mail uses the same rail as the console — same markup, same collapse
 *  behaviour — just a different item list, so moving between products never
 *  changes the shape of the navigation. Icons are individually coloured: at
 *  4rem collapsed the icon IS the item, and colour is what makes one findable
 *  at a glance when the labels are hidden.
 *
 *  Compose is an action rather than a destination, so it links to the inbox
 *  with ?compose=1 and the mail page opens the composer and tidies the URL.
 *  That keeps it a real link — middle-click and deep-link both behave.
 */
export function mailNav(): NavSection[] {
  return [
    {
      heading: 'Mail',
      items: [
        { href: '/mail/inbox?compose=1', label: 'Compose', icon: <Icon d={PATHS.compose} colour="#03b562" /> },
        { href: '/mail/inbox', label: 'Inbox', icon: <Icon d={PATHS.inbox} colour="#0fbcf9" /> },
        { href: '/mail/drafts', label: 'Drafts', icon: <Icon d={PATHS.draft} colour="#ffa909" /> },
        { href: '/mail/sent', label: 'Sent', icon: <Icon d={PATHS.sent} colour="#7367f0" /> },
        { href: '/mail/junk', label: 'Junk', icon: <Icon d={PATHS.junk} colour="#fd4963" /> },
        { href: '/mail/trash', label: 'Trash', icon: <Icon d={PATHS.trash} colour="#98a2b8" /> },
      ],
    },
    {
      heading: 'Settings',
      items: [
        // Mail's own settings — signature, and the per-mailbox preferences.
        // This pointed at /account, which is the PERSONAL hub: password,
        // devices, the accounts on this browser. Someone in their inbox
        // looking for "Settings" wants their signature and their filters, the
        // way Gmail's gear behaves. The personal hub is reachable from the
        // avatar menu and the app launcher instead.
        { href: '/mail/settings', label: 'Settings', icon: <Icon d={PATHS.gear} colour="#00cfe8" /> },
        { href: '/mail/filters', label: 'Filters and blocking', icon: <Icon d={PATHS.junk} colour="#fd4963" /> },
      ],
    },
  ];
}

// ============================================================================
//  Calendar.
// ============================================================================
export function calendarNav(): NavSection[] {
  return [
    {
      heading: 'Calendar',
      items: [
        { href: '/calendar/day', label: 'Day', icon: <Icon d={PATHS.calendar} colour="#4285f4" /> },
        { href: '/calendar/week', label: 'Week', icon: <Icon d={PATHS.calendar} colour="#03b562" /> },
        { href: '/calendar/month', label: 'Month', icon: <Icon d={PATHS.calendar} colour="#7367f0" /> },
        { href: '/calendar/agenda', label: 'Agenda', icon: <Icon d={PATHS.inbox} colour="#ffa909" /> },
      ],
    },
  ];
}

// ============================================================================
//  Connect — meetings.
//
//  "New meeting" is an action rather than a destination, so it is a real link
//  to a real page (/connect/new) instead of a button that opens a modal from
//  the rail. Middle-click and deep-link both behave, which is the same reason
//  Mail's Compose links to ?compose=1 rather than firing a handler.
//
//  There is no "Join" item. Joining starts from a link somebody sent you or
//  from the code box on /connect — a rail entry for it would be a rail entry
//  that always leads to the same empty field.
// ============================================================================
export function connectNav(): NavSection[] {
  return [
    {
      heading: 'Connect',
      items: [
        { href: '/connect/new', label: 'New meeting', icon: <Icon d={PATHS.compose} colour="#03b562" /> },
        { href: '/connect', label: 'Meetings', icon: <Icon d={PATHS.connect} colour="#003cf0" /> },
      ],
    },
  ];
}

// ============================================================================
//  Space — file storage.
// ============================================================================
export function spaceNav(): NavSection[] {
  return [
    {
      heading: 'Space',
      items: [
        { href: '/space/personal', label: 'My Space', icon: <Icon d={PATHS.draft} colour="#0fbcf9" /> },
        { href: '/space/organisational', label: 'Organisation', icon: <Icon d={PATHS.inbox} colour="#7367f0" /> },
        { href: '/space/shared', label: 'Shared with me', icon: <Icon d={PATHS.sent} colour="#03b562" /> },
        { href: '/space/trash', label: 'Trash', icon: <Icon d={PATHS.trash} colour="#98a2b8" /> },
      ],
    },
  ];
}

// ============================================================================
//  Family — the address book.
//
//  Modelled on what people already know from Google Contacts, because an
//  address book is not the place to teach someone a new mental model. The
//  names are theirs; what sits behind each one is ours:
//
//    Contacts        everything you can see, yours and the organisation's
//    Directory       the organisation's shared contacts
//    Frequent        sorted by how often you have actually corresponded
//    Other contacts  the ones mail saved for you, which you never typed
//    Bin             soft-deleted, restorable
//
//  Each is a REAL PATH, not a query string. The rail decides what is active by
//  pathname alone, so five links to /family/contacts?view=… would all light up
//  at once.
//
//  Merge is listed and disabled. It is the one operation with no server behind
//  it yet, and a menu that hides unfinished work is a menu that gets the same
//  feature requested three times.
// ============================================================================

export function familyNav(opts: {
  total?: number;
  labels?: { id: string; name: string; colour: string | null }[];
} = {}): NavSection[] {
  const { total, labels = [] } = opts;

  const sections: NavSection[] = [
    {
      heading: 'Family',
      items: [
        { href: '/family/contacts?create=1', label: 'Create contact',
          icon: <Icon d={PATHS.compose} colour="#03b562" /> },
        { href: '/family/contacts', label: 'Contacts',
          icon: <Icon d={PATHS.users} colour="#00b8d9" />,
          badge: total !== undefined && total > 0 ? String(total) : undefined },
        { href: '/family/directory', label: 'Directory',
          icon: <Icon d={PATHS.building} colour="#7367f0" /> },
        { href: '/family/frequent', label: 'Frequent',
          icon: <Icon d={PATHS.sent} colour="#ffa909" /> },
        { href: '/family/other', label: 'Other contacts',
          icon: <Icon d={PATHS.inbox} colour="#98a2b8" /> },
      ],
    },
    {
      heading: 'Fix and manage',
      items: [
        { href: '/family/merge', label: 'Merge and fix',
          icon: <Icon d={PATHS.users} colour="#98a2b8" />, disabled: true, badge: 'soon' },
        { href: '/family/import', label: 'Import and export',
          icon: <Icon d={PATHS.draft} colour="#00b8d9" /> },
        { href: '/family/bin', label: 'Bin',
          icon: <Icon d={PATHS.trash} colour="#98a2b8" /> },
      ],
    },
  ];

  sections.push({
    heading: 'Labels',
    items: [
      ...labels.map((l) => ({
        href: `/family/contacts?groupId=${l.id}`,
        label: l.name,
        icon: <Icon d={PATHS.users} colour={l.colour ?? '#98a2b8'} />,
      })),
      { href: '/family/labels', label: labels.length > 0 ? 'Manage labels' : 'Create label',
        icon: <Icon d={PATHS.gear} colour="#00cfe8" /> },
    ],
  });

  sections.push({
    heading: 'Settings',
    items: [
      { href: '/family/settings', label: 'Contact settings',
        icon: <Icon d={PATHS.gear} colour="#00cfe8" /> },
    ],
  });

  return sections;
}
