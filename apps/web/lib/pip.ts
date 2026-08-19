// ============================================================================
//  Picture-in-Picture for the meeting room.
// ============================================================================
//
//  The point: you switch to another window to look something up, and the
//  meeting does not vanish. Audio already survives — it is a background tab —
//  so what this buys is SEEING it, and knowing you are still in it.
//
//  It shows EVERYONE, not just whoever spoke last. A floating window with one
//  face in it answers "is someone talking"; a floating window with the room in
//  it answers "what is happening", which is the actual question. The grid
//  re-lays itself out for the window's size and shape every time either
//  changes, so dragging the window bigger shows more of the room rather than a
//  bigger version of the same crop.
//
//  ─────────────────────────────────────────────────────────────────────────
//  FOUR THINGS ABOUT THIS API THAT ARE NOT OPTIONAL TO KNOW.
//
//  1. YOU CANNOT OPEN A PiP WINDOW BY YOURSELF ON A TAB SWITCH.
//     requestWindow() needs transient user activation, and switching away
//     from a tab is not a gesture in that tab. Listening for
//     visibilitychange and calling it there fails, every time.
//
//     The supported route is the mediaSession action "enterpictureinpicture":
//     Chrome INVOKES it for you when the user leaves a page that is capturing
//     camera or microphone — which a meeting always is — and inside that
//     handler the call is permitted. That is the whole mechanism behind
//     "it pops out on its own" in every meeting product that does it.
//
//  2. THE ACTION IS NOT IN TypeScript's lib.dom, AND NEITHER IS
//     documentPictureInPicture. Both ship in Chrome and Edge. The
//     declarations below are the narrowest thing that compiles, and the cast
//     on the action name is to a value the browser accepts and the type
//     definition has not caught up with — not a way around a real type error.
//
//  3. DO NOT MOVE REACT'S DOM INTO THE PiP WINDOW.
//     It is the obvious implementation and it is a trap: React attaches its
//     event listeners to the root container's document, so every handler in
//     the re-parented tree silently stops firing. Instead this creates plain
//     elements in the PiP document and asks LiveKit to attach the track to
//     them — a track can be attached to several elements at once, which is
//     exactly what this needs. Nothing React owns ever leaves the page.
//
//  4. A TILE IS NOT A COMPONENT, SO IT MUST BE RECONCILED BY HAND.
//     Rebuilding the grid on every render would detach and re-attach every
//     video, and a re-attached video restarts: black frame, a flicker, and on
//     a weak connection a visible stall. setTiles() therefore keeps the
//     elements it already has, keyed by identity, and touches only what
//     actually changed. That is the whole reason PipTile carries a trackId —
//     it is how this file knows a video element is already showing the right
//     thing.
//  ─────────────────────────────────────────────────────────────────────────

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPictureApi extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

/** Chrome and Edge today. Everything else falls back to video-element PiP. */
export function documentPipSupported(): boolean {
  return typeof window !== 'undefined' && window.documentPictureInPicture !== undefined;
}

/** Safari and Firefox: one <video>, no arbitrary DOM. Still better than nothing. */
export function videoPipSupported(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
}

export function pipSupported(): boolean {
  return documentPipSupported() || videoPipSupported();
}

/**
 * Ask Chrome to call us when the person switches away.
 *
 * Returns a cleanup function. Safe to call where the action is unsupported —
 * setActionHandler throws NotSupportedError for an action a browser does not
 * know, and that is a normal answer rather than a fault.
 */
export function onAutoPip(handler: () => void): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return () => {};
  try {
    // Real action, shipped in Chrome; absent from lib.dom's MediaSessionAction
    // union. See note 2 in the header.
    navigator.mediaSession.setActionHandler(
      'enterpictureinpicture' as MediaSessionAction, handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      navigator.mediaSession.setActionHandler(
        'enterpictureinpicture' as MediaSessionAction, null);
    } catch { /* going away anyway */ }
  };
}

