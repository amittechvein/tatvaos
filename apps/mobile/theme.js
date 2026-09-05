// One place for colour. Every screen reads from here, so a brand change is
// one edit rather than a hunt — the same reason the web app uses CSS
// variables instead of hex literals in components.

export const brand = {
  green: '#0F6E56',
  greenLight: '#E1F5EE',
  greenPale: '#9FE1CB',
};

export const text = {
  primary: '#1a1d29',
  secondary: '#4a4f63',
  muted: '#8a8f9f',
};

export const surface = {
  page: '#fafaf8',
  card: '#ffffff',
  border: '#e7e7e2',
};

// Product tiles. Colour groups by product, not by position — reordering the
// dashboard must not reshuffle which product is which colour.
//
// ---------------------------------------------------------------------------
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

export const products = [
  { key: 'mail',     product: 'mail',     name: 'Mail',     icon: 'mail-outline',     tint: '#E1F5EE', ink: '#0F6E56', url: 'https://mail.tatvaos.com' },
  { key: 'connect',  product: 'connect',  name: 'Connect',  icon: 'videocam-outline', tint: '#E6F1FB', ink: '#185FA5', url: 'https://connect.tatvaos.com' },
  { key: 'space',    product: 'drive',    name: 'Space',    icon: 'folder-outline',   tint: '#EEEDFE', ink: '#534AB7', url: 'https://space.tatvaos.com' },
  { key: 'calendar', product: 'calendar', name: 'Calendar', icon: 'calendar-outline', tint: '#FAECE7', ink: '#993C1D', url: 'https://calendar.tatvaos.com' },
  { key: 'contacts', product: 'family',   name: 'Contacts', icon: 'people-outline',   tint: '#FBEAF0', ink: '#993556', url: 'https://core.tatvaos.com/family' },
  { key: 'admin',    roles: ADMIN_ROLES,  name: 'Admin',    icon: 'business-outline', tint: '#F1EFE8', ink: '#5F5E5A', url: 'https://core.tatvaos.com/org' },
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
