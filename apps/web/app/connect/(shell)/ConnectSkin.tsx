'use client';

import { useState } from 'react';

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

/* ── A choice you can see without opening it ──────────────────────────── */
/* A <select> hides every option but one, so choosing means opening a menu,
   reading, and closing it again — for a decision like "who has to wait in the
   lobby", which is worth seeing all of at once. These are radio buttons
   wearing cards: real inputs, real keyboard behaviour, real form semantics. */
.cxs .cx-choices{display:grid;gap:10px}
.cxs .cx-choices--2{grid-template-columns:repeat(2,minmax(0,1fr))}
.cxs .cx-choices--3{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:1100px){
  .cxs .cx-choices--2,.cxs .cx-choices--3{grid-template-columns:1fr}
}
.cxs .cx-choice{
  position:relative;display:block;cursor:pointer;
  padding:13px 14px 13px 42px;
  border:1px solid var(--cxs-line);border-radius:12px;background:var(--cxs-surface);
  box-shadow:0 1px 2px rgba(16,24,40,.04);
  transition:border-color .16s ease, box-shadow .16s ease, background .16s ease;
}
.cxs .cx-choice:hover{border-color:#c8d2e1;background:var(--cxs-hover)}
/* The input is still there and still focusable — it is only invisible. Hiding
   it with display:none would take it out of the tab order and off the arrow
   keys, which is most of what a radio group is for. */
.cxs .cx-choice input{position:absolute;opacity:0;width:0;height:0}
.cxs .cx-choice .cx-tick{
  position:absolute;left:14px;top:15px;width:18px;height:18px;border-radius:50%;
  border:1.5px solid #c6cede;background:var(--cxs-surface);
  transition:background .16s ease, border-color .16s ease;
}
.cxs .cx-choice .cx-tick::after{
  content:'';position:absolute;inset:4px;border-radius:50%;background:#fff;
  transform:scale(0);transition:transform .16s ease;
}
.cxs .cx-choice.is-on{
  border-color:rgba(3,181,98,.55);
  background:linear-gradient(135deg,rgba(3,181,98,.075),rgba(3,181,98,.015) 62%),
    var(--cxs-surface);
  box-shadow:0 0 0 3px rgba(3,181,98,.13), 0 6px 16px -11px rgba(3,181,98,.85);
}
.cxs .cx-choice.is-on .cx-tick{background:var(--cxs-brand);border-color:#059c56}
.cxs .cx-choice.is-on .cx-tick::after{transform:scale(1)}
.cxs .cx-choice input:focus-visible ~ .cx-tick{
  box-shadow:0 0 0 4px rgba(3,181,98,.22);
}
.cxs .cx-choice b{
  display:block;font-size:13.5px;font-weight:640;letter-spacing:-.008em;
  color:var(--cxs-ink);
}
.cxs .cx-choice .cx-note{
  display:block;font-size:12px;line-height:1.5;color:var(--cxs-ink-3);margin-top:3px;
}
.cxs .cx-choices--tight .cx-choice{padding:10px 12px 10px 38px}
.cxs .cx-choices--tight .cx-tick{top:11px;left:12px;width:16px;height:16px}

/* ── The explanation, on request ──────────────────────────────────────── */
/* The long version was written for a reason and is not being deleted — it is
   being moved one click away, so the form reads as seven decisions rather
   than seven paragraphs. */
.cxs .cx-lab{display:flex;align-items:center;margin-bottom:6px}
.cxs .cx-lab .form-label{margin-bottom:0}
/* Starts and Ends are parts of one decision, so their labels sit a level
   below the field's own. */
.cxs .cx-sublab{
  display:block;margin-bottom:5px;
  font-size:10.5px;font-weight:650;letter-spacing:.085em;text-transform:uppercase;
  color:var(--cxs-ink-3);
}
.cxs .cx-q{
  display:inline-grid;place-items:center;flex:0 0 auto;
  width:16px;height:16px;margin-left:7px;border-radius:50%;
  border:1px solid var(--cxs-line);background:var(--cxs-soft);color:var(--cxs-ink-3);
  font-size:10px;font-weight:700;line-height:1;cursor:pointer;
  transition:background .15s ease, color .15s ease, border-color .15s ease;
}
.cxs .cx-q:hover{color:var(--cxs-ink);border-color:#c8d2e1}
.cxs .cx-q[aria-expanded="true"]{
  background:var(--cxs-brand);border-color:#059c56;color:#fff;
}
.cxs .cx-why{
  margin-top:9px;padding:10px 13px;border-radius:10px;
  background:var(--cxs-soft);border:1px solid var(--cxs-line);
  font-size:12px;line-height:1.6;color:var(--cxs-ink-2);max-width:70ch;
}

/* One band per decision. .cx-field replaces the .mb-3 rule for forms that
   have been rebuilt; the older rule still covers the ones that have not. */
.cxs .cx-field{
  padding-bottom:17px;margin-bottom:17px;border-bottom:1px solid var(--cxs-soft);
}
/* The last field keeps its rule on purpose — it is what separates the
   decisions from the button that acts on them. */
.cxs .cx-field>.row>[class*="col-"]{margin-bottom:0}

/* ── What you are about to create ─────────────────────────────────────── */
/* The form is a list of settings; this is the thing those settings make. It
   follows the page down, because the answer to "wait, did I set the waiting
   room" should never be a scroll. */
.cxs .cx-sum{position:sticky;top:18px}
.cxs .cx-sum-title{
  font-size:19px;font-weight:660;letter-spacing:-.018em;color:var(--cxs-ink);
  overflow-wrap:anywhere;
}
.cxs .cx-sum-title.is-empty{color:var(--cxs-ink-3);font-weight:540}
.cxs .cx-sum-when{font-size:13px;color:var(--cxs-ink-2);margin-top:5px}
.cxs .cx-sum-list{
  margin:15px 0 0;padding:0;list-style:none;border-top:1px solid var(--cxs-soft);
}
.cxs .cx-sum-list li{
  display:flex;align-items:baseline;justify-content:space-between;gap:14px;
  padding:9px 0;border-bottom:1px solid var(--cxs-soft);font-size:12.5px;
}
.cxs .cx-sum-k{color:var(--cxs-ink-3);flex:0 0 auto}
.cxs .cx-sum-v{color:var(--cxs-ink);font-weight:580;text-align:right}
.cxs .cx-sum-v.is-warn{color:#b4690e}
.cxs .cx-sum-note{
  font-size:11.5px;line-height:1.6;color:var(--cxs-ink-3);margin-top:13px;
}

/* ── One meeting's own heading ────────────────────────────────────────── */
.cxs .cx-head{
  display:flex;align-items:center;justify-content:space-between;
  gap:16px;flex-wrap:wrap;margin:26px 0 20px;
}
.cxs .cx-head .page-title{font-size:24px;letter-spacing:-.021em}
.cxs .cx-face--xl{width:52px;height:52px;border-radius:15px;font-size:21px}
.cxs .cx-headmeta{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  margin-top:7px;font-size:12.5px;color:var(--cxs-ink-3);
}

/* ── The code, set to be read aloud ───────────────────────────────────── */
/* It is here for the person whose link did not survive a chat app, and it
   gets read out over a phone. A form field at 13px is where an l and a 1 stop
   being different characters. */
.cxs .cx-bigcode{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin-top:2px;padding:12px 12px 12px 14px;border-radius:12px;
  border:1px dashed var(--cxs-line);background:var(--cxs-soft);
}
.cxs .cx-bigcode>span{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-size:14px;font-weight:600;letter-spacing:.045em;line-height:1.55;
  color:var(--cxs-ink);word-break:break-word;
}
.cxs .cx-bigcode .btn{flex:0 0 auto}

/* ── People ───────────────────────────────────────────────────────────── */
.cxs .cx-tag{
  display:inline-block;margin-left:8px;padding:2px 7px;border-radius:6px;
  font-size:10px;font-weight:700;letter-spacing:.055em;text-transform:uppercase;
  background:rgba(200,124,12,.14);color:#9c6208;vertical-align:2px;
}
.dark .cxs .cx-tag{background:rgba(232,160,44,.16);color:#f0b755}
.cxs .cx-role{
  font-size:12.5px;font-weight:600;color:var(--cxs-ink-2);text-transform:capitalize;
}

/* ── An open door ─────────────────────────────────────────────────────── */
/* Amber, not red. Nothing is broken and nothing is being blocked — this is a
   setting doing exactly what it says, shown to somebody who may not have
   meant to choose it. Red here would cry wolf on every public briefing. */
.cxs .cx-opendoor{
  display:flex;align-items:center;justify-content:space-between;gap:18px;
  flex-wrap:wrap;margin-bottom:18px;padding:15px 18px;
  border:1px solid #f0d08a;border-radius:var(--cxs-radius);
  background:linear-gradient(135deg,#fffaf0,#fff6e6);
  box-shadow:var(--cxs-shadow);
}
.cxs .cx-opendoor strong{
  display:block;font-size:14px;font-weight:650;letter-spacing:-.012em;color:#8a5a06;
}
.cxs .cx-opendoor p{
  margin:5px 0 0;font-size:12.5px;line-height:1.6;color:#8f6b2c;max-width:74ch;
}
.cxs .cx-opendoor .btn{flex:0 0 auto}
.dark .cxs .cx-opendoor{
  border-color:rgba(240,180,60,.42);
  background:linear-gradient(135deg,rgba(240,180,60,.13),rgba(240,180,60,.05));
}
.dark .cxs .cx-opendoor strong{color:#f4c15c}
.dark .cxs .cx-opendoor p{color:#d9bd85}

/* ── What a record does not contain ───────────────────────────────────── */
/* Not an error colour. Nothing has gone wrong — a limitation stated plainly
   once is worth more than a red box people learn to close without reading. */
.cxs .cx-gap{
  padding:13px 16px;border-radius:12px;
  border:1px solid var(--cxs-line);border-left:3px solid #d8a53a;
  background:var(--cxs-soft);
}
.cxs .cx-gap strong{
  display:block;font-size:13px;font-weight:650;letter-spacing:-.01em;
  color:var(--cxs-ink);margin-bottom:4px;
}
.cxs .cx-gap p{
  margin:0;font-size:12.5px;line-height:1.65;color:var(--cxs-ink-2);max-width:78ch;
}

/* ── The minutes, read on screen ──────────────────────────────────────── */
/* Plain text with its own line breaks kept. NOT monospace: this is a record
   of a meeting, and a fixed-width font would make it look like output from a
   program rather than something a person is meant to read. */
/* Scoped under .cxs like everything else here, which works because Modal
   renders inline rather than through a portal — checked, not assumed. */
.cxs .cx-mom{
  white-space:pre-wrap;overflow-wrap:anywhere;
  font-size:13.5px;line-height:1.7;color:var(--cxs-ink);
  margin:0;max-width:80ch;
}

/* ── A row that opens ─────────────────────────────────────────────────── */
/* The drawer is a second row in the same table, spanning every column, so it
   lines up with what it belongs to instead of floating in its own box. */
.cxs .cx-drawer-row>.cx-drawer{
  border-top:0;padding:4px 20px 16px;background:var(--cxs-hover);
}
.cxs .cx-recs{display:flex;flex-direction:column;gap:8px}
.cxs .cx-rec{
  display:flex;align-items:center;justify-content:space-between;gap:14px;
  flex-wrap:wrap;padding:11px 14px;border-radius:11px;
  background:var(--cxs-surface);border:1px solid var(--cxs-line);
}
.cxs .cx-rec strong{
  display:block;font-size:13px;font-weight:640;color:var(--cxs-ink);
}
.cxs .cx-rec span{
  display:block;font-size:12px;color:var(--cxs-ink-3);margin-top:2px;
}

/* ── Watching a recording ─────────────────────────────────────────────── */
.cxs .cx-player{
  border-radius:12px;overflow:hidden;background:#000;
  border:1px solid var(--cxs-line);
}
.cxs .cx-player video{display:block;width:100%;max-height:62vh;background:#000}
/* An audio recording has no picture, so the element collapses to its control
   strip. Given a black box the height of a video it would look broken. */
.cxs .cx-player--audio{background:var(--cxs-soft);padding:14px}
.cxs .cx-player--audio video{height:44px;max-height:44px;background:transparent}

/* ── The dashboard ────────────────────────────────────────────────────── */
.cxs .cx-tiles{
  display:grid;gap:14px;margin-bottom:18px;
  grid-template-columns:repeat(4,minmax(0,1fr));
}
@media (max-width:1100px){.cxs .cx-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.cxs .cx-tiles{grid-template-columns:1fr}}

.cxs .cx-tile{
  display:flex;flex-direction:column;gap:2px;
  padding:16px 18px;border-radius:var(--cxs-radius);
  background:var(--cxs-surface);border:1px solid var(--cxs-line);
  box-shadow:var(--cxs-shadow);
}
.cxs .cx-tile-label{
  font-size:11.5px;font-weight:640;letter-spacing:.06em;text-transform:uppercase;
  color:var(--cxs-ink-3);
}
/* Tabular figures, so a number changing from 9 to 10 does not shift the row.
   The value is the thing being read; everything around it is a caption. */
.cxs .cx-tile-value{
  font-size:30px;font-weight:660;letter-spacing:-.028em;line-height:1.15;
  color:var(--cxs-ink);font-variant-numeric:tabular-nums;margin-top:5px;
}
.cxs .cx-tile-note{font-size:12px;color:var(--cxs-ink-3);margin-top:3px}
.cxs .cx-tile--live{
  border-color:rgba(3,181,98,.34);
  background:linear-gradient(135deg,rgba(3,181,98,.08),rgba(3,181,98,.02) 55%),
    var(--cxs-surface);
}
.cxs .cx-tile--live .cx-tile-value{color:var(--cxs-brand-deep)}

/* ── ONE SERIES, MEASURED COLOURS. ──────────────────────────────────────
   #07834c on white and #17a06b on the dark surface. Both were run through
   the palette checker rather than picked by eye: the brand green sits at
   2.7:1 against white, under the 3:1 a chart mark needs to be seen, and the
   obvious dark-mode brightening falls outside the readable lightness band.
   Two measured greens beat one that looked fine on the machine it was
   chosen on. */
.cxs .cx-chart{
  display:flex;align-items:flex-end;gap:4px;height:170px;padding-top:6px;
}
.cxs .cx-bar-slot{
  flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;
  height:100%;
}
.cxs .cx-bar-wrap{
  flex:1 1 auto;width:100%;display:flex;align-items:flex-end;min-height:0;
  /* A floor line rather than a grid: one reference, at the only value that
     matters for a count. */
  border-bottom:1px solid var(--cxs-line);
}
.cxs .cx-bar{
  position:relative;width:100%;
  /* Rounded at the data end only, anchored to the baseline. A bar rounded at
     the bottom too floats, and a count starts at zero. */
  border-radius:4px 4px 0 0;
  background:#07834c;
  transition:background .15s ease;
  min-height:2px;
}
.dark .cxs .cx-bar{background:#17a06b}
.cxs .cx-bar:hover{background:#0a9c5c}
.dark .cxs .cx-bar:hover{background:#1fb87c}
/* A day with nothing on it still gets a mark, or the axis reads as missing
   data rather than as a quiet Sunday. */
.cxs .cx-bar.is-zero{background:#c9d1de;min-height:3px}
.dark .cxs .cx-bar.is-zero{background:#40434d}

.cxs .cx-bar-tip{
  position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);
  display:none;white-space:nowrap;z-index:5;
  padding:7px 10px;border-radius:9px;
  background:var(--cxs-ink);color:var(--cxs-surface);
  font-size:11.5px;font-weight:600;line-height:1.3;
  box-shadow:0 8px 20px -8px rgba(16,24,40,.5);
}
.cxs .cx-bar-tip small{display:block;font-weight:400;opacity:.75;margin-top:2px}
.cxs .cx-bar-wrap:hover .cx-bar-tip{display:block}
.cxs .cx-bar-day{
  font-size:10.5px;color:var(--cxs-ink-3);margin-top:6px;
  font-variant-numeric:tabular-nums;
}

.cxs .cx-doorlist{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cxs .cx-doorlist a,.cxs .cx-doorlist span{
  font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;
  background:rgba(255,255,255,.55);border:1px solid #f0d08a;color:#8a5a06;
  text-decoration:none;
}
.cxs .cx-doorlist a:hover{background:#fff}
.dark .cxs .cx-doorlist a,.dark .cxs .cx-doorlist span{
  background:rgba(240,180,60,.10);border-color:rgba(240,180,60,.4);color:#f4c15c;
}

.cxs .cx-nextlist{display:flex;flex-direction:column;gap:2px}
.cxs .cx-next{
  display:flex;align-items:center;gap:12px;padding:10px 0;
  border-bottom:1px solid var(--cxs-soft);
}
.cxs .cx-next:last-child{border-bottom:0;padding-bottom:0}
.cxs .cx-next>div{flex:1 1 auto;min-width:0}
.cxs .cx-next .btn{flex:0 0 auto}

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

// ---------------------------------------------------------------------------
//  Form parts
// ---------------------------------------------------------------------------

/**
 * One decision: a label, the control, a short line, and the long explanation
 * folded behind a question mark.
 *
 * The question mark is a SIBLING of the label rather than a child of it. A
 * button inside a <label> is also a click on the labelled control, so opening
 * the explanation for "Waiting room" would have silently changed the waiting
 * room — the kind of bug nobody reports because it looks like a mis-click.
 */
export function Field({
  label, htmlFor, hint, why, children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  why?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cx-field">
      <div className="cx-lab">
        <label className="form-label" htmlFor={htmlFor}>{label}</label>
        {why && (
          <button type="button" className="cx-q" aria-expanded={open}
                  aria-label={open ? 'Hide the explanation' : 'Why this matters'}
                  onClick={() => setOpen(!open)}>
            ?
          </button>
        )}
      </div>
      {children}
      {hint && <div className="form-text">{hint}</div>}
      {why && open && <div className="cx-why">{why}</div>}
    </div>
  );
}

/**
 * A radio button wearing a card.
 *
 * Generic over the value so the caller keeps its union type — passing a
 * SharePolicy in gets a SharePolicy back, with no cast at the call site and
 * no way to hand it a string the server would reject.
 */
export function Choice<T extends string>({
  name, value, current, onPick, title, note,
}: {
  name: string;
  value: T;
  current: T;
  onPick: (v: T) => void;
  title: string;
  note?: string;
}) {
  const on = current === value;
  return (
    <label className={`cx-choice${on ? ' is-on' : ''}`}>
      <input type="radio" name={name} value={value} checked={on}
             onChange={() => onPick(value)} />
      <span className="cx-tick" aria-hidden="true" />
      <b>{title}</b>
      {note && <span className="cx-note">{note}</span>}
    </label>
  );
}

/** One line of the summary panel. */
export function SumRow({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <li>
      <span className="cx-sum-k">{k}</span>
      <span className={`cx-sum-v${warn ? ' is-warn' : ''}`}>{v}</span>
    </li>
  );
}