// ============================================================================
//  One person in the floating window.
// ============================================================================
//
//  Deliberately says nothing about LiveKit. This file has no idea what a Room
//  or a RemoteParticipant is, and does not want one: the caller knows how to
//  attach a track to an element, so it passes that knowledge in as a function.
//  Keeping the media library out of here is what makes this testable, and what
//  stops a PiP change from becoming a LiveKit upgrade.
export interface PipTile {
  /** Stable key. Identity, not sid — a sid changes on rejoin and the tile
   *  would be torn down and rebuilt for someone who never left. */
  id: string;
  name: string;
  /** The letter in the circle when there is no camera. */
  initial: string;
  /** A shared screen rather than a face: full width, and fitted not cropped. */
  screen?: boolean;
  speaking?: boolean;
  micMuted?: boolean;
  hand?: boolean;
  local?: boolean;
  /** The publication currently on show, or '' for none. Changing this is what
   *  makes the video re-attach; leaving it alone is what stops the flicker. */
  trackId?: string;
  attach?: (el: HTMLVideoElement) => void;
  detach?: (el: HTMLVideoElement) => void;
}

/** The PiP document's own stylesheet. Self-contained: the opener's styles are
 *  NOT inherited, and copying them would drag in the whole app's CSS for what
 *  is, in the end, a grid of rectangles. */
