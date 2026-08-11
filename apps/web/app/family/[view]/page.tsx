'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { FamilyShell, useFamilyChrome } from '@/components/family/FamilyShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
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
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

  const view: View = isView(params.view) ? params.view : 'contacts';
  const spec = VIEWS[view];
  const isBin = view === 'bin';

  const [rows, setRows] = useState<ContactSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>('all');
  const [groupId, setGroupId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // "Create contact" in the rail is a real link to ?create=1 rather than a
  // button, so middle-click and deep-link both behave. Consume the flag and
  // strip it, or a refresh reopens the dialog forever.
  useEffect(() => {
    if (search.get('create') === '1') {
      setCreating(true);
      router.replace(`/family/${view}`);
    }
  }, [search, router, view]);

  // A label chosen from the rail arrives as ?groupId=…
  const railGroup = search.get('groupId');
  useEffect(() => { if (railGroup) setGroupId(railGroup); }, [railGroup]);

  // Debounce, so typing "priya" is one request rather than five.
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(query.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // A token per load. Without it a slow first request can land AFTER a fast
  // second one and overwrite fresher results with staler ones — the classic
  // search race, and it looks like the filter is ignoring you.
  const loadToken = useRef(0);

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
          ...spec.query,
          // The chips refine the view; they never widen it. Directory stays
          // organisational even with "Mine" selected — the alternative is a
          // filter that silently contradicts the page you are on.
          ...(filter === 'personal' || filter === 'organisational'
            ? { ownership: spec.query?.ownership ?? filter } : {}),
          ...(filter === 'favourite' ? { favourite: true } : {}),
          ...(filter === 'auto' ? { source: 'auto' as const } : {}),
          groupId: groupId || undefined,
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
  }, [authedFetch, debounced, filter, groupId, page, spec]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    familyApi.groups(authedFetch)
      .then((g) => { if (live) setGroups(g); })
      .catch(() => { /* groups are a filter, not the page — a failure here is not fatal */ });
    return () => { live = false; };
  }, [authedFetch]);

  // No client-side sieve: every filter is a server query, so a page of results
  // is a page of results. Filtering here would silently drop rows and make the
  // count disagree with what is on screen.
  const visible = rows;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <FamilyShell title={spec.title} breadcrumb={spec.title}>
      {error && <Alert severity="error" className="mb-4" onClose={() => setError(null)}>{error}</Alert>}
      {note && <Alert severity="success" className="mb-4" onClose={() => setNote(null)}>{note}</Alert>}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{spec.blurb}</Typography>

      <Card
        padded={false}
        actions={!isBin && (
          <Button variant="primary" onClick={() => setCreating(true)}>Add contact</Button>
        )}
      >
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', p: 2 }}>
          <TextField
            size="small"
            placeholder="Search name, company or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ minWidth: 280, flex: '1 1 280px' }}
            slotProps={{
              input: {
                startAdornment: <InputAdornment position="start">🔍</InputAdornment>,
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setQuery('')} aria-label="Clear search">×</IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />

          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {!isBin && FILTERS.map(([key, label]) => (
              <Chip
                key={key}
                label={label}
                size="small"
                color={filter === key ? 'primary' : 'default'}
                variant={filter === key ? 'filled' : 'outlined'}
                onClick={() => { setFilter(key); setPage(1); }}
              />
            ))}
          </Box>

          {groups.length > 0 && (
            <TextField
              select size="small" label="Group"
              value={groupId}
              onChange={(e) => { setGroupId(e.target.value); setPage(1); }}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="">All groups</MenuItem>
              {groups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
            </TextField>
          )}
        </Box>

        <Divider />

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={30} /></Box>
        ) : visible.length === 0 ? (
          <Empty
            title={debounced ? `Nothing matches “${debounced}”` : spec.emptyTitle}
            hint={debounced ? 'Try part of a name, a company, or an email address.' : spec.emptyHint}
          />
        ) : (
          <Table head={['Name', 'Company', 'Address', 'Last contacted', isBin ? '' : 'Visibility']}>
            {visible.map((c) => (
              <tr
                key={c.id}
                style={{ cursor: isBin ? 'default' : 'pointer' }}
                onClick={isBin ? undefined : () => setOpenId(c.id)}
                title={isBin ? undefined : 'Open this contact'}
              >
                <Td>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
                    <Box
                      aria-hidden
                      sx={{
                        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                        display: 'grid', placeItems: 'center',
                        fontSize: 13, fontWeight: 700,
                        bgcolor: 'var(--mui-palette-primary-main)', color: '#fff',
                      }}
                    >
                      {initials(c.displayName)}
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {c.isFavourite && <span aria-label="Starred" title="Starred">★ </span>}
                        {c.displayName}
                      </Typography>
                      {c.jobTitle && (
                        <Typography variant="caption" color="text.secondary">{c.jobTitle}</Typography>
                      )}
                    </Box>
                  </Box>
                </Td>
                <Td>{c.companyName ?? '—'}</Td>
                <Td>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <span>{c.primaryEmail ?? '—'}</span>
                    {isAutoSaved(c.source) && (
                      <Tooltip title={sourceLabel(c.source)}>
                        <Chip label="auto" size="small" variant="outlined" />
                      </Tooltip>
                    )}
                  </Box>
                </Td>
                <Td>
                  <Tooltip title={c.interactionCount === 1 ? '1 exchange' : `${c.interactionCount} exchanges`}>
                    <span>{ago(c.lastContactedAt)}</span>
                  </Tooltip>
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
                    : <Badge tone="primary">Mine</Badge>}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {!debounced && pages > 1 && (
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {total} contacts · page {page} of {pages}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </Box>
          </Box>
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
    </FamilyShell>
  );
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
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add a contact</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {duplicate && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button variant="ghost" onClick={() => onOpenExisting(duplicate.contactId)}>
                Open it
              </Button>
            }
          >
            {duplicate.message}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField
            label="Name" required autoFocus fullWidth size="small"
            value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            helperText="How this person appears in every list"
          />
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField label="Company" fullWidth size="small"
                       value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            <TextField label="Job title" fullWidth size="small"
                       value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </Box>
          <TextField
            label="Email" type="email" fullWidth size="small"
            value={email} onChange={(e) => setEmail(e.target.value)}
            helperText="Becomes the primary address"
          />
          <TextField label="Phone" fullWidth size="small"
                     value={phone} onChange={(e) => setPhone(e.target.value)} />

          <TextField
            select label="Visibility" fullWidth size="small"
            value={ownership} onChange={(e) => setOwnership(e.target.value as Ownership)}
            helperText={ownership === 'personal'
              ? 'Only you can see this contact.'
              : 'Everyone in your organisation can see this contact. This cannot be undone later.'}
          >
            <MenuItem value="personal">Only me</MenuItem>
            <MenuItem value="organisational">Everyone in my organisation</MenuItem>
          </TextField>

          {groups.length > 0 && (
            <TextField select label="Add to group" fullWidth size="small"
                       value={groupToJoin} onChange={(e) => setGroupToJoin(e.target.value)}>
              <MenuItem value="">None</MenuItem>
              {groups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
            </TextField>
          )}

          <TextField label="Notes" fullWidth multiline minRows={2} size="small"
                     value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || displayName.trim().length === 0}>
          {busy ? 'Adding…' : 'Add contact'}
        </Button>
      </DialogActions>
    </Dialog>
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
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <span>{c?.displayName ?? 'Contact'}</span>
        {c && (c.ownershipType === 'organisational'
          ? <Badge tone="info">Shared</Badge>
          : <Badge tone="primary">Mine</Badge>)}
        {c && isAutoSaved(c.source) && (
          <Chip label={sourceLabel(c.source)} size="small" variant="outlined" />
        )}
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {!c ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}><CircularProgress size={28} /></Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField label="Name" fullWidth size="small" value={form.displayName}
                         onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
              <Box sx={{ display: 'flex', gap: 2 }}>
                <TextField label="Company" fullWidth size="small" value={form.companyName}
                           onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} />
                <TextField label="Job title" fullWidth size="small" value={form.jobTitle}
                           onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))} />
              </Box>
              <TextField label="Notes" fullWidth multiline minRows={2} size="small" value={form.notes}
                         onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              <Box sx={{ display: 'flex', gap: 1 }}>
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
              </Box>
            </Box>

            <Divider />

            <Section title="Email addresses">
              {c.emails.length === 0 && <Muted>No addresses.</Muted>}
              {c.emails.map((e) => (
                <Row key={e.id}>
                  <span>{e.email}{e.isPrimary && <Chip label="primary" size="small" sx={{ ml: 1 }} />}</span>
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
                  <span>{p.phone}{p.isPrimary && <Chip label="primary" size="small" sx={{ ml: 1 }} />}</span>
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

            {groups.length > 0 && (
              <Section title="Groups">
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {groups.map((g) => {
                    const member = inGroups.has(g.id);
                    return (
                      <Chip
                        key={g.id} label={g.name} size="small"
                        color={member ? 'primary' : 'default'}
                        variant={member ? 'filled' : 'outlined'}
                        onClick={() => run(() => member
                          ? familyApi.removeFromGroup(authedFetch, g.id, id)
                          : familyApi.addToGroup(authedFetch, g.id, id))}
                      />
                    );
                  })}
                </Box>
              </Section>
            )}

            <Divider />

            <Box>
              <Typography variant="body2" color="text.secondary">
                {c.interactionCount === 0
                  ? 'No exchanges recorded.'
                  : `${c.interactionCount} exchange${c.interactionCount === 1 ? '' : 's'}, most recently ${ago(c.lastContactedAt).toLowerCase()}.`}
              </Typography>
            </Box>

            {c.ownershipType === 'personal' && (
              <Alert
                severity="info"
                action={<Button variant="ghost" onClick={() => setConfirmShare(true)}>Share</Button>}
              >
                Only you can see this contact.
              </Alert>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
      </DialogActions>

      {/* Sharing is irreversible, so the dialog says so before, not after. */}
      <Dialog open={confirmShare} onClose={() => setConfirmShare(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Share with your organisation?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            Everyone in your organisation will be able to see, edit and use this contact.
          </Typography>
          <Typography variant="body2" sx={{ mt: 1.5, fontWeight: 600 }}>
            This cannot be undone. Making it personal again would mean choosing who owns it,
            and there is no right answer to that — you would have to create a fresh copy.
          </Typography>
        </DialogContent>
        <DialogActions>
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
        </DialogActions>
      </Dialog>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete this contact?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            It disappears from every list and search.
          </Typography>
          {c && isAutoSaved(c.source) && (
            <Typography variant="body2" sx={{ mt: 1.5 }}>
              Because this one was saved automatically, deleting it also stops it coming back —
              the next message from that address will not recreate it.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
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
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Small shared bits, local to this screen
// ---------------------------------------------------------------------------

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Box>
    <Typography variant="subtitle2" sx={{ mb: 1 }}>{title}</Typography>
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</Box>
  </Box>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
    {children}
  </Box>
);

const Muted = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="body2" color="text.secondary">{children}</Typography>
);

function AddRow({ label, value, onChange, onAdd, busy }: {
  label: string; value: string; onChange: (v: string) => void;
  onAdd: () => void; busy: boolean;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <TextField
        size="small" fullWidth placeholder={label} value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { e.preventDefault(); onAdd(); } }}
      />
      <Button variant="secondary" disabled={busy || value.trim().length === 0} onClick={onAdd}>Add</Button>
    </Box>
  );
}
