'use client';

import { useRef, useState } from 'react';

import { FamilyShell, useFamilyChrome } from '@/components/family/FamilyShell';
import { Badge, Button, Card, Stat, Table, Td } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import { Input, Select } from '@/components/ui/Form';
import {
  familyApi, saveBlob,
  type ImportReport, type Ownership,
} from '@/lib/family';

// ============================================================================
//  Import and export.
//
//  ─────────────────────────────────────────────────────────────────────────
//   THE DRY RUN IS THE FEATURE.
//
//   Importing contacts is a one-way door in practice: nobody notices the
//   forty duplicates on the day, they notice them in three months, by which
//   time the original file is gone and the duplicates have been edited. So
//   this screen will not import anything you have not been shown a report for
//   first. Checking costs one round trip and writes nothing.
//
//   The second safety net is the label. Every import is tagged, by default
//   with the file's name and today's date, because that is the only thing
//   that turns "undo the import" from an afternoon into two clicks.
//  ─────────────────────────────────────────────────────────────────────────
//
//  Converted off MUI. LinearProgress became Bootstrap's indeterminate striped
//  bar, and the select/switch controls became native ones — see the note on
//  Bar below for the one behaviour worth knowing about.
// ============================================================================

const ACCEPT = '.csv,.vcf,.vcard,.txt,text/csv,text/vcard,text/x-vcard';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * An indeterminate progress bar.
 *
 * Deliberately not a percentage: the server streams the whole file and reports
 * once at the end, so any number here would be invented. A moving bar says
 * "working" honestly; a fake percentage that jumps 0 → 100 does not.
 */
function Bar() {
  return (
    <div className="progress mt-3" style={{ height: 4 }} role="status" aria-label="Working">
      <div className="progress-bar progress-bar-striped progress-bar-animated w-100" />
    </div>
  );
}

/** A small outlined pill — MUI's Chip variant="outlined". */
function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="badge rounded-pill border text-body-secondary bg-transparent fw-normal">
      {children}
    </span>
  );
}

export default function FamilyImportExportPage() {
  // The panels sit INSIDE FamilyShell so useFamilyChrome() reads the shell's
  // provider rather than the default context. Calling it as a sibling of
  // <FamilyShell> looks equivalent and silently gets an empty label list.
  return (
    <FamilyShell title="Import and export" breadcrumb="Import and export">
      <ImportPanel />
      <div style={{ height: 24 }} />
      <ExportPanel />
    </FamilyShell>
  );
}

// ---------------------------------------------------------------------------
//  Import
// ---------------------------------------------------------------------------

