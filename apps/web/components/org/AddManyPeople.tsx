'use client';

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Button, Table, Td } from '@/components/ui/Kit';
import { Field, Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';

// ---------------------------------------------------------------------------
//  Add many people — paste or upload, preview, then create
// ---------------------------------------------------------------------------
//
//  Three steps, and the middle one is the point:
//
//    input    paste rows (or pick a CSV). Parsed in the browser: obvious
//             problems — wrong domain, no name — are shown here and never
//             sent.
//    preview  the server checks the rest with dryRun: true — existing
//             addresses, unknown departments, repeats — and reports what it
//             WOULD do. Nothing is written. The admin cannot reach Create
//             without seeing this.
//    done     temporary passwords, shown once. Download or copy them now;
//             they are hashed on the server and cannot be shown again.
//
//  Row format: Name, email or username, Department (optional). A header row
//  is ignored; tabs and semicolons work, so a paste from Excel is fine.
//  Department is matched by NAME against this organisation's departments —
//  "Class 5A" as the spreadsheet has it. A row without one takes the default
//  chosen above the box.
// ---------------------------------------------------------------------------

interface DeptOpt { id: string; name: string; depth: number }
interface DomainOpt { id: string; fqdn: string }

interface Row {
  line: number;
  name: string;
  localPart: string;
  department: string | null;
  /** Found before asking the server — the row never leaves the browser. */
  problem: string | null;
}
interface PreviewCreated { email: string; displayName: string; department: string | null; mailbox: boolean }
interface Skipped { address: string; displayName: string; reason: string }
interface Created { email: string; displayName: string; department: string | null; temporaryPassword: string }

const HEADER_WORDS = ['name', 'email', 'e-mail', 'username', 'user', 'login', 'department', 'class', 'localpart', 'local part'];

function splitLine(line: string): string[] {
  const delim = line.includes('\t') ? '\t'
    : (line.split(';').length > line.split(',').length ? ';' : ',');
  return line.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
}

function looksLikeHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.toLowerCase());
  return !lower.some((c) => c.includes('@')) && lower.some((c) => HEADER_WORDS.includes(c));
}

export function parseRows(text: string, fqdn: string): Row[] {
  const rows: Row[] = [];
  let first = true;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = splitLine(line);
    if (first) {
      first = false;
      if (looksLikeHeader(cells)) return;
    }
    if (cells.filter(Boolean).length < 2) {
      rows.push({ line: i + 1, name: cells[0] ?? '', localPart: '', department: null,
                  problem: 'needs a name and an email or username' });
      return;
    }
    const emailIdx = cells.findIndex((c) => c.includes('@'));
    let name: string;
    let ident: string;
    let department: string | null;
    if (emailIdx >= 0) {
      ident = cells[emailIdx] ?? '';
      const rest = cells.filter((_, j) => j !== emailIdx);
      name = rest[0] ?? '';
      department = rest[1] || null;
    } else {
      name = cells[0] ?? '';
      ident = cells[1] ?? '';
      department = cells[2] || null;
    }
    let localPart = ident.toLowerCase();
    let problem: string | null = null;
    const at = ident.indexOf('@');
    if (at >= 0) {
      const dom = ident.slice(at + 1).toLowerCase();
      localPart = ident.slice(0, at).toLowerCase();
      if (dom !== fqdn.toLowerCase()) problem = `address is on ${dom}, not ${fqdn}`;
    }
    if (!problem && name.trim().length < 2) problem = 'name is missing';
    if (!problem && !localPart) problem = 'email or username is missing';
    rows.push({ line: i + 1, name: name.trim(), localPart, department, problem });
  });
  return rows;
}

