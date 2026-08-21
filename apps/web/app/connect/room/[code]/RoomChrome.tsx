'use client';

// ============================================================================
//  Shared surface for the room — styles, and the two wrappers that use them.
// ============================================================================
//
//  Split out so that page.tsx (the door) and Stage.tsx (the live meeting) can
//  both use them WITHOUT the door pulling in livekit-client. See the note at
//  the top of page.tsx for why that split is worth a file.
//
//  Everywhere else in TatvaOS uses YZEN's Bootstrap, which is styled for light
//  surfaces. This screen is a dark room that fills the viewport and sits
//  outside the shell, so its buttons and panels are its own. The styles are a
//  plain <style> element with a string child — NOT dangerouslySetInnerHTML,
//  which eslint forbids here as an error.
// ============================================================================

export const CSS = `
.cx-root{--cx-bg:#0a0a0e;--cx-surface:#15151c;--cx-line:#26262f;--cx-text:#f2f2f5;
  --cx-dim:#9b9bab;--cx-accent:#00b8d9;--cx-good:#2ecc71;--cx-bad:#ef4757;
  position:fixed;inset:0;display:flex;flex-direction:column;background:var(--cx-bg);
  color:var(--cx-text);font-feature-settings:"tnum";overflow:hidden}
.cx-top{display:flex;align-items:center;gap:12px;padding:12px 16px;flex:0 0 auto}
.cx-title{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cx-meta{color:var(--cx-dim);font-size:12px;display:flex;align-items:center;gap:8px}
.cx-dot{width:8px;height:8px;border-radius:50%;background:var(--cx-good);
  box-shadow:0 0 0 0 rgba(46,204,113,.6);animation:cx-pulse 2.4s infinite}
@keyframes cx-pulse{70%{box-shadow:0 0 0 7px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}
.cx-ghost{margin-left:auto;display:flex;gap:8px}
.cx-mini{background:rgba(255,255,255,.06);border:1px solid var(--cx-line);color:var(--cx-text);
  border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer;transition:background .15s;
  text-decoration:none;display:inline-block}
.cx-mini:hover{background:rgba(255,255,255,.12);color:var(--cx-text)}

.cx-stage{position:relative;flex:1 1 auto;display:flex;flex-wrap:wrap;gap:12px;
  padding:0 16px 8px;align-content:center;justify-content:center;overflow-y:auto;min-height:0}

/* ── WHEN SOMEBODY IS PRESENTING, HEIGHT IS THE SCARCE THING. ──────────────
   A shared screen is letterboxed to FIT (contain, not cover — see below), so
   on a wide monitor its width is decided entirely by how tall the stage is:
   a 16:10 laptop screen in a 1900x530 box renders 848px wide and wastes more
   than half the width on black. The first live share of a browser window
   came out smaller than the browser window it was shared from.

   So while presenting, the camera strip stops taking a horizontal band of
   its own and floats over the bottom-left corner instead — which is black
   bar in almost every case — and the stage's padding tightens. That is
   roughly 150px of height handed back to the picture, and the picture is
   about 28% wider for it. The faces stay visible the whole time; they are
   simply no longer charging rent in the one dimension that matters. */
.cx-stage--present{padding:0 8px 4px;gap:8px}
.cx-strip--float{position:absolute;left:12px;bottom:10px;z-index:5;padding:0;
  max-width:calc(100% - 24px)}
.cx-strip--float .cx-tile{flex:0 0 132px;max-width:132px;
  box-shadow:0 6px 20px rgba(0,0,0,.55)}

/* flex + aspect-ratio. Never grid-cols-*: YZEN's own .grid flattens those. */
.cx-tile{position:relative;flex:1 1 clamp(240px,26vw,420px);max-width:640px;
  aspect-ratio:16/9;background:#000;border-radius:16px;overflow:hidden;
  border:1px solid var(--cx-line);transition:border-color .18s,box-shadow .18s}
.cx-tile--big{flex:1 1 100%;max-width:none;height:100%;aspect-ratio:auto}
.cx-tile.is-speaking{border-color:var(--cx-good);box-shadow:0 0 0 3px rgba(46,204,113,.22)}

/* cover is right for a FACE and wrong for a SCREEN.
   A camera tile crops to fill and nobody minds losing the edges of a room. A
   shared screen cropped to fill loses whatever is at the edges — and what is
   at the edges is usually the thing being pointed at. The first live share
   this shipped into was a sign-in page, in a stage box about 4:1, and the
   Sign in button was sliced in half by the bottom of the tile.
   contain letterboxes instead: smaller, complete, and legible. */
.cx-video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.cx-video--screen{object-fit:contain}
.cx-video--self{transform:scaleX(-1)}

/* Full screen. A shared screen inside a 460px-tall stage is never comfortable
   however it is fitted, because the browser's own chrome, the sharing bar and
   the taskbar are eating half the display. Going full screen on the whole room
   — not just the tile — reclaims all of that AND keeps the control bar, so you
   can still mute or leave without coming back out. */
.cx-root:fullscreen{background:var(--cx-bg)}
.cx-root:fullscreen .cx-top{padding:8px 16px}
.cx-off{position:absolute;inset:0;display:grid;place-items:center;
  background:radial-gradient(circle at 50% 40%,#1c1c25,#0d0d12)}
.cx-initial{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;
  font-size:28px;font-weight:700;background:rgba(255,255,255,.08);border:1px solid var(--cx-line)}
.cx-name{position:absolute;left:10px;bottom:10px;display:flex;align-items:center;gap:6px;
  background:rgba(0,0,0,.55);backdrop-filter:blur(6px);padding:4px 10px;border-radius:8px;
  font-size:12px;max-width:calc(100% - 20px)}
.cx-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Feature 62. Top LEFT, opposite the host actions, so a raised hand is never
   hidden behind the Mute/Remove pills that appear on hover. */
.cx-hand{position:absolute;left:10px;top:10px;font-size:18px;line-height:1;
  background:rgba(255,169,9,.9);color:#3a2600;border-radius:9px;padding:4px 7px;
  animation:cx-raise .4s ease-out}
@keyframes cx-raise{from{transform:translateY(6px) scale(.85);opacity:0}to{transform:none;opacity:1}}

/* Feature 49. Appears only when the connection is poor or lost — see the
   Quality component for why an always-on indicator is worse than none. */
.cx-qual{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:5px;
  background:rgba(255,169,9,.9);color:#3a2600;border-radius:8px;padding:3px 8px;
  font-size:11px;font-weight:600}
.cx-qual.is-lost{background:rgba(239,71,87,.92);color:#fff}

.cx-tileacts{position:absolute;right:10px;top:10px;display:flex;gap:6px;opacity:0;transition:opacity .15s}
.cx-tile:hover .cx-tileacts,.cx-tile:focus-within .cx-tileacts{opacity:1}
.cx-pill{border:none;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
  background:rgba(255,255,255,.15);color:#fff;backdrop-filter:blur(6px)}
.cx-pill:hover{background:rgba(255,255,255,.28)}
.cx-pill--bad{background:rgba(239,71,87,.85)}
.cx-pill--bad:hover{background:#ef4757}

.cx-strip{flex:0 0 auto;display:flex;gap:8px;padding:0 16px 8px;overflow-x:auto}
.cx-strip .cx-tile{flex:0 0 168px;max-width:168px;border-radius:12px}

.cx-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  gap:8px;flex-wrap:wrap;padding:14px 16px 18px}
.cx-btn{display:inline-flex;flex-direction:column;align-items:center;gap:4px;
  min-width:64px;padding:9px 12px;border-radius:14px;cursor:pointer;font-size:11px;
  background:rgba(255,255,255,.07);border:1px solid var(--cx-line);color:var(--cx-text);
  transition:transform .12s,background .15s}
.cx-btn:hover{background:rgba(255,255,255,.14);transform:translateY(-1px)}
.cx-btn i{font-size:19px;line-height:1}
.cx-btn.is-off{background:rgba(239,71,87,.18);border-color:rgba(239,71,87,.5);color:#ffb3bb}
.cx-btn.is-on{background:rgba(0,184,217,.18);border-color:rgba(0,184,217,.5);color:#8fe6f6}
.cx-btn--leave{background:var(--cx-bad);border-color:var(--cx-bad);color:#fff}
.cx-btn--leave:hover{background:#ff5c6c}
.cx-btn[disabled]{opacity:.5;cursor:not-allowed;transform:none}
.cx-count{position:absolute;transform:translate(18px,-8px);background:var(--cx-accent);
  color:#04262c;border-radius:999px;font-size:10px;font-weight:700;padding:1px 6px}
.cx-btnwrap{position:relative;display:inline-flex}

.cx-panel{position:fixed;top:0;right:0;bottom:0;width:min(360px,100vw);z-index:1200;
  background:var(--cx-surface);border-left:1px solid var(--cx-line);
  display:flex;flex-direction:column;box-shadow:-14px 0 44px rgba(0,0,0,.5)}
.cx-panel-head{display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;border-bottom:1px solid var(--cx-line);font-weight:600}
.cx-panel-body{flex:1 1 auto;overflow-y:auto;padding:14px 16px}
.cx-panel-foot{flex:0 0 auto;padding:12px 16px;border-top:1px solid var(--cx-line)}
.cx-x{background:none;border:none;color:var(--cx-dim);cursor:pointer;font-size:20px;line-height:1}
.cx-x:hover{color:var(--cx-text)}

.cx-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.cx-av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;
  background:rgba(255,255,255,.09);font-weight:700;font-size:13px}
.cx-grow{flex:1 1 auto;min-width:0}
.cx-sub{color:var(--cx-dim);font-size:11px}

/* Somebody is at the door. It floats over the video rather than living only in
   a panel: a request nobody sees is a person left standing outside. */
.cx-knocks{position:fixed;right:16px;top:64px;z-index:1210;display:flex;
  flex-direction:column;gap:10px;width:min(320px,calc(100vw - 32px))}
.cx-knock{background:var(--cx-surface);border:1px solid var(--cx-line);border-radius:14px;
  padding:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);animation:cx-slide .22s ease-out}
@keyframes cx-slide{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
.cx-knock-acts{display:flex;gap:8px;margin-top:10px}
.cx-knock-acts button{flex:1;border-radius:9px;padding:7px;font-size:13px;cursor:pointer;border:1px solid var(--cx-line)}
.cx-yes{background:var(--cx-good);border-color:var(--cx-good);color:#04240f;font-weight:600}
.cx-no{background:transparent;color:var(--cx-dim)}
.cx-no:hover{color:var(--cx-text)}

.cx-banner{flex:0 0 auto;padding:9px 16px;font-size:13px;text-align:center}
.cx-banner--warn{background:rgba(255,169,9,.16);color:#ffd591}
.cx-banner--bad{background:rgba(239,71,87,.18);color:#ffb3bb}

/* Recording. Deliberately the loudest thing on the screen after the video
   itself, and with NO dismiss control — a notice people can make go away is
   a notice they will make go away. Red, because that is the colour every
   recording indicator has been for fifty years and nobody has to learn it. */
.cx-banner--rec{background:rgba(239,71,87,.22);color:#ffc2c8;font-weight:600;
  display:flex;align-items:center;justify-content:center}
.cx-recdot{width:9px;height:9px;border-radius:50%;background:#ef4757;
  box-shadow:0 0 0 0 rgba(239,71,87,.7);animation:cx-recpulse 1.6s infinite}
@keyframes cx-recpulse{70%{box-shadow:0 0 0 8px rgba(239,71,87,0)}
  100%{box-shadow:0 0 0 0 rgba(239,71,87,0)}}
/* The host's own button while it is running: red, like the notice, so the
   control and the state read as the same thing rather than two. */
.cx-btn.is-rec{background:rgba(239,71,87,.22);border-color:rgba(239,71,87,.55);color:#ffc2c8}

.cx-centre{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;padding:24px;background:#0a0a0e;color:#f2f2f5}
.cx-card{width:100%;max-width:420px;text-align:left;background:#15151c;
  border:1px solid #26262f;border-radius:18px;padding:24px}
.cx-field{width:100%;background:#0f0f15;border:1px solid #26262f;color:#f2f2f5;
  border-radius:10px;padding:10px 12px;font-size:14px}
.cx-field:focus{outline:none;border-color:#00b8d9}
.cx-label{display:block;font-size:12px;color:#9b9bab;margin:0 0 6px}
.cx-cta{width:100%;background:#00b8d9;border:none;color:#04262c;font-weight:700;
  border-radius:10px;padding:11px;font-size:14px;cursor:pointer}
.cx-cta:hover{filter:brightness(1.08)}
.cx-cta[disabled]{opacity:.55;cursor:not-allowed}
@media (max-width:640px){.cx-btn{min-width:52px;font-size:0;padding:11px}.cx-btn i{font-size:20px}}

/* The pre-join screen. The preview mirrors like the self tile does — people
   expect a mirror before a meeting, and un-mirrored feels like a stranger. */
.cx-preview{position:relative;aspect-ratio:16/9;background:#000;border-radius:14px;
  overflow:hidden;border:1px solid #26262f}
.cx-preview-video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);display:block}
.cx-preview-off{position:absolute;inset:0;display:grid;place-items:center;
  background:radial-gradient(circle at 50% 40%,#1c1c25,#0d0d12)}
.cx-meter{position:absolute;left:10px;right:10px;bottom:8px;height:5px;border-radius:99px;
  background:rgba(255,255,255,.14);overflow:hidden}
.cx-meter-fill{height:100%;background:var(--cx-good,#2ecc71);border-radius:99px;
  transition:width .08s linear}

/* The one modal this screen has — the host deciding what their leaving means.
   Over everything, because it IS the question of the moment. */
.cx-modal-back{position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.6);
  display:grid;place-items:center;padding:20px}
.cx-modal{width:100%;max-width:400px;background:#15151c;border:1px solid #26262f;
  border-radius:16px;padding:20px;box-shadow:0 18px 60px rgba(0,0,0,.6)}
.cx-modal h2{font-size:16px;font-weight:600;margin:0 0 6px}
.cx-choice{display:block;width:100%;text-align:left;margin-top:10px;padding:12px 14px;
  border-radius:11px;border:1px solid #26262f;background:rgba(255,255,255,.05);
  color:#f2f2f5;cursor:pointer;font-size:14px}
.cx-choice:hover{background:rgba(255,255,255,.11)}
.cx-choice--bad{border-color:rgba(239,71,87,.5);background:rgba(239,71,87,.12);color:#ffb3bb}
.cx-choice--bad:hover{background:rgba(239,71,87,.2)}
.cx-choice[disabled]{opacity:.5;cursor:not-allowed}
`;

export function Centre({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{CSS}</style>
      <div className="cx-centre">{children}</div>
    </>
  );
}

export function Spinner() {
  return <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />;
}

export function initialOf(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}
