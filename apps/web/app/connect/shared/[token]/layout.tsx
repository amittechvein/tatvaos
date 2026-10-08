import type { Metadata } from 'next';

// A share link's page carries a secret in its address. Two things follow, and
// both are cheaper said here than discovered later:
//
//  · noindex — a link pasted somewhere public must not become a search result
//  · no-referrer — the token is in the path, and a Referer header is how a
//    path leaks to whatever the page links to next.
export const metadata: Metadata = {
  title: 'Shared recording · TatvaOS',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
