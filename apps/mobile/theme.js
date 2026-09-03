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
export const products = [
  { key: 'mail',     name: 'Mail',     icon: 'mail-outline',        tint: '#E1F5EE', ink: '#0F6E56', url: 'https://mail.tatvaos.com' },
  { key: 'connect',  name: 'Connect',  icon: 'videocam-outline',    tint: '#E6F1FB', ink: '#185FA5', url: 'https://connect.tatvaos.com' },
  { key: 'space',    name: 'Space',    icon: 'folder-outline',      tint: '#EEEDFE', ink: '#534AB7', url: 'https://space.tatvaos.com' },
  { key: 'calendar', name: 'Calendar', icon: 'calendar-outline',    tint: '#FAECE7', ink: '#993C1D', url: 'https://calendar.tatvaos.com' },
  { key: 'contacts', name: 'Contacts', icon: 'people-outline',      tint: '#FBEAF0', ink: '#993556', url: 'https://core.tatvaos.com/family' },
  { key: 'admin',    name: 'Admin',    icon: 'business-outline',    tint: '#F1EFE8', ink: '#5F5E5A', url: 'https://core.tatvaos.com/org' },
];