function ImportPanel() {
  const { authedFetch } = useAuth();
  const chrome = useFamilyChrome();
  const picker = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [ownership, setOwnership] = useState<Ownership>('personal');
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [createLabels, setCreateLabels] = useState(true);
  const [label, setLabel] = useState(`Imported ${today()}`);

  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A report is only valid for the file it was produced from. Swapping the
  // file has to invalidate it, or the Import button imports something the
  // person was never shown.
  const [checked, setChecked] = useState<{ file: File; report: ImportReport } | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);

  const chooseFile = (next: File | null) => {
    setFile(next);
    setChecked(null);
    setDone(null);
    setError(null);
  };

  const settings = {
    ownership,
    mode,
    createLabels,
    label: label.trim() || undefined,
  };

  const check = async () => {
    if (!file) return;
    setBusy('check'); setError(null); setDone(null);
    try {
      const report = await familyApi.importFile(authedFetch, file, { ...settings, dryRun: true });
      setChecked({ file, report });
    } catch (e) {
      setChecked(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!file) return;
    setBusy('import'); setError(null);
    try {
      const report = await familyApi.importFile(authedFetch, file, settings);
      setDone(report);
      setChecked(null);
      chrome.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const report = done ?? checked?.report ?? null;

  // The report the Import button would act on — null unless a dry run exists
  // for exactly the file currently chosen. Held as the report itself rather
  // than a boolean so the compiler can narrow it inside the button label; a
  // separate `ready` flag reads the same and does not narrow anything.
  const pending = checked !== null && checked.file === file ? checked.report : null;

  return (
    <Card
      title="Import contacts"
      subtitle="From Google Contacts, Outlook, Apple, or a phone backup"
      actions={<Button variant="ghost" href="/family/contacts">Back to contacts</Button>}
    >
      {error && (
        <div className="alert alert-danger d-flex align-items-start mb-3">
          <div className="flex-fill">{error}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setError(null)} />
        </div>
      )}

      <p className="fs-14 text-muted mb-3">
        CSV or vCard, up to 10 MB and 5,000 contacts in one go. Nothing is written until
        you have seen what the file contains — checking it first is one click and changes
        nothing.
      </p>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const dropped = e.dataTransfer.files.item(0);
          if (dropped) chooseFile(dropped);
        }}
        className="rounded text-center mb-3"
        style={{ border: '1px dashed #dee2e6', padding: 24 }}
      >
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
        />

        {file ? (
          <div className="d-flex flex-column gap-2 align-items-center">
            <span className="fs-14 fw-semibold">{file.name}</span>
            <span className="fs-12 text-muted">{(file.size / 1024).toFixed(0)} KB</span>
            <div className="d-flex gap-2 mt-1">
              <Button variant="ghost" onClick={() => picker.current?.click()}>Choose another</Button>
              <Button variant="ghost" onClick={() => chooseFile(null)}>Remove</Button>
            </div>
          </div>
        ) : (
          <div className="d-flex flex-column gap-2 align-items-center">
            <span className="fs-14">Drop a file here, or choose one.</span>
            <span className="fs-12 text-muted">
              In Google Contacts: Export → Google CSV. In Outlook: File → Open &amp; Export →
              Import/Export → Export to a file → Comma Separated Values.
            </span>
            <Button variant="primary" onClick={() => picker.current?.click()}>Choose a file</Button>
          </div>
        )}
      </div>

      <div className="d-flex flex-wrap gap-3 mb-3">
        <div style={{ minWidth: 220 }}>
          <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-ownership">
            Who can see them
          </label>
          <Select
            id="tv-ownership"
            value={ownership}
            onChange={(e) => { setOwnership(e.target.value as Ownership); setChecked(null); }}
          >
            <option value="personal">Only me</option>
            <option value="organisational">Everyone in my organisation</option>
          </Select>
          <div className="form-text fs-12">
            {ownership === 'personal'
              ? 'Only you.'
              : 'Everyone in your organisation. This cannot be undone per contact.'}
          </div>
        </div>

        <div style={{ minWidth: 260 }}>
          <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-dupe-mode">
            If an address is already saved
          </label>
          <Select
            id="tv-dupe-mode"
            value={mode}
            onChange={(e) => { setMode(e.target.value as 'skip' | 'update'); setChecked(null); }}
          >
            <option value="skip">Skip that row</option>
            <option value="update">Fill in what is missing</option>
          </Select>
          <div className="form-text fs-12">
            {mode === 'skip'
              ? 'Leave the existing contact untouched.'
              : 'Fill in its blanks and add numbers it does not have. Nothing is overwritten.'}
          </div>
        </div>

        <div style={{ minWidth: 260 }}>
          <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-import-label">
            Tag every contact with
          </label>
          <Input
            id="tv-import-label"
            
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="form-text fs-12">
            Leave it set. It is how you undo this import in one go.
          </div>
        </div>
      </div>

      <div className="form-check form-switch mb-2">
        <input
          className="form-check-input"
          type="checkbox"
          role="switch"
          id="tv-create-labels"
          checked={createLabels}
          onChange={(e) => setCreateLabels(e.target.checked)}
        />
        <label className="form-check-label fs-14" htmlFor="tv-create-labels">
          Also create the labels the file names, such as Google groups
        </label>
      </div>

      <hr className="my-3" />

      <div className="d-flex gap-2 align-items-center flex-wrap">
        <Button variant="secondary" disabled={!file || busy !== null} onClick={check}>
          {busy === 'check' ? 'Checking…' : 'Check the file'}
        </Button>
        <Button variant="primary" disabled={pending === null || busy !== null} onClick={run}>
          {busy === 'import'
            ? 'Importing…'
            : pending
              ? `Import ${plural(pending.created + pending.updated, 'contact')}`
              : 'Import'}
        </Button>
        {pending === null && file && !done && (
          <span className="fs-12 text-muted">
            Check the file first — the import button turns on once you have seen the report.
          </span>
        )}
      </div>

      {busy !== null && <Bar />}

      {report && <Report report={report} live={done !== null} label={label.trim()} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  The report — the same panel for a dry run and for the real thing
// ---------------------------------------------------------------------------

function Report({ report, live, label }: {
  report: ImportReport;
  live: boolean;
  label: string;
}) {
  return (
    <div className="mt-4">
      <hr className="mb-3" />

      <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <span className="fs-14 fw-semibold">
          {live ? 'Imported' : 'This is what would happen'}
        </span>
        <Badge tone={live ? 'ok' : 'info'}>{live ? 'Done' : 'Nothing written yet'}</Badge>
        <Pill>{report.format === 'vcard' ? 'vCard' : 'CSV'}</Pill>
      </div>

      {/* row/col rather than an auto-fit grid: YZEN's .grid collides with
          Tailwind's, and an arbitrary minmax() template would flatten. */}
      <div className="row g-3 mb-3">
        <div className="col-6 col-md-3">
          <Stat label="Rows in the file" value={String(report.rowsRead)} tone="info" />
        </div>
        <div className="col-6 col-md-3">
          <Stat label={live ? 'Added' : 'Would be added'} value={String(report.created)} tone="success" />
        </div>
        <div className="col-6 col-md-3">
          <Stat label={live ? 'Filled in' : 'Would be filled in'} value={String(report.updated)} tone="primary" />
        </div>
        <div className="col-6 col-md-3">
          <Stat label="Skipped" value={String(report.skipped)}
                tone={report.skipped > 0 ? 'warning' : 'primary'} />
        </div>
      </div>

      {report.warnings.map((w) => (
        <div key={w} className="alert alert-warning py-2 mb-2">{w}</div>
      ))}

      {live && report.created + report.updated > 0 && (
        <div className="alert alert-success mb-3">
          {label
            ? <>Everything from this file carries the label <strong>{label}</strong>. If it went
               wrong, open that label from the sidebar and delete what is in it.</>
            : <>These contacts were not tagged with a label, so there is no quick way to undo
               the import. Next time, leave the tag field filled in.</>}
        </div>
      )}

      {!live && report.sample.length > 0 && (
        <div className="mb-3">
          <div className="fs-14 fw-semibold mb-2">The first few that would be added</div>
          <div className="d-flex flex-wrap gap-1">
            {report.sample.map((s) => <Pill key={s}>{s}</Pill>)}
            {report.created > report.sample.length && (
              <span className="badge rounded-pill bg-light text-muted fw-normal">
                and {report.created - report.sample.length} more
              </span>
            )}
          </div>
        </div>
      )}

      {report.problems.length > 0 && (
        <div>
          <div className="fs-14 fw-semibold mb-2">
            {plural(report.skipped, 'row')} not imported
          </div>
          <p className="fs-14 text-muted mb-3">
            Every one of these is listed with a reason. Nothing was dropped quietly.
          </p>

          <Table head={['Row', 'Name', 'Address', 'Why']}>
            {report.problems.map((p) => (
              <tr key={`${p.row}-${p.email ?? p.name}`}>
                <Td>{p.row}</Td>
                <Td>{p.name}</Td>
                <Td>{p.email ?? '—'}</Td>
                <Td>{p.reason}</Td>
              </tr>
            ))}
          </Table>

          {report.problemsTruncated && (
            <span className="fs-12 text-muted">
              Only the first 500 are listed. The counts above are complete.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Export
// ---------------------------------------------------------------------------

function ExportPanel() {
  const { authedFetch } = useAuth();
  const { labels } = useFamilyChrome();

  const [scope, setScope] = useState('all');
  const [format, setFormat] = useState<'csv' | 'vcf'>('csv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const download = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const { blob, name } = await familyApi.exportFile(authedFetch, {
        format,
        ownership: scope === 'personal' ? 'personal'
                 : scope === 'organisational' ? 'organisational'
                 : undefined,
        groupId: scope.startsWith('label:') ? scope.slice(6) : undefined,
        favourite: scope === 'favourite',
      });
      saveBlob(blob, name);
      setNote(`${name} downloaded.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Export contacts"
      subtitle="Everything you can see, in a file Google and Apple will read"
    >
      {error && (
        <div className="alert alert-danger d-flex align-items-start mb-3">
          <div className="flex-fill">{error}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setError(null)} />
        </div>
      )}
      {note && (
        <div className="alert alert-success d-flex align-items-start mb-3">
          <div className="flex-fill">{note}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setNote(null)} />
        </div>
      )}

      <p className="fs-14 text-muted mb-3">
        No cap and no gate. An address book you cannot get out of is one you should not
        put anything important into.
      </p>

      <div className="d-flex flex-wrap gap-3 align-items-start">
        <div style={{ minWidth: 260 }}>
          <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-export-scope">
            What to export
          </label>
          <Select id="tv-export-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">Everything I can see</option>
            <option value="personal">Only my own contacts</option>
            <option value="organisational">Only the shared directory</option>
            <option value="favourite">Only starred</option>
            {labels.map((l) => (
              <option key={l.id} value={`label:${l.id}`}>Label: {l.name}</option>
            ))}
          </Select>
        </div>

        <div style={{ minWidth: 220 }}>
          <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-export-format">
            Format
          </label>
          <Select id="tv-export-format" value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'vcf')}>
            <option value="csv">CSV</option>
            <option value="vcf">vCard</option>
          </Select>
          <div className="form-text fs-12">
            {format === 'csv'
              ? 'Opens in Excel; imports into Google Contacts.'
              : 'One card per person; imports into iPhone and Android.'}
          </div>
        </div>

        <div style={{ paddingTop: 26 }}>
          <Button variant="primary" disabled={busy} onClick={download}>
            {busy ? 'Preparing…' : 'Download'}
          </Button>
        </div>
      </div>

      {busy && <Bar />}

      <p className="fs-12 text-muted mt-3 mb-0">
        Photos and birthdays are not in the file yet — neither is stored.
        Deleted contacts are never exported.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
