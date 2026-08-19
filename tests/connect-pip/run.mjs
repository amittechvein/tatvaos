// ============================================================================
//  The Picture-in-Picture grid, tested against a fake DOM.
//
//  Run it:   bash infra/scripts/connect-pip-test.sh
//
//  WHAT THIS IS FOR
//
//  lib/pip.ts builds plain DOM by hand, because React's event system does not
//  survive being re-parented into another window (see note 3 in that file).
//  Hand-built DOM means hand-written reconciliation, and hand-written
//  reconciliation is where the two bugs nobody sees in development live:
//
//    · REBUILDING. Tear the grid down on every render and every video
//      re-attaches. A re-attached video restarts — black frame, flicker, and
//      on a weak connection a real stall. On a developer machine with a fast
//      link it looks fine, which is exactly why it needs a test rather than
//      an eye.
//
//    · LEAKING. Drop a tile without detaching its track and the SDK keeps
//      decoding video nobody can see. It costs battery on a laptop and frames
//      on the box, and there is nothing on screen to notice.
//
//  So the assertions below are about ORDER and about the SET of tracks
//  currently held, not about markup. The fake DOM exists only to give the real
//  file something to build into.
//
//  It imports the COMPILED lib/pip.ts, not a copy — the runner script compiles
//  the real file with the repo's own TypeScript before this runs.
// ============================================================================

import { bestColumns, tileBudget, openPipWindow } from './build/pip.js';

let pass = 0, fail = 0;
const ok = (what, cond) => { cond ? (pass++, console.log(`    ok  ${what}`))
                                  : (fail++, console.log(`  FAIL  ${what}`)); };
const section = (t) => console.log(`\n  ${t}`);

// ── fake DOM ────────────────────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null;
    this.style = {}; this._class = ''; this.textContent = '';
    this.listeners = {}; this.offsetHeight = 30;
    this.classList = {
      toggle: (name, on) => {
        const set = new Set(this._class.split(' ').filter(Boolean));
        if (on) set.add(name); else set.delete(name);
        this._class = [...set].join(' ');
      },
      contains: (name) => this._class.split(' ').includes(name),
    };
  }
  get className() { return this._class; }
  set className(v) { this._class = v; }
  append(...kids) {
    for (const k of kids) {
      if (k.parent) k.parent.children = k.parent.children.filter((c) => c !== k);
      k.parent = this; this.children.push(k);
    }
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  querySelectorAll(sel) {
    const want = sel.replace('.', '');
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c._class.split(' ').includes(want)) out.push(c); walk(c); } };
    walk(this); return out;
  }
}

const doc = {
  head: new El('head'),
  body: new El('body'),
  createElement: (tag) => new El(tag),
  createTextNode: (t) => ({ text: t }),
};

const pipWindow = {
  document: doc,
  innerWidth: 420,
  innerHeight: 300,
  listeners: {},
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
  fire(t) { for (const fn of this.listeners[t] ?? []) fn(); },
  close() {},
};

globalThis.window = { documentPictureInPicture: { requestWindow: async () => pipWindow } };

// ── attach/detach bookkeeping ───────────────────────────────────────────────
// Two views of the same thing. `log` is the ORDER of calls, which is what
// catches an attach that happens before its detach; `attached` is the SET
// currently held, which is what catches a leak. A tally of one against the
// other proved nothing the first time this was written — it agreed with a
// version that never detached anything at all.
const log = [];
const attached = new Set();
const tile = (id, over = {}) => ({
  id, name: id, initial: id[0].toUpperCase(),
  trackId: over.trackId ?? '',
  attach: () => { log.push(`attach:${id}`); attached.add(id); },
  detach: () => { log.push(`detach:${id}`); attached.delete(id); },
  ...over,
});

const handles = await openPipWindow({ onToggleMute() {}, onReturn() {}, onClosed() {} });
const grid = () => doc.body.children[0].children[0];
const tiles = () => grid().children.filter((c) => c._class.includes('tile'));

section('layout — columns fit the window, not a constant');
ok('one person fills the window', bestColumns(1, 420, 270) === 1);
ok('two side by side in a wide window', bestColumns(2, 420, 270) === 2);
ok('two stacked in a TALL window', bestColumns(2, 260, 500) === 1);
ok('four make a 2×2 in a squarish window', bestColumns(4, 400, 300) === 2);
ok('six in a wide short window go 3 across', bestColumns(6, 640, 240) === 3);
ok('nine make a 3×3', bestColumns(9, 400, 320) === 3);
ok('zero and one never divide by zero', bestColumns(0, 400, 300) === 1 && bestColumns(1, 1, 1) === 1);
ok('a taller window gives FEWER columns for the same count',
   bestColumns(6, 300, 600) < bestColumns(6, 600, 300));

