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

import { useAuth, type AccountSlot } from '@/lib/auth';
import { AuthCard } from '@/components/ui/AuthCard';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

/**
 * logoUri from the API is the REAL path, '/api/auth/oauth/applications/…'.
 * API already ends with '/api' (it is '/api' in production and an absolute
 * origin plus '/api' on a laptop), so the duplicate prefix comes off rather
 * than being pasted twice.
 */
function logoSrc(path: string): string {
  return API.endsWith('/api') ? API.slice(0, -4) + path : path;
}

interface ConsentDetails {
  name: string;
  organisation: string | null;
  returnsTo: string;
  receives: string[];
  staysSignedIn: boolean;
  /** Our copy, never the application's own server. Null when none was uploaded. */
  logoUri: string | null;
  /** What the application SAYS about itself. Not verified by anyone. */
  declared: {
    description: string | null;
    operatorName: string | null;
    clientUri: string | null;
    policyUri: string | null;
    tosUri: string | null;
    contacts: string | null;
  } | null;
}

/**
 * "Signed in as …", and the way to be somebody else (Amit, 29 Sept 2026).
 *
 * A person with two accounts on this browser — their own and a shared one,
 * or two organisations — arrived here as whichever was active, and the only
 * way to sign in to the application as the other was to leave, switch, and
 * start again from the application. Now:
 *
 *   - the other accounts on this browser are listed; one that is still
 *     signed in is ONE click and no password (the same /auth/switch the
 *     account menu uses: the slot's own cookie is the credential);
 *   - "Use another account" goes to sign-in and comes back to THIS request.
 *
 * It sits OUTSIDE the form and below both buttons, closed until asked for:
 * nothing on this screen competes with the decision (CTO, 17 Sept). Its
 * buttons can therefore never submit the consent form by accident.
 *
 * WHAT IT DOES NOT DO: decide who may use the application. After a switch the
 * page asks the API again, as the new person. An account from another
 * organisation gets the API's own "cannot be used from your organisation",
 * with this chooser still there to switch back. The decision is recorded by
 * the API from the session cookie at the moment Continue is pressed, never
 * from anything this page holds.
 */
