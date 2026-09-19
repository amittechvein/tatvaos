import { hosts } from './lib/hosts';

// One place for colour. Every screen reads from here, so a brand change is
// one edit rather than a hunt — the same reason the web app uses CSS
// variables instead of hex literals in components.
//
// ---------------------------------------------------------------------------
//  THESE VALUES ARE THE WEB'S, NOT THIS FILE'S OWN.
//
//  They come from docs/UI_LANE_BRIEF.md §4.1, "the agreed palette", decided by
//  Amit on 5 September 2026. That section ends with a paragraph about this
//  file: it carried #0F6E56, "a third brand colour, a green that matches
//  neither of the web ones", and had to move or the two-systems problem would
//  exist across two codebases as well as within one.
//
//  So when these need to change, change them THERE first and copy. The web
//  keeps them as space-separated RGB channels because Tailwind needs to insert
//  an alpha channel; React Native has no such constraint, so they are hex here
//  and the CSS variable each one came from is named beside it.
// ---------------------------------------------------------------------------

export const brand = {
  base:   '#6C3CE9', // --brand-500, the brand colour
  onBase: '#F5F1FE', // --brand-50, for text and icons sitting ON base
  soft:   '#B39BF2', // --brand-300
};

export const text = {
  primary:   '#15141B', // --ink
  secondary: '#6B6880', // --ink-muted
  muted:     '#9C99AB', // --ink-faint
};

export const surface = {
  // --canvas is WARM cream, deliberately, not a grey near-white. Rule 1 of the
  // agreed palette: cream is for chrome, white is for content. The contrast
  // between the two is what gives a card its "sheet of paper" quality, and a
  // cool grey page loses it.
  page:   '#FAF6EF', // --canvas
  card:   '#FFFFFF', // --surface
  border: '#ECE7DD', // --line
};

// Product tiles. Colour groups by product, not by position — reordering the
// dashboard must not reshuffle which product is which colour.
//
// ---------------------------------------------------------------------------
//  MAIL'S GREEN IS NOW ITS OWN PRODUCT HUE, NOT THE BRAND.
//
//  Until 9 September 2026 Mail's tile was #0F6E56 / #E1F5EE — the same values
//  as the brand, because the brand happened to be green. That coupling was
//  never intended and is now gone: these are literals belonging to Mail, and
//  the brand is violet above.
//
//  Left green on purpose. Six tiles need six distinguishable hues, green is a
//  legitimate one, and moving Mail to violet would put it a few degrees from
//  Space's #534AB7 — two of six tiles nearly the same colour is worse than a
//  green one. **Whoever takes the UI lane owns this set**; if the tiles are
//  ever restyled as a system, that is the moment to decide whether the
//  flagship product should carry the brand colour and what Space becomes.
// ---------------------------------------------------------------------------
//
//  `product` IS THE SERVER'S CODE, AND TWO OF THEM ARE NOT THE OBVIOUS WORD.
//
//  /api/auth/me returns the product codes this user is entitled to, and they
//  come from core.products. Two are historical and CANNOT be guessed from the
//  name on screen:
//
//      Space    → code 'drive'   (shipped as Drive, renamed to Space; the code
//                                 stayed, because allocations, audit rows and
//                                 storage all point at it — see
//                                 0025-space-schema.sql line 17)
//      Contacts → code 'family'  (the product is Family; Contacts is the label)
//
//  Get either wrong and the tile silently disappears for every user, which
//  looks like an entitlement bug rather than a typo. Checked against
//  local/postgres/init/0028-product-catalogue.sql and 0022-family-departure.sql.
//
//  Admin has NO product code — it is gated by role, not entitlement.
// ---------------------------------------------------------------------------
const ADMIN_ROLES = ['super_admin', 'org_owner', 'org_admin'];

// ---------------------------------------------------------------------------
//  `path` IS FOR THE SIGN-IN HANDOFF, AND IT IS NOT A SECOND COPY OF `url`.
//
//  docs/decisions/0003-mobile-signin-handoff.md. The app asks the API to trade
//  its token for a short-lived URL that opens the browser ALREADY SIGNED IN,
//  and what it sends is this path — never a host. The mint refuses anything
//  whose first segment is not on its allowlist, which is what stops a handoff
//  becoming an open redirect.
//
//  The two differ on purpose:
//
//    url   where the browser goes when there is no handoff — each product on
//          its own host, which is what the address bar should say.
//    path  what the handoff asks for. It lands on the CORE host, and Caddy
//          sends it home from there: conf.d/core/product-doors.caddy redirects
//          /mail, /space, /family and /calendar to their own domains keeping
//          the path, and the session cookie is on .tatvaos.com so it survives
//          the hop. So both routes end up in the same place.
//
//  Admin's path is /org, the CUSTOMER's console — not /admin, which is the
//  platform console and is deliberately not on this dashboard (brief §4).
//
//  Connect has none: it never opens a browser, it opens screens/Meetings.js.
// ---------------------------------------------------------------------------
export const products = [
  // ── A PATH MUST BE A PAGE, NOT A PRODUCT'S PREFIX. 16 Sept 2026. ─────────
  //  The first real handoff from a phone minted in 113ms, scrubbed its code,
  //  landed on mail.tatvaos.com — and showed "404 This page could not be
  //  found". apps/web/app/mail/ has no page.tsx: /mail is a folder of routes,
  //  and the inbox is /mail/inbox. Same for /family, whose landing page is
  //  /family/contacts. Measured live the same hour: mail.tatvaos.com/ → 302
  //  /mail/inbox, but mail.tatvaos.com/mail → 404. These now match
  //  apps/web/lib/nav.tsx's own hrefs, which is where to look if they change.
  { key: 'mail',     product: 'mail',     name: 'Mail',     icon: 'mail-outline',     tint: '#E1F5EE', ink: '#0F6E56', url: hosts.mail,              path: '/mail/inbox' },
  { key: 'connect',  product: 'connect',  name: 'Connect',  icon: 'videocam-outline', tint: '#E6F1FB', ink: '#185FA5', url: hosts.connect },
  { key: 'space',    product: 'drive',    name: 'Space',    icon: 'folder-outline',   tint: '#EEEDFE', ink: '#534AB7', url: hosts.space,             path: '/space' },
  { key: 'calendar', product: 'calendar', name: 'Calendar', icon: 'calendar-outline', tint: '#FAECE7', ink: '#993C1D', url: hosts.calendar,          path: '/calendar' },
  { key: 'contacts', product: 'family',   name: 'Contacts', icon: 'people-outline',   tint: '#FBEAF0', ink: '#993556', url: `${hosts.core}/family/contacts`, path: '/family/contacts' },
  { key: 'admin',    roles: ADMIN_ROLES,  name: 'Admin',    icon: 'business-outline', tint: '#F1EFE8', ink: '#5F5E5A', url: `${hosts.core}/org`,     path: '/org' },
];

