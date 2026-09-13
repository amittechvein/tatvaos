'use client';

import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Button, Table, Td } from '@/components/ui/Kit';
import { Field, Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';

// ---------------------------------------------------------------------------
//  Add many people — download a template, fill it in, upload it, check, create
// ---------------------------------------------------------------------------
//
//  The paste box this replaces was fine for three people and wrong for forty:
//  a spreadsheet is where a list of forty people already lives, and retyping it
//  into a textarea is how the department column gets dropped.
//
//  Four steps, and the third is the point:
//
//    choose   download the template, fill it in a spreadsheet, attach it.
//    parsed   the browser reads it and shows what it understood, per row,
//             with its own problems flagged. Nothing has been sent yet.
//    preview  the server checks the rest with dryRun: true — addresses that
//             already exist, unknown departments, repeats, short passwords —
//             and reports what it WOULD do. Nothing is written. Create cannot
//             be reached without seeing this.
//    done     generated passwords, shown once. Download or copy them now;
//             they are hashed on the server and cannot be shown again.
//
//  THE PHONE COLUMN. Excel turns a long number typed into a General-formatted
//  cell into scientific notation and ROUNDS it — 9.1834E+11 is 918340000000,
//  and the digits that were there are gone from the file before it is ever
//  uploaded. Neither this screen nor the server can recover them, so a cell in
//  that shape is refused rather than imported: a plausible wrong recovery
//  number is worse than none, because it is wrong exactly when somebody is
//  locked out and needs it. The instruction beside the download button is the
//  only thing that actually prevents it.
// ---------------------------------------------------------------------------

interface DeptOpt { id: string; name: string; depth: number }
interface DomainOpt { id: string; fqdn: string }

interface Row {
  line: number;
  name: string;
  localPart: string;
  domain: string;
  department: string | null;
  password: string | null;
  recoveryEmail: string | null;
  recoveryPhone: string | null;
  mustChange: boolean | null;
  /** Found in the browser. The row is shown but never sent. */
  problem: string | null;
}

interface PreviewCreated {
  email: string; displayName: string; department: string | null; mailbox: boolean;
  passwordGenerated: boolean; mustChangePassword: boolean;
  recoveryEmail: string | null; recoveryPhone: string | null;
}
interface Skipped { address: string; displayName: string; reason: string }
interface Created {
  email: string; displayName: string; department: string | null;
  temporaryPassword: string | null; mustChangePassword: boolean;
}

// The columns, in the order the template writes them. `keys` are the header
// spellings accepted on upload, lower-cased and stripped of "[required]" and
// "[optional]" — Google's export writes those, and a column the admin did not
// type should not be a column we fail to recognise.
const COLUMNS = [
  { header: 'Full name [Required]', keys: ['full name', 'name', 'display name'] },
  { header: 'Email Address [Required]', keys: ['email address', 'email', 'e-mail', 'address'] },
  { header: 'Password [Optional]', keys: ['password'] },
  { header: 'Department Path [Required]', keys: ['department path', 'department', 'org unit path', 'org unit', 'class'] },
  { header: 'Recovery Email [Optional]', keys: ['recovery email'] },
  { header: 'Recovery Phone [Optional]', keys: ['recovery phone', 'phone'] },
  { header: 'Change Password at Next Sign-In [Optional]', keys: ['change password at next sign-in', 'change password', 'force password change'] },
];

const MIN_PASSWORD = 12;

/** Scientific notation — see the phone note at the top of this file. */
const ROUNDED = /^[0-9]+(\.[0-9]+)?[Ee][+-]?[0-9]+$/;

/**
 * A CSV line splitter that understands quotes, because a display name with a
 * comma in it ("Singh, Nandan") is not two columns. Tabs are accepted too, so
 * a straight paste-into-a-file from Excel still works.
 */
function splitCsvLine(line: string): string[] {
  if (line.includes('\t') && !line.includes('"')) return line.split('\t').map((c) => c.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normaliseHeader(cell: string): string {
  return cell.toLowerCase().replace(/\[(required|optional)\]/g, '').replace(/\s+/g, ' ').trim();
}

/** Which column is which. Returns null when the first line is not a header. */
function mapColumns(cells: string[]): Record<string, number> | null {
  const lower = cells.map(normaliseHeader);
  if (lower.some((c) => c.includes('@'))) return null;      // data, not a header
  const map: Record<string, number> = {};
  COLUMNS.forEach((col, ci) => {
    const at = lower.findIndex((c) => col.keys.includes(c));
    if (at >= 0) map[String(ci)] = at;
  });
  return Object.keys(map).length >= 2 ? map : null;
}

function truthy(v: string | null): boolean | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

export function parseCsv(text: string, domains: DomainOpt[]): Row[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const known = new Set(domains.map((d) => d.fqdn.toLowerCase()));
  // lines is non-empty here (guarded above), but the index type is
  // string | undefined under the strict tsconfig - and the Docker build on
  // the box failed on exactly this line (12 Sept 2026, WEB_EXIT=1).
  const first = splitCsvLine(lines[0] ?? '');
  const map = mapColumns(first);
  const body = map ? lines.slice(1) : lines;
  const at = (cells: string[], ci: number): string => {
    const idx = map ? map[String(ci)] : ci;
    return idx === undefined ? '' : (cells[idx] ?? '').trim();
  };

  return body.map((line, i) => {
    const cells = splitCsvLine(line);
    const name = at(cells, 0);
    const email = at(cells, 1).toLowerCase();
    const password = at(cells, 2) || null;
    const dept = at(cells, 3).replace(/^\//, '').trim() || null;
    const recoveryEmail = at(cells, 4) || null;
    const rawPhone = at(cells, 5) || null;
    const mustChange = truthy(at(cells, 6) || null);

    // indexOf + slice rather than destructuring split('@'): the tuple form
    // types both halves as string | undefined and failed the build on the
    // box (12 Sept 2026). This also keeps a second '@' inside the domain
    // half, where the verified-domains check below will refuse it.
    const atIdx = email.indexOf('@');
    const localPart = atIdx >= 0 ? email.slice(0, atIdx) : '';
    const domain = atIdx >= 0 ? email.slice(atIdx + 1) : '';
    const row: Row = {
      line: i + (map ? 2 : 1),
      name, localPart, domain, department: dept,
      password, recoveryEmail, recoveryPhone: rawPhone, mustChange,
      problem: null,
    };

    if (!name) row.problem = 'no name';
    else if (!email.includes('@')) row.problem = 'no email address';
    else if (!localPart || !domain) row.problem = `"${email}" is not an address`;
    else if (!known.has(domain)) row.problem = `${domain} is not one of your verified domains`;
    else if (!dept) row.problem = 'no department';
    else if (password && password.length < MIN_PASSWORD) {
      row.problem = `password is ${password.length} characters; the minimum is ${MIN_PASSWORD}`;
    } else if (rawPhone && ROUNDED.test(rawPhone.replace(/\s/g, ''))) {
      row.problem = `"${rawPhone}" — the spreadsheet rounded this number and the digits are lost. Format the column as Text and export again.`;
    }
    return row;
  });
}

function toCsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\r\n');
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ===========================================================================
export function AddManyPeople({
  departments, domains, onClose, onDone,
}: {
  departments: DeptOpt[];
  domains: DomainOpt[];
  onClose: () => void;
  onDone: (message: string) => Promise<void> | void;
}) {
  const { authedFetch } = useAuth();
  const [step, setStep] = useState<'choose' | 'parsed' | 'preview' | 'done'>('choose');
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [preview, setPreview] = useState<{ created: PreviewCreated[]; skipped: Skipped[] } | null>(null);
  const [result, setResult] = useState<{ created: Created[]; skipped: Skipped[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const good = useMemo(() => rows.filter((r) => !r.problem), [rows]);
  const bad = useMemo(() => rows.filter((r) => r.problem), [rows]);

  function templateCsv() {
    const example = [
      'Priya Sharma', `priya.sharma@${domains[0]?.fqdn ?? 'example.com'}`, '',
      departments[0]?.name ?? 'Sales', 'priya@gmail.com', '+919876543210', 'TRUE',
    ];
    download('tatvaos-people-template.csv', toCsv([COLUMNS.map((c) => c.header), example]));
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    setFileName(f.name);
    const parsed = parseCsv(await f.text(), domains);
    setRows(parsed);
    setStep('parsed');
  }

  async function call(dryRun: boolean) {
    const res = await authedFetch('/org/users/bulk', {
      method: 'POST',
      body: JSON.stringify({
        domainId: null,
        departmentId: null,
        dryRun,
        users: good.map((r) => ({
          localPart: r.localPart,
          displayName: r.name,
          department: r.department,
          domain: r.domain,
          password: r.password,
          recoveryEmail: r.recoveryEmail,
          recoveryPhone: r.recoveryPhone,
          mustChangePassword: r.mustChange,
        })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The import could not be processed.');
    return { created: data.created ?? [], skipped: data.skipped ?? [] };
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  const check = () => run(async () => { setPreview(await call(true)); setStep('preview'); });
  const create = () => run(async () => { setResult(await call(false)); setStep('done'); });

  const passwordsCsv = () => {
    const made = result?.created ?? [];
    download('tatvaos-new-people.csv', toCsv([
      ['Email', 'Name', 'Department', 'Temporary password', 'Must change at first sign-in'],
      ...made.map((c) => [
        c.email, c.displayName, c.department ?? '',
        c.temporaryPassword ?? '(the one you supplied)',
        c.mustChangePassword ? 'yes' : 'no',
      ]),
    ]));
  };

  return (
    <Modal
      title="Add many people"
      subtitle="Each gets a sign-in and a mailbox, and inherits their department's settings."
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{step === 'done' ? 'Close' : 'Cancel'}</Button>
          {step === 'parsed' && (
            <Button variant="primary" onClick={check} disabled={busy || good.length === 0}>
              {good.length === 0 ? 'Nothing to check' : `Check ${good.length} row${good.length === 1 ? '' : 's'}`}
            </Button>
          )}
          {step === 'preview' && (
            <Button variant="primary" onClick={create} disabled={busy || (preview?.created.length ?? 0) === 0}>
              Create {preview?.created.length ?? 0}
            </Button>
          )}
          {step === 'done' && (
            <Button variant="primary" onClick={() => onDone(`Added ${result?.created.length ?? 0} people.`)}>
              Done
            </Button>
          )}
        </>
      }
    >
      {error && <div className="alert alert-danger mb-3">{error}</div>}

      {step === 'choose' && (
        <div className="d-grid gap-3">
          <Field label="1. Download the template" hint="Seven columns. Password may be left blank — we generate a strong one and show it once.">
            <Button onClick={templateCsv}>Download CSV template</Button>
          </Field>

          <div className="alert alert-warning">
            <strong>Before you type phone numbers:</strong> select the Recovery Phone column
            in your spreadsheet and format it as <strong>Text</strong>. Otherwise Excel turns a
            number like <code>+91 98765 43210</code> into <code>9.18765E+11</code> and rounds
            away the last digits — they are gone from the file, and a rounded number is
            wrong exactly when somebody is locked out and needs it. Rows in that shape are
            refused rather than imported.
          </div>

          <Field label="2. Upload the filled-in file" hint="A header row is recognised and skipped. Department is matched by name, exactly as it appears under Departments.">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="form-control" onChange={onFile} />
          </Field>
        </div>
      )}

      {step === 'parsed' && (
        <>
          <p className="text-sm text-ink-muted">
            {fileName} — {good.length} row{good.length === 1 ? '' : 's'} ready
            {bad.length > 0 && <>, <span className="text-danger">{bad.length} with a problem</span></>}.
            Nothing has been sent yet.
          </p>
          {bad.length > 0 && (
            <Table head={['Line', 'Name', 'Address', 'Problem']}>
              {bad.map((r) => (
                <tr key={r.line}>
                  <Td>{r.line}</Td>
                  <Td>{r.name || <span className="text-ink-muted">—</span>}</Td>
                  <Td>{r.localPart ? `${r.localPart}@${r.domain}` : <span className="text-ink-muted">—</span>}</Td>
                  <Td><span className="text-danger text-wrap">{r.problem}</span></Td>
                </tr>
              ))}
            </Table>
          )}
          {good.length > 0 && (
            <Table head={['Name', 'Address', 'Department', 'Password', 'Recovery']}>
              {good.map((r) => (
                <tr key={r.line}>
                  <Td>{r.name}</Td>
                  <Td>{r.localPart}@{r.domain}</Td>
                  <Td>{r.department}</Td>
                  <Td>{r.password ? 'supplied' : <span className="text-ink-muted">generated</span>}</Td>
                  <Td className="text-wrap">
                    {[r.recoveryEmail, r.recoveryPhone].filter(Boolean).join(' · ') || <span className="text-ink-muted">—</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}

      {step === 'preview' && preview && (
        <>
          <p className="text-sm text-ink-muted">
            The server checked these and wrote nothing. {preview.created.length} would be created
            {preview.skipped.length > 0 && <>, {preview.skipped.length} skipped</>}.
          </p>
          {preview.skipped.length > 0 && (
            <Table head={['Address', 'Name', 'Skipped because']}>
              {preview.skipped.map((s) => (
                <tr key={s.address}>
                  <Td>{s.address}</Td><Td>{s.displayName}</Td>
                  <Td><span className="text-danger text-wrap">{s.reason}</span></Td>
                </tr>
              ))}
            </Table>
          )}
          {preview.created.length > 0 && (
            <Table head={['Address', 'Name', 'Department', 'Password', 'Must change']}>
              {preview.created.map((c) => (
                <tr key={c.email}>
                  <Td>{c.email}</Td><Td>{c.displayName}</Td><Td>{c.department ?? '—'}</Td>
                  <Td>{c.passwordGenerated ? 'generated' : 'supplied'}</Td>
                  <Td>{c.mustChangePassword ? 'yes' : <span className="text-ink-muted">no</span>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}

      {step === 'done' && result && (
        <>
          <div className="alert alert-warning">
            <strong>These passwords are shown once.</strong> They are hashed on the server and
            cannot be shown again. Download or copy them now.
          </div>
          <div className="d-flex gap-2 mb-3">
            <Button onClick={passwordsCsv}>Download CSV</Button>
            <Button onClick={() => navigator.clipboard?.writeText(
              (result.created).map((c) => `${c.email}\t${c.temporaryPassword ?? ''}`).join('\n'),
            )}>Copy all</Button>
          </div>
          <Table head={['Address', 'Name', 'Temporary password', 'Must change']}>
            {result.created.map((c) => (
              <tr key={c.email}>
                <Td>{c.email}</Td><Td>{c.displayName}</Td>
                <Td><code>{c.temporaryPassword ?? 'the one you supplied'}</code></Td>
                <Td>{c.mustChangePassword ? 'yes' : <span className="text-ink-muted">no</span>}</Td>
              </tr>
            ))}
          </Table>
          {result.skipped.length > 0 && (
            <Table head={['Address', 'Skipped because']}>
              {result.skipped.map((s) => (
                <tr key={s.address}>
                  <Td>{s.address}</Td>
                  <Td><span className="text-danger text-wrap">{s.reason}</span></Td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Modal>
  );
}
