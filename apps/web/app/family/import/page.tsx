'use client';

import { useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { FamilyShell, useFamilyChrome } from '@/components/family/FamilyShell';
import { Badge, Button, Card, Stat, Table, Td } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
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
// ============================================================================

const ACCEPT = '.csv,.vcf,.vcard,.txt,text/csv,text/vcard,text/x-vcard';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FamilyImportExportPage() {
  // The panels sit INSIDE FamilyShell so useFamilyChrome() reads the shell's
  // provider rather than the default context. Calling it as a sibling of
  // <FamilyShell> looks equivalent and silently gets an empty label list.
  return (
    <FamilyShell title="Import and export" breadcrumb="Import and export">
      <ImportPanel />
      <Box sx={{ height: 24 }} />
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
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        CSV or vCard, up to 10 MB and 5,000 contacts in one go. Nothing is written until
        you have seen what the file contains — checking it first is one click and changes
        nothing.
      </Typography>

      <Box
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const dropped = e.dataTransfer.files.item(0);
          if (dropped) chooseFile(dropped);
        }}
        sx={{
          border: '1px dashed', borderColor: 'divider', borderRadius: 2,
          p: 3, textAlign: 'center', mb: 2.5,
        }}
      >
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
        />

        {file ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{file.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {(file.size / 1024).toFixed(0)} KB
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
              <Button variant="ghost" onClick={() => picker.current?.click()}>Choose another</Button>
              <Button variant="ghost" onClick={() => chooseFile(null)}>Remove</Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}>
            <Typography variant="body2">Drop a file here, or choose one.</Typography>
            <Typography variant="caption" color="text.secondary">
              In Google Contacts: Export → Google CSV. In Outlook: File → Open &amp; Export →
              Import/Export → Export to a file → Comma Separated Values.
            </Typography>
            <Button variant="primary" onClick={() => picker.current?.click()}>Choose a file</Button>
          </Box>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2 }}>
        <TextField
          select size="small" label="Who can see them"
          value={ownership}
          onChange={(e) => { setOwnership(e.target.value as Ownership); setChecked(null); }}
          sx={{ minWidth: 220 }}
          helperText={ownership === 'personal'
            ? 'Only you.'
            : 'Everyone in your organisation. This cannot be undone per contact.'}
        >
          <MenuItem value="personal">Only me</MenuItem>
          <MenuItem value="organisational">Everyone in my organisation</MenuItem>
        </TextField>

        <TextField
          select size="small" label="If an address is already saved"
          value={mode}
          onChange={(e) => { setMode(e.target.value as 'skip' | 'update'); setChecked(null); }}
          sx={{ minWidth: 260 }}
          helperText={mode === 'skip'
            ? 'Leave the existing contact untouched.'
            : 'Fill in its blanks and add numbers it does not have. Nothing is overwritten.'}
        >
          <MenuItem value="skip">Skip that row</MenuItem>
          <MenuItem value="update">Fill in what is missing</MenuItem>
        </TextField>

        <TextField
          size="small" label="Tag every contact with"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          sx={{ minWidth: 260 }}
          helperText="Leave it set. It is how you undo this import in one go."
        />
      </Box>

      <FormControlLabel
        control={<Switch checked={createLabels} onChange={(e) => setCreateLabels(e.target.checked)} />}
        label={
          <Typography variant="body2">
            Also create the labels the file names, such as Google groups
          </Typography>
        }
        sx={{ mb: 1 }}
      />

      <Divider sx={{ my: 2 }} />

      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
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
          <Typography variant="caption" color="text.secondary">
            Check the file first — the import button turns on once you have seen the report.
          </Typography>
        )}
      </Box>

      {busy !== null && <LinearProgress sx={{ mt: 2 }} />}

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
    <Box sx={{ mt: 3 }}>
      <Divider sx={{ mb: 2.5 }} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <Typography variant="subtitle2">
          {live ? 'Imported' : 'This is what would happen'}
        </Typography>
        <Badge tone={live ? 'ok' : 'info'}>{live ? 'Done' : 'Nothing written yet'}</Badge>
        <Chip size="small" variant="outlined"
              label={report.format === 'vcard' ? 'vCard' : 'CSV'} />
      </Box>

      <Box sx={{
        display: 'grid', gap: 2, mb: 2.5,
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      }}>
        <Stat label="Rows in the file" value={String(report.rowsRead)} tone="info" />
        <Stat label={live ? 'Added' : 'Would be added'} value={String(report.created)} tone="success" />
        <Stat label={live ? 'Filled in' : 'Would be filled in'} value={String(report.updated)} tone="primary" />
        <Stat label="Skipped" value={String(report.skipped)}
              tone={report.skipped > 0 ? 'warning' : 'primary'} />
      </Box>

      {report.warnings.map((w) => (
        <Alert key={w} severity="warning" sx={{ mb: 1.5 }}>{w}</Alert>
      ))}

      {live && report.created + report.updated > 0 && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {label
            ? <>Everything from this file carries the label <strong>{label}</strong>. If it went
               wrong, open that label from the sidebar and delete what is in it.</>
            : <>These contacts were not tagged with a label, so there is no quick way to undo
               the import. Next time, leave the tag field filled in.</>}
        </Alert>
      )}

      {!live && report.sample.length > 0 && (
        <Box sx={{ mb: 2.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            The first few that would be added
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {report.sample.map((s) => <Chip key={s} label={s} size="small" variant="outlined" />)}
            {report.created > report.sample.length && (
              <Chip size="small"
                    label={`and ${report.created - report.sample.length} more`} />
            )}
          </Box>
        </Box>
      )}

      {report.problems.length > 0 && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {plural(report.skipped, 'row')} not imported
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Every one of these is listed with a reason. Nothing was dropped quietly.
          </Typography>

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
            <Typography variant="caption" color="text.secondary">
              Only the first 500 are listed. The counts above are complete.
            </Typography>
          )}
        </Box>
      )}
    </Box>
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
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {note && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNote(null)}>{note}</Alert>}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        No cap and no gate. An address book you cannot get out of is one you should not
        put anything important into.
      </Typography>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start' }}>
        <TextField
          select size="small" label="What to export"
          value={scope} onChange={(e) => setScope(e.target.value)}
          sx={{ minWidth: 260 }}
        >
          <MenuItem value="all">Everything I can see</MenuItem>
          <MenuItem value="personal">Only my own contacts</MenuItem>
          <MenuItem value="organisational">Only the shared directory</MenuItem>
          <MenuItem value="favourite">Only starred</MenuItem>
          {labels.map((l) => (
            <MenuItem key={l.id} value={`label:${l.id}`}>Label: {l.name}</MenuItem>
          ))}
        </TextField>

        <TextField
          select size="small" label="Format"
          value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'vcf')}
          sx={{ minWidth: 220 }}
          helperText={format === 'csv'
            ? 'Opens in Excel; imports into Google Contacts.'
            : 'One card per person; imports into iPhone and Android.'}
        >
          <MenuItem value="csv">CSV</MenuItem>
          <MenuItem value="vcf">vCard</MenuItem>
        </TextField>

        <Button variant="primary" disabled={busy} onClick={download}>
          {busy ? 'Preparing…' : 'Download'}
        </Button>
      </Box>

      {busy && <LinearProgress sx={{ mt: 2 }} />}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        Photos and birthdays are not in the file yet — neither is stored.
        Deleted contacts are never exported.
      </Typography>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
