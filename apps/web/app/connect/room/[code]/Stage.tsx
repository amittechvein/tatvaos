'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Room, RoomEvent, Track, DisconnectReason, ConnectionQuality,
  type Participant as LKParticipant,
  type RemoteParticipant,
} from 'livekit-client';
import { useAuth } from '@/lib/auth';
import {
  connectApi, minutesApi, recordingApi,
  type LobbyEntry, type Meeting, type Recording, type Seat, type SharePolicy,
} from '@/lib/connect';
import type { JoinPrefs } from './PreJoin';
import {
  documentPipSupported, onAutoPip, openPipWindow, pipSupported, videoPipSupported,
  type PipHandles, type PipTile,
} from '@/lib/pip';
import { CSS, Centre, Spinner, initialOf } from './RoomChrome';

const LOBBY_POLL_MS = 3000;

// ===========================================================================
//  The live meeting
// ===========================================================================
interface ChatLine { id: number; who: string; text: string; mine: boolean }
type PanelKind = 'people' | 'chat' | 'devices' | null;

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
  const [view, setView] = useState<'gallery' | 'speaker'>('gallery');
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

  const isHost = meeting?.myRole === 'host' || meeting?.myRole === 'cohost';

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
    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      // The devices picked on the pre-join screen. Set as capture defaults
      // rather than switched after connect, so the FIRST frame anybody sees is
      // already from the right camera.
      audioCaptureDefaults: chosen?.micId ? { deviceId: chosen.micId } : undefined,
      videoCaptureDefaults: chosen?.camId ? { deviceId: chosen.camId } : undefined,
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
      .on(RoomEvent.RecordingStatusChanged, (on: boolean) => { setBeingRecorded(on); rerender(); })
      .on(RoomEvent.ParticipantConnected, rerender)
      // Remove the tile by identity, or a black rectangle sits there looking
      // like a broken camera while everyone waits for somebody who has left.
      .on(RoomEvent.ParticipantDisconnected, rerender)
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
          if (panelRef.current !== 'chat') setUnread((n) => n + 1);
        } catch {
          // Chat is ephemeral and best-effort. A malformed frame from a client
          // we do not control is dropped, never thrown.
        }
      });

    void (async () => {
      try {
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
        setError(e instanceof Error ? e.message : 'Could not connect to the meeting.');
        setConnState('over');
      }
    })();

    return () => { void r.disconnect(); roomRef.current = null; };
  }, [seat.wsUrl, seat.token, rerender]);

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
  const lobbyLive = isHost && meeting !== null && meeting.waitingRoom !== 'off'
    && (connState === 'live' || connState === 'reconnecting');

  useEffect(() => {
    if (!lobbyLive || !meeting) { setKnocking([]); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await connectApi.lobby(authedFetch, meeting.id);
        if (alive) setKnocking(r.waiting);
      } catch {
        // A failed poll is not worth a banner — the next is three seconds away,
        // and an error that clears itself teaches people to ignore errors.
      }
    };
    void tick();
    const t = setInterval(() => void tick(), LOBBY_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [lobbyLive, meeting, authedFetch]);

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
        onReturn: () => { closePip(); try { window.focus(); } catch { /* denied */ } },
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

  useEffect(() => { pipRef.current?.setMuted(!micOn); }, [micOn, pipOpen]);

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

  async function toggleRecording() {
    if (!meeting || recBusy) return;
    setRecBusy(true);
    try {
      if (recording) {
        const stopped = await recordingApi.stop(authedFetch, meeting.id, recording.id);
        // Keep the row only while it is still live. 'processing' means LiveKit
        // is finalising the file and there is nothing left to stop.
        setRecording(stopped.status === 'starting' || stopped.status === 'recording'
          ? stopped : null);
      } else {
        // Audio, always, from this button. Video costs LiveKit four times the
        // CPU on a box that is also running the SFU, so it is not something to
        // start by tapping the obvious control — it is offered on the meeting
        // page, where there is room to say what it costs.
        setRecording(await recordingApi.start(authedFetch, meeting.id, 'audio', true));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the recording.');
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
  async function toggleShare() {
    const r = roomRef.current; if (!r) return;
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
  const shown = presenting ? [] : (view === 'speaker' && speaker ? [speaker] : participants);
  const others = presenting
    ? participants
    : (view === 'speaker' ? participants.filter((p) => p !== speaker) : []);

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


  return (
    <>
      <style>{CSS}</style>
      <div className="cx-root" ref={rootRef}>
        <header className="cx-top">
          <div style={{ minWidth: 0 }}>
            <div className="cx-title">{meeting?.title ?? 'Meeting'}</div>
            <div className="cx-meta">
              {connState === 'live' && <span className="cx-dot" aria-hidden="true" />}
              <span>{participants.length} {participants.length === 1 ? 'person' : 'people'}</span>
              {meeting?.locked && <span>· Locked</span>}
            </div>
          </div>
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
        {beingRecorded && (
          <div className="cx-banner cx-banner--rec" role="status" aria-live="polite">
            <span className="cx-recdot" aria-hidden="true" />
            <span className="ms-2">This meeting is being recorded.</span>
          </div>
        )}

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
        <div className="cx-stage"
             onDoubleClick={canFull ? toggleFull : undefined}>
          {/* The share, as a tile in its own right. Keyed separately from the
              sharer's camera tile below so React never reuses one <video> for
              both tracks. */}
          {screenSharers.map((p) => (
            <Tile key={`screen-${p.identity}`} p={p} big={screenSharers.length === 1}
                  local={p === room?.localParticipant}
                  showScreen canHost={false} onMute={() => {}} onRemove={() => {}}
                  hand={false} />
          ))}

          {shown.map((p) => (
            <Tile key={p.identity} p={p} big={view === 'speaker'}
                  local={p === room?.localParticipant}
                  showScreen={false} hand={hands[p.identity] === true}
                  canHost={isHost && meeting !== null && p !== room?.localParticipant}
                  onMute={() => void hostAction(() =>
                    connectApi.mute(authedFetch, meeting?.id ?? '', p.identity))}
                  onRemove={() => void hostAction(() =>
                    connectApi.remove(authedFetch, meeting?.id ?? '', p.identity))} />
          ))}
        </div>

        {others.length > 0 && (
          <div className="cx-strip">
            {others.map((p) => (
              <Tile key={p.identity} p={p} big={false} local={p === room?.localParticipant}
                    showScreen={false} hand={hands[p.identity] === true}
                    canHost={false} onMute={() => {}} onRemove={() => {}} />
            ))}
          </div>
        )}

        <div className="cx-bar">
          <button type="button" className={`cx-btn ${micOn ? '' : 'is-off'}`}
                  onClick={() => void toggleMic()} aria-pressed={micOn}
                  title={micOn ? 'Mute' : 'Unmute'}>
            <i className={micOn ? 'ri-mic-line' : 'ri-mic-off-line'} />
            {micOn ? 'Mute' : 'Unmute'}
          </button>

          <button type="button" className={`cx-btn ${camOn ? '' : 'is-off'}`}
                  onClick={() => void toggleCam()} aria-pressed={camOn}
                  title={camOn ? 'Stop video' : 'Start video'}>
            <i className={camOn ? 'ri-vidicon-line' : 'ri-vidicon-off-line'} />
            {camOn ? 'Video' : 'Video'}
          </button>

          <button type="button" className={`cx-btn ${sharing ? 'is-on' : ''}`}
                  onClick={() => void toggleShare()} aria-pressed={sharing}
                  disabled={!mayShare && !sharing}
                  title={mayShare || sharing
                    ? 'Share your screen'
                    : 'The host has limited who can share in this meeting'}>
            <i className="ri-computer-line" />
            {sharing ? 'Stop' : 'Share'}
          </button>

          <button type="button" className="cx-btn"
                  onClick={() => setView(view === 'gallery' ? 'speaker' : 'gallery')}
                  title="Switch layout">
            <i className={view === 'gallery' ? 'ri-layout-grid-line' : 'ri-user-3-line'} />
            {view === 'gallery' ? 'Gallery' : 'Speaker'}
          </button>

          {canFull && (
            <button type="button" className={`cx-btn ${full ? 'is-on' : ''}`}
                    onClick={toggleFull} aria-pressed={full}
                    title={full ? 'Leave full screen (Esc)' : 'Full screen'}>
              <i className={full ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'} />
              {full ? 'Exit' : 'Full'}
            </button>
          )}

          {canPip && (
            <button type="button" className={`cx-btn ${pipOpen ? 'is-on' : ''}`}
                    onClick={() => (pipOpen ? closePip() : void openPip())}
                    aria-pressed={pipOpen}
                    title="Keep the meeting in a small floating window while you work elsewhere">
              <i className="ri-picture-in-picture-exit-line" />
              {pipOpen ? 'Close' : 'Mini'}
            </button>
          )}

          <button type="button" className={`cx-btn ${myHand ? 'is-on' : ''}`}
                  onClick={toggleHand} aria-pressed={myHand}
                  title={myHand ? 'Lower your hand' : 'Raise your hand'}>
            <i className="ri-hand" />
            {myHand ? 'Lower' : 'Hand'}
          </button>

          <span className="cx-btnwrap">
            <button type="button" className={`cx-btn ${panel === 'people' ? 'is-on' : ''}`}
                    onClick={() => openPanel('people')} title="People">
              <i className="ri-group-line" />People
            </button>
            {(knocking.length + Object.values(hands).filter(Boolean).length) > 0 && (
              <span className="cx-count">
                {knocking.length + Object.values(hands).filter(Boolean).length}
              </span>
            )}
          </span>

          <span className="cx-btnwrap">
            <button type="button" className={`cx-btn ${panel === 'chat' ? 'is-on' : ''}`}
                    onClick={() => openPanel('chat')} title="Chat">
              <i className="ri-chat-1-line" />Chat
            </button>
            {unread > 0 && panel !== 'chat' && <span className="cx-count">{unread}</span>}
          </span>

          <button type="button" className={`cx-btn ${panel === 'devices' ? 'is-on' : ''}`}
                  onClick={() => openPanel('devices')} title="Settings">
            <i className="ri-settings-3-line" />Settings
          </button>

          {/* Hidden entirely when this server has no egress, rather than shown
              and refusing. A control that is always there and never works is
              read as a broken product, not as an unconfigured one. */}
          {isHost && meeting && !recOff && (
            <button type="button" className={`cx-btn ${recording ? 'is-rec' : ''}`}
                    onClick={() => void toggleRecording()} disabled={recBusy}
                    aria-pressed={recording !== null}
                    title={recording
                      ? 'Stop recording'
                      : 'Record the audio of this meeting'}>
              <i className={recording ? 'ri-stop-circle-fill' : 'ri-record-circle-line'} />
              {recBusy ? '…' : recording ? 'Stop rec' : 'Record'}
            </button>
          )}

          {isHost && meeting && (
            <button type="button" className="cx-btn"
                    onClick={() => void hostAction(() => connectApi.end(authedFetch, meeting.id))}
                    title="End the meeting for everyone">
              <i className="ri-stop-circle-line" />End
            </button>
          )}

          <button type="button" className="cx-btn cx-btn--leave" onClick={leave} title="Leave">
            <i className="ri-logout-box-r-line" />Leave
          </button>
        </div>

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
              const up = hands[p.identity] === true;
              const role = roles[p.identity];
              const isSharing = p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack !== undefined;
              // Only a signed-in person can hold controls — the same rule the
              // server enforces — and only the HOST hands roles out.
              const roleable = meeting?.myRole === 'host'
                && p !== room?.localParticipant
                && p.identity.startsWith('user:');
              return (
                <div className="cx-row" key={p.identity}>
                  <span className="cx-av">{initialOf(nm)}</span>
                  <div className="cx-grow">
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                  {isHost && meeting && p !== room?.localParticipant && (
                    <>
                      {roleable && role !== 'host' && (
                        <button type="button" className="cx-pill"
                                title={role === 'cohost'
                                  ? 'Take away their co-host controls'
                                  : 'Let them help run the meeting'}
                                onClick={() => void changeRole(p.identity,
                                  role === 'cohost' ? 'participant' : 'cohost')}>
                          {role === 'cohost' ? 'Demote' : 'Co-host'}
                        </button>
                      )}
                      {isSharing && (
                        <button type="button" className="cx-pill"
                                title="Stop their screen share; their camera stays on"
                                onClick={() => void hostAction(() =>
                                  connectApi.mute(authedFetch, meeting.id, p.identity, 'screen'))}>
                          Stop share
                        </button>
                      )}
                      <button type="button" className="cx-pill"
                              onClick={() => void hostAction(() =>
                                connectApi.mute(authedFetch, meeting.id, p.identity))}>Mute</button>
                      {/* Feature 58. The API has taken kind: 'audio' | 'video'
                          since it was written and the UI only ever sent audio —
                          one argument away the whole time. */}
                      <button type="button" className="cx-pill"
                              onClick={() => void hostAction(() =>
                                connectApi.mute(authedFetch, meeting.id, p.identity, 'video'))}>
                        Camera
                      </button>
                      <button type="button" className="cx-pill cx-pill--bad"
                              title="Remove them. A removed colleague cannot rejoin this meeting."
                              onClick={() => void hostAction(() =>
                                connectApi.remove(authedFetch, meeting.id, p.identity))}>Remove</button>
                    </>
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
                     <input className="cx-field" value={draft} maxLength={2000}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="Message everyone" aria-label="Message" />
                     <button className="cx-cta" style={{ width: 'auto', padding: '10px 16px' }}
                             type="submit">Send</button>
                   </form>
                 }>
            <div className="cx-sub" style={{ marginBottom: 10 }}>
              Messages are not saved. When the meeting ends, this goes with it.
            </div>
            {chat.length === 0 && <div className="cx-sub">Nothing yet.</div>}
            {chat.map((c) => (
              <div key={c.id} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: c.mine ? '#8fe6f6' : undefined }}>
                  {c.mine ? 'You' : c.who}
                </div>
                <div style={{ fontSize: 14, wordBreak: 'break-word' }}>{c.text}</div>
              </div>
            ))}
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
          </Panel>
        )}
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
function Tile({ p, big, local, showScreen, hand, canHost, onMute, onRemove }: {
  p: LKParticipant;
  big: boolean;
  local: boolean;
  showScreen: boolean;
  hand: boolean;
  canHost: boolean;
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
             className={`cx-video${local && !showScreen ? ' cx-video--self' : ''}`
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

      {canHost && (
        <div className="cx-tileacts">
          <button type="button" className="cx-pill" onClick={onMute}>Mute</button>
          <button type="button" className="cx-pill cx-pill--bad" onClick={onRemove}>Remove</button>
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
