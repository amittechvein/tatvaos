'use client';

/**
 * Invited by email — who, and did it actually go.
 *
 * Amit, 17 Sept 2026: "Invite on the meeting". Every row is what the mail
 * server ANSWERED for that person, not what the page hoped: a host asking
 * "did Ravi get it?" should find the answer here, including the reason when
 * the answer is no.
 *
 * Host and cohost only (the parent decides), because the list is other
 * people's email addresses.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { ContactPicker } from '@/components/family/ContactPicker';
import { Alert } from '@/components/ui/Page';
import { connectApi, type MeetingInvitation } from '@/lib/connect';

// The labels say what is KNOWN, which is whether OUR mail server took it.
// Nothing here learns about a bounce: the bounce pipeline has never been
// proven end to end (CTO review, 17 Sept 2026), so "Delivered" or "Not
// delivered" would be a claim this page cannot back. The line under the list
// says the same in words.
const STATUS: Record<Exclude<MeetingInvitation['status'], 'withdrawn'>, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  sent: { label: 'Sent', tone: 'ok' },
  pending: { label: 'Sending…', tone: 'warn' },
  failed: { label: 'Could not send', tone: 'danger' },
  not_sent: { label: 'Not sent', tone: 'neutral' },
};

export default function Invitations({ meetingId, over, allowGuests }: {
  meetingId: string; over: boolean; allowGuests: boolean;
}) {
  const { authedFetch } = useAuth();
  const search = useSearchParams();

  const [rows, setRows] = useState<MeetingInvitation[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A problem from the new-meeting form arrives in the URL: the meeting was
  // created, the invitations were not all sent, and this is where it is said.
  const [notice, setNotice] = useState<string | null>(search?.get('invite_problem') ?? null);

  const load = useCallback(async () => {
    try {
      const out = await connectApi.invitations(authedFetch, meetingId);
      setRows(out.invitations);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the invitations.');
    }
  }, [authedFetch, meetingId]);

  useEffect(() => { void load(); }, [load]);

  async function invite() {
    if (text.trim().length === 0) return;
    setBusy('invite'); setError(null); setNotice(null);
    try {
      const out = await connectApi.invite(authedFetch, meetingId, [text]);
      setRows(out.invitations);
      const said: string[] = [];
      if (out.added > 0) said.push(`${out.sent} of ${out.added} sent.`);
      if (out.alreadyInvited.length > 0) said.push(`Already invited: ${out.alreadyInvited.join(', ')}.`);
      if (out.invalid.length > 0) said.push(`Not an email address: ${out.invalid.join(', ')}.`);
      if (out.note) said.push(out.note);
      if (out.warning) said.push(out.warning);
      setNotice(said.join(' ') || null);
      // Keep what could not be sent in the box, so the typo can be fixed.
      setText(out.invalid.join(', '));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the invitations.');
    } finally {
      setBusy(null);
    }
  }

  async function act(inv: MeetingInvitation, what: 'resend' | 'withdraw') {
    setBusy(inv.id); setError(null); setNotice(null);
    try {
      if (what === 'resend') {
        const out = await connectApi.resendInvitation(authedFetch, meetingId, inv.id);
        setNotice(out.sent > 0 ? `Sent again to ${inv.email}.` : (out.note ?? `Could not send to ${inv.email}.`));
      } else {
        const out = await connectApi.withdrawInvitation(authedFetch, meetingId, inv.id);
        setNotice(out.note ?? (inv.status === 'sent'
          ? `Withdrawn. ${inv.email} was sent a cancellation.`
          : `Withdrawn.`));
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Invited by email" className="mt-4">
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      {notice && <Alert tone="info" className="mb-3" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {rows === null ? (
        <div className="text-sm text-ink-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-ink-muted">Nobody has been invited by email yet.</div>
      ) : (
        <>
        <div className="mb-1 text-xs text-ink-muted">
          &ldquo;Sent&rdquo; means your mail server accepted it. It does not confirm it reached their inbox.
        </div>
        <ul className="mb-3">
          {rows.map((inv) => (
            <li key={inv.id} className="border-b border-line py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium" title={inv.email}>{inv.email}</span>
                <Badge tone={inv.outOfDate ? 'warn' : STATUS[inv.status as keyof typeof STATUS].tone}>
                  {inv.outOfDate ? 'Old time' : STATUS[inv.status as keyof typeof STATUS].label}
                </Badge>
              </div>
              {(inv.note || inv.outOfDate) && (
                <div className="mt-1 text-xs text-ink-muted">
                  {inv.outOfDate
                    ? 'The meeting changed after this was sent, and the update could not be sent to them. Send it again.'
                    : inv.note}
                </div>
              )}
              {!over && (
                <div className="mt-1 flex gap-2">
                  {(inv.status !== 'sent' || inv.outOfDate) && (
                    <Button size="sm" type="button" disabled={busy !== null}
                            onClick={() => void act(inv, 'resend')}>
                      {busy === inv.id ? 'Sending…' : 'Send again'}
                    </Button>
                  )}
                  <Button size="sm" type="button" disabled={busy !== null}
                          onClick={() => void act(inv, 'withdraw')}>
                    Withdraw
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        </>
      )}

      {!over && (
        <>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="invite-more">
            Invite people
          </label>
          {/* Suggestions from contacts and colleagues while typing a name. */}
          <ContactPicker value={text} onPick={setText}>
            {(pickerRef, onPickerKeyDown) => (
              <Input id="invite-more" ref={pickerRef} value={text} disabled={busy !== null}
                     onChange={(e) => setText(e.target.value)}
                     onKeyDown={onPickerKeyDown}
                     placeholder="Type a name, or ravi@example.com"
                     autoComplete="off" spellCheck={false} />
            )}
          </ContactPicker>
          <div className="mt-1 text-xs text-ink-muted">
            Each person gets their own email with the link and a calendar invitation, sent from your mailbox.
            {!allowGuests && ' Guests are not allowed in this meeting, so only colleagues signed in to TatvaOS can join.'}
          </div>
          <Button variant="primary" type="button" className="mt-2"
                  disabled={busy !== null || text.trim().length === 0}
                  onClick={() => void invite()}>
            {busy === 'invite' ? 'Sending…' : 'Send invitations'}
          </Button>
        </>
      )}
    </Card>
  );
}
