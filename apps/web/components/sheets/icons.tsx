// ============================================================================
//  Sheets' own glyphs: the product mark and what a spreadsheet toolbar
//  needs beyond Docs' set (components/docs/icons.tsx, reused for the rest).
//  Kept here so a Sheets change can never restyle Docs or Mail.
// ============================================================================

type P = { className?: string };

const S = ({ d, className = 'h-[18px] w-[18px]' }: { d: string } & P) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** The product mark: a green page with a grid. */
export const SheetGlyph = ({ className = 'h-6 w-6' }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="#188038" />
    <path d="M14 2v5h5" fill="#81c995" />
    <path d="M8 11h8v7H8zM8 14.5h8M12 11v7" stroke="#fff" strokeWidth="1.3" fill="none" />
  </svg>
);

export const SI = {
  borders: (p: P) => <S d="M4 4h16v16H4zM4 12h16M12 4v16" {...p} />,
  merge: (p: P) => <S d="M4 5v14M20 5v14M8 12h8M8 12l2.5-2.5M8 12l2.5 2.5M16 12l-2.5-2.5M16 12l-2.5 2.5" {...p} />,
  wrap: (p: P) => <S d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0l2-2m-2 2l2 2M4 18h5" {...p} />,
  valignBottom: (p: P) => <S d="M4 20h16M12 4v12m0 0l-4-4m4 4l4-4" {...p} />,
  valignMiddle: (p: P) => <S d="M4 12h16M12 3v5m0 0l-3-3m3 3l3-3M12 21v-5m0 0l-3 3m3-3l3 3" {...p} />,
  valignTop: (p: P) => <S d="M4 4h16M12 20V8m0 0l-4 4m4-4l4 4" {...p} />,
  decimalLess: (p: P) => <S d="M4 17h.01M8 12a2.5 3.5 0 1 0 5 0a2.5 3.5 0 1 0-5 0M15 18h6m-6 0l2-2m-2 2l2 2" {...p} />,
  decimalMore: (p: P) => <S d="M3 17h.01M6 12a2 3 0 1 0 4 0a2 3 0 1 0-4 0M12 12a2 3 0 1 0 4 0a2 3 0 1 0-4 0M16 19h6m0 0l-2-2m2 2l-2 2" {...p} />,
  functions: (p: P) => <S d="M18 5H7l6 7-6 7h11" {...p} />,
  fill: (p: P) => <S d="M5 13l7-7 6 6-7 7zM12 6L9 3M19 15s2 2.3 2 3.5a2 2 0 0 1-4 0c0-1.2 2-3.5 2-3.5z" {...p} />,
  freeze: (p: P) => <S d="M4 4h16v16H4zM4 9h16M9 4v16" {...p} />,
  sort: (p: P) => <S d="M7 4v16m0 0l-3-3m3 3l3-3M14 6h7M14 12h5M14 18h3" {...p} />,
  plus: (p: P) => <S d="M12 5v14M5 12h14" {...p} />,
  list: (p: P) => <S d="M4 6h16M4 12h16M4 18h16" {...p} />,
  upload: (p: P) => <S d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v4h16v-4" {...p} />,
  download: (p: P) => <S d="M12 4v12m0 0l-4-4m4 4l4-4M4 16v4h16v-4" {...p} />,
};
