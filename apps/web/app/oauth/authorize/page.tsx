'use client';

/**
 * The address a customer's application sends people to — decision 0004:
 *
 *     https://core.tatvaos.com/oauth/authorize?response_type=code&client_id=…
 *
 * It is a web page and not the API endpoint for one reason: the session
 * cookies are SameSite=Strict, and the application's redirect is a
 * cross-site navigation, which carries no Strict cookie at all. An API
 * endpoint reached that way would always see "not signed in". This page
 * needs no cookie to load; once loaded, it makes ONE same-site navigation
 * to the API's authorize endpoint under /api/auth/, and that navigation
 * does carry the cookie. Then the API decides: sign-in, consent, or the
 * code back to the application.
 *
 * `replace`, not assign, so Back from the application does not return to a
 * hop that would fire again. Nothing here reads or keeps the query: it is
 * the application's request and it is forwarded as it came.
 */

import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export default function OAuthAuthorizePage() {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const search = window.location.search;
    if (!search || !new URLSearchParams(search).get('client_id')) {
      setProblem('This sign-in link is incomplete. Go back to the application and try again.');
      return;
    }
    window.location.replace(`${API}/auth/oauth/authorize${search}`);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-medium text-ink">
          {problem ? 'Could not continue' : 'Continuing to sign in…'}
        </h1>
        <p className="mt-2 text-sm text-ink-muted">{problem ?? 'One moment.'}</p>
      </div>
    </main>
  );
}
