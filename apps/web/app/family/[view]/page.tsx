'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';

import { FamilyShell, useFamilyChrome } from '@/components/family/FamilyShell';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { Input, Select } from '@/components/ui/Form';
import {
  DuplicateContactError, familyApi, isAutoSaved, sourceLabel,
  type ContactDetail, type ContactGroup, type ContactSummary, type Ownership,
} from '@/lib/family';

// ---------------------------------------------------------------------------
//  The five views, as real paths rather than query strings.
//
//  Each is the SAME screen asking the API a different question. They are
//  separate routes because the rail decides what is active by pathname — five
//  links to /family/contacts?view=… would all light up at once.
// ---------------------------------------------------------------------------

type View = 'contacts' | 'directory' | 'frequent' | 'other' | 'bin';

interface ViewSpec {
  title: string;
  blurb: string;
  emptyTitle: string;
  emptyHint: string;
  query: Parameters<typeof familyApi.list>[1];
}

const VIEWS: Record<View, ViewSpec> = {
  contacts: {
    title: 'Contacts',
    blurb: 'Everyone you can see — your own contacts, and the ones your organisation shares.',
    emptyTitle: 'No contacts yet',
    emptyHint: 'Add one by hand, or let mail save them for you as people write in.',
    query: {},
  },
  directory: {
    title: 'Directory',
    blurb: 'Shared with the whole organisation. Anyone here can see and edit these.',
    emptyTitle: 'Nothing shared yet',
    emptyHint: 'Open one of your own contacts and choose Share to put it here.',
    query: { ownership: 'organisational' },
  },
  frequent: {
    title: 'Frequent',
    blurb: 'Ordered by how much you actually correspond, rather than by name.',
    emptyTitle: 'No exchanges recorded yet',
    emptyHint: 'This fills in as mail arrives, and as you log calls and meetings.',
    query: { sort: 'frequent' },
  },
  other: {
    title: 'Other contacts',
    blurb: 'Saved automatically from mail. You never typed these — prune what you do not want.',
    emptyTitle: 'Nothing saved automatically',
    emptyHint: 'People who write to you land here, unless you have turned that off in settings.',
    query: { source: 'auto', sort: 'recent' },
  },
  bin: {
    title: 'Bin',
    blurb: 'Deleted contacts. Restoring one brings back its history and its audit trail.',
    emptyTitle: 'The bin is empty',
    emptyHint: 'Deleted contacts appear here.',
    query: { deleted: true, sort: 'deleted' },
  },
};

const isView = (v: string): v is View => Object.prototype.hasOwnProperty.call(VIEWS, v);

/**
 * The options object the list route takes.
 *
 * Named so the bulk-label change can be handed the SAME object the list was
 * built from. "Select all 1,499 matching" is only honest if the two are one
 * value rather than two lists of clauses that have to be kept in step.
 */
type ListQuery = Parameters<typeof familyApi.list>[1];

// ============================================================================
//  Contacts — the address book.
//
//  ONE IDEA RUNS THROUGH THIS SCREEN: a contact is either PERSONAL (yours
//  alone, invisible to colleagues) or ORGANISATIONAL (the company's, visible
//  to everyone). The API enforces it and row-level security enforces it again;
//  this page's job is to make which-is-which obvious, because a person sharing
//  their address book by accident is the failure that matters here.
//
//  Sharing is therefore explicit, confirmed, and one-way. The server refuses
//  to reverse it — it would have to nominate a new owner and there is no right
//  answer to that — so the confirm dialog says so plainly rather than letting
//  someone discover it afterwards.
// ============================================================================

const PAGE_SIZE = 50;

type Filter = 'all' | 'personal' | 'organisational' | 'favourite' | 'auto';

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['personal', 'Mine'],
  ['organisational', 'Shared'],
  ['favourite', 'Starred'],
  ['auto', 'Saved from mail'],
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  // Every index is guarded because this project builds with
  // noUncheckedIndexedAccess: parts[0] is string | undefined even directly
  // after a length check, and the compiler is right to insist.
  const first = parts.at(0) ?? '';
  const last = parts.at(-1) ?? '';
  if (first.length === 0) return '?';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** "3 days ago", not a timestamp. Nobody reads an ISO string. */
