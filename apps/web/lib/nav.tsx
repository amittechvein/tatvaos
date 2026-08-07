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

const Icon = ({ d }: { d: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
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
  inbox:     'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4v-6z',
  gear:      'M10.3 3h3.4l.5 2.3 1.9 1.1 2.2-.8 1.7 3-1.7 1.6v2.2l1.7 1.6-1.7 3-2.2-.8-1.9 1.1-.5 2.3h-3.4l-.5-2.3-1.9-1.1-2.2.8-1.7-3 1.7-1.6v-2.2L4 8.6l1.7-3 2.2.8 1.9-1.1.5-2.3zM12 14.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z',
  mail:      'M3 7l9 6 9-6M3 7h18v10H3z',
  drive:     'M12 3l8 14H4L12 3zM9 17l-3 4M15 17l3 4',
  people:    'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1',
  payroll:   'M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  sheet:     'M4 4h16v16H4zM4 10h16M10 4v16',
  word:      'M6 3h9l5 5v13H6zM15 3v5h5M9 13h6M9 17h6',
  // Mail folder icons for the shell rail (mailNav).
  sent: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  draft: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  junk: 'M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
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
  { code: 'drive', label: 'Drive', href: '/drive', icon: <Icon d={PATHS.drive} />,
    live: false, colour: '#28c76f', match: ['/drive'] },
  { code: 'people', label: 'People', href: '/people', icon: <Icon d={PATHS.people} />,
    live: false, colour: '#00cfe8', match: ['/people'] },
  { code: 'payroll', label: 'Payroll', href: '/payroll', icon: <Icon d={PATHS.payroll} />,
    live: false, colour: '#ff9f43', match: ['/payroll'] },
  { code: 'sheet', label: 'Sheet', href: '/sheet', icon: <Icon d={PATHS.sheet} />,
    live: false, colour: '#1e9e63', match: ['/sheet'] },
  { code: 'word', label: 'Word', href: '/word', icon: <Icon d={PATHS.word} />,
    live: false, colour: '#2f6fed', match: ['/word'] },
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
        { href: '/org/storage', label: 'Storage', icon: <Icon d={PATHS.database} /> },
        { href: '/org/billing', label: 'Billing', icon: <Icon d={PATHS.card} /> },
      ],
    },
  ];
}


/** A person inside the Mail app. The shell rail mirrors Mail's own folders so
 *  the rail is contextual to Mail rather than showing the console nav. Folders
 *  are dynamic server-side, but the five standard ones have stable slug routes,
 *  which is what the rail needs; custom folders still live in Mail's own column. */
export function mailNav(): NavSection[] {
  return [
    {
      heading: 'Mail',
      items: [
        { href: '/mail/inbox', label: 'Inbox', icon: <Icon d={PATHS.inbox} /> },
        { href: '/mail/drafts', label: 'Drafts', icon: <Icon d={PATHS.draft} /> },
        { href: '/mail/sent', label: 'Sent', icon: <Icon d={PATHS.sent} /> },
        { href: '/mail/junk', label: 'Junk', icon: <Icon d={PATHS.junk} /> },
        { href: '/mail/trash', label: 'Trash', icon: <Icon d={PATHS.trash} /> },
      ],
    },
    {
      heading: 'Settings',
      items: [
        { href: '/account', label: 'Settings', icon: <Icon d={PATHS.gear} /> },
      ],
    },
  ];
}
