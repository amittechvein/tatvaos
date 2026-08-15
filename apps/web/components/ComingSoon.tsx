'use client';

import Link from 'next/link';

/**
 * A product that has an address but not yet a product.
 *
 * calendar.tatvaos.com and connect.tatvaos.com resolve today because DNS and
 * TLS want warming up before launch day, and because a customer who guesses
 * the obvious hostname should meet a sentence rather than a browser error —
 * an error page looks like our infrastructure is broken, which costs more
 * trust than an unfinished product does.
 *
 * Deliberately says nothing about WHEN. A date on a page is a promise the
 * page cannot keep, and it ages badly in a screenshot.
 */
export function ComingSoon({ product, blurb }: { product: string; blurb: string }) {
  return (
    <div className="d-flex flex-column align-items-center justify-content-center text-center"
         style={{ minHeight: '70vh', padding: '2rem' }}>
      <h1 className="fw-semibold mb-2" style={{ fontSize: 28 }}>TatvaOS {product}</h1>
      <p className="text-muted mb-4" style={{ maxWidth: 460, fontSize: 15 }}>{blurb}</p>
      <p className="text-muted mb-4" style={{ fontSize: 13 }}>
        It is being built. This address is reserved for it and will start
        working here, at this URL, without you having to change anything.
      </p>
      <div className="d-flex gap-2 flex-wrap justify-content-center">
        <Link href="/mail/inbox" className="btn btn-primary">Open Mail</Link>
        <Link href="/space/personal" className="btn btn-light">Open Space</Link>
      </div>
    </div>
  );
}
