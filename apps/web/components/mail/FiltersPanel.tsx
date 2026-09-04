'use client';

// ============================================================================
//  Filters panel — the rule list and its editor, lifted out of the old
//  /mail/filters page so it can render both there and as a Settings tab.
//
//  Deliberately UNCHANGED in behaviour from the page it came from: same
//  fields, same operators, same actions the ingest worker actually applies.
//  The richer conditions and actions in the product wishlist (doesn't-contain,
//  has-attachment, forward, delete, archive, apply-category, drag-to-reorder,
//  duplicate) are backend work and are NOT faked here — a control that does
//  nothing is worse than its absence.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import type { Folder } from '@tatvaos/types';
import { useAuth } from '@/lib/auth';
import {
  mailApi,
  type FilterCondition,
  type FilterDraft,
  type FilterField,
  type FilterOp,
  type FilterRule,
} from '@/lib/mail';

const FIELDS: { value: FilterField; label: string }[] = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Message body' },
];

const OPS: { value: FilterOp; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'is exactly' },
];

function emptyDraft(from?: string | null): FilterDraft {
  return {
    name: from ? `Mail from ${from}` : '',
    enabled: true,
    matchAll: true,
    position: 0,
    conditions: [{ field: 'from', op: from ? 'equals' : 'contains', value: from ?? '' }],
    actions: { moveToFolderId: null, markRead: false, flag: false },
  };
}

export function FiltersPanel({ prefillFrom = null }: { prefillFrom?: string | null }) {
  const { authedFetch } = useAuth();

  const [rules, setRules] = useState<FilterRule[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // One editor at a time: null = closed, 'new' = creating, else the rule id.
  const [editing, setEditing] = useState<string | null>(prefillFrom ? 'new' : null);
  const [draft, setDraft] = useState<FilterDraft>(() => emptyDraft(prefillFrom));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ruleList, folderList] = await Promise.all([
        mailApi.filters(authedFetch),
        mailApi.folders(authedFetch),
      ]);
      setRules(ruleList);
      setFolders(folderList);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your filters.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  function openNew() {
    setDraft(emptyDraft(null));
    setEditing('new');
  }

  function openEdit(r: FilterRule) {
    const { id: _id, createdAt: _createdAt, ...rest } = r;
    setDraft(rest);
    setEditing(r.id);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (editing === 'new') await mailApi.createFilter(authedFetch, draft);
      else if (editing) await mailApi.updateFilter(authedFetch, editing, draft);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the filter.');
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(id: string) {
    setError(null);
    try {
      await mailApi.deleteFilter(authedFetch, id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the filter.');
    }
  }

  function setCondition(i: number, patch: Partial<FilterCondition>) {
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">Filters</h2>
          <p className="text-sm text-ink-muted">
            Rules run on mail as it arrives, in order. Every matching rule applies.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600"
        >
          New filter
        </button>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {editing !== null && (
        <section className="mb-6 rounded-card border border-line bg-surface p-5">
          <h3 className="mb-4 text-sm font-semibold text-ink">
            {editing === 'new' ? 'New filter' : 'Edit filter'}
          </h3>

          <label className="mb-4 block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="What this rule is for"
              className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400"
            />
          </label>

          <fieldset className="mb-4">
            <legend className="mb-2 text-sm font-medium text-ink">When a message arrives</legend>

            <label className="mb-3 flex items-center gap-2 text-sm text-ink-muted">
              <select
                value={draft.matchAll ? 'all' : 'any'}
                onChange={(e) => setDraft((d) => ({ ...d, matchAll: e.target.value === 'all' }))}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
              of these conditions match
            </label>

            {draft.conditions.map((c, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <select
                  value={c.field}
                  onChange={(e) => setCondition(i, { field: e.target.value as FilterField })}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <select
                  value={c.op}
                  onChange={(e) => setCondition(i, { op: e.target.value as FilterOp })}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input
                  value={c.value}
                  onChange={(e) => setCondition(i, { value: e.target.value })}
                  placeholder="value"
                  className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400"
                />
                {draft.conditions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, j) => j !== i) }))}
                    className="px-2 text-sm text-ink-muted transition hover:text-danger"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={() => setDraft((d) => ({
                ...d,
                conditions: [...d.conditions, { field: 'subject', op: 'contains', value: '' }],
              }))}
              className="mt-1 text-sm font-medium text-brand-600 hover:underline"
            >
              Add condition
            </button>
          </fieldset>

          <fieldset className="mb-4">
            <legend className="mb-2 text-sm font-medium text-ink">Then</legend>

            <label className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              Move it to
              <select
                value={draft.actions.moveToFolderId ?? ''}
                onChange={(e) => setDraft((d) => ({
                  ...d,
                  actions: { ...d.actions, moveToFolderId: e.target.value || null },
                }))}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">leave where it lands</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>

            <label className="mr-4 inline-flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.actions.markRead}
                onChange={(e) => setDraft((d) => ({ ...d, actions: { ...d.actions, markRead: e.target.checked } }))}
                className="h-4 w-4 rounded border-line text-brand-500"
              />
              Mark as read
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.actions.flag}
                onChange={(e) => setDraft((d) => ({ ...d, actions: { ...d.actions, flag: e.target.checked } }))}
                className="h-4 w-4 rounded border-line text-brand-500"
              />
              Star it
            </label>
          </fieldset>

          <label className="mb-4 flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              className="h-4 w-4 rounded border-line text-brand-500"
            />
            Enabled
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save filter'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
            >
              Cancel
            </button>
          </div>

          <p className="mt-3 text-xs text-ink-faint">
            Rules apply to mail that arrives from now on. Messages already in your mailbox stay
            where they are.
          </p>
        </section>
      )}

      {loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-10 text-center text-sm text-ink-muted">
          No filters yet. Mail arrives in your inbox untouched.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {r.name}
                  {!r.enabled && <span className="ml-2 text-xs text-ink-faint">(off)</span>}
                </p>
                <p className="truncate text-xs text-ink-muted">
                  {r.matchAll ? 'All' : 'Any'} of:{' '}
                  {r.conditions
                    .map((c) => `${c.field} ${c.op === 'equals' ? 'is' : 'contains'} "${c.value}"`)
                    .join(', ')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => openEdit(r)}
                className="text-sm font-medium text-brand-600 hover:underline"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void removeRule(r.id)}
                className="text-sm font-medium text-ink-muted transition hover:text-danger"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
