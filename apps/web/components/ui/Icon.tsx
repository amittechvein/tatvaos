/** Inline SVG icons. No icon library — a handful of paths is not worth a dependency. */

type IconName =
  | 'inbox' | 'send' | 'draft' | 'junk' | 'trash' | 'star' | 'star-filled'
  | 'search' | 'compose' | 'back' | 'attach' | 'archive' | 'menu' | 'reply'
  | 'reply-all' | 'forward' | 'more' | 'close'
  | 'refresh' | 'envelope' | 'envelope-open' | 'chevron-left' | 'chevron-right'
  | 'bookmark' | 'settings' | 'plus-circle'
  | 'expand' | 'collapse' | 'minimise' | 'list-ul' | 'list-ol' | 'link' | 'emoji'
  | 'split-v' | 'split-h' | 'split-none' | 'chevron-down'
  | 'drive' | 'clock' | 'lock' | 'print' | 'spellcheck';

const PATHS: Record<IconName, string> = {
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8M4 13v6h16v-6',
  send: 'M4 20l16-8L4 4v6l10 2-10 2v6z',
  draft: 'M4 20h16M6 16l10-10 2 2-10 10H6v-2z',
  junk: 'M12 3l9 16H3L12 3zm0 6v4m0 3h.01',
  trash: 'M5 7h14M9 7V5h6v2m-8 0v12h10V7',
  star: 'M12 4l2.4 5.2 5.6.6-4.2 3.9 1.2 5.6L12 16.5 6.9 19.3l1.2-5.6L4 9.8l5.6-.6L12 4z',
  'star-filled': 'M12 4l2.4 5.2 5.6.6-4.2 3.9 1.2 5.6L12 16.5 6.9 19.3l1.2-5.6L4 9.8l5.6-.6L12 4z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zm5 -2l4 4',
  compose: 'M4 20h16M6 15l9-9 3 3-9 9H6v-3z',
  back: 'M15 5l-7 7 7 7',
  attach: 'M8 12l6-6a3 3 0 114 4l-8 8a5 5 0 11-7-7l8-8',
  archive: 'M4 8h16v12H4V8zm0-4h16v4H4V4zm5 8h6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  reply: 'M9 7L4 12l5 5M4 12h9a5 5 0 015 5v1',
  'reply-all': 'M8 7l-5 5 5 5M13 7l-5 5 5 5M8 12h8a5 5 0 015 5v1',
  forward: 'M15 7l5 5-5 5M20 12h-9a5 5 0 00-5 5v1',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 10.3 4M20 5v6h-6',
  envelope: 'M4 6h16v12H4V6zm0 1l8 6 8-6',
  'envelope-open': 'M4 10l8-6 8 6v10H4V10zm0 1l8 6 8-6',
  'chevron-left': 'M14 6l-6 6 6 6',
  'chevron-right': 'M10 6l6 6-6 6',
  bookmark: 'M6 4h12v16l-6-4-6 4V4z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a7.9 7.9 0 000-2l2-1.5-2-3.5-2.4 1a8 8 0 00-1.7-1L14 3h-4l-.6 2.5a8 8 0 00-1.7 1l-2.4-1-2 3.5 2 1.5a7.9 7.9 0 000 2l-2 1.5 2 3.5 2.4-1a8 8 0 001.7 1L10 21h4l.6-2.5a8 8 0 001.7-1l2.4 1 2-3.5-2-1.5z',
  'plus-circle': 'M12 8v8m-4-4h8M12 21a9 9 0 100-18 9 9 0 000 18z',
  expand: 'M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5',
  collapse: 'M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5',
  minimise: 'M5 12h14',
  // Reading-pane layouts: a framed pane, split down the middle, across the
  // middle, or not split at all.
  'split-v': 'M3 4h18v16H3zM12 4v16',
  'split-h': 'M3 4h18v16H3zM3 12h18',
  'split-none': 'M3 4h18v16H3z',
  'chevron-down': 'M6 9l6 6 6-6',
  'list-ul': 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  'list-ol': 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M4 16h2v2H4z',
  link: 'M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1',
  emoji: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9 10h.01M15 10h.01M8 15c1 1.3 2.4 2 4 2s3-.7 4-2',
  drive: 'M8 4h8l4 8-4 8H8l-4-8z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  lock: 'M6 10V8a6 6 0 0112 0v2M5 10h14v10H5z',
  print: 'M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v6H8z',
  spellcheck: 'M5 15l3-8 3 8M6 12h4M14 9a3 3 0 013 3v3M20 12a3 3 0 00-3 3',
};

export function Icon({
  name,
  className = 'h-5 w-5',
  filled = false,
}: {
  name: IconName;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
