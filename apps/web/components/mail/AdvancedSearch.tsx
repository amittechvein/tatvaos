'use client';

import { useState } from 'react';

/**
 * Advanced search — the form that writes the query for you.
 *
 * Amit, 23 September 2026: "in search give advance search like gmail".
 *
 * ── WHY A FORM WHEN THERE IS ALREADY A QUERY LANGUAGE ───────────────────
 *
 *  The operators are for people who know them. Nobody learns `newer_than:7d`
 *  by being shown a search box, and the person who most needs to find one
 *  invoice among four thousand is the least likely to have read anything.
 *  Gmail's answer is a form that COMPOSES the query — and because it writes
 *  the same syntax into the same box, using it once teaches the syntax. The
 *  box is left holding `from:x subject:y newer_than:7d`, which the person
 *  can then edit by hand.
 *
 *  So this builds a string and hands it over. It runs no search of its own
 *  and knows nothing the box does not — one search path, not two.
 */
export function AdvancedSearch({
  folders, initial, onSearch, onClose,
}: {
  /** For "Search in" — label plus the in: value that finds it. */
  folders: { label: string; value: string }[];
  initial?: string;
  onSearch: (query: string) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [words, setWords] = useState(initial?.trim() ?? '');
  const [without, setWithout] = useState('');
  const [where, setWhere] = useState('');
  const [within, setWithin] = useState('');
  const [sizeOp, setSizeOp] = useState('larger');
  const [sizeVal, setSizeVal] = useState('');
  const [sizeUnit, setSizeUnit] = useState('M');
  const [hasAttachment, setHasAttachment] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);

  /** A value with a space has to be quoted or the space would mean AND. */
  const quote = (v: string) => (/\s/.test(v.trim()) ? `"${v.trim()}"` : v.trim());

  const build = () => {
    const parts: string[] = [];
    if (from.trim()) parts.push(`from:${quote(from)}`);
    if (to.trim()) parts.push(`to:${quote(to)}`);
    if (subject.trim()) parts.push(`subject:${quote(subject)}`);
    if (where) parts.push(`in:${where}`);
    if (within) parts.push(`newer_than:${within}`);
    if (sizeVal.trim() && /^\d+$/.test(sizeVal.trim())) {
      parts.push(`${sizeOp}:${sizeVal.trim()}${sizeUnit}`);
    }
    if (hasAttachment) parts.push('has:attachment');
    if (unreadOnly) parts.push('is:unread');
    // Free words last so the query reads the way somebody would say it.
    if (words.trim()) parts.push(words.trim());
    // Each excluded word gets its own -, because -a b would only exclude a.
    without.trim().split(/\s+/).filter(Boolean).forEach((w) => parts.push(`-${w}`));
    return parts.join(' ');
  };

  const field = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-brand-500';
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted';

  return (
    <div className="absolute right-0 top-full z-30 mt-9 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-4 shadow-raised">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <span className={label}>From</span>
          <input value={from} onChange={(e) => setFrom(e.target.value)} className={field} placeholder="name or address" />
        </div>
        <div className="col-span-2">
          <span className={label}>To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} className={field} placeholder="whole address, or me" />
        </div>
        <div className="col-span-2">
          <span className={label}>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
        </div>
        <div className="col-span-2">
          <span className={label}>Has the words</span>
          <input value={words} onChange={(e) => setWords(e.target.value)} className={field} />
        </div>
        <div className="col-span-2">
          <span className={label}>Doesn&apos;t have</span>
          <input value={without} onChange={(e) => setWithout(e.target.value)} className={field} placeholder="words to leave out" />
        </div>

        <div>
          <span className={label}>Search in</span>
          <select value={where} onChange={(e) => setWhere(e.target.value)} className={field}>
            <option value="">All mail</option>
            {folders.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            <option value="anywhere">Anywhere (incl. bin)</option>
          </select>
        </div>
        <div>
          <span className={label}>Date within</span>
          <select value={within} onChange={(e) => setWithin(e.target.value)} className={field}>
            <option value="">Any time</option>
            <option value="1d">1 day</option>
            <option value="7d">1 week</option>
            <option value="1m">1 month</option>
            <option value="6m">6 months</option>
            <option value="1y">1 year</option>
          </select>
        </div>

        <div className="col-span-2">
          <span className={label}>Size</span>
          <div className="flex gap-2">
            <select value={sizeOp} onChange={(e) => setSizeOp(e.target.value)} className={`${field} w-28`}>
              <option value="larger">greater than</option>
              <option value="smaller">less than</option>
            </select>
            <input value={sizeVal} onChange={(e) => setSizeVal(e.target.value)} inputMode="numeric"
                   className={`${field} w-20`} placeholder="10" />
            <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value)} className={`${field} w-20`}>
              <option value="K">KB</option>
              <option value="M">MB</option>
            </select>
          </div>
        </div>

        <label className="col-span-2 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={hasAttachment} onChange={(e) => setHasAttachment(e.target.checked)}
                 className="h-4 w-4 accent-brand-600" />
          Has attachment
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)}
                 className="h-4 w-4 accent-brand-600" />
          Unread only
        </label>
      </div>

      {/* What it will actually run. Shown because the form's whole job is to
          teach the syntax it writes — and because a person should be able to
          see what they are about to ask for. */}
      {build() && (
        <div className="mt-3 break-words rounded-lg bg-canvas px-2.5 py-2 font-mono text-[11px] text-ink-muted">
          {build()}
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink transition hover:bg-canvas">
          Cancel
        </button>
        <button type="button" onClick={() => { onSearch(build()); onClose(); }}
                disabled={!build()}
                className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50">
          Search
        </button>
      </div>
    </div>
  );
}