function csvCell(v: string | null): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function AddManyPeople({ departments, domains, onClose, onDone }: {
  departments: DeptOpt[];
  domains: DomainOpt[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [step, setStep] = useState<'input' | 'preview' | 'done'>('input');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ created: PreviewCreated[]; skipped: Skipped[] } | null>(null);
  const [result, setResult] = useState<{ created: Created[]; skipped: Skipped[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const domain = domains.find((d) => d.id === domainId);
  const rows = useMemo(() => (domain ? parseRows(text, domain.fqdn) : []), [text, domain]);
  const good = useMemo(() => rows.filter((r) => !r.problem), [rows]);
  const bad = useMemo(() => rows.filter((r) => r.problem), [rows]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
  }

  async function call(dryRun: boolean): Promise<{ created: unknown[]; skipped: unknown[] }> {
    const res = await authedFetch('/org/users/bulk', {
      method: 'POST',
      body: JSON.stringify({
        domainId,
        departmentId: departmentId || null,
        dryRun,
        users: good.map((r) => ({ localPart: r.localPart, displayName: r.name, department: r.department })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The import could not be processed.');
    return { created: data.created ?? [], skipped: data.skipped ?? [] };
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const runPreview = () => run(async () => {
    const d = await call(true);
    setPreview({ created: d.created as PreviewCreated[], skipped: d.skipped as Skipped[] });
    setStep('preview');
  });

  const runCreate = () => run(async () => {
    const d = await call(false);
    setResult({ created: d.created as Created[], skipped: d.skipped as Skipped[] });
    setStep('done');
  });

  const passwordLines = () =>
    (result?.created ?? []).map((c) => `${c.email}\t${c.temporaryPassword}`).join('\n');

  function download() {
    if (!result) return;
    const lines = ['Name,Email,Department,Temporary password',
      ...result.created.map((c) =>
        [csvCell(c.displayName), csvCell(c.email), csvCell(c.department), csvCell(c.temporaryPassword)].join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `people-${domain?.fqdn ?? 'import'}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(passwordLines());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — select the table and copy it by hand.');
    }
  }

  // ---- step: done ---------------------------------------------------------
  if (step === 'done' && result) {
    const n = result.created.length;
    return (
      <Modal
        title={`${n} ${n === 1 ? 'person' : 'people'} created`}
        subtitle="Temporary passwords are shown once. Download or copy them now."
        size="lg"
        onClose={() => onDone(`${n} people created.`)}
        footer={
          <>
            <Button variant="ghost" onClick={download} disabled={n === 0}>Download CSV</Button>
            <Button variant="ghost" onClick={copyAll} disabled={n === 0}>{copied ? 'Copied' : 'Copy all'}</Button>
            <Button variant="primary" onClick={() => onDone(`${n} people created.`)}>Done</Button>
          </>
        }
      >
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <div className="alert alert-warning mb-3">
          These passwords cannot be retrieved later. Each person will be asked to change
          theirs at first sign-in; if one is lost, reset it from their profile.
        </div>
        {n > 0 && (
          <Table head={['Name', 'Email', 'Department', 'Temporary password']}>
            {result.created.map((c) => (
              <tr key={c.email}>
                <Td>{c.displayName}</Td>
                <Td>{c.email}</Td>
                <Td>{c.department ?? <span className="text-muted">—</span>}</Td>
                <Td className="font-monospace">{c.temporaryPassword}</Td>
              </tr>
            ))}
          </Table>
        )}
        {result.skipped.length > 0 && (
          <>
            <p className="fs-14 text-muted mt-3 mb-2">Not created:</p>
            <Table head={['Email', 'Name', 'Reason']}>
              {result.skipped.map((s, i) => (
                <tr key={`${s.address}-${i}`}>
                  <Td>{s.address}</Td>
                  <Td>{s.displayName}</Td>
                  <Td>{s.reason}</Td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Modal>
    );
  }

  // ---- step: preview ------------------------------------------------------
  if (step === 'preview' && preview) {
    const willCreate = preview.created.length;
    const skippedTotal = preview.skipped.length + bad.length;
    return (
      <Modal
        title="Check before creating"
        subtitle={`${willCreate} will be created · ${skippedTotal} skipped. Nothing has been written yet.`}
        size="lg"
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep('input')} disabled={busy}>Back</Button>
            <Button variant="primary" onClick={runCreate} disabled={busy || willCreate === 0}>
              {busy ? 'Creating…' : `Create ${willCreate} ${willCreate === 1 ? 'person' : 'people'}`}
            </Button>
          </>
        }
      >
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <Table head={['Email', 'Name', 'Department', 'Result']}>
          {preview.created.map((c) => (
            <tr key={c.email}>
              <Td>{c.email}</Td>
              <Td>{c.displayName}</Td>
              <Td>{c.department ?? <span className="text-muted">—</span>}</Td>
              <Td><span className="badge bg-success">Will create{c.mailbox ? '' : ' (no mailbox)'}</span></Td>
            </tr>
          ))}
          {preview.skipped.map((s, i) => (
            <tr key={`s-${s.address}-${i}`}>
              <Td>{s.address}</Td>
              <Td>{s.displayName}</Td>
              <Td />
              <Td className="text-wrap"><span className="badge bg-warning text-dark">Skipped</span> <span className="fs-13">{s.reason}</span></Td>
            </tr>
          ))}
          {bad.map((r) => (
            <tr key={`b-${r.line}`}>
              <Td>{r.localPart ? `${r.localPart}@${domain?.fqdn ?? ''}` : <span className="text-muted">line {r.line}</span>}</Td>
              <Td>{r.name}</Td>
              <Td>{r.department ?? <span className="text-muted">—</span>}</Td>
              <Td className="text-wrap"><span className="badge bg-warning text-dark">Skipped</span> <span className="fs-13">{r.problem}</span></Td>
            </tr>
          ))}
        </Table>
      </Modal>
    );
  }

  // ---- step: input --------------------------------------------------------
  return (
    <Modal
      title="Add many people"
      subtitle="Each gets a sign-in and a mailbox, and inherits their department's settings."
      size="lg"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={runPreview} disabled={busy || !domain || good.length === 0}>
            {busy ? 'Checking…' : `Check ${good.length} ${good.length === 1 ? 'row' : 'rows'}`}
          </Button>
        </>
      }
    >
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <div className="row g-3 mb-3">
        <div className="col-sm-6">
          <Field label="Domain" required>
            <select className="form-select" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.fqdn}</option>)}
            </select>
          </Field>
        </div>
        <div className="col-sm-6">
          <Field label="Department for rows that don't name one">
            <select className="form-select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">None</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{'\u00a0'.repeat(d.depth * 3)}{d.name}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Field
        label="People"
        required
        hint={<>One per line: <strong>Name, email or username, Department</strong> (optional). Paste straight from Excel — tabs work. A header row is ignored. Department is matched by name, exactly as it appears under Departments.</>}
      >
        <textarea
          className="form-control font-monospace"
          rows={9}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Priya Sharma, priya, Class 5A\nRahul Verma, rahul.verma@${domain?.fqdn ?? 'example.org'}, Class 5B`}
          spellCheck={false}
        />
      </Field>
      <div className="d-flex flex-wrap align-items-center gap-3 mt-2">
        <label className="btn btn-light mb-0">
          Upload CSV
          <input type="file" accept=".csv,.txt,.tsv" hidden onChange={(e) => void onFile(e)} />
        </label>
        {rows.length > 0 && (
          <span className="fs-14 text-muted">
            {good.length} ready{bad.length > 0 ? ` · ${bad.length} with problems (shown on the next step)` : ''}
          </span>
        )}
      </div>
    </Modal>
  );
}
