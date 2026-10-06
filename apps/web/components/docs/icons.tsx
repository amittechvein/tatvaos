// ============================================================================
//  Docs' own glyphs.
//
//  The shared components/ui/Icon set is Mail's vocabulary; an editor needs
//  bold, alignment, lists and the rest, which nothing else in the product
//  draws. They live here rather than in the shared set so a Docs change can
//  never restyle Mail.
// ============================================================================

type P = { className?: string };

const S = ({ d, className = 'h-[18px] w-[18px]' }: { d: string } & P) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** The product mark: a blue page with ruled lines. */
export const DocGlyph = ({ className = 'h-6 w-6' }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d="M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="#1a73e8" />
    <path d="M14 2v5h5" fill="#8ab4f8" />
    <path d="M8.5 12h7M8.5 15h7M8.5 18h4.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const I = {
  undo: (p: P) => <S d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" {...p} />,
  redo: (p: P) => <S d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" {...p} />,
  print: (p: P) => <S d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z" {...p} />,
  bold: (p: P) => <S d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" {...p} />,
  italic: (p: P) => <S d="M10 5h8M6 19h8M14 5l-4 14" {...p} />,
  underline: (p: P) => <S d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" {...p} />,
  strike: (p: P) => <S d="M4 12h16M16 6.5A4 4 0 0 0 12 5c-2.5 0-4 1.3-4 3 0 3.5 8 2.5 8 7 0 1.8-1.7 3-4 3a4.5 4.5 0 0 1-4.5-2.5" {...p} />,
  color: (p: P) => <S d="M6 17L12 3l6 14M8.2 12h7.6" {...p} />,
  highlight: (p: P) => <S d="M9 11l-5 5v3h3l5-5M9 11l6-6 4 4-6 6M9 11l4 4" {...p} />,
  link: (p: P) => <S d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" {...p} />,
  image: (p: P) => <S d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01" {...p} />,
  comment: (p: P) => <S d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5" {...p} />,
  alignLeft: (p: P) => <S d="M4 6h16M4 10h10M4 14h16M4 18h10" {...p} />,
  alignCenter: (p: P) => <S d="M4 6h16M7 10h10M4 14h16M7 18h10" {...p} />,
  alignRight: (p: P) => <S d="M4 6h16M10 10h10M4 14h16M10 18h10" {...p} />,
  alignJustify: (p: P) => <S d="M4 6h16M4 10h16M4 14h16M4 18h16" {...p} />,
  lineSpacing: (p: P) => <S d="M11 6h9M11 12h9M11 18h9M5 8l2-3 2 3M5 16l2 3 2-3M7 5v14" {...p} />,
  bullets: (p: P) => <S d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" {...p} />,
  numbers: (p: P) => <S d="M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c0-1 2.5-1.2 2.5.3 0 1.2-2.5 1.5-2.5 3.2h2.8" {...p} />,
  checklist: (p: P) => <S d="M4 5h4v4H4zM4 15h4v4H4zM12 7h8M12 17h8M5 17l1 1 2-2" {...p} />,
  indentMore: (p: P) => <S d="M4 6h16M10 10h10M10 14h10M4 18h16M4 9.5l3 2.5-3 2.5" {...p} />,
  indentLess: (p: P) => <S d="M4 6h16M10 10h10M10 14h10M4 18h16M7 9.5L4 12l3 2.5" {...p} />,
  clear: (p: P) => <S d="M6 5h12M12 5l-3 14M4 20l16-16" {...p} />,
  table: (p: P) => <S d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" {...p} />,
  sparkle: (p: P) => <S d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" {...p} />,
  history: (p: P) => <S d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3.5 2" {...p} />,
  share: (p: P) => <S d="M16 8a3 3 0 1 0 0-.01M6 15a3 3 0 1 0 0-.01M16 22a3 3 0 1 0 0-.01M8.6 13.5l5-3M8.6 16.5l5 3" {...p} />,
  back: (p: P) => <S d="M15 18l-6-6 6-6" {...p} />,
  star: (p: P) => <S d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" {...p} />,
  close: (p: P) => <S d="M6 6l12 12M18 6L6 18" {...p} />,
  more: (p: P) => <S d="M12 6h.01M12 12h.01M12 18h.01" {...p} />,
  cloudOk: (p: P) => <S d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5zM9.5 13.5l2 2 3.5-3.5" {...p} />,
  cloudOff: (p: P) => <S d="M4 4l16 16M9 6.4A6 6 0 0 1 18 9.5a4 4 0 0 1 1.9 7.2M16 18H7a4.5 4.5 0 0 1-1.6-8.7" {...p} />,
  resolve: (p: P) => <S d="M5 12l5 5 9-10" {...p} />,
  superscript: (p: P) => <S d="M4 7l8 10M12 7l-8 10M16 9c0-1.5 3-1.8 3 .2 0 1.5-3 2-3 3.8h3.4" {...p} />,
  subscript: (p: P) => <S d="M4 5l8 10M12 5L4 15M16 16c0-1.5 3-1.8 3 .2 0 1.5-3 2-3 3.8h3.4" {...p} />,
};
