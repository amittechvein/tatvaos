# The recording notice clip

**Status: IN PLACE since 17 September 2026 — a real voice, recorded by Amit.**

It replaced, the same evening and before it ever merged, an ElevenLabs-generated
clip (its C2PA manifest said so). The generated clip was set aside for exactly
the reason below: a synthesiser reading a consent notice.

What landed, measured with ffmpeg 9.0.1 (gyan.dev essentials build, SHA-256
checked against the published sum) rather than taken on trust:

| | asked for | the file |
|---|---|---|
| words | "This meeting is being recorded." | Amit's WhatsApp voice note, supplied for this sentence |
| length | under 2 s, ~100 ms at each end | 1.78 s — cut at 0.70–2.45 s of the original, whose speech ran 0.80–2.35 s (silencedetect −40 dB); a tap at 0.28 s is outside the cut |
| loudness | about −16 LUFS | −16.1 LUFS integrated (ebur128) |
| peak | no higher than −3 dBFS | −3.5 dBFS (alimiter at 0.70 after +6.5 dB) |
| channels / rate | mono, 44.1 kHz | mono, 44.1 kHz |
| bitrate / size | 96 kbps, under 30 kB | 96 kbps, 21,316 bytes, no ID3 tag, metadata stripped |

The command, so the next version can be made the same way:

    ffmpeg -ss 0.70 -to 2.45 -i <voice-note>.ogg -map_metadata -1 \
      -af "aresample=44100,volume=6.5dB,alimiter=limit=0.70:attack=1:release=40:level=disabled,afade=t=in:d=0.02,areverse,afade=t=in:d=0.03,areverse" \
      -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -id3v2_version 0 -write_xing 0 connect-recording-notice.mp3

Still to do by ear, not by meter: listen inside a live meeting, over speech,
on a phone speaker.

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
