'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ExternalE2EEKeyProvider,
  Room, RoomEvent, Track, DisconnectReason, ConnectionQuality,
  type Participant as LKParticipant,
  type RemoteParticipant,
} from 'livekit-client';
import { useAuth } from '@/lib/auth';
import {
  connectApi, minutesApi, recordingApi, screenCaptureSupported,
  type LobbyEntry, type Meeting, type Recording, type RecordingMode, type Seat,
  type SharePolicy, type WaitingRoom,
} from '@/lib/connect';
import type { JoinPrefs } from './PreJoin';
import {
  bestColumns, documentPipSupported, onAutoPip, openPipWindow, pipSupported,
  videoPipSupported,
  type PipHandles, type PipTile,
} from '@/lib/pip';
import { CSS, Centre, Spinner, initialOf } from './RoomChrome';

const LOBBY_POLL_MS = 3000;

// ---------------------------------------------------------------------------
//  The People panel's row actions, drawn rather than borrowed.
//
//  Two reasons they are SVG and not icon-font glyphs. The first is that this
//  room has already shipped a blank button once, because a name that looked
//  obvious (ri-vidicon-off-line) does not exist in the version we ship — and
//  a missing glyph is an empty square, not an error. The second is that the
//  struck-through pair have to work on a coloured button in thirteen themes,
//  and a font cannot cut a gap around its own diagonal.
//
//  The gap is a mask: the shape is painted through everything except a thick
//  diagonal, then the thin diagonal goes on top in currentColor. Laid on top
//  without the gap, the stroke vanishes wherever the shape beneath it is
//  solid — which on the camera is most of its length.
// ---------------------------------------------------------------------------

const MIC_BODY = [
  'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z',
  'M6 10v1a6 6 0 0 0 12 0v-1h-2v1a4 4 0 0 1-8 0v-1H6z',
  'M11 18.4h2V21h-2z',
];
const CAM_BODY = [
  'M3 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  'M17.4 10.6 22 8v8l-4.6-2.6z',
];
const SCREEN_BODY = [
  'M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  'M8 18h8v2H8z',
];
const STAR_BODY = ['m12 3 2.6 5.5 6 .9-4.3 4.2 1 6-5.3-2.8L6.7 19.6l1-6L3.4 9.4l6-.9z'];
const CROSS_BODY = [
  'M5.3 3.9 3.9 5.3 10.6 12l-6.7 6.7 1.4 1.4L12 13.4l6.7 6.7 1.4-1.4-6.7-6.7 6.7-6.7-1.4-1.4L12 10.6z',
];

// The struck-through pair are STATES, not actions. Drawing the action meant a
// muted person and an unmuted one had the identical struck microphone beside
// them, in a list whose whole job is telling you who is making noise. The icon
// now says what IS, and the button is disabled once there is nothing left to
// do — you cannot unmute somebody else's microphone from here, and a button
// that looks live but refuses is worse than one that admits it.
type ActKind = 'mic' | 'micOff' | 'cam' | 'camOff' | 'screen' | 'star' | 'remove';

const ACT_PATHS: Record<ActKind, { d: readonly string[]; slash: boolean }> = {
  mic: { d: MIC_BODY, slash: false },
  micOff: { d: MIC_BODY, slash: true },
  cam: { d: CAM_BODY, slash: false },
  camOff: { d: CAM_BODY, slash: true },
  screen: { d: SCREEN_BODY, slash: true },
  star: { d: STAR_BODY, slash: false },
  remove: { d: CROSS_BODY, slash: false },
};

function ActIcon({ kind }: { kind: ActKind }) {
  const id = useId();
  const icon = ACT_PATHS[kind]!;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {icon.slash && (
        <defs>
          <mask id={id}>
            <rect width="24" height="24" fill="#fff" />
            <path d="M3 3 21 21" className="cx-cut" />
          </mask>
        </defs>
      )}
      <g mask={icon.slash ? `url(#${id})` : undefined}>
        {icon.d.map((d) => <path key={d} d={d} />)}
      </g>
      {icon.slash && <path d="M3 3 21 21" className="cx-line" />}
    </svg>
  );
}

/**
 * Keep a box's measured size in state, swapping the observer when the element
 * behind a ref changes.
 *
 * Module level so the ref callbacks that use it can stay inline arrows — the
 * hooks lint wants to see the function it is given, and a factory returning a
 * callback defeats that for no gain.
 */
function watchBox(
  obs: React.MutableRefObject<ResizeObserver | null>,
  el: HTMLElement | null,
  set: React.Dispatch<React.SetStateAction<{ w: number; h: number }>>,
): void {
  obs.current?.disconnect();
  obs.current = null;
  if (el === null || typeof ResizeObserver === 'undefined') return;

  const ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    // Sub-pixel churn is ignored: a ResizeObserver that sets state on every
    // fractional change can loop against the layout it just caused.
    set((was) => (
      Math.abs(was.w - box.width) < 1 && Math.abs(was.h - box.height) < 1
        ? was
        : { w: box.width, h: box.height }));
  });
  ro.observe(el);
  obs.current = ro;
}

// ---------------------------------------------------------------------------
//  The join/leave chime — burst suppression.
//
//  A tone per arrival is information in a meeting of six and a carillon in a
//  class of forty arriving at once. When more than CHIME_BURST_MAX tones have
//  played inside CHIME_BURST_WINDOW_MS, further ones are SUPPRESSED until the
//  window drains — the first few arrivals are announced, the stampede is not.
//
//  BOTH NUMBERS ARE PROVISIONAL, AND SAYING SO IS A REVIEW CONDITION: "measure
//  the threshold in a real meeting and tell me the number rather than defend a
//  guess." The console.info in chime() below is the measuring instrument — it
//  prints how many tones a real meeting's start actually produced, so the
//  numbers here can be replaced by observed ones, not defended.
// ---------------------------------------------------------------------------
const CHIME_BURST_WINDOW_MS = 10_000;
const CHIME_BURST_MAX = 4;

// ===========================================================================
//  The live meeting
// ===========================================================================
interface ChatFile { name: string; size: number; url: string }
interface ChatLine {
  id: number; who: string; text: string; mine: boolean;
  /** Present when this line IS a file rather than a message. */
  file?: ChatFile;
}

/** Bytes, in the words people use. */
function prettySize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
type PanelKind = 'people' | 'chat' | 'devices' | 'view' | null;

// ---------------------------------------------------------------------------
//  HOW THIS ROOM IS ARRANGED — the person's choice, remembered.
//
//  Where the controls sit, how the tiles are laid out, how many of them, and
//  three personal preferences. All of it is LOCAL: it changes what this
//  browser draws and is never sent anywhere, so one person choosing Spotlight
//  cannot decide what anybody else looks at.
//
//  Kept in localStorage rather than on the account on purpose. These are
//  answers to "what does this screen suit", and the same person is on a
//  laptop in the morning and a phone in the evening — a preference that
//  followed them between the two would be wrong half the time.
// ---------------------------------------------------------------------------
type BarPos = 'bottom' | 'left' | 'top';
type Layout = 'auto' | 'grid' | 'spotlight' | 'sidebar';

type Theme =
  | 'midnight' | 'graphite' | 'ocean' | 'plum' | 'forest'
  | 'aurora' | 'ember' | 'nebula' | 'lagoon' | 'indigo'
  | 'mist' | 'paper' | 'sky';

/** Which themes need dark text. Kept beside the list so adding a pale one
 *  and forgetting the class is a single, obvious omission rather than a
 *  scattering of overrides. */
const LIGHT_THEMES: ReadonlySet<string> = new Set(['mist', 'paper', 'sky']);

/** Swatch, label — the preview IS the label, so no words are needed in the
 *  row itself; the name is on hover and read aloud by a screen reader. */
const THEMES: [Theme, string, string][] = [
  ['midnight', 'Midnight', '#0a0a0e'],
  ['graphite', 'Graphite', '#14161a'],
  ['ocean', 'Ocean', '#07131f'],
  ['plum', 'Plum', '#150d1b'],
  ['forest', 'Forest', '#0a1712'],
  ['aurora', 'Aurora', 'linear-gradient(150deg,#0b1026,#241a52 52%,#0d3b52)'],
  ['ember', 'Ember', 'linear-gradient(150deg,#1b0b09,#3a1408 55%,#4a2410)'],
  ['nebula', 'Nebula', 'linear-gradient(150deg,#12071f,#3a1150 50%,#5c1450)'],
  ['lagoon', 'Lagoon', 'linear-gradient(150deg,#04201f,#075450 55%,#0a6f5c)'],
  ['indigo', 'Indigo', 'linear-gradient(150deg,#0e1046,#241a8c 55%,#3d1e9e)'],
  ['mist', 'Mist (light)', '#eef1f6'],
  ['paper', 'Paper (light)', 'linear-gradient(160deg,#fdfaf3,#f4ece0)'],
  ['sky', 'Sky (light)', 'linear-gradient(160deg,#eaf4ff,#d7e9fd 55%,#e9dcff)'],
];

interface RoomPrefs {
  bar: BarPos;
  theme: Theme;
  layout: Layout;
  /** Most faces drawn at once. A class of forty in forty tiles helps nobody. */
  maxTiles: number;
  hideNoCam: boolean;
  mirror: boolean;
  hideSelf: boolean;
}

const PREFS_KEY = 'tatvaos.connect.room-prefs';
/** The byte-stream topic files travel on, and the ceiling for one of them. */
const FILE_TOPIC = 'connect-file';
const FILE_MAX = 8 * 1024 * 1024;
const DEFAULT_PREFS: RoomPrefs = {
  // The rail is the default because Amit asked for it, and because it is the
  // arrangement that gives a shared screen the most height — the thing this
  // room has been short of all week. Anybody who wants the familiar bar
  // moves it back in one click and is never asked again.
  bar: 'left', theme: 'midnight', layout: 'auto', maxTiles: 12,
  hideNoCam: false, mirror: true, hideSelf: false,
};

/** What a reaction looks like while it floats. Emoji, not images: nothing to
 *  download, nothing to host, and they render on every device we support. */
const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '😮', '🙏', '💯'] as const;

function loadPrefs(): RoomPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const saved = JSON.parse(raw) as Partial<RoomPrefs>;
    // Spread over the defaults rather than trusting the stored shape: this
    // value outlives the code that wrote it, so a version saved before a new
    // field existed must not arrive as undefined and break a layout.
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    // Private windows and blocked storage both throw. A preference is not
    // worth a broken meeting.
    return DEFAULT_PREFS;
  }
}

