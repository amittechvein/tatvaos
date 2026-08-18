// ============================================================================
//  Picture-in-Picture for the meeting room.
// ============================================================================
//
//  The point: you switch to another window to look something up, and the
//  meeting does not vanish. Audio already survives — it is a background tab —
//  so what this buys is SEEING it, and knowing you are still in it.
//
//  ─────────────────────────────────────────────────────────────────────────
//  THREE THINGS ABOUT THIS API THAT ARE NOT OPTIONAL TO KNOW.
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

/** The PiP document's own stylesheet. Self-contained: the opener's styles are
 *  NOT inherited, and copying them would drag in the whole app's CSS for two
 *  elements. */
const PIP_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0a0a0e;color:#f2f2f5;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  .wrap{position:fixed;inset:0;display:flex;flex-direction:column}
  .vid{flex:1 1 auto;min-height:0;position:relative;background:#000}
  video{width:100%;height:100%;display:block;background:#000}
  /* contain, for the same reason the room uses it: a shared screen cropped to
     fill a small window loses whatever is at its edges. */
  video.screen{object-fit:contain}
  video.cam{object-fit:cover}
  .none{position:absolute;inset:0;display:grid;place-items:center;color:#9b9bab;font-size:13px}
  .bar{flex:0 0 auto;display:flex;gap:6px;padding:6px;background:#15151c;
    border-top:1px solid #26262f}
  button{flex:1;border:1px solid #26262f;background:rgba(255,255,255,.06);
    color:#f2f2f5;border-radius:8px;padding:7px 8px;font-size:12px;cursor:pointer}
  button:hover{background:rgba(255,255,255,.14)}
  button.off{background:rgba(239,71,87,.2);border-color:rgba(239,71,87,.5);color:#ffb3bb}
  .name{position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.6);
    padding:3px 8px;border-radius:7px;font-size:11px;max-width:calc(100% - 16px);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

export interface PipHandles {
  /** The floating window. */
  window: Window;
  /** Where to attach a track. */
  video: HTMLVideoElement;
  /** Sets the caption under the video. */
  setLabel(text: string): void;
  /** Switches the fit between a camera and a shared screen. */
  setKind(kind: 'cam' | 'screen'): void;
  /** Reflects mute state on the button. */
  setMuted(muted: boolean): void;
  /** True while there is a track attached. */
  setHasVideo(has: boolean): void;
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
    pip = await api.requestWindow({ width: 380, height: 260 });
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

  const shell = doc.createElement('div');
  shell.className = 'vid';

  const video = doc.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Muted, always. The audio is already playing from the page itself, and a
  // second unmuted element playing the same room is an echo.
  video.muted = true;
  video.className = 'cam';

  const none = doc.createElement('div');
  none.className = 'none';
  none.textContent = 'Camera off';

  const label = doc.createElement('div');
  label.className = 'name';

  shell.append(video, none, label);

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
  wrap.append(shell, bar);
  doc.body.append(wrap);

  // The person can close the window themselves; the page has to notice.
  pip.addEventListener('pagehide', opts.onClosed);

  return {
    window: pip,
    video,
    setLabel: (text: string) => { label.textContent = text; },
    setKind: (kind: 'cam' | 'screen') => { video.className = kind; },
    setMuted: (muted: boolean) => {
      mute.textContent = muted ? 'Unmute' : 'Mute';
      mute.className = muted ? 'off' : '';
    },
    setHasVideo: (has: boolean) => {
      video.style.display = has ? 'block' : 'none';
      none.style.display = has ? 'none' : 'grid';
    },
  };
}
