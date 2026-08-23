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
//
//  CSS below is one template literal. A BACKTICK anywhere inside it — even in
//  a /* comment */ — closes the string and the build dies on whatever CSS came
//  next. Quote things with "double quotes" in there, never backticks.
// ============================================================================

export const CSS = `
.cx-root{--cx-bg:#0a0a0e;--cx-surface:#15151c;--cx-line:#26262f;--cx-text:#f2f2f5;
  --cx-dim:#9b9bab;--cx-accent:#00b8d9;--cx-good:#2ecc71;--cx-bad:#ef4757;
  position:fixed;inset:0;display:flex;flex-direction:column;background:var(--cx-bg);
  color:var(--cx-text);font-feature-settings:"tnum";overflow:hidden}

/* ── THE ROOM'S BACKGROUND IS A CHOICE. ─────────────────────────────────
   Everything is expressed in variables, so a theme is a handful of values
   rather than a second stylesheet — and because --cx-bg is only ever used
   in a "background:" shorthand, a theme can be a GRADIENT as easily as a
   colour.

   Tiles stay black in every theme. That is the letterbox behind a video,
   not a surface; tinting it would tint the picture.

   The light themes carry a shared "cx-light" class rather than repeating
   their overrides six times — the palette differs per theme, but "dark text,
   pale surfaces, name labels stay white over video" is one rule. */

/* Deep and plain. */
.cx-theme-graphite{--cx-bg:#14161a;--cx-surface:#1d2027;--cx-line:#2e323b;
  --cx-dim:#9aa2b1}
.cx-theme-ocean{--cx-bg:#07131f;--cx-surface:#0f2032;--cx-line:#1d3448;
  --cx-dim:#8fa6bd;--cx-accent:#31c8ef}
.cx-theme-plum{--cx-bg:#150d1b;--cx-surface:#211530;--cx-line:#352348;
  --cx-dim:#b0a0c4;--cx-accent:#c07cf0}
.cx-theme-forest{--cx-bg:#0a1712;--cx-surface:#12241c;--cx-line:#1e3a2c;
  --cx-dim:#94b8a6;--cx-accent:#3ecf8e}

/* Gradients. Angled rather than vertical so the corners differ — a vertical
   fade behind a row of tiles reads as a banding artefact. */
.cx-theme-aurora{--cx-bg:linear-gradient(150deg,#0b1026 0%,#241a52 52%,#0d3b52 100%);
  --cx-surface:#191b3d;--cx-line:#33356b;--cx-dim:#a4a8d8;--cx-accent:#7aa2ff}
.cx-theme-ember{--cx-bg:linear-gradient(150deg,#1b0b09 0%,#3a1408 55%,#4a2410 100%);
  --cx-surface:#2a1410;--cx-line:#4a2a1e;--cx-dim:#d3a894;--cx-accent:#ff9d4d}
.cx-theme-nebula{--cx-bg:linear-gradient(150deg,#12071f 0%,#3a1150 50%,#5c1450 100%);
  --cx-surface:#241033;--cx-line:#42204f;--cx-dim:#c9a6da;--cx-accent:#e46bd0}
.cx-theme-lagoon{--cx-bg:linear-gradient(150deg,#04201f 0%,#075450 55%,#0a6f5c 100%);
  --cx-surface:#0c2f2c;--cx-line:#175048;--cx-dim:#8fd0c4;--cx-accent:#2fe0bd}
.cx-theme-indigo{--cx-bg:linear-gradient(150deg,#0e1046 0%,#241a8c 55%,#3d1e9e 100%);
  --cx-surface:#1a1c5c;--cx-line:#33307f;--cx-dim:#aeb0e8;--cx-accent:#8f8bff}

/* Light. */
.cx-theme-mist{--cx-bg:#eef1f6;--cx-surface:#ffffff;--cx-line:#d5dbe6;
  --cx-text:#151922;--cx-dim:#5d6675;--cx-accent:#0090ab}
.cx-theme-paper{--cx-bg:linear-gradient(160deg,#fdfaf3 0%,#f4ece0 100%);
  --cx-surface:#fffdf8;--cx-line:#e3d9c8;--cx-text:#211c14;--cx-dim:#6b6152;
  --cx-accent:#b6712a}
.cx-theme-sky{--cx-bg:linear-gradient(160deg,#eaf4ff 0%,#d7e9fd 55%,#e9dcff 100%);
  --cx-surface:#ffffff;--cx-line:#cddcf0;--cx-text:#111a2b;--cx-dim:#586a86;
  --cx-accent:#2f6fd0}

/* One rule for every light theme, whatever its palette. */
.cx-light .cx-name,.cx-light .cx-hand{color:#fff}
.cx-light .cx-mini{background:rgba(0,0,0,.05)}
.cx-light .cx-mini:hover{background:rgba(0,0,0,.1)}
.cx-light .cx-ico{background:rgba(255,255,255,.88);color:#151922}
.cx-light .cx-btn.is-on{color:#06212b}
.cx-light .cx-choice2,.cx-light .cx-pick{background:rgba(0,0,0,.04)}
.cx-light .cx-pick:hover,.cx-light .cx-choice2:hover{background:rgba(0,0,0,.08)}
.cx-light .cx-emoji{background:rgba(0,0,0,.05)}
.cx-light .cx-file{background:rgba(0,0,0,.05)}
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
   on a wide monitor its width is decided entirely by how TALL the stage is:
   a 16:10 laptop screen in a 1900x530 box renders 848px wide and wastes more
   than half the width on black. The first live share of a browser window
   came out smaller than the browser window it was shared from.

   So while presenting the faces move OUT of the horizontal band under the
   share — which was costing the picture ~150px of height — and into a narrow
   column beside it. That column is close to free: the picture is limited by
   height, not width, so taking 160px off a 1900px stage does not shrink it
   at all, while the height it releases makes it about 28% wider.

   IT IS A COLUMN AND NOT AN OVERLAY, AND THAT WAS LEARNED THE HARD WAY.
   The first version floated the tiles over the bottom-left corner on the
   reasoning that a letterboxed share leaves black bar there. Sometimes it
   does. With three people in a meeting the row was ~400px wide and landed
   squarely on the shared window — the fix became the complaint, in a
   screenshot, within the hour. A layout that only works when you can guess
   the aspect ratio of somebody else's monitor is not a layout. Nothing
   overlaps now; the column is laid out, so it cannot cover anything. */
.cx-stage--focus{padding:0 8px 4px;gap:10px;flex-wrap:nowrap;
  align-items:stretch;justify-content:flex-start}
/* min-width:0 or the share refuses to shrink below its content and pushes
   the column off the edge — the flex default nobody expects. */
.cx-stage--focus .cx-tile--big{flex:1 1 auto;min-width:0}
.cx-strip--side{flex:0 0 160px;flex-direction:column;overflow-y:auto;
  overflow-x:hidden;padding:0;align-content:flex-start}
.cx-strip--side .cx-tile{flex:0 0 auto;width:100%;max-width:none;aspect-ratio:16/9}

/* ON A NARROW SCREEN THE TRADE GOES THE OTHER WAY, SO IT IS NOT MADE.
   A side column costs width, and width is what a phone has least of: 160px
   out of 390px would take 40% of the picture to show three thumbnails. Below
   900px everything returns to the original stacked shape — share on top,
   faces in a row beneath. */
@media (max-width:900px){
  .cx-stage--focus{flex-wrap:wrap}
  .cx-strip--side{flex:0 0 100%;width:100%;flex-direction:row;
    overflow-x:auto;overflow-y:hidden;margin-top:4px}
  .cx-strip--side .cx-tile{flex:0 0 104px;width:auto;max-width:104px}
}

/* flex + aspect-ratio. Never grid-cols-*: YZEN's own .grid flattens those. */
.cx-tile{position:relative;flex:1 1 clamp(240px,26vw,420px);max-width:640px;
  aspect-ratio:16/9;background:#000;border-radius:16px;overflow:hidden;
  border:1px solid var(--cx-line);transition:border-color .18s,box-shadow .18s}
.cx-tile--big{flex:1 1 100%;max-width:none;height:100%;aspect-ratio:auto}

/* ── THE GALLERY FITS THE STAGE. BOTH WAYS. ────────────────────────────────
   The flex rules above size a tile from its WIDTH and let the height follow
   from the aspect ratio. That is fine for four people and wrong for eight:
   the rows keep their height, the stage runs out of it, and overflow-y turns
   a meeting into a scrolling list — faces cut in half at the top and bottom,
   with no clue that the missing ones are a scroll away.

   So the gallery is a real grid whose column count is computed in JS from the
   measured stage (see the note above bestColumns in lib/pip.ts — the same
   function, because it is the same problem: fit N rectangles of roughly one
   shape into a box, largest-first). Rows are 1fr, so however many there are
   they divide the height that exists. Nothing can overflow, and nothing
   needs a scrollbar.

   The column count arrives as --cx-cols on the element. It is a NUMBER in a
   repeat(), not a class name, which also sidesteps the YZEN .grid collision
   the note above warns about. */
.cx-stage--grid{
  display:grid;
  grid-template-columns:repeat(var(--cx-cols,1),minmax(0,1fr));
  grid-auto-rows:minmax(0,1fr);
  align-content:stretch;justify-content:stretch;
  overflow:hidden;
}
.cx-stage--grid .cx-tile{
  flex:none;width:100%;height:100%;max-width:none;aspect-ratio:auto;
  min-width:0;min-height:0;
}
/* The people the cap left out, in a cell of their own — and a way in to the
   list of them, because a count you cannot expand is just bad news. */
.cx-gridmore{
  display:grid;place-content:center;justify-items:center;gap:3px;
  min-width:0;min-height:0;padding:8px;
  background:var(--cx-surface);border:1px solid var(--cx-line);
  border-radius:16px;color:var(--cx-dim);font-size:13px;font-weight:600;
  cursor:pointer;transition:background .16s,color .16s,border-color .16s;
}
.cx-gridmore:hover{background:rgba(255,255,255,.06);color:var(--cx-text);
  border-color:var(--cx-accent)}
.cx-gridmore small{font-size:10.5px;font-weight:500;opacity:.7}

.cx-more-chip{flex:0 0 auto}
.cx-more-chip:hover{border-color:var(--cx-accent)}
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
/* A touch screen has no hover, so hover-to-reveal means never-reveal. Pin
   would have been a desktop-only feature by accident. */
@media (hover:none){.cx-tileacts{opacity:1}}

@media (min-width:900px){
  .cx-root--panel .cx-mainpane{padding-right:360px;transition:padding-right .18s}
}
/* The rail sits ABOVE any panel: the way out of a meeting is never allowed
   to be the thing that gets covered. */
.cx-bar--left{z-index:1250}
.cx-more{z-index:1260}

/* ── THE CHAT BUBBLE ────────────────────────────────────────────────────
   Chat was buried in More, which is the wrong place for the one thing
   people reach for repeatedly during a meeting without wanting to lose
   sight of anybody. Bottom-right corner, out of the way of the rail, and
   it lifts above the control bar when the bar is along the bottom. */
/* Green, and clear of the edge. It was pink and pressed against the right
   side of the window, which reads as something half off-screen. The depth is
   a lit sphere: a highlight above, the body below, a soft ring and a cast
   shadow — flat circles look like stickers at this size. */
.cx-fab{position:fixed;right:28px;bottom:28px;z-index:1420;width:56px;height:56px;
  border-radius:50%;display:grid;place-items:center;cursor:pointer;font-size:23px;
  color:#04240f;border:1px solid rgba(255,255,255,.34);
  background:radial-gradient(120% 120% at 32% 22%,#7bf0ae 0%,#34d67f 42%,#18a75c 100%);
  box-shadow:0 12px 26px rgba(0,0,0,.42),0 2px 0 rgba(255,255,255,.42) inset,
    0 -8px 14px rgba(0,0,0,.22) inset;
  transition:transform .14s,box-shadow .14s}
.cx-fab:hover{transform:translateY(-3px);
  box-shadow:0 18px 34px rgba(0,0,0,.5),0 2px 0 rgba(255,255,255,.5) inset,
    0 -8px 14px rgba(0,0,0,.22) inset}
.cx-fab:active{transform:translateY(0)}
.cx-root--bar-bottom .cx-fab{bottom:112px}
/* Out of the way of an open panel rather than pinned under it. */
@media (min-width:900px){.cx-root--panel .cx-fab{right:388px}}
.cx-fab .cx-count{top:-4px;right:-4px}

/* Files in chat. A row, not a bubble: the name and the size are the two
   things you decide on before clicking. */
.cx-file{display:flex;align-items:center;gap:8px;margin-top:4px;padding:8px 10px;
  border-radius:10px;background:rgba(255,255,255,.06);border:1px solid var(--cx-line);
  color:var(--cx-text);text-decoration:none;font-size:13px}
.cx-file:hover{background:rgba(255,255,255,.12);color:var(--cx-text)}
.cx-file i{font-size:18px;color:var(--cx-accent);flex:0 0 auto}
.cx-file small{color:var(--cx-dim);margin-left:auto;flex:0 0 auto}

/* ── ICONS ON THE TILE, NOT WORDS. ──────────────────────────────────────
   Three word-pills across the corner of a 160px thumbnail covered the face
   they were about. Icons are a quarter of the width and survive a column
   tile; every one keeps a title and an aria-label, so the meaning is one
   hover or one screen-reader away rather than gone. */
.cx-ico{width:30px;height:30px;display:grid;place-items:center;padding:0;
  border-radius:9px;font-size:15px;line-height:1;cursor:pointer;
  background:rgba(10,10,14,.62);border:1px solid var(--cx-line);
  color:var(--cx-text);backdrop-filter:blur(6px);transition:background .15s}
.cx-ico:hover{background:rgba(10,10,14,.85)}
.cx-ico--on{background:var(--cx-accent);border-color:var(--cx-accent);color:#04222a}
.cx-ico--on:hover{background:var(--cx-accent)}
.cx-ico--bad:hover{background:#ef4757;border-color:#ef4757;color:#fff}

/* ── THE VIEW PANEL ─────────────────────────────────────────────────── */
.cx-choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}
.cx-choice2{display:flex;flex-direction:column;align-items:flex-start;gap:4px;
  padding:10px;border-radius:12px;cursor:pointer;text-align:left;
  background:rgba(255,255,255,.05);border:1px solid var(--cx-line);
  color:var(--cx-text);font-size:13px}
.cx-choice2:hover{background:rgba(255,255,255,.1)}
.cx-choice2.is-on{border-color:var(--cx-accent);background:rgba(0,184,217,.16)}
.cx-choice2 i{font-size:18px;color:var(--cx-accent)}
.cx-choice2 small{color:var(--cx-dim);font-size:11px;line-height:1.35}
/* ── ONE LINE PER DECISION. ─────────────────────────────────────────────
   The panel explained itself in paragraphs and cost a full screen of
   scrolling. A row of icons says the same thing in a strip: the name is on
   hover for a mouse and under the icon for a phone, where there is no
   hover to rely on. */
.cx-row-pick{display:flex;gap:6px;margin-bottom:4px}
.cx-pick{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;
  gap:3px;padding:9px 4px;border-radius:11px;cursor:pointer;font-size:10px;
  background:rgba(255,255,255,.05);border:1px solid var(--cx-line);
  color:var(--cx-dim);transition:background .14s,border-color .14s}
.cx-pick i{font-size:18px;color:var(--cx-text)}
.cx-pick:hover{background:rgba(255,255,255,.11)}
.cx-pick.is-on{border-color:var(--cx-accent);background:rgba(0,184,217,.16);
  color:var(--cx-text)}
.cx-pick.is-on i{color:var(--cx-accent)}
.cx-pick span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}

/* Colours need no words — the swatch IS the label. */
.cx-swatches{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:4px}
.cx-swatch{flex:0 0 46px;height:32px;border-radius:9px;cursor:pointer;
  border:2px solid transparent;box-shadow:0 0 0 1px var(--cx-line) inset;
  transition:transform .12s,border-color .14s}
.cx-swatch:hover{transform:translateY(-2px)}
.cx-swatch.is-on{border-color:var(--cx-accent)}

.cx-range{width:100%;accent-color:var(--cx-accent)}
.cx-switch{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:9px 2px;font-size:13px;cursor:pointer;border-bottom:1px solid var(--cx-line)}
.cx-switch:last-child{border-bottom:0}
.cx-switch input{accent-color:var(--cx-accent);width:17px;height:17px;cursor:pointer}
.cx-pill{border:none;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
  background:rgba(255,255,255,.15);color:#fff;backdrop-filter:blur(6px)}
.cx-pill:hover{background:rgba(255,255,255,.28)}
.cx-pill--bad{background:rgba(239,71,87,.85)}
.cx-pill--bad:hover{background:#ef4757}
/* A pin that is ON has to look different from one you could switch on, or
   the same button reads as both states. */
.cx-pill--on{background:var(--cx-accent);color:#04222a;font-weight:600}
.cx-pill--on:hover{background:var(--cx-accent)}

.cx-strip{flex:0 0 auto;display:flex;gap:8px;padding:0 16px 8px;overflow-x:auto}
.cx-strip .cx-tile{flex:0 0 168px;max-width:168px;border-radius:12px}

/* ═══════════════════════════════════════════════════════════════════════
   THE CONTROL BAR — POSITION IS THE PERSON'S CHOICE, NOT OURS.

   Every video product on earth centres a dark bar along the bottom, so any
   product that does the same reads as a copy of whichever one you used
   last. Rather than pick a different single answer and impose it, the bar
   moves: bottom, a rail down the left, or up beside the meeting name. The
   choice is remembered per browser.

   The rail and the top bar are LAID OUT, not floated over the video —
   floating something over a picture whose shape you cannot predict is the
   mistake this file already made once with the face strip.
   ═══════════════════════════════════════════════════════════════════════ */
.cx-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  gap:8px;flex-wrap:wrap;padding:14px 16px 18px}

/* The rail. A column, vertically centred, with the stage indented to match
   so no tile ever sits underneath it. */
.cx-bar--left{flex-direction:column;flex-wrap:nowrap;justify-content:flex-start;
  padding:8px;gap:6px;overflow-y:auto;max-height:100%;
  background:rgba(21,21,28,.72);border-right:1px solid var(--cx-line)}
/* The pane holds header, stage, strip and (when it is there) the bottom bar.
   It is a flex column in every mode; the only thing the rail changes is that
   the root becomes a ROW, with the rail as the first column. */
.cx-mainpane{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0}
.cx-root--bar-left{flex-direction:row}

/* Up in the header row, beside the meeting title. Compact — no labels, or
   the title would be pushed off a laptop screen. */
.cx-bar--top{padding:0;gap:6px;flex:1 1 auto;justify-content:flex-end;
  flex-wrap:wrap}
.cx-bar--top .cx-btn{min-width:0;padding:8px 10px;font-size:0;gap:0}
.cx-bar--top .cx-btn i{font-size:18px}

/* ── EVERY CONTROL ITS OWN COLOUR, WITHOUT LOSING WHAT IS ON. ────────────
   Amit asked for coloured buttons so the product does not read as a copy.
   The risk with that is real: when every button is bright, colour stops
   telling you anything and you can no longer see at a glance that your
   microphone is live.

   So colour means IDENTITY and weight means STATE. Each button keeps its
   own hue at low strength when idle; ON fills that hue solidly; the two
   controls that can be dangerously off — microphone and camera — turn red
   and change icon, which is a difference you can see without reading. */
.cx-btn{--tone:#8b8b9a}
.cx-btn{background:color-mix(in srgb,var(--tone) 20%,transparent);
  border-color:color-mix(in srgb,var(--tone) 38%,transparent)}
.cx-btn i{color:color-mix(in srgb,var(--tone) 88%,white)}
.cx-btn:hover{background:color-mix(in srgb,var(--tone) 34%,transparent)}
.cx-btn.is-on{background:var(--tone);border-color:var(--tone);color:#07131a}
.cx-btn.is-on i{color:#07131a}
.cx-btn.is-off{background:rgba(239,71,87,.9);border-color:#ef4757;color:#fff}
.cx-btn.is-off i{color:#fff}

.cx-btn--mic{--tone:#2ecc71}
.cx-btn--cam{--tone:#00b8d9}
.cx-btn--share{--tone:#7c5cff}
.cx-btn--view{--tone:#f5a623}
.cx-btn--full{--tone:#3ec9c9}
.cx-btn--mini{--tone:#4a90d9}
.cx-btn--hand{--tone:#ffb020}
.cx-btn--people{--tone:#22b8a6}
.cx-btn--chat{--tone:#e26bb0}
.cx-btn--set{--tone:#9aa1b1}
.cx-btn--rec{--tone:#ef6b6b}
.cx-btn--end{--tone:#c46a2f}
.cx-btn--react{--tone:#ffc247}
.cx-btn--more{--tone:#8b8b9a}
.cx-btn--leave{--tone:#ef4757;background:#ef4757;border-color:#ef4757;color:#fff}
.cx-btn--leave i{color:#fff}
.cx-btn--leave:hover{background:#ff5a69}

/* ── "OFF" IS DRAWN, NOT LOOKED UP. ─────────────────────────────────────
   The camera button rendered as an empty red pill for a whole afternoon
   because ri-vidicon-off-line does not exist in this icon font — a glyph
   that is missing costs nothing at build time and everything on screen,
   and in the compact bar there is no label to fall back on.

   So the OFF state no longer depends on a second icon existing. It reuses
   the icon that is already proven to render and strikes it through in CSS.
   Nothing to look up, nothing to 404, and the meaning is the universal
   one. Apply this to any future on/off control rather than hunting for an
   "-off" variant and hoping. */
.cx-btn.is-off i{position:relative}
.cx-btn.is-off i::after{content:"";position:absolute;left:-14%;top:46%;
  width:128%;height:2px;background:currentColor;transform:rotate(-45deg);
  border-radius:2px}

/* ── MORE ───────────────────────────────────────────────────────────────
   Twelve controls in a row wrapped onto two lines and pushed the meeting
   up the screen. Four stay out — microphone, camera, share, leave — and
   the rest live behind More, which is where every product this size ends
   up. Anchored to wherever the bar is, so it never opens off-screen. */
/* FIXED and above the panels (1200). It was absolute at z-index 40, which
   put it underneath an open side panel — so pressing More with View open
   looked like a dead button: the menu WAS opening, behind the panel. */
.cx-more{position:fixed;z-index:1400;display:flex;flex-direction:column;gap:4px;
  padding:8px;min-width:216px;max-height:70vh;overflow-y:auto;
  background:var(--cx-surface);border:1px solid var(--cx-line);
  border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.55)}
.cx-root--bar-bottom .cx-more{bottom:104px;left:50%;transform:translateX(-50%)}
.cx-root--bar-left .cx-more{left:92px;bottom:16px}
.cx-root--bar-top .cx-more{top:64px;right:16px}
/* With a panel open the menu would land on top of it. Slide it clear so both
   are readable at once. */
@media (min-width:900px){
  .cx-root--panel.cx-root--bar-top .cx-more{right:376px}
  .cx-root--panel.cx-root--bar-bottom .cx-more{left:auto;right:376px;transform:none}
}
.cx-more .cx-btn{flex-direction:row;justify-content:flex-start;gap:10px;
  width:100%;min-width:0;font-size:13px;padding:9px 12px;border-radius:11px}
.cx-more .cx-btn i{font-size:17px}
.cx-more-head{font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--cx-dim);padding:4px 6px 2px}

/* ── REACTIONS ──────────────────────────────────────────────────────────
   They float up over the meeting and disappear. No history, no storage,
   no row in a table: a reaction is a gesture, and a gesture that is still
   on screen a minute later has become a message. */
.cx-reacts{position:absolute;left:0;right:0;bottom:0;height:60%;
  pointer-events:none;z-index:30;overflow:hidden}
.cx-react{position:absolute;bottom:0;font-size:34px;line-height:1;
  animation:cx-float 3.4s ease-out forwards;
  filter:drop-shadow(0 3px 8px rgba(0,0,0,.5))}
.cx-react small{display:block;font-size:11px;text-align:center;color:var(--cx-text);
  background:rgba(0,0,0,.5);border-radius:6px;padding:1px 5px;margin-top:2px;
  max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes cx-float{
  0%{transform:translateY(0) scale(.6);opacity:0}
  12%{transform:translateY(-30px) scale(1.08);opacity:1}
  78%{opacity:1}
  100%{transform:translateY(-58vh) scale(.9);opacity:0}}
.cx-picker{display:flex;gap:6px;flex-wrap:wrap;padding:8px;max-width:230px}
.cx-emoji{font-size:24px;line-height:1;background:rgba(255,255,255,.06);
  border:1px solid var(--cx-line);border-radius:11px;padding:7px 9px;cursor:pointer;
  transition:transform .12s,background .15s}
.cx-emoji:hover{background:rgba(255,255,255,.14);transform:translateY(-2px) scale(1.08)}

/* ── THE RECORDING NOTICE, AS A PILL ────────────────────────────────────
   It was a full-width band under the header, which cost a row of the room
   permanently while recording. Beside the meeting name it is just as
   unmissable — it is red, it pulses, and it is at the top of the screen —
   without taking a stripe of the video away. Still not dismissible, and
   still driven by LiveKit's own flag rather than our state. */
.cx-recpill{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;
  background:rgba(239,71,87,.18);border:1px solid rgba(239,71,87,.55);
  color:#ff8b96;border-radius:999px;padding:4px 11px;font-size:12px;font-weight:600;
  white-space:nowrap}
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

/* ── A PANEL MUST NOT SWALLOW THE CONTROLS. ─────────────────────────────
   width was min(360px,100vw), so on a narrow window it became the WHOLE
   screen and buried the rail — the mute button vanished behind the View
   panel. It now always leaves the rail's width uncovered, and on a wide
   screen the meeting is INDENTED by the panel rather than hidden under it
   (the same lay-out-don't-overlay rule as the faces column). */
.cx-panel{position:fixed;top:0;right:0;bottom:0;width:min(360px,calc(100vw - 78px));z-index:1200;
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

/* ── A NAME IS NEVER ABBREVIATED. ──────────────────────────────────────────
   The host's controls used to share this line with the name, and five
   buttons in a 360px panel left the name about eight characters — so the
   panel whose whole job is telling you who is in the meeting was reporting
   "Shruti Sin…". The controls moved to their own wrapping line underneath;
   the name now takes the width it needs and wraps if it has to. */
.cx-row--person{align-items:center}
.cx-pname{font-size:13.5px;line-height:1.4;overflow-wrap:anywhere}
.cx-acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex:0 0 auto}

/* ── ROW ACTIONS ARE ICONS, AND THEY ARE VISIBLE. ──────────────────────────
   They were .cx-pill, which is a translucent white over whatever is behind
   it. Over video that reads; over the panel's own dark surface it came out
   as text with no button around it at all — reported, correctly, as "button
   not visible". These have a real background and a real border, and the one
   destructive action is the only coloured one. */
.cx-act{
  display:inline-grid;place-items:center;flex:0 0 auto;
  width:30px;height:30px;border-radius:9px;cursor:pointer;
  background:var(--cx-surface);border:1px solid var(--cx-line);color:var(--cx-text);
  transition:background .15s,border-color .15s,color .15s;
}
/* Hover changes the BORDER and the ink, never the fill. The gap under the
   diagonal is painted in the button's background colour, so a background that
   shifts on hover fills the gap in at exactly the moment somebody is looking
   at it. */
.cx-act:hover{border-color:var(--cx-accent);color:var(--cx-accent)}
/* Nothing left to do. Dimmed rather than hidden, because the icon is still
   saying something useful — that they are already muted, or already off. */
.cx-act:disabled{opacity:.42;cursor:default}
.cx-act:disabled:hover{border-color:var(--cx-line);color:var(--cx-text)}
.cx-act svg{width:16px;height:16px;display:block;fill:currentColor}
.cx-act i{font-size:16px;line-height:1}

/* Chat closed. Where the composer would have been, so the answer to "why is
   there no box" is in the place the box was. */
.cx-chatshut{
  display:flex;align-items:center;gap:9px;
  padding:11px 13px;border-radius:11px;
  background:rgba(255,255,255,.05);border:1px solid var(--cx-line);
  color:var(--cx-dim);font-size:12.5px;line-height:1.5;
}
.cx-light .cx-chatshut{background:rgba(0,0,0,.04)}
.cx-chatshut i{font-size:15px;flex:0 0 auto;color:var(--cx-dim)}
/* Putting a hand down is the answer to a request, so it reads as the friendly
   one of the five rather than another grey square. */
.cx-act--hand{border-color:rgba(46,204,113,.5);color:var(--cx-good)}
.cx-act--hand:hover{border-color:var(--cx-good);color:var(--cx-good)}
/* The gap under the diagonal is painted in the BUTTON's own background, so it
   is a hole whatever the theme makes that colour. */
.cx-act .cx-cut{stroke:var(--cx-surface);stroke-width:4.4;stroke-linecap:round;fill:none}
.cx-act .cx-line{stroke:currentColor;stroke-width:2.1;stroke-linecap:round;fill:none}
.cx-act--on{background:var(--cx-accent);border-color:var(--cx-accent);color:#04222a}
.cx-act--on .cx-cut{stroke:var(--cx-accent)}
.cx-act--bad{background:rgba(239,71,87,.92);border-color:#ef4757;color:#fff}
.cx-act--bad:hover{border-color:#fff;color:#fff}

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