export default function Stage({ seat, meeting, prefs }: {
  seat: Seat; meeting: Meeting | null; prefs?: JoinPrefs;
}) {
  const { authedFetch } = useAuth();
  const roomRef = useRef<Room | null>(null);
  // What the person decided on the pre-join screen. A ref because it is fixed
  // for the life of this mount and must not churn the connect effect's deps.
  const prefsRef = useRef<JoinPrefs | undefined>(prefs);

  const [room, setRoom] = useState<Room | null>(null);
  // livekit-client mutates its Room in place; React cannot see that. Every SDK
  // event bumps this, which is the only thing that makes the room's current
  // state reach the screen. The value itself is never read.
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [connState, setConnState] = useState<'connecting' | 'live' | 'reconnecting' | 'over'>('connecting');
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Read once on mount, not at module load: localStorage does not exist while
  // Next renders this on the server, and reading it in the initialiser keeps
  // the first paint correct instead of flashing the default layout.
  // roomPrefs, NOT prefs: this component already takes a `prefs` PROP — the
  // camera and microphone choices made on the pre-join screen. Naming this
  // state `prefs` shadowed it and the build stopped dead with "Identifier
  // 'prefs' has already been declared". Two different meanings of a very
  // ordinary word, one scope apart.
  const [roomPrefs, setRoomPrefs] = useState<RoomPrefs>(DEFAULT_PREFS);
  useEffect(() => { setRoomPrefs(loadPrefs()); }, []);
  const setRoomPref = useCallback(<K extends keyof RoomPrefs>(k: K, v: RoomPrefs[K]) => {
    setRoomPrefs((old) => {
      const next = { ...old, [k]: v };
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* fine */ }
      return next;
    });
  }, []);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  // Feature 42. The Settings panel had camera and microphone and stopped
  // there, which looks finished and is not: anybody on a headset needs to
  // choose where the sound COMES OUT, and hits this on day one.
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  // Feature 62. Rides the existing data channel; no backend, no schema.
  // Keyed by identity because that is what survives a rejoin.
  const [hands, setHands] = useState<Record<string, boolean>>({});
  const [myHand, setMyHand] = useState(false);
  // Feature 64. Pointless with four people and the only usable way through a
  // class of forty, which is the room this product is actually for.
  const [find, setFind] = useState('');
  // Which tile this person wants kept large — a screen key (`screen-<id>`) or
  // a participant identity. Local to this browser and pushed to nobody: one
  // person pinning the whiteboard must not decide what everyone else looks
  // at. Cleared by clicking Unpin, never by somebody else's actions.
  const [pinned, setPinned] = useState<string | null>(null);
  // Reactions in flight. Each carries its own id so React can key them and
  // its own left-offset so two at once do not overlap perfectly. They are
  // removed by a timer, never by anything the sender does.
  const [reacts, setReacts] = useState<{ id: number; emoji: string; who: string; x: number }[]>([]);
  const reactSeq = useRef(0);
  const [picker, setPicker] = useState(false);
  const [more, setMore] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [knocking, setKnocking] = useState<LobbyEntry[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [why, setWhy] = useState<DisconnectReason | undefined>(undefined);

  // ---- Host leave, roles and the share policy --------------------------
  //
  // `leaveAsk` is the dialog: a HOST clicking Leave has to decide what their
  // leaving means, and until they have, they have not left.
  //
  // `roles` is OUR database's answer (connectApi.participants), fetched when
  // the People panel opens. LiveKit knows who is connected; it has no idea
  // who is a cohost, and the metadata on its participants is not trusted for
  // anything — the same rule the server enforces.
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [handover, setHandover] = useState('');
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [sharePolicy, setSharePolicy] = useState<SharePolicy>(
    meeting?.sharePolicy ?? 'everyone');
  // The waiting-room setting, LIVE — state rather than the prop, because the
  // host can now change it from inside the room and the lobby poll below has
  // to follow the change, not the value at join.
  const [waitingRoom, setWaitingRoom] = useState<WaitingRoom>(
    meeting?.waitingRoom ?? 'guests');

  // ---- The join/leave chime --------------------------------------------
  //
  // Entirely client-side: an oscillator, not an asset — nothing to download,
  // nothing to cache, nothing that 404s. Everyone hears it, guests included,
  // because "did somebody just join?" is a question everybody in a meeting
  // has. The toggle lives in Settings; a ref mirrors it because the room's
  // event handlers are registered once and would otherwise close over the
  // first render's value for the life of the meeting (same rule as pipRef).
  const [chimeOn, setChimeOn] = useState(true);
  const chimeOnRef = useRef(true);
  useEffect(() => { chimeOnRef.current = chimeOn; }, [chimeOn]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // TWO SEPARATE BUDGETS, DELIBERATELY. A join or a leave is ambient — it
  // tells you what happened. A KNOCK asks the host to make a decision, and
  // nothing happens until they do. Sharing one budget would let four people
  // arriving silence the single event that actually needs somebody to act.
  const chimeTimesRef = useRef<{ ambient: number[]; knock: number[] }>({ ambient: [], knock: [] });
  const chimeSuppressedRef = useRef<{ ambient: number; knock: number }>({ ambient: 0, knock: 0 });

  const chime = useCallback((kind: 'join' | 'leave' | 'knock' | 'chat' | 'hand' | 'react' | 'rec') => {
    if (!chimeOnRef.current) return;

    // Burst suppression — see the constants at the top of the file.
    // Everything that is not a knock shares the ambient budget, which is what
    // stops a burst of reactions from turning the meeting into a fairground.
    const bucket: 'ambient' | 'knock' = kind === 'knock' ? 'knock' : 'ambient';
    const now = Date.now();
    const recent = chimeTimesRef.current[bucket].filter((t) => now - t < CHIME_BURST_WINDOW_MS);
    if (recent.length >= CHIME_BURST_MAX) {
      chimeSuppressedRef.current[bucket] += 1;
      chimeTimesRef.current[bucket] = recent;
      // The measuring instrument for the review condition: after a real
      // meeting, this line says what the burst actually was.
      console.info(`[chime] suppressed a ${kind} tone — ${recent.length} played and `
        + `${chimeSuppressedRef.current[bucket]} suppressed within ${CHIME_BURST_WINDOW_MS / 1000}s`);
      return;
    }
    if (chimeSuppressedRef.current[bucket] > 0) {
      console.info(`[chime] burst over (${bucket}) — `
        + `${chimeSuppressedRef.current[bucket]} tones were suppressed`);
      chimeSuppressedRef.current[bucket] = 0;
    }
    recent.push(now);
    chimeTimesRef.current[bucket] = recent;

    // A missing tone is nothing; a thrown one would take the handler with it.
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      // The context can be born suspended under autoplay policy; resume is a
      // no-op when it is already running and best-effort when it is not.
      if (ctx.state === 'suspended') void ctx.resume();

      // Two soft sine notes, and the SHAPE is what tells them apart without
      // looking — which is the entire point of a chime:
      //   join   rising    — somebody is here
      //   leave  falling   — somebody is gone
      //   knock  twice on the SAME note, spaced a little wider — the sound a
      //          knock makes. Not a third melody to learn: a person who has
      //          never been told what it means still reads "someone is at the
      //          door", and it cannot be confused with an arrival, which is
      //          the confusion that would matter.
      //   join   rising     — somebody is here
      //   leave  falling    — somebody is gone
      //   knock  two taps   — somebody is at the door, and needs a decision
      //   chat   one blip   — a message arrived
      //   hand   rising 5th — a hand went up; higher, because it asks for you
      //   react  light trill — a gesture, the least important thing here
      //   rec    low pair   — recording started; the only sombre one
      const notes = kind === 'join' ? [659.25, 880]
        : kind === 'leave' ? [880, 659.25]
        : kind === 'knock' ? [587.33, 587.33]
        : kind === 'chat' ? [783.99]
        : kind === 'hand' ? [659.25, 987.77]
        : kind === 'react' ? [1046.5, 1318.5]
        : [329.63, 261.63];
      const gap = kind === 'knock' ? 0.16 : kind === 'react' ? 0.07 : 0.11;
      const at = ctx.currentTime;
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = at + i * gap;
        // Quiet on purpose (peak 0.06): a notification, not a doorbell — it
        // sits under speech rather than over it.
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.22);
      });
    } catch { /* no AudioContext, no chime — the meeting is unaffected */ }
  }, []);

  // The AudioContext outlives the room (it is lazily made and survives a
  // reconnect), so it is closed on unmount, not in the connect effect.
  useEffect(() => () => { void audioCtxRef.current?.close(); }, []);

  // Shown to everybody, INCLUDING the person who sent it — a gesture you
  // cannot see yourself having made feels broken, and the round trip through
  // LiveKit would be the wrong thing to wait on for something this trivial.
  const showReact = useCallback((emoji: string, who: string) => {
    const id = reactSeq.current++;
    setReacts((r) => [...r, { id, emoji, who, x: 8 + Math.floor(Math.random() * 78) }]);
    chime('react');
    // Matches the CSS animation. If the two ever drift, the element is
    // removed while still visible, which reads as a flicker.
    window.setTimeout(() => setReacts((r) => r.filter((x) => x.id !== id)), 3400);
  }, [chime]);


  // ---- Full screen -----------------------------------------------------
  //
  // Whether we are in it is read from the DOCUMENT rather than tracked here,
  // because Esc and the browser's own controls leave full screen without
  // going through our button — and a boolean we set on click alone would be
  // wrong the moment somebody presses Esc.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const [canFull, setCanFull] = useState(false);

  // ---- Picture-in-Picture ----------------------------------------------
  //
  // The handles live in a REF rather than state because the mediaSession
  // handler Chrome calls is registered once and would otherwise close over
  // the first render's value for the life of the meeting.
  const pipRef = useRef<PipHandles | null>(null);
  const [pipOpen, setPipOpen] = useState(false);
  const [canPip, setCanPip] = useState(false);

  // ---- Recording -------------------------------------------------------
  //
  // TWO SEPARATE PIECES OF STATE, AND THE DIFFERENCE MATTERS.
  //
  // `beingRecorded` is LiveKit's own room flag. It is what EVERY participant,
  // guest included, is told — and it arrives on the same signalling channel as
  // the media, so a client cannot decline to be told. That is what drives the
  // notice on screen.
  //
  // `recording` is OUR row, and only a host has one. It exists because
  // stopping needs an id, and the id is ours, not LiveKit's room flag.
  //
  // Driving the notice from our row instead would mean a guest — who never
  // calls that endpoint — sat in a recorded meeting with nothing on screen.
  const [beingRecorded, setBeingRecorded] = useState(false);

  // ---- The SPOKEN notice (docs/CONNECT_DECISIONS.md §2) ----------------
  //
  // "This meeting is being recorded." — heard as well as read, exactly once
  // per activation, LOCALLY: it plays on this client only, so it is not in
  // the recording, does not interrupt whoever is talking, and does not fire
  // eleven times for the eleven people already there. The trigger is
  // "recording became active FOR ME" — joining an already-recorded meeting
  // and the host pressing Record twenty minutes in both count, which is why
  // this watches the flag's transition rather than the join.
  //
  // A static clip, not the Web Speech API: browser voices vary by OS and are
  // absent on some Android builds, and the one sentence that has to be heard
  // must not depend on that. Autoplay is allowed here because clicking Join
  // was a user activation and the page holds a microphone permission — but a
  // refusal (or a missing clip) is swallowed: the WRITTEN notice below is
  // non-dismissible and role="status", and the audio is the second channel,
  // never the only one.
  const spokenRef = useRef(false);
  useEffect(() => {
    if (!beingRecorded) { spokenRef.current = false; return; }
    if (spokenRef.current) return;
    spokenRef.current = true;
    try {
      const clip = new Audio('/connect-recording-notice.mp3');
      void clip.play().catch(() => { /* blocked or clip absent; the banner stands */ });
    } catch { /* no Audio in this environment; the banner stands */ }
  }, [beingRecorded]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [recOff, setRecOff] = useState(false);   // no egress on this server
  // The audio-or-video question, asked once per recording rather than assumed.
  const [recordAsk, setRecordAsk] = useState(false);

  const isHost = meeting?.myRole === 'host' || meeting?.myRole === 'cohost';

  // A guest has no meeting row, so the seat carries the mode for them. Both
  // come from the same database column, so they cannot disagree.
  const isPrivate = (meeting?.mode ?? seat.mode) === 'private';

  // The SDK handlers are registered once, so they close over the FIRST render's
  // state. `panel` read directly inside one would be permanently null. A ref
  // updated every render is the standard way out.
  const panelRef = useRef<PanelKind>(null);
  panelRef.current = panel;

  // Same reason as panelRef: the DataReceived handler below is registered once
  // and closes over the FIRST render. It needs the meeting to know where to
  // store a chat line, and the meeting arrives as a prop that can change.
  const meetingRef = useRef<Meeting | null>(meeting);
  meetingRef.current = meeting;
  const fetchRef = useRef(authedFetch);
  fetchRef.current = authedFetch;

  // ---------------------------------------------------------------------
  useEffect(() => {
    const chosen = prefsRef.current;

    // ── ENCRYPTION, FOR A PRIVATE MEETING ONLY. ────────────────────────
    //
    // The key came down with the seat and exists nowhere else: not in
    // storage, not in the URL, not in a log. It dies with this tab.
    //
    // Everything about the setup is deliberately DONE BEFORE connect(), and
    // a failure below aborts the join rather than continuing. See the catch
    // in the async block further down for why that is not negotiable.
    //
    // The worker is constructed with `new Worker(new URL(...))` because that
    // is the form the bundler understands statically; a path assembled at
    // runtime would not be emitted into the bundle at all. The specifier is
    // a BARE package name, which is LiveKit's documented form.
    //
    // NO `{ type: 'module' }`, and that is a finding rather than an omission.
    // It was written that way first; webpack compiled the worker to a CLASSIC
    // one anyway and emitted `type: undefined` into the bundle, because the
    // chunk it produces uses importScripts, which module workers do not have.
    // Verified in the build output: the emitted call is
    //     new Worker(n.tu(new URL(n.p + n.u(3347), n.b)), { type: void 0 })
    // and chunk 3347 is a worker bootstrap that importScripts the rest. So
    // declaring 'module' here would have been a claim the output contradicts —
    // and classic is the better answer anyway on the older Android browsers
    // our guests actually carry.
    //
    // STILL UNVERIFIED WITHOUT A BROWSER: that the chunk URL resolves at
    // runtime behind our public path, and that the media genuinely decodes.
    // A green build proves the worker was bundled, not that it runs.
    const wantsE2ee = typeof seat.roomKey === 'string' && seat.roomKey.length > 0;
    let keyProvider: ExternalE2EEKeyProvider | null = null;
    let e2eeWorker: Worker | null = null;
    if (wantsE2ee) {
      keyProvider = new ExternalE2EEKeyProvider();
      e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url));
    }

    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      // The devices picked on the pre-join screen. Set as capture defaults
      // rather than switched after connect, so the FIRST frame anybody sees is
      // already from the right camera.
      audioCaptureDefaults: chosen?.micId ? { deviceId: chosen.micId } : undefined,
      videoCaptureDefaults: chosen?.camId ? { deviceId: chosen.camId } : undefined,
      e2ee: keyProvider && e2eeWorker
        ? { keyProvider, worker: e2eeWorker }
        : undefined,
    });
    roomRef.current = r;
    setRoom(r);

    // isRecording is read on Connected as well as on the event, because the
    // event only fires on a CHANGE. Somebody joining a meeting that was
    // already being recorded would otherwise never be told — which is the one
    // case where being told matters most.
    r.on(RoomEvent.Connected, () => {
      setConnState('live'); setBeingRecorded(r.isRecording); rerender();
    })
      // The REASON is kept, not just the fact. Telling somebody the host
      // removed them "you have left the meeting" is a lie they will argue with.
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        setWhy(reason); setConnState('over'); rerender();
      })
      // Reconnecting is NOT an error. Dropping wifi in a lift is ordinary; the
      // SDK re-establishes and the meeting continues. Saying "the meeting
      // ended" here makes people rejoin a call they never left.
      .on(RoomEvent.Reconnecting, () => { setConnState('reconnecting'); rerender(); })
      .on(RoomEvent.Reconnected, () => { setConnState('live'); rerender(); })
      // The server tells everyone in the room, including guests. This is the
      // ONLY input to the notice on screen — see the state comment above.
      .on(RoomEvent.RecordingStatusChanged, (on: boolean) => {
        // Sound only when it STARTS. The notice on screen carries the fact;
        // this is for the person looking somewhere else at that moment.
        if (on) chime('rec');
        setBeingRecorded(on); rerender();
      })
      // The chime rides the same events the tiles do. Existing participants
      // do not fire ParticipantConnected at OUR join, so entering a full room
      // is silent — the chime announces changes, not the status quo.
      .on(RoomEvent.ParticipantConnected, () => { chime('join'); rerender(); })
      // Remove the tile by identity, or a black rectangle sits there looking
      // like a broken camera while everyone waits for somebody who has left.
      .on(RoomEvent.ParticipantDisconnected, () => { chime('leave'); rerender(); })
      .on(RoomEvent.TrackSubscribed, rerender)
      .on(RoomEvent.TrackUnsubscribed, rerender)
      .on(RoomEvent.TrackMuted, rerender)
      .on(RoomEvent.TrackUnmuted, rerender)
      // The host tightened (or loosened) who may share while people were
      // already in the room — the server pushes new permissions through
      // UpdateParticipant, and this is that change arriving.
      .on(RoomEvent.ParticipantPermissionsChanged, rerender)
      .on(RoomEvent.LocalTrackPublished, rerender)
      // A share can end WITHOUT the button: the browser's own "Stop sharing"
      // bar, or the server revoking the permission mid-share. The button must
      // follow the truth rather than its own last click.
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) setSharing(false);
        rerender();
      })
      .on(RoomEvent.ActiveSpeakersChanged, rerender)
      // Feature 49. LiveKit publishes this for every participant and nothing
      // was listening. It is what turns "the call is bad" into a support
      // ticket with data in it rather than an argument.
      .on(RoomEvent.ConnectionQualityChanged, rerender)
      // Somebody left with their hand up. Clearing it here rather than leaving
      // a raised hand for a person who is not in the room.
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        setHands((h) => { const { [participant.identity]: _gone, ...rest } = h; return rest; });
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
          if (typeof parsed !== 'object' || parsed === null) return;

          // Feature 62, on the same channel as chat. A separate key rather
          // than a magic chat message, so a hand can never be mistaken for
          // something somebody typed.
          if ('hand' in parsed) {
            const up = (parsed as { hand?: unknown }).hand === true;
            const who = participant?.identity;
            if (who) setHands((h) => ({ ...h, [who]: up }));
            // Only the raise makes a sound. A hand going DOWN is somebody
            // withdrawing a request; announcing that is noise.
            if (up) chime('hand');
            return;
          }

          if ('react' in parsed) {
            const emoji = String((parsed as { react?: unknown }).react ?? '');
            // Whitelisted, not echoed. This arrives from another browser, and
            // rendering whatever it sends would put arbitrary text on
            // everybody's screen at 34px.
            if ((REACTIONS as readonly string[]).includes(emoji)) {
              showReact(emoji, participant?.name ?? 'Someone');
            }
            return;
          }

          if (!('text' in parsed)) return;
          const text = String((parsed as { text?: unknown }).text ?? '');
          if (text.length === 0) return;

          // ── KEEPING A GUEST'S LINE FOR THE MINUTES. ───────────────────
          //
          // A guest has no session, so they cannot store their own line —
          // somebody signed in has to do it for them. Everybody doing it
          // would be N posts per line, which for a class of forty is absurd,
          // so exactly ONE client relays: the signed-in participant whose
          // identity sorts first. That is a pure function of who is in the
          // room, so every client agrees without anyone electing anything.
          //
          // The agreement does not have to be perfect. Someone joining or
          // leaving mid-message can briefly make two clients think they are
          // first, and the id below means the server keeps one row anyway.
          // Consensus would be the wrong amount of machinery for a problem
          // a unique index already solves.
          const from = participant?.identity;
          const cid = (parsed as { cid?: unknown }).cid;
          const at = (parsed as { at?: unknown }).at;
          const mine = meetingRef.current;
          if (typeof cid === 'string' && cid.length > 0
              && from?.startsWith('guest:') === true
              && mine && relayerOf(r) === r.localParticipant.identity) {
            void minutesApi.storeChat(fetchRef.current, mine.id, {
              clientId: cid,
              identity: from,
              body: text,
              sentAt: typeof at === 'string' ? at : new Date().toISOString(),
            });
          }

          setChat((c) => [...c, {
            id: c.length,
            who: participant?.name ?? participant?.identity ?? 'Someone',
            text,
            mine: false,
          }]);
          // Not unread if they are looking at it. Counting anyway leaves a
          // badge for messages already read the moment the panel closes.
          if (panelRef.current !== 'chat') { setUnread((n) => n + 1); chime('chat'); }
        } catch {
          // Chat is ephemeral and best-effort. A malformed frame from a client
          // we do not control is dropped, never thrown.
        }
      });

    // Incoming files. Registered before connect so a file sent the instant
    // somebody joins is not missed. The blob URL is revoked when the room is
    // torn down — see the cleanup below — because each one pins its bytes in
    // memory until it is.
    r.registerByteStreamHandler(FILE_TOPIC, (reader, participantInfo) => {
      void (async () => {
        try {
          const chunks = await reader.readAll();
          const name = reader.info.name ?? 'file';
          const blob = new Blob(chunks as BlobPart[],
            { type: reader.info.mimeType || 'application/octet-stream' });
          setChat((c) => [...c, {
            id: c.length,
            who: participantInfo.identity ?? 'Someone',
            mine: false,
            text: '',
            file: { name, size: blob.size, url: URL.createObjectURL(blob) },
          }]);
          if (panelRef.current !== 'chat') { setUnread((n) => n + 1); chime('chat'); }
        } catch {
          // A partial transfer is dropped rather than shown as a broken link.
        }
      })();
    });

    void (async () => {
      try {
        // ── THE KEY, THEN ENCRYPTION ON, THEN CONNECT. IN THAT ORDER. ──
        //
        // AND IF ANY OF IT FAILS, WE DO NOT JOIN.
        //
        // The tempting shape is a try/catch that logs and carries on, the way
        // the camera and microphone are handled twenty lines below — those are
        // survivable, because attending without a camera is still attending.
        // This one is not. A participant who joined a meeting labelled
        // Private with encryption silently off would be publishing plaintext
        // into a room everyone believes is encrypted, and NOBODY WOULD SEE IT
        // HAPPEN: the tiles would look normal to them and to everyone else.
        //
        // So the failure is loud and total. A meeting you cannot join is a
        // bad afternoon; a meeting that lied about being private is the whole
        // promise gone.
        if (keyProvider && wantsE2ee) {
          await keyProvider.setKey(seat.roomKey as string);
          await r.setE2EEEnabled(true);
        }

        await r.connect(seat.wsUrl, seat.token);
        // Mic and camera are attempted separately and each failure survivable:
        // joining audio-only because the camera is busy is a normal way to
        // attend a meeting. The pre-join screen's choices are honoured here —
        // somebody who said "camera off" joins with it off, not with a camera
        // that flashes on and then obeys.
        if (chosen?.mic !== false) {
          try { await r.localParticipant.setMicrophoneEnabled(true); setMicOn(true); }
          catch (e) { noteBlocked(e, setBlocked); }
        }
        if (chosen?.cam !== false) {
          try { await r.localParticipant.setCameraEnabled(true); setCamOn(true); }
          catch (e) { noteBlocked(e, setBlocked); }
        }
        rerender();
      } catch (e) {
        // Named separately when it was the encryption that failed, because
        // "could not connect" would send somebody to check their wifi.
        setError(wantsE2ee
          ? 'This private meeting could not be encrypted on this device, so it was '
            + 'not joined. Nothing was published. Try a recent Chrome, Edge or Safari.'
          : e instanceof Error ? e.message : 'Could not connect to the meeting.');
        setConnState('over');
      }
    })();

    return () => {
      void r.disconnect();
      roomRef.current = null;
      // Every received file holds its bytes alive through its blob URL until
      // this runs. A meeting where twenty files were passed around would
      // otherwise keep all twenty in memory for the life of the tab.
      setChat((c) => {
        c.forEach((line) => { if (line.file) URL.revokeObjectURL(line.file.url); });
        return c;
      });
      // The worker outlives the Room unless it is told otherwise, and a
      // leaked one per rejoin is a thread nobody is counting.
      e2eeWorker?.terminate();
    };
    // seat.roomKey belongs here with the other seat fields. It cannot change
    // without the token changing — both arrive in one response — so this adds
    // no re-runs; it is listed because a dependency the effect reads and the
    // array omits is a lie that stays true only by luck. chime is a stable
    // useCallback with no dependencies, listed for the same reason.
    // showReact is a stable useCallback (its own dependency is chime, which
    // has none), so listing it costs no re-connections — and omitting a
    // dependency the effect reads is a lie that stays true only by luck.
  }, [seat.wsUrl, seat.token, seat.roomKey, rerender, chime, showReact]);

  // Device labels are blank until permission exists, so a menu built too early
  // is a list of empty strings.
  useEffect(() => {
    if (!camOn && !micOn) return;
    void (async () => {
      try {
        setCams(await Room.getLocalDevices('videoinput'));
        setMics(await Room.getLocalDevices('audioinput'));
        // Its own try: Firefox does not implement audiooutput enumeration and
        // throws. One missing list must not empty the other two.
        try { setOuts(await Room.getLocalDevices('audiooutput')); } catch { setOuts([]); }
      } catch { /* enumeration can fail; the toggles still work */ }
    })();
  }, [camOn, micOn]);

  // ---------------------------------------------------------------------
  //  The door, from inside the room.
  //
  //  Hosts used to have to leave the meeting and open the meeting page to let
  //  somebody in — which nobody does mid-call, so guests waited until they
  //  gave up. Polled here only while it can matter: a host, in a live meeting,
  //  with a waiting room actually switched on.
  // ---------------------------------------------------------------------
  const lobbyLive = isHost && meeting !== null && waitingRoom !== 'off'
    && (connState === 'live' || connState === 'reconnecting');

  // Which knocks this host has already been told about. null means "not yet
  // primed" — see the first-poll rule inside the tick.
  const knownKnocksRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!lobbyLive || !meeting) {
      setKnocking([]);
      // Forget what was waiting, so that switching the waiting room back on
      // primes again rather than announcing a queue that formed while the
      // door was open.
      knownKnocksRef.current = null;
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await connectApi.lobby(authedFetch, meeting.id);
        if (!alive) return;
        setKnocking(r.waiting);

        // ── THE KNOCK TONE, AND WHY THE FIRST POLL IS SILENT. ───────────
        //
        // A knock is the one thing in this room that does not resolve
        // itself: nobody comes in until the host decides, and the card can
        // sit unseen behind a shared screen or a full-screen tile. So it
        // gets a sound of its own — the gap this feature had, found by a
        // host watching somebody wait.
        //
        // The first poll only LEARNS who is already waiting. A host opening
        // a meeting that has a queue would otherwise be met with one tone
        // per person already in it — announcing the status quo, exactly
        // what the join tone deliberately refuses to do.
        //
        // One tone per poll however many arrived in it: three people
        // knocking inside the same three seconds is one thing for the host
        // to deal with, not three.
        const seen = knownKnocksRef.current;
        const ids = new Set(r.waiting.map((k) => k.requestId));
        knownKnocksRef.current = ids;
        if (seen === null) return;
        if (r.waiting.some((k) => !seen.has(k.requestId))) chime('knock');
      } catch {
        // A failed poll is not worth a banner — the next is three seconds away,
        // and an error that clears itself teaches people to ignore errors.
        // It also leaves the known set alone, so a blip cannot re-announce
        // everybody who was already waiting.
      }
    };
    void tick();
    const t = setInterval(() => void tick(), LOBBY_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [lobbyLive, meeting, authedFetch, chime]);

  // Roles, from OUR rows, fetched when a host opens the People panel or the
  // leave dialog — the two places a role is about to be read or changed.
  const rolesLive = (panel === 'people' || leaveAsk) && isHost && meeting !== null;
  useEffect(() => {
    if (!rolesLive || !meeting) return;
    let alive = true;
    void (async () => {
      try {
        const r = await connectApi.participants(authedFetch, meeting.id);
        if (alive) {
          setRoles(Object.fromEntries(r.participants.map((p) => [p.identity, p.role])));
        }
      } catch { /* the panel still works; the badges just stay generic */ }
    })();
    return () => { alive = false; };
  }, [rolesLive, meeting, authedFetch]);

  async function changeRole(identity: string, role: 'cohost' | 'participant') {
    if (!meeting) return;
    try {
      await connectApi.setRole(authedFetch, meeting.id, identity, role);
      setRoles((r) => ({ ...r, [identity]: role }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change their role.');
    }
  }

  async function changeSharePolicy(next: SharePolicy) {
    if (!meeting) return;
    const previous = sharePolicy;
    setSharePolicy(next);   // optimistic: the select should not lag its click
    try {
      await connectApi.update(authedFetch, meeting.id, { sharePolicy: next });
    } catch (e) {
      setSharePolicy(previous);
      setError(e instanceof Error ? e.message : 'Could not change who may share.');
    }
  }

  async function changeWaitingRoom(next: WaitingRoom) {
    if (!meeting) return;
    const previous = waitingRoom;
    setWaitingRoom(next);   // optimistic — same rule as the share select
    try {
      await connectApi.update(authedFetch, meeting.id, { waitingRoom: next });
      // Turning it OFF admits everybody parked, server-side, in the same
      // PATCH — so the knock cards are stale the moment it succeeds. Cleared
      // here rather than left for the poll, or the host spends three seconds
      // looking at "Let in" buttons for people who are already in. A change
      // to 'guests' only frees colleagues, so there the poll corrects.
      if (next === 'off') setKnocking([]);
    } catch (e) {
      setWaitingRoom(previous);
      setError(e instanceof Error ? e.message : 'Could not change the waiting room.');
    }
  }

  async function decide(entry: LobbyEntry, admit: boolean) {
    if (!meeting) return;
    setDeciding(entry.requestId);
    try {
      await (admit
        ? connectApi.admit(authedFetch, meeting.id, entry.requestId)
        : connectApi.deny(authedFetch, meeting.id, entry.requestId));
      // Drop it immediately so the card cannot be clicked twice while the next
      // poll is in flight — admitting the same person twice is confusing, and
      // the poll will correct us within three seconds either way.
      setKnocking((k) => k.filter((x) => x.requestId !== entry.requestId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not answer the door.');
    } finally {
      setDeciding(null);
    }
  }

  // ---------------------------------------------------------------------
  //  Full screen.
  //
  //  Not decoration. On a laptop the browser's tab strip, the "Sharing … to
  //  this tab" bar and the taskbar together take roughly a third of the
  //  display, and what is left has to hold a header, a filmstrip and a control
  //  bar before the shared screen gets any of it. The first live share went
  //  into a stage box about four times wider than it was tall.
  // ---------------------------------------------------------------------
  useEffect(() => {
    // Hidden rather than broken where it is not supported — iOS Safari allows
    // full screen on a <video> element only, never on a container, so a button
    // that silently did nothing would read as a bug.
    setCanFull(typeof document !== 'undefined' && document.fullscreenEnabled);
    const onChange = () => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFull = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* already out */ });
    } else {
      // A rejected request is normal — a permissions policy, or a gesture the
      // browser did not count. Silent, because there is nothing the person can
      // do about it and the meeting is unaffected.
      void el.requestFullscreen().catch(() => { /* not permitted */ });
    }
  }, []);

  // ---------------------------------------------------------------------
  //  Picture-in-Picture.
  //
  //  See lib/pip.ts for why the auto-open goes through mediaSession and not
  //  through visibilitychange: switching away from a tab is not a gesture in
  //  that tab, so requestWindow() from a visibilitychange handler is refused
  //  every time. Chrome calls the "enterpictureinpicture" action for pages
  //  that are capturing camera or microphone, and a meeting always is.
  // ---------------------------------------------------------------------
  useEffect(() => { setCanPip(pipSupported()); }, []);

  // The floating window's Leave has to run the CURRENT leave(), because what
  // leaving means depends on the role we hold now. leave() is a hoisted
  // function declaration further down, so naming it here is safe; the ref is
  // what carries it across into a handler built once at open time.
  const leaveRef = useRef<() => void>(() => {});
  // No dependency array on purpose. leave() is redefined every render, so
  // listing it would be a dependency that always changes — which is what the
  // exhaustive-deps rule complains about, and rightly. Running after every
  // render is exactly the intent: keep the ref pointing at the current one.
  useEffect(() => { leaveRef.current = leave; });

  // ---------------------------------------------------------------------
  //  How big the stage actually is.
  //
  //  Measured rather than guessed, because a CSS-only gallery can only size
  //  tiles from the WIDTH it has: the rows keep their height, the stage runs
  //  out of it, and overflow-y turns a meeting into a scrolling list. Eight
  //  people came out with two faces cut in half and two more below the fold.
  //
  //  A callback ref rather than useRef + useEffect. This component returns
  //  early while joining and again once the meeting is over, so the stage
  //  element is created and destroyed more than once in a session — and an
  //  effect that ran on mount would be observing an element that no longer
  //  exists. A callback ref fires on every attach and detach, which is the
  //  question being asked.
  // ---------------------------------------------------------------------
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  const [stripBox, setStripBox] = useState({ w: 0, h: 0 });
  const stageObs = useRef<ResizeObserver | null>(null);
  const stripObs = useRef<ResizeObserver | null>(null);

  // Both are measured. The first attempt assumed the side column was the
  // 160px the stylesheet asks for — and a flex basis is a starting point, not
  // a promise. It lands wider, every tile is taller than the arithmetic
  // expected, and a capacity computed from the constant let one more tile in
  // than fits. Measure the thing; never re-derive it from the CSS.
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    watchBox(stageObs, el, setStageBox);
  }, []);
  const stripRef = useCallback((el: HTMLDivElement | null) => {
    watchBox(stripObs, el, setStripBox);
  }, []);

  const closePip = useCallback(() => {
    const handles = pipRef.current;
    pipRef.current = null;
    setPipOpen(false);
    if (handles) { try { handles.window.close(); } catch { /* already gone */ } }
    // The video-element fallback lives in the page's own document.
    if (typeof document !== 'undefined' && document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => { /* already out */ });
    }
  }, []);

  const openPip = useCallback(async () => {
    if (pipRef.current) return;

    if (documentPipSupported()) {
      const handles = await openPipWindow({
        // Read the microphone's state from the SDK, not from React state.
        // This handler is created once and would otherwise close over the
        // first render's micOn for the life of the meeting — so the button
        // would mute correctly once and then toggle the wrong way.
        onToggleMute: () => {
          const r = roomRef.current;
          if (!r) return;
          const on = r.localParticipant.isMicrophoneEnabled;
          void r.localParticipant.setMicrophoneEnabled(!on)
            .then(() => setMicOn(!on))
            .catch(() => { /* device gone; the room UI will show it */ });
        },
        // Same reasoning as the microphone: read the camera from the SDK, not
        // from a camOn captured on first render.
        onToggleCamera: () => {
          const r = roomRef.current;
          if (!r) return;
          const on = r.localParticipant.isCameraEnabled;
          void r.localParticipant.setCameraEnabled(!on)
            .then(() => { setCamOn(!on); setBlocked(null); })
            .catch(() => { /* device gone; the room UI will show it */ });
        },
        onReturn: () => { closePip(); try { window.focus(); } catch { /* denied */ } },
        // Leaving from the floating window comes back to the page first. A
        // host's Leave opens a dialog — end it, or hand it over — and a dialog
        // cannot be shown in a PiP window. leaveRef is refreshed every render
        // so this reads the current role rather than the one at open time.
        onLeave: () => {
          closePip();
          try { window.focus(); } catch { /* denied */ }
          leaveRef.current();
        },
        onClosed: () => { pipRef.current = null; setPipOpen(false); },
      });
      if (handles) { pipRef.current = handles; setPipOpen(true); }
      return;
    }

    // Safari and Firefox: one <video>, no arbitrary DOM. Take whichever the
    // stage is currently showing biggest, which is the first one in it.
    if (videoPipSupported()) {
      const el = rootRef.current?.querySelector('.cx-stage video');
      if (el instanceof HTMLVideoElement) {
        try { await el.requestPictureInPicture(); setPipOpen(true); }
        catch { /* denied, or the element has no frames yet */ }
      }
    }
  }, [closePip]);

  // Chrome's automatic trigger. Registered once; the handlers above read live
  // state rather than closing over it.
  useEffect(() => onAutoPip(() => { void openPip(); }), [openPip]);

  // Coming back to the tab should put the meeting back where it belongs.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) closePip(); };
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('leavepictureinpicture', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('leavepictureinpicture', onVisible);
    };
  }, [closePip]);

  // The effect that keeps the window showing the RIGHT thing lives further
  // down, immediately after the values it depends on are computed. A
  // dependency array is evaluated during render, so referencing them from up
  // here would read a const before its initialiser and throw.

  // These three run on pipOpen as well as on the value, which is how a freshly
  // opened window gets the CURRENT state: openPip cannot pass it in without
  // capturing it, and a captured value is the bug these handlers avoid.
  useEffect(() => { pipRef.current?.setMuted(!micOn); }, [micOn, pipOpen]);
  useEffect(() => { pipRef.current?.setCameraOff(!camOn); }, [camOn, pipOpen]);
  useEffect(() => {
    pipRef.current?.setRecording(beingRecorded);
  }, [beingRecorded, pipOpen]);

  // Leaving the meeting must not leave a floating window behind showing a
  // room nobody is in.
  useEffect(() => { if (connState === 'over') closePip(); }, [connState, closePip]);

  // ---------------------------------------------------------------------
  //  Recording — the host's half.
  //
  //  Asked for ONCE on joining, not polled. Two states matter and both are
  //  already covered without a timer: whether the room is being recorded comes
  //  from LiveKit on its own channel, and this host's own start/stop replies
  //  carry the row back. A poll would add a request every few seconds per open
  //  tab to learn something nothing is changing.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!isHost || !meeting) return;
    let alive = true;
    void (async () => {
      try {
        const list = await recordingApi.list(authedFetch, meeting.id);
        if (!alive) return;
        if (!list.enabled) { setRecOff(true); return; }
        // A host who reloads mid-recording must get the STOP button back, and
        // that needs the id of the recording already running.
        const live = list.items.find(
          (i) => i.recording.status === 'starting' || i.recording.status === 'recording');
        setRecording(live?.recording ?? null);
      } catch {
        // Not worth a banner. The button will say what went wrong the moment
        // somebody presses it, which is when they actually care.
      }
    })();
    return () => { alive = false; };
  }, [isHost, meeting, authedFetch]);

  // ── STARTING AND STOPPING ARE NOT THE SAME KIND OF ACT. ─────────────────
  //
  // Stopping is one obvious thing and happens on the click. STARTING now asks
  // audio or video first, because the two are not interchangeable and the
  // difference is not visible from the button: video costs this server roughly
  // four times the CPU while it is also running the SFU, and the file is an
  // order of magnitude larger on a disk that is already most of the way full.
  //
  // The old code chose audio silently and left a comment saying video "is
  // offered on the meeting page". It was not offered anywhere — the API has
  // taken mode: 'audio' | 'video' since it was written, and no screen ever
  // sent 'video'. A capability nobody can reach is the same as one that does
  // not exist, which is why this is the fix rather than a new feature.
  async function stopRecording() {
    if (!meeting || !recording || recBusy) return;
    setRecBusy(true);
    try {
      const stopped = await recordingApi.stop(authedFetch, meeting.id, recording.id);
      // Keep the row only while it is still live. 'processing' means LiveKit
      // is finalising the file and there is nothing left to stop.
      setRecording(stopped.status === 'starting' || stopped.status === 'recording'
        ? stopped : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop the recording.');
    } finally {
      setRecBusy(false);
    }
  }

  async function startRecording(mode: RecordingMode) {
    if (!meeting || recBusy) return;
    setRecordAsk(false);
    setRecBusy(true);
    try {
      setRecording(await recordingApi.start(authedFetch, meeting.id, mode, true));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the recording.');
    } finally {
      setRecBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  // Read fresh every render rather than memoised: the input is a mutable SDK
  // object, so a dependency array could only be a guess about when it changed
  // — and a stale guess shows people who have left.
  const participants: LKParticipant[] = room
    ? [room.localParticipant as LKParticipant, ...Array.from(room.remoteParticipants.values())]
    : [];

  // ── A SCREEN SHARE IS ITS OWN TILE. IT IS NOT A MODE OF SOMEBODY'S FACE. ──
  //
  // This used to make `speaker` the sharer and then render that one tile with
  // showScreen, so the moment anybody shared, THEIR CAMERA DISAPPEARED — the
  // person presenting became a screen and stopped having a face. It is the
  // person talking you most want to see while they present.
  //
  // Now: the share is a tile of its own on the stage, and every participant,
  // sharer included, keeps a camera tile in the strip below.
  // Feature 71. This used to be .find(), so a SECOND person sharing was
  // silently invisible — worse than refusing them, because nobody could tell
  // it had happened. LiveKit publishes as many screen tracks as there are
  // sharers; show all of them.
  const screenSharers = participants.filter(
    (p) => p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack,
  );
  // Speaker view's single tile. Picture-in-Picture used to borrow this too;
  // it now shows everyone, so this is only the stage's own layout.
  const speaker = participants.find((p) => p.isSpeaking && p !== room?.localParticipant)
    ?? participants[0];

  // ---------------------------------------------------------------------
  //  Picture-in-Picture — what the floating window should be showing.
  //
  //  EVERYONE, tiled to the window. This used to be one face: whoever was
  //  talking, or the shared screen. That answers "is someone speaking" and
  //  nothing else — you could not tell who was still in the room, who had
  //  their hand up, or that four people had joined while you were away. The
  //  window is now the room, at whatever size the person has dragged it to.
  //
  //  What is built here is PLAIN DATA — strings, booleans, and two functions
  //  for attaching a track. lib/pip.ts knows nothing about LiveKit and should
  //  not: a track can be attached to several elements at once, so the page
  //  keeps its own copy on the stage and nothing is moved or stolen.
  //
  //  ABOVE the "you have left the meeting" early return, deliberately. This
  //  block first sat below it, and the rules-of-hooks lint caught what would
  //  have been a crash the first time somebody was removed from a call: a
  //  hook that runs on some renders and not others.
  // ---------------------------------------------------------------------
  const pipTiles: PipTile[] = [];

  // Screens first, and each sharer gets their own tile — the same rule the
  // stage follows, for the same reason (feature 71).
  for (const p of screenSharers) {
    const pub = p.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.videoTrack;
    if (!track) continue;
    pipTiles.push({
      id: `screen-${p.identity}`,
      name: p.name && p.name.length > 0 ? p.name : p.identity,
      initial: initialOf(p.name && p.name.length > 0 ? p.name : p.identity),
      screen: true,
      trackId: pub?.trackSid ?? '',
      attach: (el) => track.attach(el),
      detach: (el) => track.detach(el),
    });
  }

  // Then the people. Ordered by things that change RARELY — hand raised, then
  // camera on — and never by who is speaking. Sorting on speech would shuffle
  // the grid every couple of seconds, and a face that moves while you are
  // looking at it is harder to follow than one in the wrong place. Speaking is
  // shown with a ring instead. You go last, because you know what you look
  // like; unless you are the only one here, in which case last is also first.
  const pipPeople = [...participants].sort((a, b) => {
    const local = Number(a === room?.localParticipant) - Number(b === room?.localParticipant);
    if (local !== 0) return local;
    const hand = Number(hands[b.identity] === true) - Number(hands[a.identity] === true);
    if (hand !== 0) return hand;
    const cam = (x: typeof a) => Number(
      x.getTrackPublication(Track.Source.Camera)?.isMuted === false);
    return cam(b) - cam(a);
  });

  for (const p of pipPeople) {
    const who = p.name && p.name.length > 0 ? p.name : p.identity;
    const camPub = p.getTrackPublication(Track.Source.Camera);
    const camTrack = camPub?.isMuted === true ? undefined : camPub?.videoTrack;
    const micPub = p.getTrackPublication(Track.Source.Microphone);
    pipTiles.push({
      id: p.identity,
      name: who,
      initial: initialOf(who),
      speaking: p.isSpeaking,
      // No publication at all is not "unmuted" — somebody who never turned a
      // microphone on cannot be heard, and showing them as live is a lie the
      // person in the floating window has no way to check.
      micMuted: !micPub || micPub.isMuted === true,
      hand: hands[p.identity] === true,
      local: p === room?.localParticipant,
      trackId: camTrack ? camPub?.trackSid ?? '' : '',
      attach: camTrack ? (el) => camTrack.attach(el) : undefined,
      detach: camTrack ? (el) => camTrack.detach(el) : undefined,
    });
  }

  // Everything the window can actually show, as one string.
  //
  // The effect depends on THIS rather than on the array. pipTiles is rebuilt
  // on every render — new array, new closures — so an effect depending on it
  // would run on every render, detaching and re-attaching every video, and a
  // re-attached video restarts: black frame, flicker, a stall on a weak
  // connection. The signature changes only when something visible changes.
  const pipKey = pipTiles.map((t) => [
    t.id, t.trackId, t.name,
    t.screen ? 's' : '', t.speaking ? 'v' : '', t.micMuted ? 'm' : '', t.hand ? 'h' : '',
  ].join('|')).join(';');

  // The freshest tiles, readable from an effect that does not depend on them.
  const pipTilesRef = useRef<PipTile[]>(pipTiles);
  pipTilesRef.current = pipTiles;

  useEffect(() => {
    if (!pipOpen) return;
    pipRef.current?.setTiles(pipTilesRef.current);
  }, [pipOpen, pipKey]);

  // ---------------------------------------------------------------------
  async function toggleCam() {
    const r = roomRef.current; if (!r) return;
    try { await r.localParticipant.setCameraEnabled(!camOn); setCamOn(!camOn); setBlocked(null); }
    catch (e) { noteBlocked(e, setBlocked); }
  }
  async function toggleMic() {
    const r = roomRef.current; if (!r) return;
    try { await r.localParticipant.setMicrophoneEnabled(!micOn); setMicOn(!micOn); setBlocked(null); }
    catch (e) { noteBlocked(e, setBlocked); }
  }
  function sendReact(emoji: string) {
    setPicker(false);
    const r = roomRef.current;
    showReact(emoji, 'You');
    if (!r) return;
    // Same data channel as chat and raised hands, with its own key so a
    // reaction can never be mistaken for something somebody typed.
    void r.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ react: emoji })),
      { reliable: false },
    );
  }

  // ── FILES GO BROWSER TO BROWSER. ──────────────────────────────────────
  //
  // livekit-client 2.22 carries byte streams, so a small file can travel the
  // same path as chat: no upload endpoint, no bucket, no database row, no
  // retention rule to get wrong. The price is honest and worth stating —
  // a file reaches only the people IN THE ROOM at that moment. Somebody who
  // joins a minute later never sees it, and nothing is kept afterwards.
  //
  // Hence the size cap. This is a way to pass a page around mid-meeting, not
  // a file service; anything large belongs in Space where it can be found
  // again tomorrow.
  async function sendFile(file: File) {
    const r = roomRef.current;
    if (!r) return;
    if (file.size > FILE_MAX) {
      setError(`"${file.name}" is ${prettySize(file.size)}. Files here are limited to `
        + '8 MB and are passed straight to the people in the meeting — put anything '
        + 'bigger in Space and paste the link.');
      return;
    }
    try {
      await r.localParticipant.sendFile(file, { topic: FILE_TOPIC });
      // Shown locally the same way a received one is, so the sender sees
      // exactly what everybody else got.
      setChat((c) => [...c, {
        id: c.length, who: 'You', mine: true, text: '',
        file: { name: file.name, size: file.size, url: URL.createObjectURL(file) },
      }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be sent.');
    }
  }

  async function toggleShare() {
    const r = roomRef.current; if (!r) return;

    // The phone case, answered before the SDK is asked. Without this the
    // browser throws something unhelpful (or nothing at all) and the button
    // reads as broken — the single most common "screen share is not working"
    // report, and every time it is a phone.
    if (!sharing && !screenCaptureSupported()) {
      setError('This browser cannot share a screen. Phone and tablet browsers do not '
        + 'have the feature at all — it is not a permission you can turn on. Join from '
        + 'a computer to share, or ask someone on a computer to share instead. You can '
        + 'still SEE what other people share here.');
      return;
    }

    try {
      // Feature 69. audio: true asks the browser to offer "also share tab
      // audio" in its picker. Without it, sharing a video is SILENT, which
      // everybody reports as broken rather than as missing.
      //
      // Chrome offers it for a tab or a whole screen; Safari does not support
      // it at all and simply ignores the flag rather than refusing the share.
      await r.localParticipant.setScreenShareEnabled(!sharing, { audio: true });
      setSharing(!sharing);
    }
    catch (e) {
      setSharing(false);
      // Cancelling the browser's picker throws NotAllowedError — a decision,
      // not a fault, and it gets no banner. A refusal from the SERVER is a
      // different thing: the share policy said no, and a guest (who cannot
      // read the policy) deserves the reason in words rather than a button
      // that silently does nothing.
      if (e instanceof Error && e.name !== 'NotAllowedError'
          && /permission|insufficient|not allowed/i.test(e.message)) {
        setError('The host has limited who can share their screen in this meeting.');
      }
    }
  }
  function toggleHand() {
    const r = roomRef.current;
    if (!r) return;
    const up = !myHand;
    setMyHand(up);
    // Your own hand goes in the same map as everybody else's, so the list and
    // the tiles have ONE source rather than a special case for yourself.
    setHands((h) => ({ ...h, [r.localParticipant.identity]: up }));
    void r.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ hand: up })), { reliable: true });
  }

  async function switchDevice(kind: MediaDeviceKind, deviceId: string) {
    const r = roomRef.current; if (!r) return;
    try { await r.switchActiveDevice(kind, deviceId); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not switch device.'); }
  }
  function send(e: React.FormEvent) {
    e.preventDefault();
    const r = roomRef.current;
    const text = draft.trim();
    if (!r || text.length === 0) return;

    // ── THE LINE CARRIES AN ID AND A TIME, AND BOTH ARE LOAD-BEARING. ────
    //
    // cid is what stops the same line being stored twice. A guest cannot
    // post to the API — no session — so their lines are kept by one of the
    // signed-in clients that received them, and 'one of' is a race. The
    // server inserts ON CONFLICT DO NOTHING against this id, so five clients
    // racing leave one row instead of five.
    //
    // `at` is when it was TYPED, not when the POST lands. A line sent during
    // a thirty-second reconnect belongs where it was said, or the chat in the
    // minutes reads out of order for no visible reason.
    const cid = newId();
    const at = new Date().toISOString();

    void r.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ text, cid, at })), { reliable: true });
    setChat((c) => [...c, { id: c.length, who: 'You', text, mine: true }]);
    setDraft('');

    // Kept for the minutes. Fire and forget, ALWAYS: the line is already
    // delivered by the time this runs, and a flapping API must cost a line in
    // the record rather than break chat itself.
    if (meeting) {
      void minutesApi.storeChat(authedFetch, meeting.id, {
        clientId: cid, identity: r.localParticipant.identity, body: text, sentAt: at,
      });
    }
  }
  async function hostAction(fn: () => Promise<void>) {
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
  }
  async function copyLink() {
    if (!meeting) return;
    try {
      await navigator.clipboard.writeText(meeting.joinUrl);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { setError('Copy the link from the meeting page.'); }
  }
  function openPanel(k: PanelKind) {
    setPanel(panel === k ? null : k);
    if (k === 'chat') setUnread(0);
  }
  function leave() {
    // The HOST does not get to leave by accident. Their leaving is a decision
    // about everybody else's meeting — end it, or hand it over — and the
    // dialog is where that decision is made. A cohost or participant leaving
    // decides nothing, so they just leave. myRole is read from OUR meeting
    // row, not from anything the client could edit; the server would refuse
    // a fake host's /end anyway — this is UX, not the control.
    if (meeting?.myRole === 'host' && connState !== 'over') {
      setLeaveAsk(true);
      return;
    }
    void roomRef.current?.disconnect();
    setConnState('over');
  }

  function justLeave() {
    setLeaveAsk(false);
    void roomRef.current?.disconnect();
    setConnState('over');
  }

  async function endForEveryone() {
    if (!meeting) { justLeave(); return; }
    setLeaveBusy(true);
    try {
      await connectApi.end(authedFetch, meeting.id);
      justLeave();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end the meeting.');
      setLeaveBusy(false);
    }
  }

  async function handOverAndLeave() {
    if (!meeting || handover.length === 0) return;
    setLeaveBusy(true);
    try {
      // Transfer FIRST, leave after it resolves: if this fails the meeting
      // still has no other host, and leaving anyway would orphan it.
      await connectApi.transferHost(authedFetch, meeting.id, handover);
      justLeave();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not hand the meeting over.');
      setLeaveBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  if (connState === 'over') {
    const { headline, detail, rejoin } = endingFor(why);
    return (
      <Centre>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{headline}</h1>
        {detail && (
          <p style={{ color: '#9b9bab', maxWidth: 420, marginBottom: 16 }}>{detail}</p>
        )}
        {error && <p style={{ color: '#ffb3bb', marginBottom: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          {rejoin && (
            <button type="button" className="cx-cta" style={{ width: 'auto', padding: '11px 20px' }}
                    onClick={() => window.location.reload()}>Rejoin</button>
          )}
          <Link href="/connect" className="cx-mini" style={{ display: 'grid', placeItems: 'center' }}>
            Back to Connect
          </Link>
        </div>
      </Centre>
    );
  }

  // While somebody is sharing, the share owns the stage and EVERYONE — the
  // sharer too — is in the strip. The Gallery/Speaker choice is deliberately
  // ignored for the duration: there is one thing being presented, and a
  // layout that put it in a quarter of the screen next to three faces would
  // be nobody's idea of presenting.
  // Raised hands to the top, then the filter. Sorting here rather than in the
  // panel so the count on the button and the list can never disagree.
  const needle = find.trim().toLowerCase();
  const listed = participants
    .filter((p) => needle.length === 0
      || (p.name ?? '').toLowerCase().includes(needle)
      || p.identity.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => Number(hands[b.identity] === true) - Number(hands[a.identity] === true));

  const presenting = screenSharers.length > 0;

  // ── ONE LIST, ONE DECISION ABOUT WHAT IS LARGE. ─────────────────────────
  //
  // A screen and a face are both just tiles; what differs is which track they
  // show. Keeping them in one list is what lets a pinned FACE outrank a
  // screen share without a second code path — the share simply stops being
  // in `main` and turns up in the column like anything else.
  //
  // The order of the rules IS the product decision, most specific first:
  //   1. a pin, because somebody asked for it by hand
  //   2. a screen share, because that is what people came to look at
  //   3. speaker view's current speaker
  //   4. otherwise everybody, at equal size
  const me = room?.localParticipant;
  const hasCamera = (p: LKParticipant) => {
    const pub = p.getTrackPublication(Track.Source.Camera);
    return pub !== undefined && pub.videoTrack !== undefined && pub.isMuted !== true;
  };

  const tiles: { key: string; p: LKParticipant; screen: boolean }[] = [
    // A SHARED SCREEN IS NEVER FILTERED OUT. "Hide people with no camera" is
    // about empty black squares with initials in them; a screen is the thing
    // the meeting is looking at, and hiding it because of a preference about
    // faces would be absurd.
    ...screenSharers.map((p) => ({ key: `screen-${p.identity}`, p, screen: true })),
    ...participants
      .filter((p) => !(roomPrefs.hideSelf && p === me))
      // Your own tile survives hideNoCam even with the camera off: a black
      // square is how you notice your camera is off. Everyone else's does not.
      .filter((p) => !roomPrefs.hideNoCam || p === me || hasCamera(p))
      .map((p) => ({ key: p.identity, p, screen: false })),
  ];

  // A pin on somebody who has since left is ignored rather than cleared, so
  // that a brief reconnect does not silently un-pin them.
  const pinnedKey = pinned && tiles.some((t) => t.key === pinned) ? pinned : null;

  // 'auto' is not a layout of its own — it is a rule for choosing one, and
  // resolving it here means everything below deals with three real layouts
  // instead of three plus a special case.
  const layout: Exclude<Layout, 'auto'> = roomPrefs.layout !== 'auto'
    ? roomPrefs.layout
    : (presenting || pinnedKey !== null) ? 'sidebar' : 'grid';

  // The one tile that gets the stage, when a layout has one. Pin first
  // because somebody asked by hand; then the share, because that is what
  // people came to look at; then whoever is speaking.
  const focusKey = pinnedKey
    ?? (screenSharers[0] ? `screen-${screenSharers[0].identity}` : null)
    ?? (speaker ? speaker.identity : null)
    ?? tiles[0]?.key
    ?? null;

  // "Most faces at once" applies to the GALLERY as well, which it did not
  // before: mainKeys took every tile there, so the slider moved and nothing
  // happened. It is the only view where the cap matters most — twenty live
  // videos is real work for a laptop, and the setting is how somebody whose
  // fan is screaming gets out of trouble.
  const galleryCap = Math.max(1, roomPrefs.maxTiles);

  const mainKeys = layout === 'grid'
    ? tiles.slice(0, galleryCap).map((t) => t.key)
    : focusKey !== null ? [focusKey] : [];

  const main = tiles.filter((t) => mainKeys.includes(t.key));

  // People the gallery's cap left out. Counted, never silently dropped.
  const galleryHidden = layout === 'grid'
    ? Math.max(0, tiles.length - main.length)
    : 0;

  // Spotlight shows ONE tile and nothing else — that is the whole point of
  // asking for it, so the others are not demoted to a column, they are gone.
  // The gallery has no strip either: it IS the strip.
  const restAll = layout === 'spotlight' || layout === 'grid'
    ? []
    : tiles.filter((t) => !mainKeys.includes(t.key));

  // The cap applies to the COMPANY, never to the focused tile, and it counts
  // what was hidden so the number can be shown rather than the people simply
  // disappearing.
  // ---------------------------------------------------------------------
  //  IN SIDE VIEW THE COLUMN IS COMPANY, NOT A REGISTER.
  //
  //  While somebody is presenting, the column exists so you can see the
  //  faces of the people watching. A column of black squares with initials
  //  in them is not that — it is a list of names taking up the space the
  //  faces would have used, and in an eighteen-person meeting it pushed
  //  every actual camera off the bottom.
  //
  //  So: cameras only, EXCEPT the host and co-hosts, who stay whether their
  //  camera is on or not. They are who you look for when you need something
  //  to happen, and finding them should not depend on whether they happen to
  //  be on camera. A shared screen is never filtered — it is the point.
  //
  //  Nobody is lost: whoever is filtered out is added to the "+N more"
  //  count, and that chip opens People.
  // ---------------------------------------------------------------------
  const runsTheMeeting = (p: LKParticipant) =>
    roles[p.identity] === 'host' || roles[p.identity] === 'cohost';

  const sideList = main.length === 1
    ? restAll.filter((t) => t.screen || hasCamera(t.p) || runsTheMeeting(t.p))
    : restAll;

  const rest = sideList.slice(0, Math.max(0, roomPrefs.maxTiles));
  // Counted against restAll, so the people the camera filter removed are in
  // the number too. To whoever is reading it there is one question: how many
  // people am I not seeing.
  const overflow = restAll.length - rest.length;

  // Exactly one large tile with company beside it — a share, a pinned person,
  // or speaker view. That is when the side column earns its place; a gallery
  // of equals has no column and needs none.
  const focused = main.length === 1 && rest.length > 0;

  // Zero while the stage is unmeasured. The first paint has no size yet, and
  // guessing 1 would be a visible one-frame jump from a single huge tile to
  // the real layout. See the note beside stageRef for the rest.
  //
  // The "+N more" chip is a cell like any other, so it is counted here. A
  // chip squeezed in afterwards would push the last face onto a row of its
  // own — which is how a fix for overflow becomes a cause of it.
  const gridItems = main.length + (galleryHidden > 0 ? 1 : 0);
  const gridCols = focused || stageBox.w === 0
    ? 0
    : bestColumns(Math.max(1, gridItems), stageBox.w, stageBox.h, 16 / 9);

  // ---------------------------------------------------------------------
  //  THE SIDE COLUMN HAS TO FIT TOO.
  //
  //  The same failure as the gallery, in one dimension. The column is a
  //  fixed 160px wide and its tiles are 16:9, so each one costs about 100px
  //  of height including the gap — and past about eight of them the column
  //  simply scrolled. In an eighteen-person meeting that meant the sixth
  //  face cut in half and everybody after it below the fold, with no hint
  //  they were there. The "+N more" chip exists precisely so that people who
  //  do not fit are COUNTED rather than hidden; it was being bypassed
  //  because the cap it works from is a preference, not a measurement.
  //
  //  Below 900px the column becomes a horizontal row (see the media query in
  //  RoomChrome), so there the budget is a width rather than a height.
  //
  //  One slot is given back to the chip whenever there is something to
  //  count, for the same reason pip.ts does it: a chip that pushes a face
  //  off the end makes its own number wrong.
  // ---------------------------------------------------------------------
  //  The column's own width decides how tall each 16:9 tile is, so the
  //  capacity is measured end to end and no number here is copied from the
  //  stylesheet.
  const GAP = 10;
  const stripFit = !focused || stripBox.w === 0 || stripBox.h === 0
    ? rest.length
    : stageBox.w <= 900
      // Narrow screens turn the column into a row: the budget is width, and
      // the tiles are the fixed 104px the media query gives them.
      ? Math.max(1, Math.floor((stripBox.w + 8) / 112))
      : Math.max(1, Math.floor(
        (stripBox.h + GAP) / (stripBox.w * (9 / 16) + GAP)));

  const strip = rest.length > stripFit
    ? rest.slice(0, Math.max(1, stripFit - 1))
    : rest;
  // Everything the preference dropped, plus everything the column could not
  // hold. One number, because to the person looking at it there is only one
  // question: how many people am I not seeing.
  const unseen = overflow + (rest.length - strip.length);

  // Built once and placed in one of two containers — beside the large tile
  // when focused, below it otherwise. Two copies of this JSX would be two
  // things to keep in step, and the one edited less often is the one that
  // quietly stops matching.
  const stripTiles = strip.map((t) => (
    <Tile key={t.key} p={t.p} big={false} local={t.p === room?.localParticipant}
          showScreen={t.screen} hand={!t.screen && hands[t.p.identity] === true}
          canHost={false} pinned={false} mirror={roomPrefs.mirror}
          onPin={() => setPinned(t.key)}
          onMute={() => {}} onRemove={() => {}} />
  ));

  // Who could take the meeting over: signed-in people other than you. A guest
  // cannot host — every host control keys on a user account they do not have.
  const eligibleHosts = participants.filter(
    (p) => p !== room?.localParticipant && p.identity.startsWith('user:'));

  // What the SHARE BUTTON should say, from the policy and OUR role. This is
  // display logic only — the token and UpdateParticipant are the enforcement,
  // so a client that edits this away gets a refusal from the server instead
  // of a hidden button. Guests have a null meeting and keep the button; if
  // the policy stops them the SDK's refusal is turned into a sentence in
  // toggleShare above.
  const mayShare = meeting === null
    || sharePolicy === 'everyone'
    || (sharePolicy === 'cohost' && (meeting.myRole === 'host' || meeting.myRole === 'cohost'))
    || (sharePolicy === 'host' && meeting.myRole === 'host');


  // ── THE CONTROL BUTTONS, BUILT ONCE. ─────────────────────────────────
  //
  // They are rendered in one of three places depending on the preference —
  // a row at the bottom, a rail on the left, or up in the header. Written
  // once here so the three placements cannot drift apart; a button added to
  // only two of them would be a bug nobody notices until somebody has moved
  // their bar.
  // ── FOUR CONTROLS OUT, THE REST BEHIND "MORE". ────────────────────────
  //
  // Twelve buttons in a row wrapped onto two lines and pushed the meeting up
  // the screen; in the compact bar they lost their labels too, so a wall of
  // small coloured squares was all that was left. What stays out is what you
  // reach for without thinking — microphone, camera, share, react — plus the
  // way out. Everything else is one tap away and labelled in words.
  //
  // ICON NOTE: most icons here are the solid (-fill) variants. Two are not,
  // and deliberately: the camera and Picture-in-Picture keep the outline
  // names that are PROVEN to render in this icon font. A missing glyph costs
  // nothing at build time and leaves a blank button on screen — which is
  // exactly what ri-vidicon-off-line did for an afternoon. Where a fill
  // variant has not been confirmed, the proven name stays.
  // What is actually waiting for you behind the More button: people at the
  // door, and people with a hand up. Chat is deliberately NOT in this sum —
  // see the note beside the badge itself.
  const moreWaiting = knocking.length
    + Object.values(hands).filter(Boolean).length;

  const barPrimary = (
    <>
      <button type="button" className={`cx-btn cx-btn--mic ${micOn ? '' : 'is-off'}`}
              onClick={() => void toggleMic()} aria-pressed={micOn}
              title={micOn ? 'Mute' : 'Unmute'}>
        <i className="ri-mic-fill" />
        {micOn ? 'Mute' : 'Unmute'}
      </button>

      <button type="button" className={`cx-btn cx-btn--cam ${camOn ? '' : 'is-off'}`}
              onClick={() => void toggleCam()} aria-pressed={camOn}
              title={camOn ? 'Stop video' : 'Start video'}>
        <i className="ri-vidicon-line" />
        Video
      </button>

      <button type="button" className={`cx-btn cx-btn--share ${sharing ? 'is-on' : ''}`}
              onClick={() => void toggleShare()} aria-pressed={sharing}
              disabled={!mayShare && !sharing}
              title={!screenCaptureSupported()
                ? 'This browser cannot share a screen — join from a computer'
                : mayShare || sharing
                  ? 'Share your screen'
                  : 'The host has limited who can share in this meeting'}>
        <i className="ri-computer-fill" />
        {sharing ? 'Stop' : 'Share'}
      </button>

      <button type="button" className={`cx-btn cx-btn--react ${picker ? 'is-on' : ''}`}
              onClick={() => { setPicker(!picker); setMore(false); }}
              aria-haspopup="menu" aria-expanded={picker}
              title="Send a reaction">
        <i className="ri-emotion-fill" />
        React
      </button>

      <span className="cx-btnwrap">
        <button type="button" className={`cx-btn cx-btn--more ${more ? 'is-on' : ''}`}
                onClick={() => { setMore(!more); setPicker(false); }}
                aria-haspopup="menu" aria-expanded={more}
                title="Everything else">
          <i className="ri-more-2-fill" />
          More
        </button>
        {/* A badge is a promise that there is something behind the button it
            sits on. Chat is NOT behind this one — it has its own floating
            button in the corner, with its own count — so an unread message
            lighting up More sent people into a menu to find nothing new, and
            the same message got counted twice on the same screen.

            What is behind More: somebody at the door, and somebody with a
            hand up. Both live in People, and People lives in here. */}
        {moreWaiting > 0 && (
          <span className="cx-count"
                title={`${moreWaiting} waiting for you in People`}>
            {moreWaiting}
          </span>
        )}
      </span>

      <button type="button" className="cx-btn cx-btn--leave" onClick={leave} title="Leave">
        <i className="ri-logout-box-r-fill" />Leave
      </button>
    </>
  );

  // The contents of More. Same buttons, same handlers — only the place
  // changed, and each one closes the menu so it never sits open over the
  // thing it just did.
  const moreItems = (
    <>
      <div className="cx-more-head">The meeting</div>

      <button type="button" className={`cx-btn cx-btn--view ${panel === 'view' ? 'is-on' : ''}`}
              onClick={() => { setMore(false); openPanel('view'); }}
              title="Choose how the meeting is arranged">
        <i className="ri-layout-grid-fill" />View and layout
      </button>

      <span className="cx-btnwrap">
        <button type="button" className={`cx-btn cx-btn--people ${panel === 'people' ? 'is-on' : ''}`}
                onClick={() => { setMore(false); openPanel('people'); }} title="People">
          <i className="ri-group-fill" />People
        </button>
        {moreWaiting > 0 && <span className="cx-count">{moreWaiting}</span>}
      </span>

      {/* No Chat row here: it has its own button in the corner, and one
          feature in two menus is two places to keep in step. */}

      <button type="button" className={`cx-btn cx-btn--hand ${myHand ? 'is-on' : ''}`}
              onClick={() => { setMore(false); toggleHand(); }} aria-pressed={myHand}
              title={myHand ? 'Lower your hand' : 'Raise your hand'}>
        <i className="ri-hand" />
        {myHand ? 'Lower your hand' : 'Raise your hand'}
      </button>

      <div className="cx-more-head">This screen</div>

      {canFull && (
        <button type="button" className={`cx-btn cx-btn--full ${full ? 'is-on' : ''}`}
                onClick={() => { setMore(false); toggleFull(); }} aria-pressed={full}
                title={full ? 'Leave full screen (Esc)' : 'Full screen'}>
          <i className={full ? 'ri-fullscreen-exit-fill' : 'ri-fullscreen-fill'} />
          {full ? 'Leave full screen' : 'Full screen'}
        </button>
      )}

      {canPip && (
        <button type="button" className={`cx-btn cx-btn--mini ${pipOpen ? 'is-on' : ''}`}
                onClick={() => { setMore(false); if (pipOpen) closePip(); else void openPip(); }}
                aria-pressed={pipOpen}
                title="Keep the meeting in a small floating window while you work elsewhere">
          <i className="ri-picture-in-picture-exit-line" />
          {pipOpen ? 'Close small window' : 'Small window'}
        </button>
      )}

      <button type="button" className={`cx-btn cx-btn--set ${panel === 'devices' ? 'is-on' : ''}`}
              onClick={() => { setMore(false); openPanel('devices'); }} title="Settings">
        <i className="ri-settings-3-line" />Camera, mic and sound
      </button>

      {/* Hidden entirely when this server has no egress, rather than shown
          and refusing. A control that is always there and never works is
          read as a broken product, not as an unconfigured one. */}
      {isHost && meeting && !recOff && !isPrivate && (
        <>
          <div className="cx-more-head">Host</div>
          <button type="button" className={`cx-btn cx-btn--rec ${recording ? 'is-rec' : ''}`}
                  onClick={() => {
                    setMore(false);
                    if (recording) void stopRecording(); else setRecordAsk(true);
                  }}
                  disabled={recBusy}
                  aria-pressed={recording !== null}
                  aria-haspopup={recording ? undefined : 'dialog'}
                  title={recording
                    ? 'Stop recording'
                    : 'Record this meeting — you choose audio or video'}>
            <i className={recording ? 'ri-stop-circle-fill' : 'ri-record-circle-line'} />
            {recBusy ? 'Working…' : recording ? 'Stop recording' : 'Record'}
          </button>
        </>
      )}

      {/* NO "End" button here. It used to sit beside Leave and do very nearly
          the same thing, which is why they read as duplicates: pressing Leave
          as the host already opens a dialog whose first choice is "End the
          meeting for everyone". One way to end a meeting, and it is the one
          that asks what you meant. */}
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className={`cx-root cx-theme-${roomPrefs.theme} cx-root--bar-${roomPrefs.bar}`
        + `${LIGHT_THEMES.has(roomPrefs.theme) ? ' cx-light' : ''}`
        + `${roomPrefs.bar === 'left' ? ' cx-root--bar-left' : ''}`
        + `${panel !== null ? ' cx-root--panel' : ''}`}
           ref={rootRef}>
        {/* The rail lives OUTSIDE the main pane so it can be a sibling column
            rather than something floating over the video. Everything else —
            header, stage, strip — sits in the pane beside it. */}
        {roomPrefs.bar === 'left' && <div className="cx-bar cx-bar--left">{barPrimary}</div>}
        <div className="cx-mainpane">
        <header className="cx-top">
          <div style={{ minWidth: 0 }}>
            <div className="cx-title">{meeting?.title ?? 'Meeting'}</div>
            <div className="cx-meta">
              {connState === 'live' && <span className="cx-dot" aria-hidden="true" />}
              <span>{participants.length} {participants.length === 1 ? 'person' : 'people'}</span>
              {meeting?.locked && <span>· Locked</span>}
              {/* Says what is true and no more: the meeting SERVER cannot
                  hear it. Not "end-to-end encrypted" unqualified — our API
                  derived the key, and the wording rule in lib/connect.ts
                  explains why that distinction is not pedantry. */}
              {isPrivate && (
                <span title="Encrypted so the meeting server cannot see or hear it. It cannot be recorded.">
                  · 🔒 Private
                </span>
              )}
            </div>
          </div>
          {/* The recording notice, beside the name rather than as a band
              across the room. Still not dismissible, still driven by
              LiveKit's own flag — only the shape changed, because a
              permanent stripe cost a row of the meeting for its whole
              length. */}
          {beingRecorded && (
            <span className="cx-recpill" role="status" aria-live="polite">
              <span className="cx-recdot" aria-hidden="true" />
              Recording
            </span>
          )}

          {roomPrefs.bar === 'top' && <div className="cx-bar cx-bar--top">{barPrimary}</div>}
          <div className="cx-ghost">
            {meeting && (
              <button type="button" className="cx-mini" onClick={() => void copyLink()}>
                <i className="ri-link me-1" />{copied ? 'Copied' : 'Copy link'}
              </button>
            )}
          </div>
        </header>

        {/* Everyone in the room, guests included, and NOT dismissible.
            Driven by LiveKit's room flag rather than by our own state, so it
            is true for people who joined after recording began and cannot be
            suppressed by a client that would rather not show it.

            This is a NOTICE, not consent. Several places Connect will run
            require the latter; that is a product decision and it is written
            up in docs/CONNECT_RECORDING_AND_NOTES.md rather than assumed. */}
        {connState === 'reconnecting' && (
          <div className="cx-banner cx-banner--warn" role="status">
            <Spinner /> <span className="ms-2">Connection lost — reconnecting. Stay on this page.</span>
          </div>
        )}
        {blocked && <div className="cx-banner cx-banner--bad" role="alert">{blocked}</div>}
        {error && (
          <div className="cx-banner cx-banner--bad" role="alert">
            {error}
            <button type="button" className="cx-x ms-2" aria-label="Dismiss"
                    onClick={() => setError(null)}>×</button>
          </div>
        )}

        {/* Double-click anywhere on the stage toggles full screen. The
            gesture every video player has had for twenty years, so it needs
            no discovery — the button below is for the people who never learnt
            it. */}
        <div ref={stageRef}
             className={`cx-stage${focused ? ' cx-stage--focus' : ''}`
               + `${gridCols > 0 ? ' cx-stage--grid' : ''}`}
             // A custom property in a style object. The double assertion is
             // for the React typings, which only learned about --* keys
             // recently and are not worth pinning a version over.
             style={gridCols > 0
               ? ({ '--cx-cols': gridCols } as unknown as React.CSSProperties)
               : undefined}
             onDoubleClick={canFull ? toggleFull : undefined}>
          {/* Screen tiles are keyed apart from their owner's camera tile so
              React never reuses one <video> element for two different
              tracks. */}
          {main.map((t) => (
            <Tile key={t.key} p={t.p} big={main.length === 1}
                  local={t.p === room?.localParticipant}
                  showScreen={t.screen}
                  hand={!t.screen && hands[t.p.identity] === true}
                  pinned={pinnedKey === t.key}
                  mirror={roomPrefs.mirror}
                  onPin={() => setPinned(pinnedKey === t.key ? null : t.key)}
                  canHost={!t.screen && isHost && meeting !== null
                    && t.p !== room?.localParticipant}
                  onMute={() => void hostAction(() =>
                    connectApi.mute(authedFetch, meeting?.id ?? '', t.p.identity))}
                  onRemove={() => void hostAction(() =>
                    connectApi.remove(authedFetch, meeting?.id ?? '', t.p.identity))} />
          ))}

          {/* The people the cap left out, in a cell of their own rather than
              nowhere. They are still in the meeting and still heard. */}
          {galleryHidden > 0 && (
            <button type="button" className="cx-gridmore"
                    title="See everyone in the meeting"
                    onClick={() => openPanel('people')}>
              +{galleryHidden} more
              <small>Open People</small>
            </button>
          )}

          {/* Reactions float over everything and are pointer-transparent, so
              they can never swallow a click meant for a tile. */}
          {reacts.length > 0 && (
            <div className="cx-reacts" aria-hidden="true">
              {reacts.map((r) => (
                <div key={r.id} className="cx-react" style={{ left: `${r.x}%` }}>
                  {r.emoji}
                  <small>{r.who}</small>
                </div>
              ))}
            </div>
          )}

          {/* Beside the large tile, in the flow — see .cx-strip--side. The ref
              is how the column's real width and height reach the capacity
              sum above; the stylesheet's 160px is a flex basis, not a fact. */}
          {focused && (
            <div ref={stripRef} className="cx-strip cx-strip--side">
              {stripTiles}
              {unseen > 0 && (
                <button type="button" className="cx-mini cx-more-chip"
                        title="See everyone in the meeting"
                        onClick={() => openPanel('people')}>
                  +{unseen} more
                </button>
              )}
            </div>
          )}
        </div>

        {!focused && rest.length > 0 && (
          <div className="cx-strip">
            {stripTiles}
            {unseen > 0 && (
              <button type="button" className="cx-mini cx-more-chip"
                      title="See everyone in the meeting"
                      onClick={() => openPanel('people')}>
                +{unseen} more
              </button>
            )}
          </div>
        )}

        {roomPrefs.bar === 'bottom' && <div className="cx-bar">{barPrimary}</div>}

        {/* One backdrop for both popups: a menu that only closes by pressing
            its own button is a menu people leave open by accident. */}
        {(more || picker) && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1390 }}
               onClick={() => { setMore(false); setPicker(false); }} />
        )}

        {/* Chat, in the corner. It was buried in More, which is the wrong
            place for the thing people reach for most often during a meeting
            — and the one thing they want to reach WITHOUT losing sight of
            anybody. Hidden while the chat panel is open, because then the
            button would just be a lid on something already in front of you. */}
        {panel !== 'chat' && (
          <span className="cx-btnwrap">
            <button type="button" className="cx-fab" onClick={() => openPanel('chat')}
                    aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
                    title="Chat and files">
              <i className="ri-chat-3-fill" />
            </button>
            {unread > 0 && <span className="cx-count">{unread}</span>}
          </span>
        )}

        {more && <div className="cx-more" role="menu">{moreItems}</div>}

        {picker && (
          <div className="cx-more" role="menu" style={{ minWidth: 0 }}>
            <div className="cx-picker">
              {REACTIONS.map((e) => (
                <button type="button" key={e} className="cx-emoji"
                        onClick={() => sendReact(e)} aria-label={`Send ${e}`}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The host deciding what their leaving means. The two answers the
            brief names — end it for everyone, or hand it to somebody — plus
            the honest third case: a room with nobody who CAN host, where
            leaving-with-it-running is stated in words rather than implied. */}
        {leaveAsk && (
          <div className="cx-modal-back" role="dialog" aria-modal="true"
               aria-label="Leaving the meeting">
            <div className="cx-modal">
              <h2>You are the host</h2>
              <p className="cx-sub" style={{ margin: '0 0 4px' }}>
                Decide what happens to the meeting before you go.
              </p>

              <button type="button" className="cx-choice cx-choice--bad"
                      disabled={leaveBusy} onClick={() => void endForEveryone()}>
                <strong>End the meeting for everyone</strong>
                <div className="cx-sub">Everybody is disconnected. Notes and minutes follow.</div>
              </button>

              {eligibleHosts.length > 0 ? (
                <>
                  <div style={{ marginTop: 14 }}>
                    <label className="cx-label" htmlFor="cx-handover">Hand the meeting to</label>
                    <select id="cx-handover" className="cx-field" value={handover}
                            onChange={(e) => setHandover(e.target.value)}>
                      <option value="">Choose someone…</option>
                      {eligibleHosts.map((p) => (
                        <option key={p.identity} value={p.identity}>
                          {(p.name && p.name.length > 0 ? p.name : p.identity)
                            + (roles[p.identity] === 'cohost' ? ' (co-host)' : '')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="button" className="cx-choice"
                          disabled={leaveBusy || handover.length === 0}
                          onClick={() => void handOverAndLeave()}>
                    <strong>Leave, and they host</strong>
                    <div className="cx-sub">You become a co-host; the meeting carries on.</div>
                  </button>
                </>
              ) : (
                <button type="button" className="cx-choice" disabled={leaveBusy}
                        onClick={justLeave}>
                  <strong>Leave with the meeting running</strong>
                  <div className="cx-sub">
                    Everyone else here is a guest, so nobody can take over as host.
                    The room stays open until it empties or you end it from the
                    meeting page.
                  </div>
                </button>
              )}

              <button type="button" className="cx-choice" disabled={leaveBusy}
                      onClick={() => setLeaveAsk(false)}>
                Stay in the meeting
              </button>
            </div>
          </div>
        )}

        {/* Audio or video, asked once, in the words of what it costs rather
            than the words of the API. The recommendation is stated rather
            than implied by ordering: a host who does not know the difference
            should be able to read one line and pick correctly. */}
        {recordAsk && (
          <div className="cx-modal-back" role="dialog" aria-modal="true"
               aria-label="Start recording">
            <div className="cx-modal">
              <h2>Record this meeting</h2>
              <p className="cx-sub" style={{ margin: '0 0 4px' }}>
                Everyone here is told a recording has started, and it cannot be
                paused — stopping ends it.
              </p>

              <button type="button" className="cx-choice" disabled={recBusy}
                      onClick={() => void startRecording('audio')}>
                <strong>Audio only</strong>
                <div className="cx-sub">
                  Voices, and everything the notes and transcript need. Light on
                  the server and small to keep. Choose this unless you
                  specifically need to see the screen afterwards.
                </div>
              </button>

              <button type="button" className="cx-choice" disabled={recBusy}
                      onClick={() => void startRecording('video')}>
                <strong>Audio and video</strong>
                <div className="cx-sub">
                  Everything on screen, as an MP4. About four times the load on
                  this server while it runs, and a much larger file — worth it
                  for a demonstration or a class, wasteful for a conversation.
                </div>
              </button>

              <button type="button" className="cx-choice" disabled={recBusy}
                      onClick={() => setRecordAsk(false)}>
                Not now
              </button>
            </div>
          </div>
        )}

        {/* Somebody at the door, over the video. A request that only lives in a
            panel is a person left standing outside. */}
        {knocking.length > 0 && (
          <div className="cx-knocks">
            {knocking.slice(0, 3).map((k) => (
              <div className="cx-knock" key={k.requestId}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="cx-av">{initialOf(k.displayName)}</span>
                  <div className="cx-grow">
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{k.displayName}</div>
                    <div className="cx-sub">
                      {k.isGuest ? 'Guest — wants to join' : 'Wants to join'}
                    </div>
                  </div>
                </div>
                <div className="cx-knock-acts">
                  <button type="button" className="cx-yes" disabled={deciding === k.requestId}
                          onClick={() => void decide(k, true)}>Let in</button>
                  <button type="button" className="cx-no" disabled={deciding === k.requestId}
                          onClick={() => void decide(k, false)}>Turn away</button>
                </div>
              </div>
            ))}
            {knocking.length > 3 && (
              <button type="button" className="cx-mini" onClick={() => openPanel('people')}>
                {knocking.length - 3} more waiting
              </button>
            )}
          </div>
        )}

        {panel === 'people' && (
          <Panel title={`People (${participants.length})`} onClose={() => setPanel(null)}>
            {isHost && meeting && (
              <div style={{ marginBottom: 14 }}>
                <label className="cx-label" htmlFor="cx-share-policy">Who can share their screen</label>
                <select id="cx-share-policy" className="cx-field" value={sharePolicy}
                        onChange={(e) => void changeSharePolicy(e.target.value as SharePolicy)}>
                  <option value="everyone">Everyone</option>
                  <option value="cohost">Only the host and co-hosts</option>
                  <option value="host">Only the host</option>
                </select>
                <div className="cx-sub" style={{ marginTop: 4 }}>
                  Applies to everyone already here, immediately.
                </div>

                <label className="cx-label" htmlFor="cx-waiting-room"
                       style={{ marginTop: 14, display: 'block' }}>Waiting room</label>
                <select id="cx-waiting-room" className="cx-field" value={waitingRoom}
                        onChange={(e) => void changeWaitingRoom(e.target.value as WaitingRoom)}>
                  <option value="off">Off — anyone with the link joins straight in</option>
                  <option value="guests">Guests wait to be let in</option>
                  <option value="everyone">Everyone waits to be let in</option>
                </select>
                <div className="cx-sub" style={{ marginTop: 4 }}>
                  Opening the door also lets in the people already waiting.
                </div>
              </div>
            )}
            {isHost && knocking.length > 0 && (
              <>
                <div className="cx-sub" style={{ marginBottom: 6 }}>WAITING</div>
                {knocking.map((k) => (
                  <div className="cx-row" key={k.requestId}>
                    <span className="cx-av">{initialOf(k.displayName)}</span>
                    <div className="cx-grow">
                      <div>{k.displayName}</div>
                      <div className="cx-sub">{k.isGuest ? 'Guest' : 'Colleague'}</div>
                    </div>
                    <button type="button" className="cx-pill" disabled={deciding === k.requestId}
                            onClick={() => void decide(k, true)}>Let in</button>
                    <button type="button" className="cx-pill cx-pill--bad" disabled={deciding === k.requestId}
                            onClick={() => void decide(k, false)}>No</button>
                  </div>
                ))}
                <div className="cx-sub" style={{ margin: '16px 0 6px' }}>IN THE MEETING</div>
              </>
            )}
            {participants.length > 6 && (
              <input className="cx-field" style={{ marginBottom: 10 }} value={find}
                     placeholder="Find someone"
                     onChange={(e) => setFind(e.target.value)} />
            )}

            {listed.map((p) => {
              const nm = p.name && p.name.length > 0 ? p.name : p.identity;
              const muted = p.getTrackPublication(Track.Source.Microphone)?.isMuted !== false;
              // NOT camOn — that is your own camera, and this row is about
              // theirs. Shadowing it here would read correctly and mean the
              // wrong thing to whoever edits this next.
              const theirCam = hasCamera(p);
              const up = hands[p.identity] === true;
              const role = roles[p.identity];
              const isSharing = p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack !== undefined;
              // Only a signed-in person can hold controls — the same rule the
              // server enforces — and only the HOST hands roles out.
              const roleable = meeting?.myRole === 'host'
                && p !== room?.localParticipant
                && p.identity.startsWith('user:');
              return (
                <div className="cx-row cx-row--person" key={p.identity}>
                  <span className="cx-av">{initialOf(nm)}</span>
                  <div className="cx-grow">
                    {/* Wraps rather than ellipsises. The controls used to sit
                        on this line and squeezed it to about eight characters,
                        so a panel whose entire job is telling you who is in
                        the meeting was showing "Shruti Sin…". A name is the
                        one thing here that must never be abbreviated. */}
                    <div className="cx-pname">
                      {up && <span aria-label="Hand raised" title="Hand raised">✋ </span>}
                      {nm}{p === room?.localParticipant ? ' (you)' : ''}
                    </div>
                    {/* 'Speaking' used to show for anybody merely UNMUTED, so a
                        silent room read as everybody talking at once. */}
                    <div className="cx-sub">
                      {role === 'host' ? 'Host · ' : role === 'cohost' ? 'Co-host · ' : ''}
                      {muted ? 'Muted' : p.isSpeaking ? 'Speaking' : 'Unmuted'}
                      {isSharing ? ' · Sharing' : ''}
                    </div>
                  </div>
                  {/* Icons, inline, on the right. Words did not fit — five
                      text buttons and a name across 360px left the name about
                      eight characters — and the pill they were drawn as came
                      out nearly invisible against the panel. Icons at 30px
                      cost about a third of the width and can be given a solid
                      background that reads on every theme. */}
                  {isHost && meeting && p !== room?.localParticipant && (
                    <div className="cx-acts">
                      {roleable && role !== 'host' && (
                        <button type="button"
                                className={`cx-act${role === 'cohost' ? ' cx-act--on' : ''}`}
                                title={role === 'cohost'
                                  ? 'Take away their co-host controls'
                                  : 'Let them help run the meeting'}
                                aria-label={role === 'cohost'
                                  ? 'Take away their co-host controls'
                                  : 'Let them help run the meeting'}
                                onClick={() => void changeRole(p.identity,
                                  role === 'cohost' ? 'participant' : 'cohost')}>
                          <ActIcon kind="star" />
                        </button>
                      )}
                      {isSharing && (
                        <button type="button" className="cx-act"
                                title="Stop their screen share; their camera stays on"
                                aria-label="Stop their screen share"
                                onClick={() => void hostAction(() =>
                                  connectApi.mute(authedFetch, meeting.id, p.identity, 'screen'))}>
                          <ActIcon kind="screen" />
                        </button>
                      )}
                      {/* Shows the state, and goes quiet once there is
                          nothing to do: a microphone can be muted from here
                          but never unmuted — that is the other person's
                          choice, and the server refuses it. */}
                      <button type="button" className="cx-act" disabled={muted}
                              title={muted
                                ? 'They are already muted'
                                : 'Mute their microphone'}
                              aria-label={muted
                                ? 'They are already muted'
                                : 'Mute their microphone'}
                              onClick={() => void hostAction(() =>
                                connectApi.mute(authedFetch, meeting.id, p.identity))}>
                        <ActIcon kind={muted ? 'micOff' : 'mic'} />
                      </button>
                      {/* Feature 58. The API has taken kind: 'audio' | 'video'
                          since it was written and the UI only ever sent audio —
                          one argument away the whole time. */}
                      <button type="button" className="cx-act" disabled={!theirCam}
                              title={theirCam
                                ? 'Turn their camera off'
                                : 'Their camera is already off'}
                              aria-label={theirCam
                                ? 'Turn their camera off'
                                : 'Their camera is already off'}
                              onClick={() => void hostAction(() =>
                                connectApi.mute(authedFetch, meeting.id, p.identity, 'video'))}>
                        <ActIcon kind={theirCam ? 'cam' : 'camOff'} />
                      </button>
                      <button type="button" className="cx-act cx-act--bad"
                              title="Remove them. A removed colleague cannot rejoin this meeting."
                              aria-label="Remove them from the meeting"
                              onClick={() => void hostAction(() =>
                                connectApi.remove(authedFetch, meeting.id, p.identity))}>
                        <ActIcon kind="remove" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {listed.length === 0 && (
              <div className="cx-sub">Nobody here matches “{find}”.</div>
            )}
          </Panel>
        )}

        {panel === 'chat' && (
          <Panel title="Chat" onClose={() => setPanel(null)}
                 foot={
                   <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
                     <button type="button" className="cx-ico" style={{ flex: '0 0 auto' }}
                             onClick={() => fileInputRef.current?.click()}
                             aria-label="Send a file" title="Send a file (up to 8 MB)">
                       <i className="ri-attachment-2" />
                     </button>
                     <input ref={fileInputRef} type="file" hidden
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              // Cleared straight away, or choosing the same
                              // file twice in a row fires no change event.
                              e.target.value = '';
                              if (f) void sendFile(f);
                            }} />
                     <input className="cx-field" value={draft} maxLength={2000}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="Message everyone" aria-label="Message" />
                     <button className="cx-cta" style={{ width: 'auto', padding: '10px 16px' }}
                             type="submit">Send</button>
                   </form>
                 }>
            <div className="cx-sub" style={{ marginBottom: 10 }}>
              Nothing here is saved. Files go straight to the people in the
              meeting — up to 8 MB, and only to whoever is here now.
            </div>
            {/* ── AN HONEST LINE ABOUT WHAT PRIVATE COVERS. ──────────────
                A Private meeting encrypts its AUDIO AND VIDEO so the media
                server cannot read them. Chat and files travel a different
                path and the server can. Saying so is the same rule the rest
                of this module follows: never let somebody assume a promise
                wider than the one we actually keep. */}
            {isPrivate && (
              <div className="cx-sub" style={{ marginBottom: 10, color: 'var(--cx-bad)' }}>
                The encryption covers the audio and video of this meeting, not
                chat or files.
              </div>
            )}
            {chat.length === 0 && <div className="cx-sub">Nothing yet.</div>}
            {chat.map((c) => (
              <div key={c.id} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: c.mine ? '#8fe6f6' : undefined }}>
                  {c.mine ? 'You' : c.who}
                </div>
                {c.text.length > 0 && (
                  <div style={{ fontSize: 14, wordBreak: 'break-word' }}>{c.text}</div>
                )}
                {c.file && (
                  <a className="cx-file" href={c.file.url} download={c.file.name}>
                    <i className="ri-file-line" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis',
                                   whiteSpace: 'nowrap' }}>{c.file.name}</span>
                    <small>{prettySize(c.file.size)}</small>
                  </a>
                )}
              </div>
            ))}
          </Panel>
        )}

        {panel === 'view' && (
          <Panel title="View" onClose={() => setPanel(null)}>
            <div className="cx-sub" style={{ marginBottom: 8 }}>
              Yours alone, and remembered.
            </div>

            <div className="cx-row-pick">
              {([
                ['auto', 'ri-magic-fill', 'Auto', 'Follows the meeting'],
                ['grid', 'ri-layout-grid-fill', 'Grid', 'Everyone the same size'],
                ['spotlight', 'ri-fullscreen-fill', 'Spot', 'One tile only'],
                ['sidebar', 'ri-layout-right-fill', 'Side', 'One large, rest beside it'],
              ] as [Layout, string, string, string][]).map(([id, icon, label, hint]) => (
                <button type="button" key={id} title={hint}
                        className={`cx-pick${roomPrefs.layout === id ? ' is-on' : ''}`}
                        aria-label={hint}
                        aria-pressed={roomPrefs.layout === id}
                        onClick={() => setRoomPref('layout', id)}>
                  <i className={icon} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <label className="cx-label" htmlFor="cx-maxtiles" style={{ marginTop: 14 }}>
              Most faces at once: {roomPrefs.maxTiles}
            </label>
            <input id="cx-maxtiles" className="cx-range" type="range"
                   min={1} max={49} step={1} value={roomPrefs.maxTiles}
                   onChange={(e) => setRoomPref('maxTiles', Number(e.target.value))} />
            <div className="cx-sub" style={{ marginBottom: 10 }}>
              The large tile is never counted. Everyone else is still in the
              meeting and still heard.
            </div>

            <label className="cx-switch">
              <span>
                Hide people with no camera
                <div className="cx-sub">Yours always stays.</div>
              </span>
              <input type="checkbox" checked={roomPrefs.hideNoCam}
                     onChange={(e) => setRoomPref('hideNoCam', e.target.checked)} />
            </label>

            <label className="cx-switch">
              <span>
                Mirror my own video
                <div className="cx-sub">Off when holding up writing. Others are unaffected.</div>
              </span>
              <input type="checkbox" checked={roomPrefs.mirror}
                     onChange={(e) => setRoomPref('mirror', e.target.checked)} />
            </label>

            <label className="cx-switch">
              <span>
                Hide my own tile
                <div className="cx-sub">You stay on camera for others.</div>
              </span>
              <input type="checkbox" checked={roomPrefs.hideSelf}
                     onChange={(e) => setRoomPref('hideSelf', e.target.checked)} />
            </label>

            <div className="cx-sub" style={{ margin: '16px 0 6px' }}>BACKGROUND</div>
            <div className="cx-swatches">
              {THEMES.map(([id, label, swatch]) => (
                <button type="button" key={id} title={label} aria-label={label}
                        className={`cx-swatch${roomPrefs.theme === id ? ' is-on' : ''}`}
                        style={{ background: swatch }}
                        aria-pressed={roomPrefs.theme === id}
                        onClick={() => setRoomPref('theme', id)} />
              ))}
            </div>

            <div className="cx-sub" style={{ margin: '16px 0 6px' }}>WHERE THE CONTROLS SIT</div>
            <div className="cx-row-pick">
              {([
                ['bottom', 'ri-layout-bottom-fill', 'Bottom', 'Controls along the bottom'],
                ['left', 'ri-layout-left-fill', 'Rail', 'Controls down the left edge'],
                ['top', 'ri-layout-top-fill', 'Top', 'Controls beside the meeting name'],
              ] as [BarPos, string, string, string][]).map(([id, icon, label, hint]) => (
                <button type="button" key={id} title={hint} aria-label={hint}
                        className={`cx-pick${roomPrefs.bar === id ? ' is-on' : ''}`}
                        aria-pressed={roomPrefs.bar === id}
                        onClick={() => setRoomPref('bar', id)}>
                  <i className={icon} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </Panel>
        )}

        {panel === 'devices' && (
          <Panel title="Settings" onClose={() => setPanel(null)}>
            <label className="cx-label" htmlFor="cx-cam">Camera</label>
            <select id="cx-cam" className="cx-field" style={{ marginBottom: 16 }}
                    onChange={(e) => void switchDevice('videoinput', e.target.value)}>
              {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
            </select>
            <label className="cx-label" htmlFor="cx-mic">Microphone</label>
            <select id="cx-mic" className="cx-field" style={{ marginBottom: 16 }}
                    onChange={(e) => void switchDevice('audioinput', e.target.value)}>
              {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
            </select>

            {/* Feature 42. switchActiveDevice('audiooutput', …) calls setSinkId
                on every audio element the SDK manages, so this moves the whole
                meeting to the chosen speaker rather than one track. */}
            <label className="cx-label" htmlFor="cx-out">Speaker</label>
            {outs.length > 0 ? (
              <select id="cx-out" className="cx-field"
                      onChange={(e) => void switchDevice('audiooutput', e.target.value)}>
                {outs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || 'Speaker'}</option>
                ))}
              </select>
            ) : (
              <div className="cx-sub">
                This browser does not let a page choose the speaker. Change it in
                your system sound settings.
              </div>
            )}
            {cams.length === 0 && mics.length === 0 && (
              <div className="cx-sub" style={{ marginTop: 12 }}>
                Device names appear once the browser has granted the camera or microphone.
              </div>
            )}

            {/* The chime's own mute — a review condition, not a nicety: a
                sound nobody can switch off is a sound people mute the whole
                tab to escape. Per tab, deliberately: back-to-back meetings
                have different manners, and a checkbox is cheap to re-tick. */}
            <label className="cx-label" style={{ marginTop: 16, display: 'flex',
                   alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={chimeOn}
                     onChange={(e) => setChimeOn(e.target.checked)} />
              Play a soft tone when someone joins, leaves or knocks
            </label>
          </Panel>
        )}
        </div>{/* /cx-mainpane */}
      </div>
    </>
  );
}

// ===========================================================================
/**
 * Feature 49 — the connection indicator.
 *
 * Shown ONLY when the connection is actually poor or lost. An indicator that
 * is green 99% of the time teaches people to stop looking at it, and then it
 * is not there on the day it matters. Silence means fine.
 *
 * Not rendered for yourself: your own quality as the SERVER sees it is not
 * what your screen can tell you, and a warning about your own connection
 * belongs in the reconnecting banner, which already exists.
 */
function Quality({ p }: { p: LKParticipant }) {
  const q = p.connectionQuality;
  if (q !== ConnectionQuality.Poor && q !== ConnectionQuality.Lost) return null;
  const lost = q === ConnectionQuality.Lost;
  return (
    <div className={`cx-qual ${lost ? 'is-lost' : ''}`}
         title={lost ? 'Connection lost' : 'Weak connection'}>
      <i className={lost ? 'ri-wifi-off-line' : 'ri-signal-wifi-line'} />
      <span>{lost ? 'Lost' : 'Weak'}</span>
    </div>
  );
}

// ===========================================================================
function Panel({ title, onClose, children, foot }: {
  title: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode;
}) {
  return (
    <aside className="cx-panel" role="dialog" aria-label={title}>
      <div className="cx-panel-head">
        <span>{title}</span>
        <button type="button" className="cx-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="cx-panel-body">{children}</div>
      {foot && <div className="cx-panel-foot">{foot}</div>}
    </aside>
  );
}

// ===========================================================================
function Tile({ p, big, local, showScreen, hand, canHost, pinned, mirror = true,
                onPin, onMute, onRemove }: {
  p: LKParticipant;
  big: boolean;
  local: boolean;
  showScreen: boolean;
  hand: boolean;
  canHost: boolean;
  /** Is THIS tile the pinned one? Local to this browser. */
  pinned?: boolean;
  /** Mirror your OWN camera. A preference: a mirror is what people expect of
   *  themselves, and un-mirrored reads as a stranger — but anybody holding up
   *  writing wants it off. Never applies to other people or to a screen. */
  mirror?: boolean;
  /** Absent on tiles that cannot be pinned; present means the button shows. */
  onPin?: () => void;
  onMute: () => void;
  onRemove: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const source = showScreen ? Track.Source.ScreenShare : Track.Source.Camera;
  const videoPub = p.getTrackPublication(source);
  const audioPub = p.getTrackPublication(Track.Source.Microphone);
  const videoTrack = videoPub?.videoTrack;
  const audioTrack = audioPub?.audioTrack;
  const camOff = !videoTrack || videoPub?.isMuted === true;
  const name = p.name && p.name.length > 0 ? p.name : p.identity;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoTrack) return;
    videoTrack.attach(el);
    return () => { videoTrack.detach(el); };
  }, [videoTrack]);

  useEffect(() => {
    const el = audioRef.current;
    // Never attach your OWN microphone: the browser plays it straight back and
    // the room howls.
    if (!el || !audioTrack || local) return;
    audioTrack.attach(el);
    return () => { audioTrack.detach(el); };
  }, [audioTrack, local]);

  return (
    // The speaking ring belongs on a FACE. On a screen tile it would mean the
    // presenter's slides are talking.
    <div className={`cx-tile${big ? ' cx-tile--big' : ''}`
      + `${p.isSpeaking && !showScreen ? ' is-speaking' : ''}`}>
      <video ref={videoRef} autoPlay playsInline muted={local}
             // Two things a screen share must not do, for the same underlying
             // reason — you have to be able to READ it.
             //   --self   mirrors, and mirrored text is unusable.
             //   --screen switches object-fit to contain, because the default
             //            cover CROPS, and it crops off exactly whatever is at
             //            the edge of the thing somebody is presenting.
             className={`cx-video${local && !showScreen && mirror ? ' cx-video--self' : ''}`
               + `${showScreen ? ' cx-video--screen' : ''}`}
             style={{ display: camOff ? 'none' : 'block' }} />
      {!local && <audio ref={audioRef} autoPlay />}

      {camOff && (
        <div className="cx-off">
          <div className="cx-initial">{initialOf(name)}</div>
        </div>
      )}

      {/* Feature 62. On the tile as well as in the People list: a hand raised
          only in a panel nobody has open is a hand nobody sees. */}
      {hand && !showScreen && (
        <div className="cx-hand" title="Hand raised" aria-label="Hand raised">✋</div>
      )}

      {/* Feature 49. Only when it is worth saying — a bar that is always
          green is furniture, and furniture is not read. */}
      {!showScreen && !local && <Quality p={p} />}

      <div className="cx-name">
        {/* No mic icon on a screen tile — the microphone belongs to the
            person, and their camera tile in the strip already says so. */}
        {!showScreen && audioPub?.isMuted !== false
          && <i className="ri-mic-off-line" aria-label="Muted" />}
        <span>
          {showScreen
            ? `${local ? 'Your' : `${name}'s`} screen`
            : (local ? `${name} (you)` : name)}
        </span>
      </div>

      {/* PIN IS EVERYONE'S, AND IT IS ONLY YOURS.
          Mute and Remove act on other people and belong to a host. Pinning
          changes nothing but what THIS browser shows, so a guest gets it too
          — and pinning must never be pushed to anybody else, which is the
          whole reason it lives in local state and touches no API. */}
      {(canHost || onPin) && (
        <div className="cx-tileacts">
          {onPin && (
            <button type="button" className={`cx-ico${pinned ? ' cx-ico--on' : ''}`}
                    onClick={onPin}
                    aria-label={pinned ? 'Unpin' : 'Pin'}
                    aria-pressed={pinned === true}
                    title={pinned
                      ? 'Stop keeping this one large'
                      : 'Keep this one large, whoever is talking'}>
              <i className={pinned ? 'ri-pushpin-fill' : 'ri-pushpin-line'} />
            </button>
          )}
          {canHost && (
            <>
              <button type="button" className="cx-ico" onClick={onMute}
                      aria-label="Mute this person" title="Mute their microphone">
                <i className="ri-mic-off-line" />
              </button>
              <button type="button" className="cx-ico cx-ico--bad" onClick={onRemove}
                      aria-label="Remove this person"
                      title="Remove them from the meeting">
                <i className="ri-user-unfollow-line" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
/**
 * Why the meeting ended, in words the person can act on.
 *
 * These are four genuinely different events and they used to share one
 * sentence. Being removed by a host and being told "you have left" is not a
 * wording quibble — it is the product denying something the person watched
 * happen, and the difference decides whether "Rejoin" is an honest offer.
 */
function endingFor(why: DisconnectReason | undefined): {
  headline: string; detail?: string; rejoin: boolean;
} {
  switch (why) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return {
        headline: 'You were removed from the meeting',
        detail: 'The host ended your connection. Ask them if you think that was a mistake.',
        // No Rejoin: the host just decided otherwise, and a button undoing that
        // by one click makes the control meaningless.
        rejoin: false,
      };
    case DisconnectReason.ROOM_DELETED:
      return {
        headline: 'The meeting has ended',
        detail: 'The host ended it for everyone.',
        rejoin: false,
      };
    case DisconnectReason.DUPLICATE_IDENTITY:
      return {
        headline: 'You joined from somewhere else',
        detail: 'This meeting was opened again in another tab or on another device, '
          + 'which takes over the connection. Close the other one and rejoin here.',
        rejoin: true,
      };
    case DisconnectReason.CLIENT_INITIATED:
      return { headline: 'You have left the meeting', rejoin: true };
    default:
      // SERVER_SHUTDOWN, SIGNAL_CLOSE, JOIN_FAILURE, UNKNOWN — from the
      // person's side these are all "it dropped", and rejoining is the answer.
      return {
        headline: 'The meeting disconnected',
        detail: 'The connection to the meeting was lost.',
        rejoin: true,
      };
  }
}

/**
 * A denial is sticky and the prompt never returns, so it earns specific copy
 * rather than a generic failure.
 */
function noteBlocked(e: unknown, set: (m: string | null) => void) {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    set('Your browser is blocking the camera or microphone for this site. '
      + 'Click the padlock in the address bar, allow them, then reload — the '
      + 'prompt will not appear again on its own.');
    return;
  }
  if (name === 'NotFoundError') { set('No camera or microphone was found on this device.'); return; }
  if (name === 'NotReadableError') {
    set('Another app is using your camera. Close it and press Video again.');
    return;
  }
  set(null);
}

// ===========================================================================
//  Two small things the chat needs
// ===========================================================================

/**
 * An id for one chat line.
 *
 * crypto.randomUUID needs a secure context, which this app always is — but
 * "always" has been wrong before, and a chat that throws on send because an
 * id could not be made would be a spectacular way to lose a meeting. The
 * fallback is not cryptography; it only has to be unique among the handful of
 * lines one room types.
 */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* no secure context */ }
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/**
 * Which signed-in client is responsible for storing guests' chat lines.
 *
 * The one whose identity sorts first. No election, no messages, no state —
 * every client computes the same answer from the same room, and when it is
 * briefly wrong the server's unique index makes that harmless.
 *
 * Returns null when the room has only guests in it, in which case nobody can
 * store anything and the chat simply is not part of the minutes. That is the
 * honest outcome: there is no signed-in person present to take
 * responsibility for the record.
 */
function relayerOf(r: Room): string | null {
  const signedIn = [
    r.localParticipant.identity,
    ...Array.from(r.remoteParticipants.values(), (p) => p.identity),
  ].filter((id) => !id.startsWith('guest:'));

  signedIn.sort();
  return signedIn[0] ?? null;
}
