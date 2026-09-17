'use client';

/**
 * The consent screen — decision 0004. The API's authorize endpoint sends a
 * signed-in person here the first time an application asks for them, with
 * the application's whole request in the query.
 *
 * What it says, in words (0004): the application's name, "Added by
 * <organisation> administrators", the host it will return them to, and what
 * it will receive — "your name, your work email address, and which
 * organisation you belong to". Continue or Cancel.
 *
 * HOW THE ANSWER TRAVELS. Not by fetch: by a form POST to the API's
 * authorize endpoint, carrying every parameter of the original request as
 * hidden fields plus tv_decision. A top-level same-site POST carries the
 * Strict session cookie, so the API knows who answered; a cross-site page
 * cannot forge the same POST, because its POST carries no cookie and lands
 * as "not signed in". The API records the consent and, on allow, redirects
 * straight to the application with the code — this page never sees a code.
 *
 * The details come from the API under the person's own session and tenant:
 * an application of another organisation is "not found" here, and the
 * authorize endpoint refuses it independently.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { AuthCard, AUTH_BUTTON } from '@/components/ui/AuthCard';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

interface ConsentDetails {
  name: string;
  organisation: string | null;
  returnsTo: string;
  receives: string[];
  staysSignedIn: boolean;
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export default function OAuthConsentPage() {
  const router = useRouter();
  const { user, loading, authedFetch } = useAuth();
  const [params, setParams] = useState<[string, string][] | null>(null);
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The application's request, minus any decision: a decision is made on
  // this page, by a click, and never arrives with the query.
  useEffect(() => {
    const entries = [...new URLSearchParams(window.location.search).entries()]
      .filter(([k]) => k !== 'tv_decision');
    setParams(entries);
  }, []);

  useEffect(() => {
    if (loading || !params) return;
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent(`/oauth/consent${window.location.search}`)}`);
      return;
    }
    const q = new URLSearchParams(params);
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const scope = q.get('scope') ?? '';
    if (!clientId || !redirectUri) {
      setError('This sign-in link is incomplete. Go back to the application and try again.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await authedFetch(
          `/auth/oauth/consent?client_id=${encodeURIComponent(clientId)}`
          + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`,
        );
        if (cancelled) return;
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? 'This application cannot be used from your organisation.');
          return;
        }
        setDetails((await r.json()) as ConsentDetails);
      } catch {
        if (!cancelled) setError('Could not load the application. Go back and try again.');
      }
    })();
    return () => { cancelled = true; };
  }, [loading, user, params, authedFetch, router]);

  if (loading || !params || (!details && !error)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
        <p className="text-sm text-ink-muted">One moment.</p>
      </main>
    );
  }

  return (
    <AuthCard>
      {error ? (
        <>
          <h1 className="text-lg font-semibold text-ink">Could not continue</h1>
          <p className="mt-2 text-sm text-ink-muted">{error}</p>
        </>
      ) : details && (
        <form method="post" action={`${API}/auth/oauth/authorize`}>
          {params.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}

          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Sign in to</p>
          <h1 className="mt-1 text-xl font-semibold text-ink">{details.name}</h1>
          {details.organisation && (
            <p className="mt-1 text-sm text-ink-muted">Added by {details.organisation} administrators</p>
          )}

          <div className="mt-5 space-y-3 text-sm text-ink">
            <p>
              <span className="font-medium">{details.name}</span> will receive {joinWords(details.receives)}.
              {details.staysSignedIn && ' It can keep you signed in without asking again.'}
            </p>
            <p>
              You will be returned to <span className="font-medium">{details.returnsTo}</span>.
            </p>
            {user && (
              <p className="text-ink-muted">
                Signed in as {user.displayName} ({user.email}).
              </p>
            )}
          </div>

          <div className="mt-6 flex flex-col gap-2">
            <button type="submit" name="tv_decision" value="allow" className={AUTH_BUTTON}>
              Continue
            </button>
            <button
              type="submit"
              name="tv_decision"
              value="deny"
              className="w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-canvas"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </AuthCard>
  );
}
