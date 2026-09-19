// ============================================================================
//  The product artwork, as the APP draws it: on any ground, in either theme.
//
//  Amit, 19 Sept 2026, a screenshot of the sidebar in dark mode: two white
//  boxes with logos in them. Every file in /brand is fully opaque - the white is
//  painted in - and the wordmark's "Tatva" is dark navy. On the light rail
//  nobody could tell. On the dark rail each was a white rectangle.
//
//  /brand/ui holds the same artwork with the ground removed, plus a second
//  wordmark whose dark ink is light, all made by
//  apps/web/scripts/make-brand-ui.py. The originals in /brand are NOT replaced:
//  nine email templates load them by URL, and a mail app that forces dark mode
//  repaints whatever is behind a transparent image. The white box is what keeps
//  a logo legible there.
//
//  TWO <img>, NOT <picture>. Dark mode here is the `dark` class on <html>
//  (tailwind darkMode:'class'), chosen by a button - not the operating system's
//  preference, which is all a <source media> can ask about. A <picture> would
//  follow the OS and disagree with the page.
//
//  No hooks, no 'use client': /platform is a static server page that must stay
//  dependency-free, and it uses these too.
// ============================================================================

export type BrandProduct = 'core' | 'mail' | 'connect' | 'space' | 'calendar' | 'family' | 'platform';

/** The square mark. One file for both themes: it has no dark ink. */
export function BrandMark({ product, className = '', alt = '', width, height }: {
  product: BrandProduct | string;
  className?: string;
  alt?: string;
  width?: number;
  height?: number;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={className} src={`/brand/ui/${product}-logo.png`} alt={alt} width={width} height={height} />
  );
}

/** The "TatvaOS <Product>" wordmark: dark ink on a light page, light ink on a
 *  dark one. `className` sizes BOTH images; say the alt once, on the pair. */
export function BrandName({ product, className = '', alt = '', width, height }: {
  product: BrandProduct | string;
  className?: string;
  alt?: string;
  width?: number;
  height?: number;
}) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={`${className} dark:hidden`} src={`/brand/ui/${product}-name.png`}
           alt={alt} width={width} height={height} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={`${className} hidden dark:block`} src={`/brand/ui/${product}-name-dark.png`}
           alt={alt} width={width} height={height} />
    </>
  );
}
