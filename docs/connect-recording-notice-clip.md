# The recording notice clip

**Status: IN PLACE since 17 September 2026 — a generated voice, by Amit's
decision, not the recorded human voice this page asks for below.**

What landed, measured from the file itself rather than taken on trust:

| | asked for | the file |
|---|---|---|
| words | "This meeting is being recorded." | as supplied by Amit, file named for that sentence |
| voice | a person, not a synthesiser | **ElevenLabs**: its embedded C2PA manifest names Eleven Labs Inc. with digitalSourceType `trainedAlgorithmicMedia` |
| length | under 2 s | 2.09 s (80 MPEG-1 Layer III frames) |
| channels / rate | mono, 44.1 kHz | mono, 44.1 kHz |
| bitrate / size | 96 kbps, under 30 kB | 128 kbps, 50,084 bytes, of which 16,648 are the ID3 tag carrying the C2PA manifest |
| loudness | about −16 LUFS, peak ≤ −3 dBFS | **not measured**: no decoder on the laptop it was added from |

Left as supplied, deliberately. Trimming and re-encoding needs ffmpeg, which is
not installed and needs Amit's go to download. And stripping the tag would
also strip the content credentials that say this voice is generated; that is
not a thing to remove quietly to save 16 kB.

Two things for whoever touches this next: listen to it inside a live meeting
to check its loudness against speech, and check that TatvaOS's ElevenLabs plan
allows commercial use of the output (Amit's to confirm). The section below is
still the brief for a human recording if that decision changes.

**Original status (until 17 Sept): not recorded.** This is a five-minute job for
a person with a phone, and it had been outstanding since the recording feature
shipped.

## What is missing

`apps/web/public/connect-recording-notice.mp3`

Connect plays it once, on each client, at the moment that client learns the
meeting is being recorded — whether the host pressed Record just now or the
person has just joined a meeting that was already recording.

## Why it is not a nice-to-have

The written banner is the channel that must work, and it does: it is
non-dismissible, it is `role="status"` so a screen reader announces it, and it
does not depend on any of this. The spoken sentence is the second channel, and
it exists for the people the written one reaches last — somebody who joined on
a phone in their pocket, somebody looking at a shared document rather than the
meeting, somebody who cannot see the screen at all.

`CONNECT_DECISIONS.md` §2 called for it. Nobody recorded it. The code asked for
the file, the file 404'd, and the failure was caught by a `catch` that could not
tell a missing file from a browser refusing autoplay — so for the whole life of
the feature the spoken notice was absent and every reading of the code said it
was fine.

Since 26 August the code falls back to the browser's own speech synthesis and
writes a console warning naming this file. That is a floor, not a fix: the
synthesised voice varies by operating system and is missing entirely on some
Android builds, which is exactly why a static clip was chosen in the first
place.

## What to record

**The words, exactly:**

> This meeting is being recorded.

Nothing before it, nothing after it. Not "please be aware that", not the
product name. It is a statement of fact that has to survive being half-heard.

**How to say it:** evenly, at a normal speaking pace, in a normal room. It is a
notice, not an announcement — no warmth to sell it and no gravity to dramatise
it. A neutral Indian English accent matches the customer base; the voice does
not need to match anybody at TatvaOS, because it is the product speaking.

**Format:**

| | |
|---|---|
| file | `apps/web/public/connect-recording-notice.mp3` |
| length | under 2 seconds of speech; trim the silence at both ends to about 100 ms |
| loudness | around −16 LUFS, peaking no higher than −3 dBFS |
| channels | mono |
| sample rate | 44.1 kHz |
| bitrate | 96 kbps is plenty for one spoken sentence — keep the file under 30 kB |

Mono and small on purpose: it plays on top of a live meeting on connections
that are already carrying video, and it is fetched at the worst possible
moment, which is the moment recording starts.

**A voice, not a synthesiser.** A phone voice memo in a quiet room, trimmed,
beats every text-to-speech engine available here — a robot reading a consent
notice sounds like a machine covering itself, which is the opposite of the
effect wanted.

## Checking it landed

Join a meeting in two browsers, start recording in one, and listen in the
other. If the console shows

    [connect] recording notice clip missing — falling back to speech synthesis.

then the file is not being served: check it is in `apps/web/public/` (not
`app/`), and that the name matches exactly, lowercase, with hyphens.