function AccountChooser({ user, accounts, busy, problem, onSwitch, onSignIn }: {
  user: { displayName: string; email: string };
  accounts: AccountSlot[];
  busy: boolean;
  problem: string | null;
  onSwitch: (slot: number) => void;
  onSignIn: (email?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const others = accounts.filter((a) => !a.active);

  return (
    <div className="mt-5 text-center text-xs text-ink-muted">
      <p>
        Signed in as {user.displayName} ({user.email}). You can remove this later from your account page.
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        {open ? 'Keep this account' : 'Switch account'}
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-line text-left">
          {problem && <p className="border-b border-line px-4 py-2.5 text-danger" role="alert">{problem}</p>}
          <ul className="divide-y divide-line">
            {others.map((a) => (
              <li key={a.slot}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => (a.signedIn ? onSwitch(a.slot) : onSignIn(a.email))}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-canvas disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{a.displayName}</span>
                    <span className="block truncate">{a.email}{a.organisation ? ` · ${a.organisation}` : ''}</span>
                  </span>
                  <span className="shrink-0 font-semibold text-brand-700">
                    {a.signedIn ? 'Use this account' : 'Sign in'}
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSignIn()}
                className="w-full px-4 py-2.5 text-left text-sm font-medium text-ink hover:bg-canvas disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40"
              >
                Use another account
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export default function OAuthConsentPage() {
  const router = useRouter();
  const { user, loading, authedFetch, accounts, switchTo } = useAuth();
  const [params, setParams] = useState<[string, string][] | null>(null);
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchProblem, setSwitchProblem] = useState<string | null>(null);

  /** This same request, as a path the sign-in page can return to. */
  const thisRequest = () => `/oauth/consent${window.location.search}`;

  async function switchAccount(slot: number) {
    setSwitching(true);
    setSwitchProblem(null);
    try {
      // The details below belong to the person who WAS signed in. They are
      // cleared first, so the application is never shown under one name
      // while the session is already another's; the effect asks again.
      setDetails(null);
      setError(null);
      await switchTo(slot);
    } catch (e) {
      // That account's session had ended. switchTo has signed this page out
      // of it; the effect below then sends the person to sign in, and back.
      setSwitchProblem(e instanceof Error ? e.message : 'That account needs to sign in again.');
    } finally {
      setSwitching(false);
    }
  }

  function signInAs(email?: string) {
    const to = `/login?add=1&next=${encodeURIComponent(thisRequest())}`
      + (email ? `&email=${encodeURIComponent(email)}` : '');
    router.push(to);
  }

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

          {/* The two parties, connected: the application on the left, the
              person on the right. Still a bare page (CTO, 17 Sept): nothing
              here competes with the decision. */}
          <div className="flex items-center justify-center gap-3">
            {/* THE LOGO IS NOT HERE, ON THIS SCREEN, DELIBERATELY.
                A logo is wayfinding where the viewer already trusts the list,
                and evidence where they do not (CTO, 18 Sept 2026). In the
                console an administrator is looking at applications they
                registered themselves, so it sits in the tile and helps them
                find the right row. Here it is a mark that could resemble a
                bank or a government service, and the top of this screen is
                reserved for the one thing we can stand behind: the name, and
                "Added by <organisation> administrators". The logo appears
                below, inside the block labelled as the application's own
                claims, with everything else nobody has checked. */}
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-xl font-bold text-white shadow-lg shadow-brand-600/25"
                 aria-hidden="true">
              {details.name.trim().charAt(0).toUpperCase() || '?'}
            </div>
            <div className="flex items-center gap-1 text-ink-faint" aria-hidden="true">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />
            </div>
            <div className="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-xl font-bold text-ink"
                 aria-hidden="true">
              {(user?.displayName?.trim().charAt(0) || 'T').toUpperCase()}
            </div>
          </div>

          <div className="mt-5 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              Sign in to {details.name}
            </h1>
            {details.organisation && (
              <span className="mt-2 inline-block rounded-full border border-line bg-canvas px-3 py-1 text-xs font-medium text-ink-muted">
                Added by {details.organisation} administrators
              </span>
            )}
          </div>

          <div className="mt-6 rounded-xl border border-line bg-canvas p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              {details.name} will receive
            </p>
            <ul className="mt-2 space-y-2 text-sm text-ink">
              {/* Exactly what the API said, in its order. The offline_access
                  sentence lives in OidcEndpoints.ReceivesInWords with the
                  others, so this screen and the account page can never word
                  the same grant differently (house rule 10). */}
              {details.receives.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700"
                        aria-hidden="true">
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 10.5l4 4 8-9" />
                    </svg>
                  </span>
                  <span>{item.charAt(0).toUpperCase() + item.slice(1)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-sm text-ink">
              You will be returned to <span className="font-semibold">{details.returnsTo}</span>.
            </p>
          </div>

          {/* WHAT WE VOUCH FOR AND WHAT IS CLAIMED ARE DIFFERENT THINGS.
              "Added by <organisation> administrators" above is a fact: their
              own admin registered it. Everything here was typed into a form
              by whoever registered the application and is checked by nobody,
              so it is smaller, labelled as the application's own words, and
              below the decision rather than beside the name. A self-declared
              company name rendered with the authority of a verified one is a
              phishing vector (CTO, 18 Sept 2026). */}
          {(details.logoUri || (details.declared && (details.declared.description || details.declared.operatorName
            || details.declared.clientUri || details.declared.policyUri || details.declared.tosUri))) && (
            <details className="mt-4 rounded-xl border border-line">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-ink-muted">
                What {details.name} says about itself
              </summary>
              <div className="border-t border-line px-4 py-3 text-xs text-ink-muted">
                <p className="mb-2 text-[0.6875rem] uppercase tracking-wide">
                  Provided by whoever registered it. TatvaOS has not checked any of it.
                </p>
                {details.logoUri && (
                  <p className="mb-2">
                    {/* Served from our own copy, never the application's
                        server — see the migration. It sits here, not at the
                        top, because it is a claim like the rest. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={logoSrc(details.logoUri)} alt=""
                         className="h-10 w-10 rounded-lg border border-line bg-surface object-contain p-1" />
                  </p>
                )}
                {details.declared?.description && <p className="mb-2">{details.declared.description}</p>}
                {details.declared?.operatorName && <p className="mb-2">Says it is operated by {details.declared.operatorName}.</p>}
                <p className="mb-0 flex flex-wrap gap-x-4 gap-y-1">
                  {details.declared?.clientUri && (
                    <a href={details.declared.clientUri} target="_blank" rel="noopener noreferrer nofollow">Website</a>
                  )}
                  {details.declared?.policyUri && (
                    <a href={details.declared.policyUri} target="_blank" rel="noopener noreferrer nofollow">Privacy policy</a>
                  )}
                  {details.declared?.tosUri && (
                    <a href={details.declared.tosUri} target="_blank" rel="noopener noreferrer nofollow">Terms</a>
                  )}
                  {details.declared?.contacts && <span>Support: {details.declared.contacts}</span>}
                </p>
              </div>
            </details>
          )}

          {/* EQUAL WEIGHT, DELIBERATELY (CTO, 18 Sept 2026). The first draft
              had Cancel as quiet muted text under a gradient Continue — the
              known consent-screen pattern where the safe choice is quieter
              than the agreeable one, which teaches people to click through.
              Both are now the same size, the same padding and full-strength
              ink; Continue is filled because it is the action, not because it
              is preferred. If anyone "tidies" Cancel back to a text link,
              this is the reason not to. */}
          <div className="mt-6 flex flex-col gap-3">
            <button
              type="submit"
              name="tv_decision"
              value="allow"
              className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-brand-800 px-4 py-3 text-base font-semibold text-white shadow-lg shadow-brand-600/30 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-brand-600/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 active:translate-y-0"
            >
              Continue
              <svg viewBox="0 0 20 20" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 10h12M11 5l5 5-5 5" />
              </svg>
            </button>
            <button
              type="submit"
              name="tv_decision"
              value="deny"
              className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-base font-semibold text-ink transition hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            >
              Cancel
            </button>
          </div>

        </form>
      )}

      {/* Outside the form, and shown when the application could NOT be
          loaded too: "cannot be used from your organisation" is exactly when
          somebody needs to be a different account. */}
      {user && (
        <AccountChooser
          user={user}
          accounts={accounts}
          busy={switching}
          problem={switchProblem}
          onSwitch={switchAccount}
          onSignIn={signInAs}
        />
      )}
    </AuthCard>
  );
}
