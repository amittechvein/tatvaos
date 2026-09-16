'use client';

import { useCallback, useEffect, useState } from 'react';

import { FamilyShell, useFamilyChrome } from '@/components/family/FamilyShell';
import { Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { familyApi, type LabelSummary } from '@/lib/family';
import { Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

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
//
//  Converted off MUI onto the Kit Modal, so these dialogs behave like every
//  other dialog in the console rather than like MUI's.
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
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {note && <Alert tone="ok" onDismiss={() => setNote(null)}>{note}</Alert>}

      <p className="text-[0.875rem] text-ink-muted mb-4">
        Labels group contacts without moving them. A contact can carry any number, and
        deleting a label never deletes the people in it.
      </p>

      <Card
        padded={false}
        actions={<Button variant="primary" onClick={() => setEditing('new')}>New label</Button>}
      >
        {loading ? (
          <Spinner />
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
                  <span
                    aria-hidden
                    className="inline-block rounded-full"
                    style={{ width: 12, height: 12, background: l.colour ?? '#98a2b8' }}
                  />
                </Td>
                <Td>
                  <span className="text-[0.875rem] font-semibold">{l.name}</span>
                </Td>
                <Td>
                  <span className="text-[0.875rem] text-ink-muted">{l.description ?? '—'}</span>
                </Td>
                <Td>
                  {l.count === 0 ? (
                    <span className="text-[0.875rem] text-ink-muted">Empty</span>
                  ) : (
                    <Button variant="ghost" href={`/family/contacts?groupId=${l.id}`}>
                      {l.count === 1 ? '1 contact' : `${l.count} contacts`}
                    </Button>
                  )}
                </Td>
                <Td>
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" onClick={() => setEditing(l)}>Rename</Button>
                    <Button variant="ghost" onClick={() => setDeleting(l)}>Delete</Button>
                  </div>
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

      {deleting !== null && (
        <Modal
          title="Delete this label?"
          size="sm"
          busy={busy}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" disabled={busy}
                      onClick={() => { void remove(deleting); }}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <p className="text-[0.875rem] mb-0">
            {deleting.count > 0
              ? `“${deleting.name}” comes off ${deleting.count === 1
                  ? 'one contact' : `${deleting.count} contacts`}. The contacts themselves stay exactly where they are.`
              : 'This label is empty, so nothing else changes.'}
          </p>
          <p className="text-[0.875rem] text-ink-muted mt-4 mb-0">
            There is no undo for the label itself — you would have to create it again and
            re-add the contacts.
          </p>
        </Modal>
      )}
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
    <Modal
      title={label ? 'Rename label' : 'New label'}
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || name.trim().length === 0}>
            {busy ? 'Saving…' : label ? 'Save' : 'Create label'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <Field
        label="Name"
        required
        hint={label
          ? 'Renaming keeps every contact already in this label.'
          : 'Names are unique. Suppliers, Dealers, Fair 2026 — whatever you will look for later.'}
      >
        <Input
          
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim().length > 0) { e.preventDefault(); void save(); }
          }}
        />
      </Field>

      <Field label="Description" hint="Optional. Only shown on this screen.">
        <Input
          
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <div>
        <div className="text-[0.75rem] text-ink-muted mb-2">Colour — this is the dot in the sidebar</div>
        {/* Real buttons rather than divs with role="button": type="button" keeps
            them out of the form's submit path, and Space/Enter activation comes
            from the browser instead of a hand-written key handler. */}
        <div className="flex gap-2 flex-wrap">
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Use ${c}`}
              aria-pressed={colour === c}
              onClick={() => setColour(c)}
              className="rounded-full border-0 p-0"
              style={{
                width: 28,
                height: 28,
                background: c,
                cursor: 'pointer',
                outline: colour === c ? '2px solid #0a0a0a' : '1px solid #dee2e6',
                outlineOffset: 2,
              }}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}
