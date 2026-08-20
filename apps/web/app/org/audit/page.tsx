'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { formatTimestamp } from '@/lib/dates';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import {
  fetchAudit, fetchAuditActions, formatState, humaniseAction, isSensitive,
  type AuditEntry, type AuditQuery,
} from '@/lib/audit';

// ============================================================================
//  Audit trail
// ============================================================================
//
//  Every administrative action has been recorded since the beginning and there
//  has never been anywhere to look at it. This is that place.
//
//  Two decisions shape the screen.
//
//  LOAD MORE, NOT PAGE NUMBERS. The trail grows while it is open, so there is
//  no stable "page 2" — an offset would show a row twice or skip one as new
//  entries land above. The API pages by cursor and the UI matches it honestly
//  rather than inventing pagination the data cannot support.
//
//  DETAIL IS COLLAPSED BY DEFAULT. Most rows are routine and the before/after
//  blobs are large. Expanding is per row, so scanning stays possible.
// ============================================================================

/** Local midnight → ISO, so a date input filters the day the user means. */
function dayStart(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T00:00:00`).toISOString();
}

/** The instant AFTER the chosen day, since the API's `to` is exclusive. */
function dayEnd(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// Rendered in the reader's own ZONE — that part was always right and stays —
// but no longer in the reader's browser LOCALE, which silently decided field
// order. An audit trail is read to answer "when exactly", and an ambiguous
// 03/04 costs somebody a phone call.
const when = formatTimestamp;

export default function OrgAuditPage() {
  const { authedFetch } = useAuth();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // "Who" offers the organisation's people; "Product" is the fixed set of
  // things that write to the trail. Answers the two questions the trail is
  // actually opened for: "what did THIS person do" and "who touched Mail".
  const [people, setPeople] = useState<{ id: string; displayName: string }[]>([]);
  const [actor, setActor] = useState('');
  const [product, setProduct] = useState('');

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const query = useCallback((): AuditQuery => ({
    action: action || undefined,
    actorUserId: actor || undefined,
    productCode: product || undefined,
    from: dayStart(from),
    to: dayEnd(to),
  }), [action, actor, product, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await fetchAudit(authedFetch, query());
      setEntries(page.entries);
      setNextBefore(page.nextBefore);
      setHasMore(page.hasMore);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the audit trail.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch, query]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void fetchAuditActions(authedFetch).then(setActions).catch(() => setActions([]));
    void authedFetch('/org/users')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { id: string; displayName: string }[]) =>
        setPeople(list.sort((a, b) => a.displayName.localeCompare(b.displayName))))
      .catch(() => setPeople([]));
  }, [authedFetch]);

  async function loadMore() {
    if (nextBefore === null) return;
    setLoadingMore(true);
    try {
      const page = await fetchAudit(authedFetch, { ...query(), before: nextBefore });
      // Appended, never replaced — the cursor guarantees no overlap with what
      // is already on screen.
      setEntries((prev) => [...prev, ...page.entries]);
      setNextBefore(page.nextBefore);
      setHasMore(page.hasMore);
    } catch {
      setError('Could not load more entries.');
    } finally {
      setLoadingMore(false);
    }
  }

  function clearFilters() {
    setAction('');
    setActor('');
    setProduct('');
    setFrom('');
    setTo('');
  }

  const filtered = action !== '' || actor !== '' || product !== '' || from !== '' || to !== '';

  return (
    <AdminShell
      scope="organisation"
      title="Audit trail"
      subtitle="Every administrative action in your organisation, newest first."
    >
      <Card>
        {/* Filters */}
        <div className="row g-2 align-items-end mb-3">
          <div className="col-md-3">
            <label className="form-label fs-12 text-muted mb-1">Action</label>
            <select
              className="form-select"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="">All actions</option>
              {actions.map((a) => (
                <option key={a} value={a}>{humaniseAction(a)}</option>
              ))}
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label fs-12 text-muted mb-1">Who</label>
            <select
              className="form-select"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            >
              <option value="">Anyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label fs-12 text-muted mb-1">Product</label>
            <select
              className="form-select"
              value={product}
              onChange={(e) => setProduct(e.target.value)}
            >
              <option value="">All products</option>
              {/* The set of things that write to the trail — a new product
                  writing audits needs a line here to become filterable. */}
              <option value="core">Core console</option>
              <option value="mail">Mail</option>
              <option value="drive">Space</option>
            </select>
          </div>
          <div className="col-md-2">
            <label className="form-label fs-12 text-muted mb-1">From</label>
            <input type="date" className="form-control"
                   value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="col-md-2">
            <label className="form-label fs-12 text-muted mb-1">To</label>
            <input type="date" className="form-control"
                   value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {filtered && (
            <div className="col-auto">
              <Button variant="secondary" onClick={clearFilters}>Clear</Button>
            </div>
          )}
        </div>

        {error && <div className="alert alert-danger">{error}</div>}

        {loading ? (
          <div className="grid place-items-center py-5">
            <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
          </div>
        ) : entries.length === 0 ? (
          <Empty
            title={filtered ? 'Nothing matches those filters' : 'No activity recorded yet'}
            hint={filtered
              ? 'Try a wider date range, or clear the filters.'
              : 'Administrative actions appear here as they happen.'}
          />
        ) : (
          <>
            <Table head={['When', 'Action', 'Who', 'Target', '']}>
              {entries.map((e) => (
                // A real Fragment, not <>: the key has to live on the outermost
                // element of the map, and shorthand fragments cannot carry one.
                <Fragment key={e.id}>
                  <tr>
                    <Td>
                      <div className="fs-13">{when(e.occurredAt)}</div>
                    </Td>
                    <Td>
                      <div className="fw-semibold">
                        {humaniseAction(e.action)}
                        {/* Credential and access changes are what somebody is
                            looking for after an incident; routine entries are
                            what they are scrolling past. */}
                        {isSensitive(e.action) && (
                          <span className="ms-2"><Badge tone="warn">Sensitive</Badge></span>
                        )}
                      </div>
                      <div className="fs-12 text-muted">
                        {e.action}
                        {e.productCode && e.productCode !== 'core' && ` · ${e.productCode}`}
                      </div>
                    </Td>
                    <Td>
                      {e.actorName ?? e.actorEmail ?? (
                        // A deleted actor, or the platform itself. Saying so is
                        // more honest than printing a bare id nobody can resolve.
                        <span className="text-muted">Not recorded</span>
                      )}
                      {e.actorIp && <div className="fs-12 text-muted">{e.actorIp}</div>}
                    </Td>
                    <Td>
                      {e.targetType
                        ? <span className="fs-13">{e.targetType}</span>
                        : <span className="text-muted">—</span>}
                      {e.targetId && (
                        <div className="fs-12 text-muted text-truncate" style={{ maxWidth: 220 }}>
                          {e.targetId}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {e.hasDetail && (
                        <button
                          type="button"
                          className="btn btn-sm btn-light"
                          onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                        >
                          {expanded === e.id ? 'Hide' : 'Detail'}
                        </button>
                      )}
                    </Td>
                  </tr>

                  {expanded === e.id && (
                    <tr>
                      <td colSpan={5} className="bg-light">
                        <div className="row g-3 p-2">
                          <div className="col-md-6">
                            <div className="fs-12 fw-semibold text-muted mb-1">BEFORE</div>
                            <pre className="fs-12 mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                              {formatState(e.beforeState) ?? '—'}
                            </pre>
                          </div>
                          <div className="col-md-6">
                            <div className="fs-12 fw-semibold text-muted mb-1">AFTER</div>
                            <pre className="fs-12 mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                              {formatState(e.afterState) ?? '—'}
                            </pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>

            <div className="d-flex justify-content-center mt-3">
              {hasMore ? (
                <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              ) : (
                <span className="fs-12 text-muted">
                  {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} — that is everything.
                </span>
              )}
            </div>
          </>
        )}
      </Card>
    </AdminShell>
  );
}
