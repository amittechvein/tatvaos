'use client';

import { useEffect, useState } from 'react';

import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Field, FormActions, Input, InputSuffix, Switch } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { useHireAccess } from '../HireAccess';

// ============================================================================
//  Setting up the public careers page (decision 0010 §1) — administrators.
//
//  The page says plainly whether candidates can see anything: the
//  organisation's switch is one of two, and the platform's switch stays off
//  until Mr. Singh has ruled and a lawyer has confirmed the retention period.
//  An administrator who turns theirs on and sees nothing must be told why,
//  not left to guess.
// ============================================================================

interface Site {
  saved: boolean;
  slug: string | null;
  displayName: string;
  erasureContact: string | null;
  isEnabled: boolean;
  platformEnabled: boolean;
  path: string | null;
}

export default function HireCareersSetupPage() {
  const { authedFetch } = useAuth();
  const me = useHireAccess();
  const [site, setSite] = useState<Site | null>(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (me.access !== 'admin') return;
    void (async () => {
      const res = await authedFetch('/hire/careers');
      if (!res.ok) { setError('Could not load the careers page settings.'); return; }
      const s: Site = await res.json();
      setSite(s);
      setSlug(s.slug ?? '');
      setName(s.displayName);
      setContact(s.erasureContact ?? '');
      setEnabled(s.isEnabled);
    })();
  }, [authedFetch, me.access]);

  if (me.access !== 'admin') {
    return (
      <>
        <PageHeader title="Careers page" />
        <Alert tone="info">Only an administrator can set up the careers page.</Alert>
      </>
    );
  }
  if (!site) return error ? <Alert tone="danger">{error}</Alert> : <Spinner />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authedFetch('/hire/careers', {
        method: 'PUT',
        body: JSON.stringify({ slug, displayName: name, erasureContact: contact, isEnabled: enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setSite({ ...site!, saved: true, slug: body.slug, isEnabled: body.isEnabled, path: body.path });
      setNotice('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const live = site.saved && site.isEnabled && site.platformEnabled;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <PageHeader title="Careers page" subtitle="A public page listing your open jobs" />
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {live ? (
        <Alert tone="ok" title="Your careers page is live">
          <a href={site.path!} target="_blank" rel="noreferrer" className="font-medium underline">{origin}{site.path}</a>
        </Alert>
      ) : (
        <Alert tone="info" title="Nobody outside your organisation can see it yet">
          {!site.platformEnabled
            ? 'Careers pages are not open on TatvaOS yet. You can set yours up now; it appears once they open.'
            : !site.saved || !site.isEnabled
              ? 'Switch it on below when you are ready.'
              : null}
        </Alert>
      )}

      <Card title="Your page" className="mb-5">
        <form onSubmit={save} noValidate>
          <Field label="Address" required hint="Lower-case letters and digits, hyphens between them. Choose carefully: changing it breaks links you have shared.">
            {(p) => <InputSuffix {...p} suffix={`/careers/…`} value={slug} maxLength={40}
                                 onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="techvein" />}
          </Field>
          <Field label="Organisation name, as candidates see it" required>
            {(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Who answers questions about candidates' data"
                 hint="Candidates write here to see, correct or delete their data; your organisation replies within 30 days. By default, your organisation's owner.">
            {(p) => <Input {...p} type="email" value={contact} maxLength={320} onChange={(e) => setContact(e.target.value)} />}
          </Field>
          {/* Mr. Singh, 24 Sept 2026 (PR 275): the default is a named person,
              and this address goes on the open internet. Say so, and offer the
              role address, before anyone saves. Wording awaiting his approval. */}
          <Alert tone="warn">
            This address is shown publicly on every job, so spammers will find it. A shared address such
            as privacy@ or hr@ is better than a person&apos;s own — someone must still read it and reply
            within 30 days.
          </Alert>
          <Switch label="Show the careers page" hint="Lists your open job openings. Drafts, jobs on hold and closed jobs never appear."
                  checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <FormActions>
            <Button type="submit" variant="primary" disabled={busy || !slug.trim() || !name.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </FormActions>
        </form>
      </Card>

      <Card title="Not yet on this page">
        <p className="mb-0 text-[0.8125rem] text-ink-muted">
          Candidates cannot apply through the careers page yet — the application form, with the notice
          telling them how their data is kept, comes next. For now, add candidates yourself under Candidates.
        </p>
      </Card>
    </>
  );
}
