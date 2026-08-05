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
  tag:       'M4 6h16M4 12h16M4 18h10',
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
};

/** Products that exist. Everything else in core.products is future work. */
const LIVE_PRODUCTS = new Set(['mail']);

const PRODUCTS: { code: string; label: string; href: string; icon: string }[] = [
  { code: 'mail',    label: 'Mail',    href: '/mail/f-inbox', icon: PATHS.mail },
  { code: 'drive',   label: 'Drive',   href: '/drive',        icon: PATHS.drive },
  { code: 'people',  label: 'People',  href: '/people',       icon: PATHS.people },
  { code: 'payroll', label: 'Payroll', href: '/payroll',      icon: PATHS.payroll },
  { code: 'sheet',   label: 'Sheet',   href: '/sheet',        icon: PATHS.sheet },
  { code: 'word',    label: 'Word',    href: '/word',         icon: PATHS.word },
];

function productSection(): NavSection {
  return {
    heading: 'Products',
    items: PRODUCTS.map((p) => ({
      href: LIVE_PRODUCTS.has(p.code) ? p.href : '',
      label: p.label,
      icon: <Icon d={p.icon} />,
      disabled: !LIVE_PRODUCTS.has(p.code),
      badge: LIVE_PRODUCTS.has(p.code) ? undefined : 'Soon',
    })),
  };
}

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
    productSection(),
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
            { href: '/org/categories', label: 'Categories' },
          ],
        },
        { href: '/org/domains', label: 'Domains', icon: <Icon d={PATHS.globe} /> },
        { href: '/org/storage', label: 'Storage', icon: <Icon d={PATHS.database} /> },
        { href: '/org/billing', label: 'Billing', icon: <Icon d={PATHS.card} /> },
      ],
    },
    productSection(),
  ];
}