section('budget — a 320px window does not draw twenty smudges');
// The number itself is not the contract — the TILE SIZE is. Assert that,
// so the constants can be tuned without the test having to be rewritten to
// agree with whatever they became.
for (const [w, h] of [[320, 200], [420, 270], [640, 400], [900, 700], [240, 520]]) {
  const b = tileBudget(w, h);
  const cols = bestColumns(b, w, h);
  const rows = Math.ceil(b / cols);
  ok(`${w}×${h}: ${b} tiles stay at least 60×45 (${Math.round(w / cols)}×${Math.round(h / rows)})`,
     w / cols >= 60 && h / rows >= 45);
}
ok('a large window holds more', tileBudget(900, 700) > tileBudget(320, 200));
ok('never zero, however small', tileBudget(1, 1) === 1);
ok('capped, however large — sixteen faces is already unreadable', tileBudget(4000, 3000) === 16);

section('reconcile — the same person is not rebuilt');
handles.setTiles([tile('asha', { trackId: 't1' }), tile('ravi', { trackId: 't2' })]);
ok('two tiles drawn', tiles().length === 2);
ok('both videos attached once', log.filter((l) => l.startsWith('attach')).length === 2);

const first = tiles()[0];
log.length = 0;
handles.setTiles([tile('asha', { trackId: 't1', speaking: true }), tile('ravi', { trackId: 't2' })]);
ok('a re-render with the same tracks attaches NOTHING again', log.length === 0);
ok('and reuses the very same element — no flicker', tiles()[0] === first);
ok('speaking is shown with a ring, not a rebuild', tiles()[0]._class.includes('spk'));

log.length = 0;
handles.setTiles([tile('asha', { trackId: 't9' }), tile('ravi', { trackId: 't2' })]);
// ORDER, not just presence. Attaching the new track before releasing the old
// one leaves two elements holding the same track for an instant, and the SDK
// stops the first — a black tile that only ever appears on a camera switch.
ok('changing the track detaches the old one BEFORE attaching the new',
   log.join(',') === 'detach:asha,attach:asha');
ok('and the tile is still holding a track afterwards', attached.has('asha'));

log.length = 0;
handles.setTiles([tile('ravi', { trackId: 't2' })]);
ok('someone leaving is detached, not leaked',
   log.length === 1 && log[0].startsWith('detach:asha'));
ok('and their tile is removed', tiles().length === 1);

section('camera off shows the photo, not a black rectangle');
handles.setTiles([tile('sam', { trackId: '' })]);
const sam = tiles()[0];
ok('the video element is hidden', sam.children[0].style.display === 'none');
ok('the initial circle is shown', sam.children[1].style.display === 'grid');
ok('and the initial is the letter', sam.children[1].children[0].textContent === 'S');

section('a shared screen takes the width and is fitted, not cropped');
handles.setTiles([
  { ...tile('screen-ravi', { trackId: 's1' }), screen: true },
  tile('asha', { trackId: 't1' }),
  tile('ravi', { trackId: '' }),
]);
const scr = tiles().find((t) => t._class.includes('scr'));
ok('the screen tile is marked', scr !== undefined);
ok('and spans every column', scr.style.gridColumn === '1 / -1');
ok('the people are still there under it', tiles().length === 3);

section('overflow — the count is honest');
pipWindow.innerWidth = 200; pipWindow.innerHeight = 140;
handles.setTiles(Array.from({ length: 12 }, (_, i) => tile(`p${i}`, { trackId: `t${i}` })));
const more = grid().children.find((c) => c._class.includes('more'));
ok('a chip appears when there is no room for everyone', more !== undefined);
const drawn = tiles().length;
ok('and the chip counts exactly what is not drawn',
   more.textContent === `+${12 - drawn} more`);
ok('nothing is attached that is not on screen — no track left running off-window',
   attached.size === drawn);

section('resize — dragging the window bigger shows more of the room');
const before = tiles().length;
pipWindow.innerWidth = 900; pipWindow.innerHeight = 700;
handles.setTiles(Array.from({ length: 12 }, (_, i) => tile(`p${i}`, { trackId: `t${i}` })));
ok('a bigger window draws more faces', tiles().length > before);
pipWindow.fire('resize');
ok('and a bare resize event re-lays out without a crash', tiles().length > before);

section('closing detaches everything');
log.length = 0;
const attachedNow = tiles().length;
for (const fn of pipWindow.listeners['pagehide'] ?? []) fn();
ok('every attached track is released on close', attached.size === 0 && attachedNow > 0);

console.log(`\n  ═════════════════════════════════════════\n  ${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
