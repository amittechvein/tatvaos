'use client'

/**
 * The landing page for a sign-in handoff — docs/decisions/0003-mobile-signin-handoff.md.
 *
 * The mobile app opens this with the code in the URL FRAGMENT:
 *
 *     https://core.tatvaos.com/handoff#c=<code>&p=/mail/inbox
 *
 * THE FRAGMENT IS THE WHOLE POINT. A query string reaches the server, every
 * proxy in between, and any access log anyone turns on later; a fragment never
 * leaves the browser. What the browser DOES keep is history, which is why the
 * first thing this page does — before the network call, before any render that
 * could be screenshotted by the OS — is replace its own URL with a bare
 * /handoff. After that the code exists only in this page's memory.
 *
 * It is then POSTed (not GET: a GET with a side effect is prefetchable by link
 * previews and would spend the code before the person arrived), the API sets
 * the same cookies a password sign-in sets, and we navigate to the path the
 * SERVER returned. Never the `p` from the URL — that half is only for showing
 * where someone is going while they wait. The authoritative path comes back
 * from the row, so editing the fragment cannot aim this anywhere.
 *
 * Failure is one sentence and a stop. No retry loop: a code is single-use and
 * lives sixty seconds, so a second attempt is guaranteed to fail and a spinner
 * that never ends is the failure this codebase keeps writing down.
 */

import { useEffect, useState } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api'

// One sentence for expired, already used, tampered with and missing alike.
// The server cannot tell these apart on purpose, and neither should this page.
const EXPIRED = 'This link has expired. Go back to the app and open it again.'

export default function HandoffPage() {
  const [error, setError] = useState('')
  const [heading, setHeading] = useState('Signing you in…')

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
    const params = new URLSearchParams(hash)
    const code = params.get('c')
    const shown = params.get('p')

    // Scrub first, ask questions later. Nothing below may run before the
    // address bar and the history entry have stopped holding the code.
    window.history.replaceState(null, '', '/handoff')

    if (!code) {
      setHeading('Could not open this link')
      setError(EXPIRED)
      return
    }
    if (shown && shown.startsWith('/')) setHeading(`Opening ${shown}…`)

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API}/auth/handoff/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ code }),
        })
        if (cancelled) return

        if (!res.ok) {
          setHeading('Could not open this link')
          setError(EXPIRED)
          return
        }

        const data = (await res.json()) as { redirect?: string }
        // The server's path, and a last shape check on it: this navigation is
        // the one place a bad value would become a redirect.
        const to = data.redirect && data.redirect.startsWith('/') && !data.redirect.startsWith('//')
          ? data.redirect
          : '/'
        // replace, not assign: Back should not return to a spent handoff.
        window.location.replace(to)
      } catch {
        if (cancelled) return
        setHeading('Could not open this link')
        setError('Something went wrong opening this link. Go back to the app and try again.')
      }
    })()

    return () => { cancelled = true }
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-medium text-ink">{heading}</h1>
        {error
          ? <p className="mt-2 text-sm text-ink-muted">{error}</p>
          : <p className="mt-2 text-sm text-ink-muted">One moment.</p>}
      </div>
    </main>
  )
}