const PIP_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0a0a0e;color:#f2f2f5;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  .wrap{position:fixed;inset:0;display:flex;flex-direction:column}
  .grid{flex:1 1 auto;min-height:0;display:grid;gap:3px;padding:3px}
  .tile{position:relative;min-width:0;min-height:0;overflow:hidden;
    border-radius:7px;background:#14141b}
  .tile.spk{box-shadow:inset 0 0 0 2px #34d399}
  .tile video{width:100%;height:100%;display:block;background:#000;object-fit:cover}
  /* contain, for the same reason the room uses it: a shared screen cropped to
     fill a small window loses whatever is at its edges — which on a slide is
     usually the point of the slide. */
  .tile.scr video{object-fit:contain;background:#000}
  .tile.scr{background:#000}
  .ph{position:absolute;inset:0;display:grid;place-items:center}
  .ph b{display:grid;place-items:center;border-radius:50%;background:#2b2b36;
    color:#d8d8e2;font-weight:600;line-height:1;
    width:44%;height:44%;max-width:56px;max-height:56px;min-width:20px;min-height:20px;
    font-size:min(22px,4.5vw)}
  .nm{position:absolute;left:0;right:0;bottom:0;padding:2px 5px;font-size:10px;
    line-height:1.4;background:linear-gradient(transparent,rgba(0,0,0,.72));
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nm .m{color:#ffb3bb}
  .tile.tiny .nm{display:none}
  .more{display:grid;place-items:center;color:#9b9bab;font-size:12px;
    background:#14141b;border-radius:7px}
  .empty{position:absolute;inset:0;display:grid;place-items:center;
    color:#9b9bab;font-size:12px}
  .bar{flex:0 0 auto;display:flex;gap:5px;padding:5px;background:#15151c;
    border-top:1px solid #26262f}
  button{flex:1;border:1px solid #26262f;background:rgba(255,255,255,.06);
    color:#f2f2f5;border-radius:8px;padding:6px 8px;font-size:12px;cursor:pointer}
  button:hover{background:rgba(255,255,255,.14)}
  button.off{background:rgba(239,71,87,.2);border-color:rgba(239,71,87,.5);color:#ffb3bb}
`;

export interface PipHandles {
  /** The floating window. */
  window: Window;
  /** Replace who is on screen. Safe to call on every render — it reconciles. */
  setTiles(tiles: PipTile[]): void;
  /** Reflects mute state on the button. */
  setMuted(muted: boolean): void;
}

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * How many columns to use.
 *
 * Tries every column count and keeps the one that makes the largest tile at a
 * sensible shape. This is the standard answer and it is worth doing properly:
 * a fixed grid looks right at one window size and wastes half the window at
 * every other, and the whole promise of this feature is that it fits the
 * window the person dragged.
 */
export function bestColumns(count: number, w: number, h: number, aspect = 4 / 3): number {
  if (count <= 1) return 1;
  let best = 1;
  let bestArea = 0;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // The cell, then the largest tile of the wanted shape that fits in it.
    const cw = w / cols;
    const ch = h / rows;
    const tw = Math.min(cw, ch * aspect);
    const area = tw * (tw / aspect);
    if (area > bestArea + 0.5) { bestArea = area; best = cols; }
  }
  return best;
}

/**
 * How many tiles are worth drawing at all.
 *
 * A PiP window can be 320 pixels wide. Twenty faces in it are twenty grey
 * smudges, which is worse than eight faces and a note saying there are twelve
 * more — the smudges LOOK like information. So the cap comes from the window,
 * not from a constant: roughly 68×52 CSS pixels per tile, which is about the
 * size at which a face stops being recognisable.
 */
export function tileBudget(w: number, h: number): number {
  const cols = Math.max(1, Math.floor(w / 68));
  const rows = Math.max(1, Math.floor(h / 52));
  return Math.max(1, Math.min(16, cols * rows));
}

/**
 * Open the floating window and build its contents.
 *
 * The two buttons are wired with plain addEventListener rather than React —
 * see note 3. They are the two things somebody in a PiP window actually needs:
 * stop talking, and come back.
 */
export async function openPipWindow(opts: {
  onToggleMute: () => void;
  onReturn: () => void;
  onClosed: () => void;
}): Promise<PipHandles | null> {
  const api = typeof window !== 'undefined' ? window.documentPictureInPicture : undefined;
  if (!api) return null;

  let pip: Window;
  try {
    // Wider than the old single-face window, because the contents are now a
    // room rather than a portrait.
    pip = await api.requestWindow({ width: 420, height: 300 });
  } catch {
    // Denied, or no activation. Not worth surfacing — the button is still
    // there and the meeting is unaffected.
    return null;
  }

  const doc = pip.document;
  const style = doc.createElement('style');
  style.append(doc.createTextNode(PIP_CSS));
  doc.head.append(style);

  const wrap = doc.createElement('div');
  wrap.className = 'wrap';

  const grid = doc.createElement('div');
  grid.className = 'grid';

  const empty = doc.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'Waiting for the meeting…';
  grid.append(empty);

  const bar = doc.createElement('div');
  bar.className = 'bar';

  const mute = doc.createElement('button');
  mute.type = 'button';
  mute.textContent = 'Mute';
  mute.addEventListener('click', opts.onToggleMute);

  const back = doc.createElement('button');
  back.type = 'button';
  back.textContent = 'Back to meeting';
  back.addEventListener('click', opts.onReturn);

  bar.append(mute, back);
  wrap.append(grid, bar);
  doc.body.append(wrap);

  // ── The reconciler ────────────────────────────────────────────────────
  //
  // One entry per person currently on screen. `trackId` is what it is
  // showing, so a render that changes nothing about the video changes
  // nothing about the element — see note 4.
  interface Live {
    root: HTMLDivElement;
    video: HTMLVideoElement;
    photo: HTMLDivElement;
    initial: HTMLElement;
    name: HTMLDivElement;
    trackId: string;
    detach?: (el: HTMLVideoElement) => void;
  }
  const live = new Map<string, Live>();
  let overflow: HTMLDivElement | null = null;
  let shown: PipTile[] = [];
  let hiddenCount = 0;
  let wanted: PipTile[] = [];

  function make(): Live {
    const root = doc.createElement('div');
    root.className = 'tile';

    const video = doc.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    // Muted, always. The audio is already playing from the page itself, and a
    // second unmuted element playing the same room is an echo.
    video.muted = true;
    video.style.display = 'none';

    const photo = doc.createElement('div');
    photo.className = 'ph';
    const initial = doc.createElement('b');
    photo.append(initial);

    const name = doc.createElement('div');
    name.className = 'nm';

    root.append(video, photo, name);
    return { root, video, photo, initial, name, trackId: '' };
  }

  function detachTile(entry: Live) {
    if (entry.trackId && entry.detach) {
      try { entry.detach(entry.video); } catch { /* already gone */ }
    }
    entry.trackId = '';
    entry.detach = undefined;
  }

  function layout() {
    const w = Math.max(1, pip.innerWidth);
    // The button bar is a fixed strip; the grid gets the rest.
    const h = Math.max(1, pip.innerHeight - bar.offsetHeight);

    const budget = tileBudget(w, h);
    hiddenCount = Math.max(0, wanted.length - budget);
    // When something has to be dropped, the LAST visible slot becomes the
    // "+N more" chip rather than a face — otherwise the count is a lie.
    shown = hiddenCount > 0 ? wanted.slice(0, Math.max(1, budget - 1)) : wanted;
    hiddenCount = wanted.length - shown.length;

    const screens = shown.filter((t) => t.screen).length;
    const people = shown.length - screens + (hiddenCount > 0 ? 1 : 0);

    // A shared screen takes a band across the top and the room sits under it.
    // Sizing the band by how much room is left keeps both usable: with one
    // other person the screen gets most of the window, with eight it does not
    // squeeze them into a line of pixels.
    const cols = bestColumns(Math.max(1, people), w, screens > 0 ? h * 0.42 : h);
    const rows = Math.max(1, Math.ceil(Math.max(1, people) / cols));

    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = screens > 0
      ? `minmax(0, ${1.35 * rows}fr) repeat(${rows}, minmax(0, 1fr))`
      : `repeat(${rows}, minmax(0, 1fr))`;

    // Below this a name label is a grey smear over a face, so it comes off.
    const tiny = w / cols < 96;
    for (const t of shown) {
      const entry = live.get(t.id);
      if (!entry) continue;
      entry.root.style.gridColumn = t.screen ? '1 / -1' : '';
      entry.root.classList.toggle('tiny', tiny && !t.screen);
    }
  }

  function setTiles(next: PipTile[]) {
    wanted = next;

    // Work out what is visible at this window size FIRST, so a tile that is
    // only being dropped for want of space still gets its track detached.
    const w = Math.max(1, pip.innerWidth);
    const h = Math.max(1, pip.innerHeight - bar.offsetHeight);
    const budget = tileBudget(w, h);
    const visible = next.length > budget ? next.slice(0, Math.max(1, budget - 1)) : next;
    const keep = new Set(visible.map((t) => t.id));

    for (const [id, entry] of live) {
      if (keep.has(id)) continue;
      detachTile(entry);
      entry.root.remove();
      live.delete(id);
    }

    empty.style.display = visible.length === 0 ? 'grid' : 'none';

    for (const t of visible) {
      let entry = live.get(t.id);
      if (!entry) {
        entry = make();
        live.set(t.id, entry);
      }

      entry.root.classList.toggle('scr', t.screen === true);
      entry.root.classList.toggle('spk', t.speaking === true && t.screen !== true);
      entry.initial.textContent = t.initial;

      const bits: string[] = [t.name];
      if (t.local) bits.push('(you)');
      if (t.hand) bits.push('✋');
      entry.name.textContent = t.screen ? `${t.name} — screen` : bits.join(' ');
      if (t.micMuted && !t.screen) {
        const m = doc.createElement('span');
        m.className = 'm';
        m.textContent = ' muted';
        entry.name.append(m);
      }

      const id = t.trackId ?? '';
      if (id !== entry.trackId) {
        detachTile(entry);
        if (id && t.attach) {
          try {
            t.attach(entry.video);
            entry.trackId = id;
            entry.detach = t.detach;
          } catch { /* the track went away between render and here */ }
        }
      }

      const hasVideo = entry.trackId !== '';
      entry.video.style.display = hasVideo ? 'block' : 'none';
      entry.photo.style.display = hasVideo ? 'none' : 'grid';

      // append() on an element already in place is a no-op move, which is what
      // keeps the DOM order matching the list without rebuilding anything.
      grid.append(entry.root);
    }

    if (next.length > visible.length) {
      if (!overflow) {
        overflow = doc.createElement('div');
        overflow.className = 'more';
      }
      overflow.textContent = `+${next.length - visible.length} more`;
      grid.append(overflow);
    } else if (overflow) {
      overflow.remove();
      overflow = null;
    }

    layout();
  }

  // A person dragging the window bigger is asking to see more of the room.
  pip.addEventListener('resize', layout);

  // The person can close the window themselves; the page has to notice.
  pip.addEventListener('pagehide', () => {
    for (const entry of live.values()) detachTile(entry);
    live.clear();
    opts.onClosed();
  });

  return {
    window: pip,
    setTiles,
    setMuted: (muted: boolean) => {
      mute.textContent = muted ? 'Unmute' : 'Mute';
      mute.className = muted ? 'off' : '';
    },
  };
}
