'use client';

// ============================================================================
//  Connect's own skin for the pages that live in the app shell.
// ============================================================================
//
//  WHY THIS FILE EXISTS RATHER THAN A CHANGE TO components/ui/Kit.tsx.
//
//  Kit is shared: Admin, Org, Family and Account all render the same Card,
//  Button, Table and Badge. Restyling Kit restyles the whole product, which is
//  a decision about TatvaOS rather than about Connect, and not one to make on
//  a Thursday afternoon. So this leaves Kit's MARKUP exactly as it is and
//  re-dresses it, scoped under one class that only Connect's layout applies.
//  Every rule below begins .cxs — remove the wrapper and the pages fall back
//  to the standard look with nothing else touched.
//
//  The room (RoomChrome.tsx) does the same thing for the same reason. This is
//  the shell half of that idea.
//
//  WHAT "PREMIUM" MEANT HERE, CONCRETELY. Not more decoration — less, applied
//  harder:
//    · one type scale with real contrast between levels, and negative tracking
//      on the large sizes, which is what stops a heading looking like body
//      text that happened to be bold;
//    · depth from two shadows rather than one — a 1px contact shadow that
//      keeps an edge crisp, and a wide soft one that lifts the card off the
//      page. A single blurry shadow reads as cheap because it has no contact;
//    · a table that stops announcing that it is a table: no rules, no boxes,
//      quiet uppercase headings, and the meeting itself given a face;
//    · the live meeting treated as an event rather than a row.
//
//  There is NO web font here on purpose. A font request is a network call, a
//  CSP entry and a decision about the whole product's voice. Weight, spacing
//  and colour do most of the work anyway.
// ============================================================================