/**
 * The tiles this person should see.
 *
 * When we do not yet know — /me has not answered, or failed — show everything
 * rather than nothing. An empty dashboard reads as "your account is broken";
 * a tile that turns out to be unavailable reads as a permission, which is
 * what it is.
 */
export function visibleProducts(entitled, role) {
  if (!Array.isArray(entitled)) return products;
  return products.filter((p) =>
    p.roles ? p.roles.includes(role) : entitled.includes(p.product));
}

// ---------------------------------------------------------------------------
//  THE SHAPE OF THINGS, AS DISTINCT FROM THEIR COLOUR.
//
//  Amit, 18 September 2026: "designing part and decoration for modern ui for
//  Gen-Z" — the login, the dashboard, Mail, the meeting, and the join
//  options. The colours above are the web's and stay the web's (the note at
//  the top of this file says why). What was dated was not the palette but
//  the SHAPE: 8px corners, flat cards, 14px type, thin borders doing all the
//  work. So this is a second layer — corners, spacing, type, depth, and a
//  handful of tones DERIVED from the brand violet rather than added beside
//  it — and the screens read from it the way they read from `brand`.
//
//  No gradient library. A native module means a rebuild on every laptop
//  that has ever fought this one, and the effect can be had from layered
//  translucent views, which is what `wash` is for.
// ---------------------------------------------------------------------------

// pill is for views WITHOUT elevation. On Android an elevated view with a
// radius larger than half its size draws its shadow as a SQUARE — seen on the
// dashboard avatar, 19 Sept 2026. Give an elevated pill half its height instead.
export const radius = { sm: 12, md: 18, lg: 24, xl: 32, pill: 999 };

export const space = { xs: 4, sm: 8, md: 14, lg: 20, xl: 28, xxl: 40 };

// Sizes are the system's; weights lean heavier than before because bold
// display type on a calm page is most of what "modern" turns out to be.
export const type = {
  display: { fontSize: 34, fontWeight: '800', letterSpacing: -0.8, lineHeight: 40 },
  title:   { fontSize: 24, fontWeight: '700', letterSpacing: -0.4, lineHeight: 30 },
  heading: { fontSize: 18, fontWeight: '700', letterSpacing: -0.2, lineHeight: 24 },
  body:    { fontSize: 15, fontWeight: '400', lineHeight: 22 },
  strong:  { fontSize: 15, fontWeight: '600', lineHeight: 22 },
  caption: { fontSize: 12, fontWeight: '500', lineHeight: 16 },
  // A label that reads as a tag: small, uppercase, spaced out.
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
};

// Elevation on Android, the equivalent shadow on iOS. Soft and violet-tinted
// so a card lifts off the cream rather than sitting in a grey smudge.
export const shadow = {
  card: {
    shadowColor: '#3B2A7A', shadowOpacity: 0.08, shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 }, elevation: 3,
  },
  float: {
    shadowColor: '#3B2A7A', shadowOpacity: 0.18, shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 }, elevation: 8,
  },
  glow: {
    shadowColor: brand.base, shadowOpacity: 0.35, shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 }, elevation: 6,
  },
};

// Derived from brand.base (#6C3CE9), not chosen beside it: the same hue,
// pushed darker for an immersive header and lighter for a tinted surface.
export const tone = {
  deep:   '#2A1B5E', // the brand hue at night — hero backgrounds, the meeting
  deeper: '#1B1240',
  wash:   '#EFE9FD', // the brand hue as a tint — chips, selected rows
  ink:    '#4B2BB8', // the brand hue as text on a light surface
  // Translucent layers over `deep`. Stacked at an offset they read as a
  // gradient without a gradient.
  washA:  'rgba(179,155,242,0.22)', // brand.soft
  washB:  'rgba(108,60,233,0.35)',  // brand.base
  onDeep: '#F5F1FE',
  onDeepMuted: 'rgba(245,241,254,0.66)',
};
