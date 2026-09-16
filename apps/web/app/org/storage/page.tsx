'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '@tatvaos/core';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Meter, Stat, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { Checkbox, Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import {
  AllocationError, fetchMailboxUsage, fetchOrgStorage, setAllocation,
  type MailboxUsage, type OrgStorage, type StorageProduct,
} from '@/lib/orgStorage';

const GB = 1024 ** 3;

/** The org-level colour comes from the server's flags, never from a local sum. */
function toneOf(s: OrgStorage): 'ok' | 'warn' | 'danger' {
  if (s.isCritical) return 'danger';
  if (s.isWarning) return 'warn';
  return 'ok';
}

export default function OrgStoragePage() {
  const { authedFetch } = useAuth();

  const [storage, setStorage] = useState<OrgStorage | null>(null);
  const [mailboxes, setMailboxes] = useState<MailboxUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StorageProduct | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m] = await Promise.all([
        fetchOrgStorage(authedFetch),
        fetchMailboxUsage(authedFetch),
      ]);
      setStorage(s);
      setMailboxes(m);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load storage.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <AdminShell scope="organisation" title="Storage">
        <div className="grid place-items-center !py-[3rem]">
          <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
        </div>
      </AdminShell>
    );
  }

  if (error || !storage) {
    return (
      <AdminShell scope="organisation" title="Storage">
        <Alert tone="danger">{error ?? 'Could not load storage.'}</Alert>
      </AdminShell>
    );
  }

  const s = storage;
  const pooled = s.storageModel === 'pooled';
  const tone = toneOf(s);

  return (
    <AdminShell
      scope="organisation"
      title="Storage"
      subtitle={pooled
        ? 'One allocation shared across every mailbox'
        : 'Each mailbox has its own fixed allowance'}
    >
      {/* The gate's own words. Writing our own sentence here would eventually
          describe a rule the server no longer enforces. */}
      {!s.canAddUser && s.reason && (
        <Alert tone="warn">{s.reason}</Alert>
      )}

      <div className="!mb-[1.5rem] grid grid-cols-2 !gap-[1.5rem] lg:grid-cols-4">
        <Stat label="Used" value={formatBytes(s.usedBytes)}
              caption={`of ${formatBytes(s.totalBytes)}`} />
        <Stat label="Available" value={formatBytes(s.availableBytes)} />
        <Stat label="People" value={String(s.userCount)}
              caption={s.maxUsers == null ? 'Unlimited' : `of ${s.maxUsers} allowed`} />
        <Stat
          label={pooled ? 'Model' : 'Per person'}
          value={pooled ? 'Pooled' : formatBytes(s.perUserQuotaBytes ?? 0)}
          caption={pooled ? 'Shared pool' : 'Each mailbox'}
        />
      </div>

      <Card
        title={pooled ? 'The pool' : 'Committed across the organisation'}
        subtitle={pooled
          ? 'Every mailbox draws from this. When it fills, they all stop receiving at once.'
          : `${formatBytes(s.perUserQuotaBytes ?? 0)} per mailbox × ${s.maxUsers ?? s.userCount} seats. Only consumed as mailboxes are created.`}
        className="!mb-[1.5rem]"
      >
        {/* tone comes from isWarning/isCritical so this bar and the add-user
            gate can never disagree about what "nearly full" means. */}
        <Meter used={s.usedBytes} total={s.totalBytes} tone={tone} />
        <p className="!mt-[1rem] mb-0 !text-[0.75rem] !text-ink-muted">
          {Math.round(s.usedFraction * 100)}% used — {formatBytes(s.availableBytes)} still available.
          {s.isCritical && ' This is critical: new mail will start failing.'}
          {!s.isCritical && s.isWarning && ' Approaching the limit.'}
        </p>
      </Card>

      <div className="grid !gap-[1.5rem] lg:grid-cols-2">
        {/* ---- products ---- */}
        <Card title="By product"
              subtitle="How the pool is divided. A product with no allocation draws from whatever is left.">
          {s.products.length === 0 ? (
            <Empty title="No products yet" />
          ) : (
            <div className="grid !gap-[1rem]">
              {s.products.map((p) => (
                <div key={p.productCode}>
                  <div className="!flex !items-center gap-2 mb-1">
                    <span className="!font-semibold !text-[0.8125rem] !flex-auto">{p.productName}</span>
                    <span className="!text-[0.75rem] !text-ink-muted">
                      {formatBytes(p.usedBytes)}
                      {p.allocatedBytes == null
                        ? ' · from the pool'
                        : ` of ${formatBytes(p.allocatedBytes)}`}
                    </span>
                    <Button variant="ghost" onClick={() => setEditing(p)}>Change</Button>
                  </div>
                  <Meter used={p.usedBytes} total={p.allocatedBytes ?? s.totalBytes} />
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ---- heaviest mailboxes ---- */}
        <Card title="Heaviest mailboxes"
              subtitle="Sorted by what they hold — the first row is the conversation to have."
              padded={false}>
          {mailboxes.length === 0 ? (
            <Empty title="No mailboxes yet" />
          ) : (
            <Table head={['Mailbox', 'Used', '']}>
              {mailboxes.map((m) => (
                <tr key={m.address}>
                  <Td>
                    <div className="!font-semibold">
                      {m.displayName ?? m.address}
                      {/* A shared mailbox has nobody behind it — saying so stops
                          somebody hunting for who owns support@. */}
                      {m.isShared && (
                        <span className="ml-2"><Badge tone="neutral">Shared</Badge></span>
                      )}
                    </div>
                    {m.displayName && <div className="!text-[0.75rem] !text-ink-muted">{m.address}</div>}
                  </Td>
                  <Td>
                    <div className="!text-[0.75rem]">
                      {formatBytes(m.usedBytes)}
                      <span className="!text-ink-muted"> / {formatBytes(m.quotaBytes)}</span>
                    </div>
                    <div className="mt-1" style={{ width: 112 }}>
                      <Meter used={m.usedBytes} total={m.quotaBytes} />
                    </div>
                  </Td>
                  <Td>
                    <span className="!text-[0.75rem] !text-ink-muted">{Math.round(m.usedFraction * 100)}%</span>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {editing && (
        <AllocationDialog
          product={editing}
          pool={s}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
function AllocationDialog({ product, pool, onClose, onSaved }: {
  product: StorageProduct;
  pool: OrgStorage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authedFetch } = useAuth();
  // null allocation is the sensible default for a single-product customer, so
  // it is a first-class choice here rather than "clear the field".
  const [fromPool, setFromPool] = useState(product.allocatedBytes == null);
  const [gb, setGb] = useState(
    product.allocatedBytes == null ? '' : String(Math.round(product.allocatedBytes / GB)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [headroom, setHeadroom] = useState<number | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setHeadroom(null);
    try {
      await setAllocation(authedFetch, product.productCode, fromPool ? null : Math.round(Number(gb) * GB));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the allocation.');
      if (e instanceof AllocationError && e.availableBytes != null) setHeadroom(e.availableBytes);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Allocation — ${product.productName}`}
      subtitle={`Currently holding ${formatBytes(product.usedBytes)}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}
                  disabled={busy || (!fromPool && !(Number(gb) > 0))}>
            {busy ? 'Saving…' : 'Save allocation'}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger">
          {error}
          {headroom != null && (
            <div className="!text-[0.75rem] mt-1">{formatBytes(headroom)} is unallocated in the pool.</div>
          )}
        </Alert>
      )}

      <Checkbox
        id="from-pool"
        label="Draw from whatever is left in the pool"
        checked={fromPool}
        onChange={(e) => setFromPool(e.target.checked)}
      />

      {!fromPool && (
        <Field
          label="Allocation (GB)"
          hint={`The pool holds ${formatBytes(pool.totalBytes)} in total. An allocation cannot be smaller than what the product already uses.`}
        >
          <Input  type="number" min={1} value={gb}
                 onChange={(e) => setGb(e.target.value.replace(/\D/g, ''))} />
        </Field>
      )}
    </Modal>
  );
}
