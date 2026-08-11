'use client';

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { FamilyShell, useFamilyChrome } from '@/components/family/FamilyShell';
import { Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import { familyApi, type LabelSummary } from '@/lib/family';

// ============================================================================
//  Manage labels.
//
//  ─────────────────────────────────────────────────────────────────────────
//   THIS SCREEN DID NOT EXIST, AND NOTHING SAID SO.
//
//   The sidebar has linked to /family/labels since Family shipped. There was
//   no page behind it, so Next fell through to the [view] route, which does
//   not recognise "labels" and quietly rendered the Contacts list instead.
//   Clicking Manage labels appeared to do nothing at all.
//
//   The fix is this file. The other half of the fix is in [view]/page.tsx,
//   which now returns a 404 for a view it does not know rather than showing
//   the wrong screen — a broken link should be loud.
//  ─────────────────────────────────────────────────────────────────────────
//
//  A label is a `family.contact_groups` row. Renaming one is a real update
//  rather than a delete and recreate, because every membership points at the
//  id and recreating it would silently empty the label.
// ============================================================================

/**
 * Eight colours rather than a colour picker.
 *
 * A free picker gives you two labels three shades apart, which is worse than
 * no colour at all — the whole job of the dot is to be told apart at a glance
 * in a narrow rail. These are the product's own accents and they are distinct
 * from each other at 10 pixels.
 */
const COLOURS = [
  '#7367f0', '#00b8d9', '#28c76f', '#ff9f43',
  '#ff4c51', '#a855f7', '#0ea5e9', '#98a2b8',
];

export default function FamilyLabelsPage() {
  return (
    <FamilyShell title="Labels" breadcrumb="Labels">
      <Labels />
    </FamilyShell>
  );
}

function Labels() {
  const { authedFetch } = useAuth();
  const chrome = useFamilyChrome();

  const [rows, setRows] = useState<LabelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // null      nothing open
  // 'new'     the create dialog
  // a label   the edit dialog for that one
  const [editing, setEditing] = useState<LabelSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LabelSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setRows(await familyApi.groups(authedFetch));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const after = (message: string) => {
    setNote(message);
    chrome.refresh();     // the rail lists labels; it has to agree with this page
    void load();
  };

  const remove = async (label: LabelSummary) => {
    setBusy(true); setError(null);
    try {
      await familyApi.deleteGroup(authedFetch, label.id);
      setDeleting(null);
      after(`${label.name} deleted.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Alert severity="error" className="mb-4" onClose={() => setError(null)}>{error}</Alert>}
      {note && <Alert severity="success" className="mb-4" onClose={() => setNote(null)}>{note}</Alert>}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Labels group contacts without moving them. A contact can carry any number, and
        deleting a label never deletes the people in it.
      </Typography>

      <Card
        padded={false}
        actions={<Button variant="primary" onClick={() => setEditing('new')}>New label</Button>}
      >
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={30} /></Box>
        ) : rows.length === 0 ? (
          <Empty
            title="No labels yet"
            hint="Labels are how you find a group of people again — Suppliers, Dealers, the ones you met at a fair. Create one, then add contacts to it from their card."
            action={<Button variant="primary" onClick={() => setEditing('new')}>Create the first one</Button>}
          />
        ) : (
          <Table head={['', 'Label', 'Description', 'Contacts', '']}>
            {rows.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Box
                    aria-hidden
                    sx={{
                      width: 12, height: 12, borderRadius: '50%',
                      bgcolor: l.colour ?? '#98a2b8',
                    }}
                  />
                </Td>
                <Td>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{l.name}</Typography>
                </Td>
                <Td>
                  <Typography variant="body2" color="text.secondary">
                    {l.description ?? '—'}
                  </Typography>
                </Td>
                <Td>
                  {l.count === 0 ? (
                    <Typography variant="body2" color="text.secondary">Empty</Typography>
                  ) : (
                    <Button variant="ghost" href={`/family/contacts?groupId=${l.id}`}>
                      {l.count === 1 ? '1 contact' : `${l.count} contacts`}
                    </Button>
                  )}
                </Td>
                <Td>
                  <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                    <Button variant="ghost" onClick={() => setEditing(l)}>Rename</Button>
                    <Button variant="ghost" onClick={() => setDeleting(l)}>Delete</Button>
                  </Box>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing !== null && (
        <LabelDialog
          label={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); after(message); }}
        />
      )}

      <Dialog open={deleting !== null} onClose={busy ? undefined : () => setDeleting(null)}
              maxWidth="xs" fullWidth>
        <DialogTitle>Delete this label?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {deleting && deleting.count > 0
              ? `“${deleting.name}” comes off ${deleting.count === 1
                  ? 'one contact' : `${deleting.count} contacts`}. The contacts themselves stay exactly where they are.`
              : 'This label is empty, so nothing else changes.'}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1.5 }} color="text.secondary">
            There is no undo for the label itself — you would have to create it again and
            re-add the contacts.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy}
                  onClick={() => { if (deleting) void remove(deleting); }}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Create and rename are the same form
// ---------------------------------------------------------------------------

function LabelDialog({ label, onClose, onSaved }: {
  /** null to create a new one. */
  label: LabelSummary | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { authedFetch } = useAuth();

  const [name, setName] = useState(label?.name ?? '');
  const [description, setDescription] = useState(label?.description ?? '');
  const [colour, setColour] = useState(label?.colour ?? COLOURS[0] ?? '#7367f0');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) { setError('A name is required.'); return; }

    setBusy(true); setError(null);
    try {
      if (label) {
        await familyApi.updateGroup(authedFetch, label.id, {
          name: trimmed,
          description: description.trim(),
          colour,
        });
        onSaved(`${trimmed} saved.`);
      } else {
        await familyApi.createGroup(authedFetch, trimmed, description.trim() || undefined, colour);
        onSaved(`${trimmed} created.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{label ? 'Rename label' : 'New label'}</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField
            label="Name" required autoFocus fullWidth size="small"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim().length > 0) { e.preventDefault(); void save(); }
            }}
            helperText={label
              ? 'Renaming keeps every contact already in this label.'
              : 'Names are unique. Suppliers, Dealers, Fair 2026 — whatever you will look for later.'}
          />

          <TextField
            label="Description" fullWidth size="small"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            helperText="Optional. Only shown on this screen."
          />

          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Colour — this is the dot in the sidebar
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {COLOURS.map((c) => (
                <Box
                  key={c}
                  role="button"
                  tabIndex={0}
                  aria-label={`Use ${c}`}
                  aria-pressed={colour === c}
                  onClick={() => setColour(c)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setColour(c); }}
                  sx={{
                    width: 28, height: 28, borderRadius: '50%', bgcolor: c, cursor: 'pointer',
                    outline: colour === c ? '2px solid' : '1px solid',
                    outlineColor: colour === c ? 'text.primary' : 'divider',
                    outlineOffset: 2,
                  }}
                />
              ))}
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || name.trim().length === 0}>
          {busy ? 'Saving…' : label ? 'Save' : 'Create label'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
