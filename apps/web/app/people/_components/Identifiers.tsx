'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge, Button, Card, Table, Td } from '@/components/ui/Kit';
import { Input, Select, Textarea } from '@/components/ui/Form';
import { Field, Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

type Kind = 'aadhaar' | 'pan' | 'bank_account';
interface Item { kind: Kind; last4: string; ifsc: string | null; verified: boolean; updatedAt: string }
interface Listing { configured: boolean; canReveal: boolean; canSet: boolean; items: Item[] }
interface Read { kind: Kind; reader: string | null; reason: string; note: string | null; outcome: 'shown' | 'failed'; readAt: string }

const KINDS: Kind[] = ['aadhaar', 'pan', 'bank_account'];
const KIND_LABEL: Record<Kind, string> = { aadhaar: 'Aadhaar', pan: 'PAN', bank_account: 'Bank account' };
const REASON_LABEL: Record<string, string> = {
  payroll_setup: 'Setting up payroll',
  statutory_filing: 'A statutory filing',
  correction: 'Correcting the record',
  employee_request: 'The employee asked',
  own_record: 'It is my own',
};
const HIDE_AFTER_MS = 60_000;

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// ============================================================================
//  Aadhaar, PAN and bank details on one employee (decision 0015; Amit's
//  answers of 10 Oct 2026). HELD FOR MR. SINGH with the API behind it.
//
//  WHAT THIS PAGE MAY SAY, CHECKED AGAINST THE API:
//    * masked by default - the list endpoint returns only the last four;
//    * "only the people your organisation names, and you for your own" -
//      PeopleAccess.CanRevealAsync; a manager never gets this card at all
//      (the list answers 404 and the card renders nothing);
//    * "every reveal is recorded with its reason" - one identifier_reads row
//      per value, written in the same save as the decryption.
//
//  A REVEALED VALUE LIVES ONLY IN THIS COMPONENT'S STATE: never in storage,
//  never in the URL, cleared when the dialog closes and after a minute.
// ============================================================================
export function IdentifiersCard({ employeeId, own, isHr, exited }: {
  employeeId: string;
  /** The signed-in person's own record: they may reveal theirs, reason "own_record". */
  own: boolean;
  /** People HR may mark an original as seen. */
  isHr: boolean;
  exited: boolean;
}) {
  const { authedFetch } = useAuth();
  const [data, setData] = useState<Listing | null | 'hidden'>(null);
  const [reads, setReads] = useState<Read[]>([]);
  const [setting, setSetting] = useState<Kind | null>(null);
  const [revealing, setRevealing] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authedFetch(`/people/employees/${employeeId}/identifiers`);
    if (!res.ok) { setData('hidden'); return; }
    setData(await res.json());
    const r = await authedFetch(`/people/employees/${employeeId}/identifier-reads`);
    if (r.ok) setReads(await r.json());
  }, [authedFetch, employeeId]);

  useEffect(() => { void load(); }, [load]);

  async function verify(kind: Kind) {
    setError(null);
    const res = await authedFetch(`/people/employees/${employeeId}/identifiers/${kind}/verify`, { method: 'POST' });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? 'Could not save.'); return; }
    await load();
  }

  if (data === null || data === 'hidden') return null;
  const byKind = new Map(data.items.map((i) => [i.kind, i]));

  return (
    <>
      <Card title="Identity and bank details" className="mb-5" padded={false}>
        {!data.configured && (
          <div className="p-4 pb-0">
            <Alert tone="info">Identity and bank details are not set up on this server yet. Nothing can be entered or shown.</Alert>
          </div>
        )}
        {error && <div className="p-4 pb-0"><Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert></div>}
        <p className="px-4 pt-4 text-[0.8125rem] text-ink-muted">
          Stored encrypted and shown masked. {own ? 'You can see your own in full; ' : ''}Only the people your
          organisation names can see them in full, and each time is recorded with the reason
          {own ? ' — you can see who, below' : ''}.
        </p>
        <Table head={['', 'Number', 'Original seen', '']}>
          {KINDS.map((k) => {
            const it = byKind.get(k);
            return (
              <tr key={k}>
                <Td className="font-medium">{KIND_LABEL[k]}</Td>
                <Td>
                  {it ? <span className="font-mono">•••• {it.last4}</span> : <span className="text-ink-muted">Not entered</span>}
                  {it?.ifsc && <div className="text-xs text-ink-muted">IFSC {it.ifsc}</div>}
                </Td>
                <Td>{it ? (it.verified ? <Badge tone="ok">Yes</Badge> : <Badge tone="neutral">Not yet</Badge>) : '—'}</Td>
                <Td className="text-right whitespace-nowrap">
                  {it && data.canReveal && data.configured && (
                    <Button size="sm" variant="ghost" onClick={() => setRevealing(k)}>Show</Button>
                  )}
                  {it && isHr && !it.verified && (
                    <Button size="sm" variant="ghost" onClick={() => void verify(k)}>Mark original seen</Button>
                  )}
                  {data.canSet && data.configured && !exited && (
                    <Button size="sm" variant="ghost" onClick={() => setSetting(k)}>{it ? 'Replace' : 'Enter'}</Button>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      {reads.length > 0 && (
        <Card title={own ? 'Who has seen mine in full' : 'Who has seen these in full'} className="mb-5" padded={false}>
          <Table head={['When', 'Who', 'What', 'Why']}>
            {reads.map((r, i) => (
              <tr key={i}>
                <Td>{when(r.readAt)}</Td>
                <Td>{r.reader ?? 'Someone no longer here'}</Td>
                <Td>{KIND_LABEL[r.kind]}{r.outcome === 'failed' && <> <Badge tone="danger">could not be opened</Badge></>}</Td>
                <Td>{REASON_LABEL[r.reason] ?? r.reason}{r.note && <div className="text-xs text-ink-muted">{r.note}</div>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {setting && (
        <SetDialog employeeId={employeeId} kind={setting} replacing={byKind.has(setting)}
                   onClose={() => setSetting(null)} onSaved={async () => { setSetting(null); await load(); }} />
      )}
      {revealing && (
        <RevealDialog employeeId={employeeId} kind={revealing} own={own}
                      onClose={async () => { setRevealing(null); await load(); }} />
      )}
    </>
  );
}

function SetDialog({ employeeId, kind, replacing, onClose, onSaved }: {
  employeeId: string; kind: Kind; replacing: boolean; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { authedFetch } = useAuth();
  const [value, setValue] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/employees/${employeeId}/identifiers/${kind}`, {
        method: 'PUT', body: JSON.stringify({ value, ifsc: kind === 'bank_account' ? ifsc || null : null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save.');
      setValue('');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const hint = kind === 'aadhaar' ? '12 digits. Spaces are fine. Only the number — never a scan.'
    : kind === 'pan' ? 'Five letters, four digits and a letter, like ABCDE1234F.'
    : '9 to 18 digits.';
  return (
    <Modal title={`${replacing ? 'Replace' : 'Enter'} ${KIND_LABEL[kind]}`} onClose={onClose} busy={busy}
           footer={<>
             <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={() => void save()} disabled={busy || !value.trim()}>Save</Button>
           </>}>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {replacing && <p className="mb-3 text-[0.8125rem] text-ink-muted">The old number is replaced, and "original seen" is cleared until HR sees the new one.</p>}
      <Field label={KIND_LABEL[kind]} required hint={hint}>
        <Input aria-label={KIND_LABEL[kind]} value={value} onChange={(e) => setValue(e.target.value)}
               autoComplete="off" spellCheck={false} inputMode={kind === 'pan' ? 'text' : 'numeric'} />
      </Field>
      {kind === 'bank_account' && (
        <Field label="IFSC" hint="11 characters, like HDFC0001234.">
          <Input aria-label="IFSC" value={ifsc} onChange={(e) => setIfsc(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      )}
    </Modal>
  );
}

function RevealDialog({ employeeId, kind, own, onClose }: {
  employeeId: string; kind: Kind; own: boolean; onClose: () => void | Promise<void>;
}) {
  const { authedFetch } = useAuth();
  const [reason, setReason] = useState(own ? 'own_record' : '');
  const [note, setNote] = useState('');
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The value goes when the dialog does, and after a minute regardless.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); setValue(null); }, []);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/employees/${employeeId}/identifiers/${kind}/reveal`, {
        method: 'POST', cache: 'no-store', body: JSON.stringify({ reason, note: note.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not show it.');
      setValue(body.value);
      timer.current = setTimeout(() => setValue(null), HIDE_AFTER_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not show it.');
    } finally {
      setBusy(false);
    }
  }

  const reasons = Object.entries(REASON_LABEL).filter(([k]) => own || k !== 'own_record');
  return (
    <Modal title={`Show ${KIND_LABEL[kind]}`} onClose={() => void onClose()} busy={busy}
           footer={value
             ? <Button variant="primary" onClick={() => void onClose()}>Hide and close</Button>
             : <>
                 <Button variant="ghost" onClick={() => void onClose()} disabled={busy}>Cancel</Button>
                 <Button variant="primary" onClick={() => void reveal()} disabled={busy || !reason}>Show</Button>
               </>}>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {value ? (
        <>
          <p className="mb-2 select-all font-mono text-lg tracking-wider">{value}</p>
          <p className="text-[0.8125rem] text-ink-muted">This has been recorded. It hides itself after a minute.</p>
        </>
      ) : (
        <>
          <p className="mb-3 text-[0.8125rem] text-ink-muted">
            {own ? 'This is recorded, like every time anyone sees it.' : 'This is recorded with your name and reason, and the employee can see it.'}
          </p>
          <Field label="Why" required>
            <Select aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose…</option>
              {reasons.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Note" hint="Optional. Up to 300 characters. Never the number itself.">
            <Textarea aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} />
          </Field>
        </>
      )}
    </Modal>
  );
}

// ============================================================================
//  Who may see identifiers in full. Administrators name them, themselves
//  included, recorded as such (identifier_reader.added, appointedThemselves).
// ============================================================================
export function IdentifierReadersCard({ canName, people, currentUserId }: {
  canName: boolean;
  people: { id: string; displayName: string; email: string }[];
  currentUserId: string | undefined;
}) {
  const { authedFetch } = useAuth();
  const [readers, setReaders] = useState<{ userId: string; name: string | null; createdAt: string }[] | null>(null);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authedFetch('/people/identifier-readers');
    setReaders(res.ok ? await res.json() : []);
  }, [authedFetch]);
  useEffect(() => { void load(); }, [load]);

  async function change(userId: string, method: 'PUT' | 'DELETE') {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/identifier-readers/${userId}`, { method });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save.');
      setPick('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (readers === null) return null;
  const onList = new Set(readers.map((r) => r.userId));
  return (
    <Card title="Who can see Aadhaar, PAN and bank details in full" className="mt-5" padded={false}>
      <div className="px-4 pt-4">
        {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
        <p className="text-[0.8125rem] text-ink-muted">
          Being People HR is not enough. Only the people named here, and each employee for their own, can see a
          number in full — and each time is recorded with a reason the employee can read.
          {!canName && ' Only an administrator can change this list.'}
        </p>
      </div>
      {readers.length === 0 ? (
        <p className="p-4 text-[0.8125rem] text-ink-muted">Nobody is named. Numbers stay masked for everyone but the employee.</p>
      ) : (
        <Table head={['Name', 'Since', '']}>
          {readers.map((r) => (
            <tr key={r.userId}>
              <Td>{r.name ?? 'Unknown'}{r.userId === currentUserId ? ' (you)' : ''}</Td>
              <Td>{new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</Td>
              <Td className="text-right">
                {canName && <Button size="sm" variant="ghost" onClick={() => void change(r.userId, 'DELETE')} disabled={busy}>Remove</Button>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {canName && (
        <div className="flex items-end gap-2 p-4">
          <div className="flex-1">
            <Select aria-label="Name someone" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Name someone…</option>
              {people.filter((p) => !onList.has(p.id)).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}{p.id === currentUserId ? ' (you)' : ''} — {p.email}</option>
              ))}
            </Select>
          </div>
          <Button variant="primary" onClick={() => void change(pick, 'PUT')} disabled={busy || !pick}>Add</Button>
        </div>
      )}
    </Card>
  );
}
