# Screen checks

`pnpm run check` (or `npx jest`). Render-level checks for `screens/`, written
the night of 9–10 September 2026 without a phone in hand, which is exactly why
they exist: they are the part of the Connect work that could be proven that
night.

## What they prove

The state machine in `screens/Meeting.js` does the right thing for every
answer the API and the SDK can give, driven through the real component with
`@testing-library/react-native`:

- direct join → connect with the minted token, mic on, speaker selected
- waiting room → poll every 2 s, enter with the token the **poll** returned
  (it is one-shot on the server), denied is terminal and named
- 403 → password asked; wrong one → told; right one → joined
- 409 → the server's own sentence shown, nothing connects
- share: consent given → Stop share; refusal that **throws** with the
  inverted shape → REFUSED; refusal that **resolves undefined** → REFUSED;
  other failure → failure, not refusal; capture revoked by the OS
  (`LocalTrackUnpublished`) → button drops back to Share
- mic refused at join → in the call, muted, told why
- leave → disconnect and hand back exactly once
- server-side disconnect → shown by name, not number
- Android runtime permissions asked before the first join call, and a
  failure there costs the prompt, not the join
- `screens/Meetings.js`: list and join; empty list and failed load told
  apart; start-now creates and joins

Calibrated: removing the refusal branch, the revoke listener, or using the
join token instead of the poll token each turns exactly one named check red.
A check that cannot fail proves nothing; these can, and did.

## What they cannot prove

Everything native is a fake here — `livekit-client`, `@livekit/react-native`,
`PermissionsAndroid`. So these say nothing about whether:

- the consent sheet appears, or what Android does when it is refused
- audio actually routes to the speaker
- the camera flips (`restartTrack` is untested on hardware as of writing)
- the foreground-service notification appears
- a second participant sees the screen

Those are proven only on a phone, in a real meeting, with a second
participant. See `docs/onboarding/mobile/WELCOME.md` §5.