const SKIN = `
.cxs{
  /* Connect's own tokens. Deliberately not the global ones: those are shared,
     and this file must not be able to change another module by accident. */
  --cxs-ink:#131a2a;
  --cxs-ink-2:#59627a;
  --cxs-ink-3:#8b93a8;
  --cxs-surface:#ffffff;
  --cxs-line:#e6eaf2;
  --cxs-soft:#eff2f7;
  --cxs-hover:#f6f8fc;
  --cxs-brand:#03b562;
  --cxs-brand-deep:#07834c;
  --cxs-radius:16px;
  /* Two shadows, always. The 1px one is contact; the wide one is lift. */
  --cxs-shadow:0 1px 2px rgba(16,24,40,.05), 0 10px 28px -16px rgba(16,24,40,.22);
  --cxs-lift:0 2px 4px rgba(16,24,40,.06), 0 20px 44px -20px rgba(16,24,40,.34);
  color:var(--cxs-ink);
  position:relative;
  z-index:0;
}

.dark .cxs{
  --cxs-ink:#e8eaf1;
  --cxs-ink-2:#a4abbd;
  --cxs-ink-3:#7d8497;
  --cxs-surface:#232327;
  --cxs-line:#33343c;
  --cxs-soft:#2b2c33;
  --cxs-hover:rgba(255,255,255,.035);
  --cxs-shadow:0 1px 2px rgba(0,0,0,.45), 0 12px 32px -18px rgba(0,0,0,.9);
  --cxs-lift:0 2px 6px rgba(0,0,0,.5), 0 22px 48px -22px rgba(0,0,0,1);
}

/* A wash of colour at the top of the page. Fixed, so it does not slide away
   on scroll, and pinned behind the content by the stacking context .cxs
   opens above — it can never end up over a button. */
.cxs::before{
  content:'';position:fixed;left:0;right:0;top:0;height:440px;
  pointer-events:none;z-index:-1;
  background:
    radial-gradient(900px 380px at 18% -10%, rgba(3,181,98,.075), transparent 62%),
    radial-gradient(820px 340px at 88% -4%, rgba(84,124,255,.055), transparent 60%);
}
.dark .cxs::before{
  background:
    radial-gradient(900px 380px at 18% -10%, rgba(3,181,98,.10), transparent 62%),
    radial-gradient(820px 340px at 88% -4%, rgba(84,124,255,.08), transparent 60%);
}

/* ── The page's own heading ────────────────────────────────────────────── */
.cxs .page-header-breadcrumb{margin:26px 0 20px}
.cxs .page-title{
  font-size:27px;font-weight:660;letter-spacing:-.022em;line-height:1.14;
  color:var(--cxs-ink);margin-bottom:5px;
}
.cxs .breadcrumb{font-size:12.5px}
.cxs .breadcrumb-item,.cxs .breadcrumb-item.active{
  color:var(--cxs-ink-3);letter-spacing:.005em;
}

/* ── Cards ────────────────────────────────────────────────────────────── */
.cxs .card.custom-card{
  background:var(--cxs-surface);
  border:1px solid var(--cxs-line);
  border-radius:var(--cxs-radius);
  box-shadow:var(--cxs-shadow);
  margin-bottom:18px;
  overflow:hidden;
}
.cxs .card.custom-card .card-header{
  padding:17px 20px 14px;
  background:transparent;
  border-bottom:1px solid var(--cxs-soft);
}
.cxs .card.custom-card .card-title{
  font-size:15px;font-weight:640;letter-spacing:-.012em;color:var(--cxs-ink);
}
.cxs .card.custom-card .card-title .text-muted{
  color:var(--cxs-ink-3);letter-spacing:0;font-weight:400;
}
.cxs .card.custom-card .card-body{padding:18px 20px}

/* ── Buttons ──────────────────────────────────────────────────────────── */
.cxs .btn{
  border-radius:10px;border:1px solid transparent;
  padding:9px 15px;font-size:13.5px;font-weight:600;letter-spacing:-.004em;
  line-height:1.25;
  transition:transform .12s ease, box-shadow .18s ease, background .18s ease,
             border-color .18s ease;
}
.cxs .btn:active{transform:translateY(1px)}
.cxs .btn i{vertical-align:-.09em}

/* The gradient runs light-to-dark downward and carries a 1px inner highlight
   along its top edge. That highlight is the whole trick: it is what a raised
   physical control does to light, and its absence is why a flat fill reads as
   a coloured rectangle. */
.cxs .btn-primary{
  background:linear-gradient(180deg,#13c877 0%,#04a75c 100%);
  border-color:#048a4e;color:#fff;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.30),
             0 8px 18px -9px rgba(3,166,92,.85);
}
.cxs .btn-primary:hover{
  background:linear-gradient(180deg,#18d382 0%,#06b365 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.34),
             0 11px 22px -9px rgba(3,166,92,.95);
}
.cxs .btn-primary:disabled{
  background:#a9d9c2;border-color:#a9d9c2;box-shadow:none;opacity:1;color:#f4fffa;
}
.cxs .btn-outline-light,.cxs .btn-light{
  background:var(--cxs-surface);border-color:var(--cxs-line);color:var(--cxs-ink);
  box-shadow:0 1px 2px rgba(16,24,40,.05);
}
.cxs .btn-outline-light:hover,.cxs .btn-light:hover{
  background:var(--cxs-hover);border-color:#d9dfea;color:var(--cxs-ink);
}
.dark .cxs .btn-outline-light:hover,.dark .cxs .btn-light:hover{border-color:#41434c}
.cxs .btn-danger{
  background:linear-gradient(180deg,#f45b66 0%,#dc3543 100%);
  border-color:#c62b39;color:#fff;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.26),
             0 8px 18px -9px rgba(220,53,67,.8);
}
.cxs .btn-sm{padding:6px 11px;font-size:12.5px;border-radius:8px}

/* ── Tabs, as a segmented control ─────────────────────────────────────── */
/* The old look was a green pill on a white card, which is a lot of colour
   spent on "which of three lists am I looking at". A track with a raised
   thumb says the same thing and keeps the green for the one button on the
   page that actually starts something. */
.cxs .nav-pills{
  display:inline-flex;background:var(--cxs-soft);border-radius:12px;padding:4px;
}
.cxs .nav-pills .nav-link{
  border:0;border-radius:9px;padding:7px 15px;
  font-size:13px;font-weight:600;letter-spacing:-.004em;
  color:var(--cxs-ink-2);background:transparent;
  transition:background .16s ease, color .16s ease, box-shadow .16s ease;
}
.cxs .nav-pills .nav-link:hover{color:var(--cxs-ink)}
.cxs .nav-pills .nav-link.active{
  background:var(--cxs-surface);color:var(--cxs-ink);
  box-shadow:0 1px 2px rgba(16,24,40,.07), 0 3px 10px -3px rgba(16,24,40,.18);
}

/* ── Tables that do not look like tables ──────────────────────────────── */
.cxs .table{margin:0;border-color:transparent}
.cxs .table>thead>tr>th{
  border:0;background:transparent;padding:12px 20px 10px;
  font-size:10.5px;font-weight:650;letter-spacing:.085em;text-transform:uppercase;
  color:var(--cxs-ink-3);
}
.cxs .table>tbody>tr>td{
  border:0;border-top:1px solid var(--cxs-soft);
  padding:13px 20px;vertical-align:middle;
  font-size:13.5px;color:var(--cxs-ink-2);
}
.cxs .table>tbody>tr:hover>td{background:var(--cxs-hover)}
.cxs .table>tbody>tr>td a{color:var(--cxs-ink);text-decoration:none}
.cxs .table>tbody>tr>td a:hover{color:var(--cxs-brand-deep)}
/* The name column is the one anybody scans. Give it room before the columns
   that are only ever glanced at. */
.cxs .table>thead>tr>th:first-child,
.cxs .table>tbody>tr>td:first-child{min-width:200px}

/* ── The meeting itself, given a face ─────────────────────────────────── */
.cxs .cx-who{display:flex;align-items:center;gap:12px;min-width:0}
/* Without this the name refuses to ellipsis and pushes the row wide. */
.cxs .cx-who>div{min-width:0}
.cxs .cx-face{
  flex:0 0 auto;display:grid;place-items:center;color:#fff;
  width:36px;height:36px;border-radius:11px;
  font-size:14px;font-weight:650;letter-spacing:-.01em;
  box-shadow:0 6px 14px -9px rgba(16,24,40,.9);
}
.cxs .cx-face--lg{width:44px;height:44px;border-radius:13px;font-size:17px}
/* Colour by name, not by chance, so the same meeting looks the same tomorrow. */
.cxs .cx-t0{background:linear-gradient(140deg,#16c186,#08805c)}
.cxs .cx-t1{background:linear-gradient(140deg,#5a90f8,#2a4ed2)}
.cxs .cx-t2{background:linear-gradient(140deg,#a874f6,#6c33c6)}
.cxs .cx-t3{background:linear-gradient(140deg,#f2965d,#d3612b)}
.cxs .cx-t4{background:linear-gradient(140deg,#33bccd,#127b94)}
.cxs .cx-t5{background:linear-gradient(140deg,#ea6d92,#ba2d62)}

.cxs .cx-name{
  font-size:14px;font-weight:620;letter-spacing:-.012em;color:var(--cxs-ink);
  text-decoration:none;display:inline-block;max-width:100%;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;
}
.cxs .cx-name:hover{color:var(--cxs-brand-deep)}
.cxs .cx-sub{
  font-size:12px;color:var(--cxs-ink-3);margin-top:2px;
  display:flex;align-items:center;gap:7px;flex-wrap:wrap;
}

/* ── A meeting code is data, so it is set as data ─────────────────────── */
.cxs .cx-code{
  display:inline-block;
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-size:11.5px;letter-spacing:.02em;color:var(--cxs-ink-2);
  background:var(--cxs-soft);border:1px solid var(--cxs-line);
  padding:3px 8px;border-radius:7px;white-space:nowrap;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;
}
/* A code is six groups of letters and takes real width. On a narrow window it
   gives way before the columns that carry meaning; the full code is on the
   meeting's own page and in the Copy button, so nothing is lost. */
@media (max-width:1500px){
  .cxs .table .cx-code{max-width:150px}
}

/* ── Status ───────────────────────────────────────────────────────────── */
/* A dot in front does the reading at a glance; the word is for confirming. */
.cxs .badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 10px 4px 8px;border-radius:999px;
  font-size:11px;font-weight:640;letter-spacing:.012em;text-transform:capitalize;
}
.cxs .badge::before{
  content:'';width:6px;height:6px;border-radius:50%;
  background:currentColor;opacity:.95;flex:0 0 auto;
}

/* ── Happening now ────────────────────────────────────────────────────── */
/* A live meeting is the only thing on this page with a deadline attached, so
   it gets the one tinted surface and the one moving element. */
.cxs .cx-live.card.custom-card{
  border-color:rgba(3,181,98,.30);
  background:
    linear-gradient(135deg, rgba(3,181,98,.085) 0%, rgba(3,181,98,.02) 44%,
      rgba(255,255,255,0) 72%),
    var(--cxs-surface);
  box-shadow:var(--cxs-lift);
}
.cxs .cx-live .card-header{border-bottom-color:rgba(3,181,98,.20)}

/* The live dot is a pseudo-element on the heading rather than a span in the
   markup, because Card takes its title as a STRING — and widening that prop
   to accept nodes would change a component four other modules render. The
   ring is an animated box-shadow for the same reason a pseudo-element cannot
   have a pseudo-element of its own. */
.cxs .cx-live .card-title{display:flex;align-items:center;gap:9px}
.cxs .cx-live .card-title::before{
  content:'';flex:0 0 auto;width:9px;height:9px;border-radius:50%;
  background:var(--cxs-brand);
  animation:cxs-pulse 2s ease-out infinite;
}
@keyframes cxs-pulse{
  0%{box-shadow:0 0 0 0 rgba(3,181,98,.55)}
  72%{box-shadow:0 0 0 9px rgba(3,181,98,0)}
  100%{box-shadow:0 0 0 0 rgba(3,181,98,0)}
}
/* Somebody who has asked for less movement should not be given a heartbeat. */
@media (prefers-reduced-motion:reduce){
  .cxs .cx-live .card-title::before{animation:none;box-shadow:0 0 0 4px rgba(3,181,98,.22)}
}

.cxs .cx-liverow{
  display:flex;align-items:center;justify-content:space-between;
  gap:14px;flex-wrap:wrap;padding:4px 0;
}
.cxs .cx-liverow + .cx-liverow{
  border-top:1px solid rgba(3,181,98,.16);margin-top:10px;padding-top:14px;
}
/* Joining is the only thing anybody came to this card to do. */
.cxs .cx-liverow .btn{padding:10px 20px;font-size:14px}

/* ── Forms ────────────────────────────────────────────────────────────── */
.cxs .form-control,.cxs .form-select{
  border-radius:10px;border:1px solid var(--cxs-line);
  background-color:var(--cxs-surface);color:var(--cxs-ink);
  font-size:13.5px;
  box-shadow:0 1px 2px rgba(16,24,40,.04);
  transition:border-color .15s ease, box-shadow .15s ease;
}
.cxs .form-control{padding:10px 13px}
/* background-COLOR only, never the shorthand: Bootstrap draws the chevron with
   a background-image, and the right padding below is the space it needs. Set
   the shorthand here and every select loses its arrow. */
.cxs .form-select{padding:10px 38px 10px 13px}
.cxs .form-control::placeholder{color:var(--cxs-ink-3)}
.cxs .form-control:focus,.cxs .form-select:focus{
  border-color:#4ed49d;box-shadow:0 0 0 4px rgba(3,181,98,.15);
}
.cxs .form-label{
  font-size:13px;font-weight:620;letter-spacing:-.006em;
  color:var(--cxs-ink);margin-bottom:6px;
}
/* Help text is for the person who needs it and should be invisible to the
   person who does not. Measured, not just small: past about 70 characters a
   line stops being scannable. */
.cxs .form-text{
  font-size:12px;line-height:1.55;color:var(--cxs-ink-3);
  margin-top:6px;max-width:68ch;
}
.cxs .form-check-input{
  width:17px;height:17px;margin-top:.18em;border-radius:5px;
  border:1px solid #cdd4e0;box-shadow:0 1px 2px rgba(16,24,40,.05);
}
.cxs .form-check-input:checked{background-color:var(--cxs-brand);border-color:#059c56}
.cxs .form-check-input:focus{box-shadow:0 0 0 4px rgba(3,181,98,.15);border-color:#4ed49d}
.cxs .form-check-label{font-size:13.5px;font-weight:560;color:var(--cxs-ink)}
/* Each field its own band, so a long form reads as a sequence of decisions
   rather than one wall. The last one drops the rule so the card does not end
   on a line. */
.cxs form .card-body>.mb-3,
.cxs form .card-body>.row,
.cxs form .card-body>.form-check{
  padding-bottom:16px;margin-bottom:16px;
  border-bottom:1px solid var(--cxs-soft);
}
/* Starts and Ends are one decision on two controls, so the pair keeps the
   band's spacing and the columns inside it stop adding their own. */
.cxs form .card-body>.row>[class*="col-"]{margin-bottom:0}
.cxs form .card-body>.d-flex{padding-top:2px}
.cxs .text-muted{color:var(--cxs-ink-3)}

/* The join field and its button are one control, so they are drawn as one. */
.cxs .input-group>.form-control{
  border-top-right-radius:0;border-bottom-right-radius:0;border-right:0;
}
.cxs .input-group>.btn{
  border-top-left-radius:0;border-bottom-left-radius:0;padding-inline:18px;
}

/* ── Everything else that shows up on these three pages ───────────────── */
.cxs .alert{border-radius:12px;padding:12px 16px;font-size:13.5px;border:1px solid}
.cxs .alert-danger{background:#fff1f2;border-color:#fecdd3;color:#a01133}
.dark .cxs .alert-danger{background:rgba(220,53,67,.12);border-color:rgba(220,53,67,.4);color:#ffb3bb}
.cxs .progress{border-radius:999px;background:var(--cxs-soft)}
.cxs .progress-bar{border-radius:999px}
.cxs .table-responsive{border:0}
.cxs hr{border-color:var(--cxs-soft);opacity:1}
`;

/**
 * Wraps Connect's shell pages and carries the stylesheet with them.
 *
 * A plain <style> element with a string child, not dangerouslySetInnerHTML —
 * which eslint forbids as an error everywhere but the one audited file that
 * renders mail bodies.
 */
export function ConnectSkin({ children }: { children: React.ReactNode }) {
  return (
    <div className="cxs">
      <style>{SKIN}</style>
      {children}
    </div>
  );
}

/**
 * Which of the six face colours a name gets.
 *
 * Deterministic, so a meeting is the same colour every time anybody looks at
 * it — a colour that changes on reload is decoration, whereas one that does
 * not becomes something you recognise a row by.
 */
export function toneOf(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 'cx-t' + String(h % 6);
}

/** First letter, for the face. Falls back rather than rendering an empty box. */
export function faceOf(name: string): string {
  const t = name.trim();
  return t.length > 0 ? t[0]!.toUpperCase() : '•';
}