function ago(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export default function FamilyViewPage() {
  const { authedFetch } = useAuth();
  const params = useParams<{ view: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const chrome = useFamilyChrome();

  // Anything that is not one of the five is a 404 — NOT a quiet fall back to
  // Contacts.
  //
  // The fallback is what hid the missing /family/labels page for weeks. The
  // sidebar linked to it, Next found no static route, matched this dynamic one
  // instead, and this line turned an unknown view into the contacts list. So
  // clicking "Manage labels" looked like a button that did nothing rather than
  // like a broken link. A wrong screen is harder to diagnose than an error.
  if (!isView(params.view)) notFound();
  const view = params.view as View;

  const spec = VIEWS[view];
  const isBin = view === 'bin';

  const [rows, setRows] = useState<ContactSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // ---------------------------------------------------------------------
  //  Selection.
  //
  //  Two kinds, and the difference matters:
  //
  //    selected     ids that were ticked. What you see is what changes.
  //    allMatching  everything the current filter returns, which is usually
  //                 more than one page and may be thousands of contacts
  //                 nobody has looked at.
  //
  //  The second is the one worth having — pruning an imported address book
  //  fifty rows at a time is why people abandon address books — and it is the
  //  one that has to be impossible to trigger by accident. So it is never the
  //  default, it takes a second deliberate click after the page is already
  //  selected, and the count is spelled out on the button that acts on it.
  // ---------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; mode: 'add' | 'remove' } | null>(null);
  const [newLabel, setNewLabel] = useState<string | null>(null);
  const [groupTick, setGroupTick] = useState(0);

  // "Create contact" in the rail is a real link to ?create=1 rather than a
  // button, so middle-click and deep-link both behave. Consume the flag and
  // strip it, or a refresh reopens the dialog forever.
  useEffect(() => {
    if (search.get('create') === '1') {
      setCreating(true);
      router.replace(`/family/${view}`);
    }
    // ?open=<id> is how a sender's name in Mail lands on their card. Same
    // consume-and-strip rule as ?create, for the same reason.
    const open = search.get('open');
    if (open) {
      setOpenId(open);
      router.replace(`/family/${view}`);
    }
  }, [search, router, view]);

  // ---------------------------------------------------------------------
  //  THE LABEL FILTER LIVES IN THE URL, NOT IN STATE.
  //
  //  It used to be a useState mirrored from ?groupId= by an effect that only
  //  ever SET it:
  //
  //      useEffect(() => { if (railGroup) setGroupId(railGroup); }, [railGroup])
  //
  //  So clicking a label filtered the list, and then clicking Contacts — which
  //  goes to /family/contacts with no query at all — left the state exactly
  //  where it was. The URL said everything, the screen showed 1,499 of 1,650,
  //  and the only clue was a dropdown in the corner still naming a label you
  //  had already navigated away from. It reads as "the filter is broken"
  //  because the thing on screen no longer matches anything you clicked.
  //
  //  Deriving it from the URL removes the second copy, and with it the whole
  //  class of bug: back, forward, refresh, deep-link and the rail all agree
  //  because there is only one answer to agree with.
  // ---------------------------------------------------------------------
  const groupId = search.get('groupId') ?? '';

  const chooseGroup = useCallback((next: string) => {
    router.replace(next ? `/family/${view}?groupId=${next}` : `/family/${view}`);
  }, [router, view]);

  // Page 1 of a different set. Staying on page 12 of a label with three
  // contacts shows an empty table and looks like the filter found nothing.
  useEffect(() => { setPage(1); }, [groupId]);

  // Debounce, so typing "priya" is one request rather than five.
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(query.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // A token per load. Without it a slow first request can land AFTER a fast
  // second one and overwrite fresher results with staler ones — the classic
  // search race, and it looks like the filter is ignoring you.
  const loadToken = useRef(0);

  // ---------------------------------------------------------------------
  //  ONE definition of "what this screen is showing".
  //
  //  Used by the list request and by "select all matching". Written twice,
  //  these two drift, and the day they do somebody labels a set of contacts
  //  the screen never showed them. The server keeps the same promise from its
  //  end — see ContactFilters on the API side.
  // ---------------------------------------------------------------------
  const listQuery: ListQuery = useMemo(() => ({
    ...spec.query,
    // The chips refine the view; they never widen it. Directory stays
    // organisational even with "Mine" selected — the alternative is a filter
    // that silently contradicts the page you are on.
    ...(filter === 'personal' || filter === 'organisational'
      ? { ownership: spec.query?.ownership ?? filter } : {}),
    ...(filter === 'favourite' ? { favourite: true } : {}),
    ...(filter === 'auto' ? { source: 'auto' as const } : {}),
    groupId: groupId || undefined,
  }), [spec, filter, groupId]);

  const load = useCallback(async () => {
    const mine = ++loadToken.current;
    setLoading(true); setError(null);
    try {
      if (debounced.length > 0) {
        const found = await familyApi.search(authedFetch, debounced, 100);
        if (mine !== loadToken.current) return;
        setRows(found); setTotal(found.length);
      } else {
        const res = await familyApi.list(authedFetch, {
          ...listQuery,
          page, pageSize: PAGE_SIZE,
        });
        if (mine !== loadToken.current) return;
        setRows(res.items); setTotal(res.total);
      }
    } catch (e) {
      if (mine === loadToken.current) setError((e as Error).message);
    } finally {
      if (mine === loadToken.current) setLoading(false);
    }
  }, [authedFetch, debounced, listQuery, page]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    familyApi.groups(authedFetch)
      .then((g) => { if (live) setGroups(g); })
      .catch(() => { /* groups are a filter, not the page — a failure here is not fatal */ });
    return () => { live = false; };
  }, [authedFetch, groupTick]);

  // A selection belongs to one set of results. Keeping ticks across a filter
  // change or a page turn means acting on rows that are no longer on screen,
  // which is the single easiest way to relabel the wrong people.
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [debounced, listQuery, page, view]);

  // No client-side sieve: every filter is a server query, so a page of results
  // is a page of results. Filtering here would silently drop rows and make the
  // count disagree with what is on screen.
  const visible = rows;

  const activeGroup = groupId ? groups.find((g) => g.id === groupId) ?? null : null;

  // ---- selection ---------------------------------------------------------
  const pageIds = visible.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));
  const selectionCount = allMatching ? total : selected.size;

  // Offered only once the whole page is already ticked, and never during a
  // search — the server filter has no idea what you typed, so "all matching"
  // would quietly mean something other than what is on screen.
  const canSelectAll =
    !allMatching && allOnPage && debounced.length === 0 && total > pageIds.length;

  const clearSelection = () => { setSelected(new Set()); setAllMatching(false); };

  const toggleOne = (id: string) => {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const applyLabel = async (labelId: string, mode: 'add' | 'remove', labelName?: string) => {
    setBulkBusy(true); setError(null);
    try {
      // allMatching sends the filter, not the ids. The server re-runs it, so
      // what changes is what the count on the button was counting.
      const body: Parameters<typeof familyApi.bulkLabels>[1] = allMatching
        ? {
            all: true,
            ownership: listQuery.ownership,
            groupId: listQuery.groupId,
            favourite: listQuery.favourite,
            source: listQuery.source,
          }
        : { contactIds: [...selected] };

      if (mode === 'add') body.add = [labelId];
      else body.remove = [labelId];

      const result = await familyApi.bulkLabels(authedFetch, body);
      const name = labelName ?? groups.find((g) => g.id === labelId)?.name ?? 'That label';

      if (mode === 'add') {
        const already = result.contacts - result.added;
        setNote(`${name} added to ${plural(result.added, 'contact')}.`
          + (already > 0 ? ` ${plural(already, 'contact')} already had it.` : ''));
      } else {
        setNote(`${name} removed from ${plural(result.removed, 'contact')}.`);
      }

      clearSelection();
      setGroupTick((t) => t + 1);
      chrome.refresh();
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const createAndApply = async (name: string) => {
    setBulkBusy(true); setError(null);
    try {
      const { id } = await familyApi.createGroup(authedFetch, name);
      setNewLabel(null);
      setGroupTick((t) => t + 1);
      await applyLabel(id, 'add', name);
    } catch (e) {
      setError((e as Error).message);
      setBulkBusy(false);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <FamilyShell title={spec.title} breadcrumb={spec.title}>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {note && <Alert tone="ok" onDismiss={() => setNote(null)}>{note}</Alert>}

      <p className="text-[0.875rem] text-ink-muted mb-4">{spec.blurb}</p>

      {/*
        A filtered list has to say so where you are looking.

        The count lives at the bottom of fifty rows, and two labels covering
        most of the same address book produce a first page that looks
        identical either way — which is indistinguishable from a filter that
        does nothing. This is the line that tells you it worked, and the one
        click that undoes it.
      */}
      {activeGroup && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-[0.875rem] text-ink-muted">Showing only</span>
          <span
            className="inline-flex items-center gap-2 rounded-full px-2.5 py-0.5 text-xs font-semibold"
            style={activeGroup.colour
              ? { background: activeGroup.colour, color: '#fff' }
              : { background: 'rgb(var(--canvas))', color: 'rgb(var(--ink-muted))' }}
          >
            {activeGroup.name}
            {/* The dismiss affordance MUI's Chip onDelete gave us. */}
            <button
              type="button"
              className="p-0 leading-none opacity-80 hover:opacity-100"
              style={{ fontSize: 14 }}
              aria-label={`Stop filtering by ${activeGroup.name}`}
              onClick={() => chooseGroup('')}
            >
              ×
            </button>
          </span>
          {!loading && (
            <span className="text-[0.875rem] text-ink-muted">
              — {total === 1 ? '1 contact' : `${total} contacts`}
            </span>
          )}
        </div>
      )}

      <Card
        padded={false}
        actions={!isBin && (
          <>
            <Button variant="secondary" href="/family/import">Import / export</Button>
            <Button variant="primary" onClick={() => setCreating(true)}>Add contact</Button>
          </>
        )}
      >
        <div className="flex flex-wrap gap-2 items-center p-4">
          <div className="relative" style={{ minWidth: 280, flex: '1 1 280px' }}>
            <span className="absolute flex items-center"
                  style={{ left: 10, top: 0, bottom: 0, pointerEvents: 'none' }}>🔍</span>
            <Input
              
              placeholder="Search name, company or address…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 32, paddingRight: query ? 32 : undefined }}
            />
            {query && (
              <button
                type="button"
                className="absolute p-0 text-ink-muted hover:text-ink"
                style={{ right: 8, top: '50%', transform: 'translateY(-50%)', lineHeight: 1 }}
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          {/* Filter pills are buttons: they change the list on click, so they
              have to be reachable by keyboard. MUI's clickable Chip was doing
              that quietly. */}
          <div className="flex gap-1 flex-wrap">
            {!isBin && FILTERS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${filter === key
                  ? 'border-transparent bg-brand-500 text-white'
                  : 'border-line bg-transparent text-ink-muted hover:bg-canvas'}`}
                style={{ cursor: 'pointer', fontWeight: 500 }}
                onClick={() => { setFilter(key); setPage(1); }}
              >
                {label}
              </button>
            ))}
          </div>

          {groups.length > 0 && (
            <div style={{ minWidth: 160 }}>
              <Select
                value={groupId}
                aria-label="Group"
                onChange={(e) => chooseGroup(e.target.value)}
              >
                <option value="">All groups</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </div>
          )}
        </div>

        {/*
          The bar only exists while something is selected, so the screen is not
          carrying a permanently disabled toolbar for a thing nobody is doing.
        */}
        {!isBin && selectionCount > 0 && (
          <div
            className="flex items-center gap-2 flex-wrap px-4 py-2 border-top"
            style={{ background: 'rgba(0,0,0,0.03)' }}
          >
            <span className="text-[0.875rem] font-semibold">
              {allMatching
                ? `All ${total} selected`
                : `${plural(selected.size, 'contact')} selected`}
            </span>

            {canSelectAll && (
              <Button variant="ghost" onClick={() => setAllMatching(true)}>
                Select all {total} matching
              </Button>
            )}

            <Button
              variant="secondary" disabled={bulkBusy}
              onClick={(e) => setMenu({ anchor: e.currentTarget, mode: 'add' })}
            >
              Add label
            </Button>
            <Button
              variant="secondary" disabled={bulkBusy}
              onClick={(e) => setMenu({ anchor: e.currentTarget, mode: 'remove' })}
            >
              Remove label
            </Button>

            <Button variant="ghost" disabled={bulkBusy} onClick={clearSelection}>Clear</Button>
            {bulkBusy && (
              <Spinner inline label="Working" className="text-[18px] text-brand-600" />
            )}
          </div>
        )}

        <hr className="m-0" />

        {loading ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <Empty
            title={debounced ? `Nothing matches “${debounced}”` : spec.emptyTitle}
            hint={debounced ? 'Try part of a name, a company, or an email address.' : spec.emptyHint}
          />
        ) : (
          <Table
            head={[
              ...(isBin ? [] : [(
                <input
                  key="select-page"
                  type="checkbox"
                  className="m-0 h-4 w-4 cursor-pointer rounded border border-line accent-brand-500"
                  checked={allOnPage}
                  ref={(el) => { if (el) el.indeterminate = !allOnPage && someOnPage; }}
                  onChange={togglePage}
                  aria-label="Select everything on this page"
                />
              )]),
              'Name', 'Company', 'Address', 'Last contacted', isBin ? '' : 'Visibility',
            ]}
          >
            {visible.map((c) => (
              <tr
                key={c.id}
                style={{ cursor: isBin ? 'default' : 'pointer' }}
                onClick={isBin ? undefined : () => setOpenId(c.id)}
                title={isBin ? undefined : 'Open this contact'}
              >
                {!isBin && (
                  <Td>
                    {/* stopPropagation, or ticking a box also opens the contact. */}
                    <input
                      type="checkbox"
                      className="m-0 h-4 w-4 cursor-pointer rounded border border-line accent-brand-500"
                      checked={allMatching || selected.has(c.id)}
                      disabled={allMatching}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleOne(c.id)}
                      aria-label={`Select ${c.displayName}`}
                    />
                  </Td>
                )}
                <Td>
                  <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                    <span
                      aria-hidden
                      className="grid rounded-full flex-shrink-0 text-white"
                      style={{
                        width: 36, height: 36, placeItems: 'center',
                        fontSize: 13, fontWeight: 700, background: '#6C3CE9',
                      }}
                    >
                      {initials(c.displayName)}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="text-[0.875rem] font-semibold">
                        {c.isFavourite && <span aria-label="Starred" title="Starred">★ </span>}
                        {c.displayName}
                      </div>
                      {c.jobTitle && <div className="text-[0.75rem] text-ink-muted">{c.jobTitle}</div>}
                    </div>
                  </div>
                </Td>
                <Td>{c.companyName ?? '—'}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <span>{c.primaryEmail ?? '—'}</span>
                    {isAutoSaved(c.source) && (
                      // title= replaces MUI's Tooltip — no library, and it is
                      // reachable on keyboard focus.
                      <span
                        className="inline-flex items-center rounded-full border border-line bg-transparent px-2.5 py-0.5 text-xs font-normal text-ink-muted"
                        title={sourceLabel(c.source)}
                      >
                        auto
                      </span>
                    )}
                  </div>
                </Td>
                <Td>
                  <span title={c.interactionCount === 1 ? '1 exchange' : `${c.interactionCount} exchanges`}>
                    {ago(c.lastContactedAt)}
                  </span>
                </Td>
                <Td>
                  {isBin ? (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await familyApi.restore(authedFetch, c.id);
                          setNote(`${c.displayName} restored.`);
                          chrome.refresh();
                          void load();
                        } catch (e) { setError((e as Error).message); }
                      }}
                    >
                      Restore
                    </Button>
                  ) : c.ownershipType === 'organisational'
                    ? <Badge tone="info">Shared</Badge>
                    : <Badge tone="neutral">Mine</Badge>}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {!debounced && pages > 1 && (
          <div className="flex justify-between items-center p-4">
            <span className="text-[0.875rem] text-ink-muted">
              {total} contacts · page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>

      {creating && (
        <CreateDialog
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={(id, message) => {
            setCreating(false); setNote(message); setOpenId(id);
            chrome.refresh(); void load();
          }}
          onOpenExisting={(id) => { setCreating(false); setOpenId(id); }}
        />
      )}

      {openId && (
        <DetailDialog
          id={openId}
          groups={groups}
          onClose={() => setOpenId(null)}
          onChanged={(message) => { if (message) setNote(message); chrome.refresh(); void load(); }}
          onDeleted={() => {
            setOpenId(null); setNote('Contact deleted.'); chrome.refresh(); void load();
          }}
        />
      )}
      {menu !== null && (
        <AnchoredMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
          {groups.length === 0 && (
            <li className="dropdown-item text-ink-muted" aria-disabled>No labels yet</li>
          )}
          {groups.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  const mode = menu?.mode ?? 'add';
                  setMenu(null);
                  void applyLabel(g.id, mode);
                }}
              >
                {g.name}
              </button>
            </li>
          ))}
          {menu.mode === 'add' && <li><hr className="dropdown-divider" /></li>}
          {menu.mode === 'add' && (
            <li>
              <button type="button" className="dropdown-item"
                      onClick={() => { setMenu(null); setNewLabel(''); }}>
                New label…
              </button>
            </li>
          )}
        </AnchoredMenu>
      )}

      {newLabel !== null && (
        <Modal
          title="New label"
          size="sm"
          busy={bulkBusy}
          onClose={() => setNewLabel(null)}
          footer={
            <>
              <Button variant="ghost" disabled={bulkBusy} onClick={() => setNewLabel(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={bulkBusy || (newLabel ?? '').trim().length === 0}
                onClick={() => void createAndApply((newLabel ?? '').trim())}
              >
                {bulkBusy ? 'Creating…' : 'Create and apply'}
              </Button>
            </>
          }
        >
          <Field
            label="Name"
            hint={`It will be created and put on ${
              selectionCount === 1 ? 'this contact' : `these ${selectionCount} contacts`}.`}
          >
            <Input
              
              autoFocus
              value={newLabel ?? ''}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (newLabel ?? '').trim().length > 0) {
                  e.preventDefault();
                  void createAndApply((newLabel ?? '').trim());
                }
              }}
            />
          </Field>
        </Modal>
      )}
    </FamilyShell>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
//  Create
// ---------------------------------------------------------------------------

function CreateDialog({ groups, onClose, onCreated, onOpenExisting }: {
  groups: ContactGroup[];
  onClose: () => void;
  onCreated: (id: string, message: string) => void;
  onOpenExisting: (id: string) => void;
}) {
  const { authedFetch } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [ownership, setOwnership] = useState<Ownership>('personal');
  const [groupToJoin, setGroupToJoin] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ message: string; contactId: string } | null>(null);

  const save = async () => {
    if (displayName.trim().length === 0) { setError('A name is required.'); return; }
    setBusy(true); setError(null); setDuplicate(null);
    try {
      const { id } = await familyApi.create(authedFetch, {
        displayName: displayName.trim(),
        companyName: companyName.trim() || undefined,
        jobTitle: jobTitle.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        ownershipType: ownership,
      });
      if (groupToJoin) {
        // A failed group add must not lose the contact that was just created.
        await familyApi.addToGroup(authedFetch, groupToJoin, id).catch(() => undefined);
      }
      onCreated(id, `${displayName.trim()} added.`);
    } catch (e) {
      if (e instanceof DuplicateContactError) setDuplicate({ message: e.message, contactId: e.contactId });
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add a contact"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || displayName.trim().length === 0}>
            {busy ? 'Adding…' : 'Add contact'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {duplicate && (
        <Alert tone="warn"
               action={<Button variant="ghost" onClick={() => onOpenExisting(duplicate.contactId)}>Open it</Button>}>
          {duplicate.message}
        </Alert>
      )}

      <Field label="Name" required hint="How this person appears in every list">
        <Input  autoFocus value={displayName}
               onChange={(e) => setDisplayName(e.target.value)} />
      </Field>

      <div className="flex gap-4">
        <div className="flex-auto">
          <Field label="Company">
            <Input  value={companyName}
                   onChange={(e) => setCompanyName(e.target.value)} />
          </Field>
        </div>
        <div className="flex-auto">
          <Field label="Job title">
            <Input  value={jobTitle}
                   onChange={(e) => setJobTitle(e.target.value)} />
          </Field>
        </div>
      </div>

      <Field label="Email" hint="Becomes the primary address">
        <Input  type="email" value={email}
               onChange={(e) => setEmail(e.target.value)} />
      </Field>

      <Field label="Phone">
        <Input  value={phone}
               onChange={(e) => setPhone(e.target.value)} />
      </Field>

      <Field
        label="Visibility"
        hint={ownership === 'personal'
          ? 'Only you can see this contact.'
          : 'Everyone in your organisation can see this contact. This cannot be undone later.'}
      >
        <Select value={ownership}
                onChange={(e) => setOwnership(e.target.value as Ownership)}>
          <option value="personal">Only me</option>
          <option value="organisational">Everyone in my organisation</option>
        </Select>
      </Field>

      {groups.length > 0 && (
        <Field label="Add to group">
          <Select value={groupToJoin}
                  onChange={(e) => setGroupToJoin(e.target.value)}>
            <option value="">None</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
      )}

      <Field label="Notes">
        <textarea rows={2}
                        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25" value={notes}
                  onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Detail / edit
// ---------------------------------------------------------------------------

function DetailDialog({ id, groups, onClose, onChanged, onDeleted }: {
  id: string;
  groups: ContactGroup[];
  onClose: () => void;
  onChanged: (message?: string) => void;
  onDeleted: () => void;
}) {
  const { authedFetch } = useAuth();

  const [c, setC] = useState<ContactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmShare, setConfirmShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newAddr, setNewAddr] = useState(EMPTY_ADDRESS);
  const addrFilled = Object.values(newAddr).some((v) => v.trim().length > 0);

  // Editable fields, held separately so Cancel is just "close".
  const [form, setForm] = useState({ displayName: '', jobTitle: '', companyName: '', notes: '' });

  const reload = useCallback(async () => {
    setError(null);
    try {
      const d = await familyApi.get(authedFetch, id);
      setC(d);
      setForm({
        displayName: d.displayName,
        jobTitle: d.jobTitle ?? '',
        companyName: d.companyName ?? '',
        notes: d.notes ?? '',
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [authedFetch, id]);

  useEffect(() => { void reload(); }, [reload]);

  const dirty = !!c && (
    form.displayName !== c.displayName ||
    form.jobTitle !== (c.jobTitle ?? '') ||
    form.companyName !== (c.companyName ?? '') ||
    form.notes !== (c.notes ?? '')
  );

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true); setError(null);
    try {
      await fn();
      await reload();
      onChanged(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inGroups = new Set((c?.groups ?? []).map((g) => g.id));

  return (
    // The two confirmations are SIBLINGS of the detail dialog, not children of
    // it. MUI nested them and stacked its own backdrops; Kit's Modal renders a
    // fixed overlay, so a nested one would sit inside a container that is
    // already positioned and inherit the wrong stacking context. Rendering
    // them alongside keeps each overlay owning the whole viewport.
    <>
      <Modal
        title={c?.displayName ?? 'Contact'}
        busy={busy}
        onClose={onClose}
        footer={
          <div className="flex justify-between w-full">
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
          </div>
        }
      >
        <div className="flex items-center gap-2 mb-4">
          {c && (c.ownershipType === 'organisational'
            ? <Badge tone="info">Shared</Badge>
            : <Badge tone="neutral">Mine</Badge>)}
          {c && isAutoSaved(c.source) && (
            <span className="inline-flex items-center rounded-full border border-line bg-transparent px-2.5 py-0.5 text-xs font-normal text-ink-muted">
              {sourceLabel(c.source)}
            </span>
          )}
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        {!c ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Field label="Name">
                <Input  value={form.displayName}
                       onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
              </Field>
              <div className="flex gap-4">
                <div className="flex-auto">
                  <Field label="Company">
                    <Input  value={form.companyName}
                           onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} />
                  </Field>
                </div>
                <div className="flex-auto">
                  <Field label="Job title">
                    <Input  value={form.jobTitle}
                           onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))} />
                  </Field>
                </div>
              </div>
              <Field label="Notes">
                <textarea rows={2}
                        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25" value={form.notes}
                          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="primary" disabled={busy || !dirty}
                  onClick={() => run(() => familyApi.patch(authedFetch, id, {
                    displayName: form.displayName.trim(),
                    jobTitle: form.jobTitle.trim(),
                    companyName: form.companyName.trim(),
                    notes: form.notes.trim(),
                  }), 'Saved.')}
                >
                  {busy ? 'Saving…' : 'Save changes'}
                </Button>
                <Button
                  variant="ghost" disabled={busy}
                  onClick={() => run(() => familyApi.patch(authedFetch, id, { isFavourite: !c.isFavourite }))}
                >
                  {c.isFavourite ? '★ Starred' : '☆ Star'}
                </Button>
              </div>
            </div>

            <hr className="my-0" />

            <Section title="Email addresses">
              {c.emails.length === 0 && <Muted>No addresses.</Muted>}
              {c.emails.map((e) => (
                <Row key={e.id}>
                  <span>
                    {e.email}
                    {e.isPrimary && <span className="ml-2 inline-flex items-center rounded-full border border-line bg-canvas px-2.5 py-0.5 text-xs font-semibold text-ink-muted">primary</span>}
                  </span>
                  <Button variant="ghost" disabled={busy}
                          onClick={() => run(() => familyApi.removeEmail(authedFetch, id, e.id))}>
                    Remove
                  </Button>
                </Row>
              ))}
              <AddRow
                label="Add an address" value={newEmail} onChange={setNewEmail} busy={busy}
                onAdd={() => run(async () => {
                  await familyApi.addEmail(authedFetch, id, newEmail.trim());
                  setNewEmail('');
                })}
              />
            </Section>

            <Section title="Phone numbers">
              {c.phones.length === 0 && <Muted>No numbers.</Muted>}
              {c.phones.map((p) => (
                <Row key={p.id}>
                  <span>
                    {p.phone}
                    {p.isPrimary && <span className="ml-2 inline-flex items-center rounded-full border border-line bg-canvas px-2.5 py-0.5 text-xs font-semibold text-ink-muted">primary</span>}
                  </span>
                  <Button variant="ghost" disabled={busy}
                          onClick={() => run(() => familyApi.removePhone(authedFetch, id, p.id))}>
                    Remove
                  </Button>
                </Row>
              ))}
              <AddRow
                label="Add a number" value={newPhone} onChange={setNewPhone} busy={busy}
                onAdd={() => run(async () => {
                  await familyApi.addPhone(authedFetch, id, newPhone.trim());
                  setNewPhone('');
                })}
              />
            </Section>
            <Section title="Postal addresses">
              {c.addresses.length === 0 && <Muted>No postal addresses.</Muted>}
              {c.addresses.map((a) => (
                <Row key={a.id}>
                  <span>
                    {formatAddress(a)}
                    {a.isPrimary && <span className="ml-2 inline-flex items-center rounded-full border border-line bg-canvas px-2.5 py-0.5 text-xs font-semibold text-ink-muted">primary</span>}
                  </span>
                  <Button variant="ghost" disabled={busy}
                          onClick={() => run(() => familyApi.removeAddress(authedFetch, id, a.id))}>
                    Remove
                  </Button>
                </Row>
              ))}
              <div className="flex flex-wrap gap-2">
                <div className="grow" style={{ minWidth: 200 }}>
                  <Input placeholder="Street" value={newAddr.streetLine1}
                         onChange={(e) => setNewAddr({ ...newAddr, streetLine1: e.target.value })} />
                </div>
                <div style={{ width: 140 }}>
                  <Input placeholder="City" value={newAddr.city}
                         onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} />
                </div>
                <div style={{ width: 120 }}>
                  <Input placeholder="State" value={newAddr.stateProvince}
                         onChange={(e) => setNewAddr({ ...newAddr, stateProvince: e.target.value })} />
                </div>
                <div style={{ width: 100 }}>
                  <Input placeholder="PIN" value={newAddr.postalCode}
                         onChange={(e) => setNewAddr({ ...newAddr, postalCode: e.target.value })} />
                </div>
                <div style={{ width: 130 }}>
                  <Input placeholder="Country" value={newAddr.country}
                         onChange={(e) => setNewAddr({ ...newAddr, country: e.target.value })} />
                </div>
                <Button variant="secondary" disabled={busy || !addrFilled}
                        onClick={() => run(async () => {
                          await familyApi.addAddress(authedFetch, id, newAddr);
                          setNewAddr(EMPTY_ADDRESS);
                        })}>
                  Add
                </Button>
              </div>
            </Section>

            {groups.length > 0 && (
              <Section title="Groups">
                {/* Real buttons: these toggle membership on click, so they were
                    interactive Chips. A span with onClick is not reachable by
                    keyboard, and MUI's Chip was quietly handling that. */}
                <div className="flex flex-wrap gap-2">
                  {groups.map((g) => {
                    const member = inGroups.has(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        disabled={busy}
                        aria-pressed={member}
                        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${member
                          ? 'border-transparent bg-brand-500 text-white'
                          : 'border-line bg-transparent text-ink-muted hover:bg-canvas'}`}
                        style={{ cursor: 'pointer', fontWeight: 500 }}
                        onClick={() => run(() => member
                          ? familyApi.removeFromGroup(authedFetch, g.id, id)
                          : familyApi.addToGroup(authedFetch, g.id, id))}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                </div>
              </Section>
            )}

            <hr className="my-0" />

            <p className="text-[0.875rem] text-ink-muted mb-0">
              {c.interactionCount === 0
                ? 'No exchanges recorded.'
                : `${c.interactionCount} exchange${c.interactionCount === 1 ? '' : 's'}, most recently ${ago(c.lastContactedAt).toLowerCase()}.`}
            </p>

            {c.ownershipType === 'personal' && (
              <Alert tone="info" className="mb-0"
                     action={<Button variant="ghost" onClick={() => setConfirmShare(true)}>Share</Button>}>
                Only you can see this contact.
              </Alert>
            )}
          </div>
        )}
      </Modal>

      {/* Sharing is irreversible, so the dialog says so before, not after. */}
      {confirmShare && (
        <Modal
          title="Share with your organisation?"
          size="sm"
          onClose={() => setConfirmShare(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmShare(false)}>Cancel</Button>
              <Button
                variant="primary" disabled={busy}
                onClick={() => { setConfirmShare(false); void run(
                  () => familyApi.patch(authedFetch, id, { ownershipType: 'organisational' }),
                  'Shared with your organisation.',
                ); }}
              >
                Share it
              </Button>
            </>
          }
        >
          <p className="text-[0.875rem] mb-0">
            Everyone in your organisation will be able to see, edit and use this contact.
          </p>
          <p className="text-[0.875rem] font-semibold mt-4 mb-0">
            This cannot be undone. Making it personal again would mean choosing who owns it,
            and there is no right answer to that — you would have to create a fresh copy.
          </p>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Delete this contact?"
          size="sm"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button
                variant="primary" disabled={busy}
                onClick={async () => {
                  setConfirmDelete(false); setBusy(true);
                  try { await familyApi.remove(authedFetch, id); onDeleted(); }
                  catch (e) { setError((e as Error).message); setBusy(false); }
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-[0.875rem] mb-0">It disappears from every list and search.</p>
          {c && isAutoSaved(c.source) && (
            <p className="text-[0.875rem] mt-4 mb-0">
              Because this one was saved automatically, deleting it also stops it coming back —
              the next message from that address will not recreate it.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
//  Small shared bits, local to this screen
// ---------------------------------------------------------------------------

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <div className="text-[0.875rem] font-semibold mb-2">{title}</div>
    <div className="flex flex-col gap-2">{children}</div>
  </div>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-2">
    {children}
  </div>
);

const Muted = ({ children }: { children: React.ReactNode }) => (
  <span className="text-[0.875rem] text-ink-muted">{children}</span>
);

const EMPTY_ADDRESS = { streetLine1: '', city: '', stateProvince: '', postalCode: '', country: '' };

function formatAddress(a: {
  streetLine1?: string | null; streetLine2?: string | null; city?: string | null;
  stateProvince?: string | null; postalCode?: string | null; country?: string | null;
}): string {
  return [a.streetLine1, a.streetLine2, a.city, a.stateProvince, a.postalCode, a.country]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(', ');
}

function AddRow({ label, value, onChange, onAdd, busy }: {
  label: string; value: string; onChange: (v: string) => void;
  onAdd: () => void; busy: boolean;
}) {
  return (
    <div className="flex gap-2">
      <Input
        
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { e.preventDefault(); onAdd(); } }}
      />
      <Button variant="secondary" disabled={busy || value.trim().length === 0} onClick={onAdd}>Add</Button>
    </div>
  );
}


/**
 * Replaces MUI's Menu: a list positioned under the element that opened it.
 *
 * Fixed positioning measured from the anchor, for the same reason as the
 * contact picker — the bulk bar scrolls, and an absolutely positioned child
 * would be clipped by the card's overflow.
 *
 * Dismissal is deliberately complete: outside click, Escape, scroll and
 * resize all close it. MUI repositioned on scroll instead; closing is the
 * simpler promise to keep, and a menu left floating beside the button it no
 * longer points at is worse than one that has gone away.
 */
function AnchoredMenu({ anchor, onClose, children }: {
  anchor: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const r = anchor.getBoundingClientRect();
    setBox({ top: r.bottom + 4, left: r.left });

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);

  if (!box) return null;

  return (
    <>
      {/* A transparent full-screen catcher, so any outside click closes the
          menu without every ancestor needing its own handler. */}
      <div className="fixed top-0 start-0 w-full h-full"
           style={{ zIndex: 1390 }} onClick={onClose} aria-hidden />
      <ul
        className="list-none pl-0 bg-surface rounded shadow border m-0 py-1"
        style={{
          position: 'fixed', top: box.top, left: box.left,
          minWidth: 200, maxHeight: 320, overflowY: 'auto', zIndex: 1400,
        }}
        role="menu"
      >
        {children}
      </ul>
    </>
  );
}