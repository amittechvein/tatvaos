'use client';

import { useEffect, useRef } from 'react';

/**
 * Declared here rather than imported: lib/auth.tsx does not export this type,
 * and lib/connect.ts declares its own copy for the same reason. Following the
 * house pattern rather than "improving" it in a file nobody asked me to touch.
 */
type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Turn this browser's own speech into a free transcript.
 *
 * ---------------------------------------------------------------------------
 *  WHY THIS EXISTS, IN ONE SUM
 *
 *  Measured on a real 31-minute meeting on 22 August 2026: paid transcription
 *  cost Rs 16.6 and the model that writes the actual minutes cost Rs 0.40.
 *  Turning speech into text was 97% of the bill — and the browser will do that
 *  part for nothing, live, while the meeting is happening.
 *
 *  At roughly 300 meetings a month that is about Rs 7,200 becoming Rs 90.
 *
 * ---------------------------------------------------------------------------
 *  WHAT THE HOST MUST BE TOLD, AND THEREFORE THE ROOM
 *
 *  Chrome's speech recognition SENDS THE AUDIO TO GOOGLE. This does not remove
 *  a third party from the meeting; it changes which one, from a provider under
 *  contract to one that is not. Connect's UI has to say that where captions
 *  are switched on. A school or a hospital asking where its meeting goes is
 *  owed a straight answer, and "it is captions, not recording" is not one.
 *
 *  It is also PARTIAL BY CONSTRUCTION, in a way a recording is not:
 *
 *    - Chrome and Edge only. Firefox has no support at all, and a participant
 *      using it contributes nothing — their half of the conversation is simply
 *      not in the record.
 *    - Each browser hears only ITS OWN microphone, so somebody who leaves
 *      early takes their share of the transcript with them.
 *    - Signed-in participants only, for now. A guest's token expires every ten
 *      minutes, so guest captions need a signed ticket that does not exist yet.
 *
 *  The compensation is real: because each browser reports its own speech, the
 *  minutes get WHO SAID WHAT, which transcribing a mixed room recording does
 *  not give us at all. That is the difference between "somebody will send the
 *  pricing sheet" and "Rahul will send the pricing sheet".
 *
 * ---------------------------------------------------------------------------
 *  HOW TO WIRE IT IN — one line, inside the room, for a signed-in participant:
 *
 *      useCaptions({ meetingId, enabled: captionsOn, authedFetch });
 *
 *  It does nothing at all when `enabled` is false or the browser has no
 *  support, so there is no branch to write at the call site.
 */

/** The browser's own type for this is not in the DOM lib, so: the parts used. */
interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Is there any point offering the switch in this browser? */
export function captionsSupported(): boolean {
  return recognitionConstructor() !== null;
}

interface Line { text: string; at: string }

export interface UseCaptionsOptions {
  meetingId: string;
  enabled: boolean;
  authedFetch: AuthedFetch;
  /**
   * BCP-47 code. 'en-IN' rather than 'hi-IN' by default, and that is a
   * considered choice for this platform: Indian English recognition copes with
   * a Hindi word dropped into an English sentence far better than Hindi
   * recognition copes with an English one, and TatvaOS meetings are mostly the
   * former. It is a setting because that generalisation will be wrong for
   * somebody, and they should be able to say so rather than file a bug.
   */
  lang?: string;
}

/**
 * How long lines are held before being posted. Long enough that a talkative
 * meeting is a few requests a minute rather than one per sentence; short
 * enough that closing the tab loses at most this much speech.
 */
const FLUSH_MS = 5000;

export function useCaptions({
  meetingId, enabled, authedFetch, lang = 'en-IN',
}: UseCaptionsOptions): void {
  // Refs rather than state throughout: none of this should re-render the
  // room, and a caption arriving must never interrupt a video tile.
  const pending = useRef<Line[]>([]);
  const stopped = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const Recognition = recognitionConstructor();
    if (!Recognition) return;      // Firefox, older Safari. Nothing to do.

    stopped.current = false;
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = true;
    // Interim results are what make captions feel live on screen. They are
    // NOT collected here: an interim result is a guess that the next one
    // replaces, and posting them would put every half-heard sentence into the
    // minutes alongside its correction.
    recognition.interimResults = false;

    const flush = async () => {
      if (pending.current.length === 0) return;
      const lines = pending.current;
      pending.current = [];

      try {
        await authedFetch(`/connect/meetings/${meetingId}/captions`, {
          method: 'POST',
          body: JSON.stringify({ lines }),
        });
      } catch {
        // Deliberately swallowed, and deliberately NOT retried by putting the
        // lines back. A meeting must not be disturbed by a caption failing to
        // send, and a queue that grows while the network is down is how a tab
        // ends up holding an hour of speech it will never deliver. Losing a
        // few lines of an already-partial transcript is the cheaper failure.
      }
    };

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        // Indexed access is checked in this project, and rightly: these
        // objects come from the browser, not from us.
        const result = event.results[i];
        if (!result?.isFinal) continue;
        const text = result[0]?.transcript?.trim();
        if (text) pending.current.push({ text, at: new Date().toISOString() });
      }
    };

    // Recognition stops on its own — a pause in speech, a network blip, a
    // browser deciding it has listened long enough. Restarting is the whole
    // job of keeping captions running for an hour, and without this the
    // transcript quietly ends a few minutes into every meeting.
    recognition.onend = () => {
      if (stopped.current) return;
      try { recognition.start(); } catch { /* already starting; harmless */ }
    };

    recognition.onerror = (event) => {
      // 'not-allowed' means the person declined the microphone prompt, and
      // retrying would just ask again forever.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopped.current = true;
      }
    };

    try { recognition.start(); } catch { /* a second start() is not fatal */ }

    const timer = setInterval(flush, FLUSH_MS);

    return () => {
      stopped.current = true;
      clearInterval(timer);
      try { recognition.stop(); } catch { /* already stopped */ }
      // One last send on the way out, so the end of the meeting — which is
      // where the decisions usually are — is not the part that gets lost.
      void flush();
    };
  }, [enabled, meetingId, authedFetch, lang]);
}
