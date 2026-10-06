'use client';

import { useEffect, useState } from 'react';

import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import {
  cancelDeletion, downloadMyData, fetchLifecycle, requestDeletion, type MyLifecycle,
} from '@/lib/personal';

// ============================================================================
//  Account → Plan → Your data (build plan §4.2, §8), personal accounts only.
//
//  Download my data: one zip, streamed by the server.
//  Delete my account: the password again, then 7 days in which it can be
//  cancelled; after that everything goes, and the address is held for 90
//  days. A suspended account sees why it cannot send, and can still download.
//
//  Wording is DRAFT until Mr. Singh and Amit approve it (build plan §10).
// ============================================================================

function indiaDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export function YourDataCard() {
  const { authedFetch } = useAuth();
  const [life, setLife] = useState<MyLifecycle | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'download' | 'delete' | 'cancel' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => fetchLifecycle(authedFetch).then(setLife).catch(() => setErr('Could not load your account status.'));
  useEffect(() => { void reload(); }, [authedFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(kind: 'download' | 'delete' | 'cancel', fn: () => Promise<unknown>) {
    setBusy(kind); setErr(null);
    try { await fn(); await reload(); if (kind === 'delete') { setAsking(false); setPassword(''); } }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  if (!life) return <Card title="Your data">{err ? <p className="mb-0 text-sm text-danger">{err}</p> : <Spinner />}</Card>;

  return (
    <Card title="Your data" subtitle="Take a copy, or delete your account.">
      {err && <Alert tone="danger" onDismiss={() => setErr(null)}>{err}</Alert>}

      {life.suspended && (
        <Alert tone="warn" title="This account can't send mail right now">
          You can still read your mail and download your data. If you think this is a mistake, write to support.
        </Alert>
      )}

      {life.deleteAfter && (
        <Alert tone="danger" title={`This account will be deleted on ${indiaDate(life.deleteAfter)}`}
               action={life.canCancel ? (
                 <Button onClick={() => run('cancel', () => cancelDeletion(authedFetch))} disabled={busy !== null}>
                   {busy === 'cancel' ? <Spinner inline label="Working" /> : 'Keep my account'}
                 </Button>
               ) : undefined}>
          Everything in it goes then: mail, files, calendars, contacts and the meetings you hosted.
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-semibold">Download my data</div>
          <div className="text-sm text-ink-muted">Your mail, files, contacts and calendars, in one zip file.</div>
        </div>
        <Button onClick={() => run('download', () => downloadMyData(authedFetch))} disabled={busy !== null}>
          {busy === 'download' ? <Spinner inline label="Preparing" /> : 'Download'}
        </Button>
      </div>

      {!life.deleteAfter && (
        <div className="border-t border-line pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Delete my account</div>
              <div className="text-sm text-ink-muted">You have 7 days to change your mind.</div>
            </div>
            {!asking && <Button onClick={() => setAsking(true)}>Delete my account…</Button>}
          </div>
          {asking && (
            <Alert tone="danger" title="Delete your account?">
              <p className="mb-3">
                In 7 days your mail, files, calendars, contacts and the meetings you hosted will be deleted for good.
                Download your data first if you want a copy. Enter your password to confirm.
              </p>
              <Input type="password" autoComplete="current-password" value={password}
                     aria-label="Your password" onChange={(e) => setPassword(e.target.value)} className="mb-3" />
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" disabled={busy !== null || password.length === 0}
                        onClick={() => run('delete', () => requestDeletion(authedFetch, password))}>
                  {busy === 'delete' ? <Spinner inline label="Working" /> : 'Delete in 7 days'}
                </Button>
                <Button onClick={() => { setAsking(false); setPassword(''); }} disabled={busy !== null}>Cancel</Button>
              </div>
            </Alert>
          )}
        </div>
      )}
    </Card>
  );
}
