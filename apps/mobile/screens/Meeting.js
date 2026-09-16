/**
 * A meeting. Join, microphone, camera, speaker, participant tiles, screen
 * share, and leaving cleanly — the v1 Connect scope from the lane brief, §4.
 *
 * Everything hard in this file was learned on 9 September 2026 by running the
 * spikes, first on an emulator and then on a Samsung. Where a line exists
 * because of something measured, the comment says what was measured. Where a
 * line exists because of the API contract and has NOT yet run on a phone, the
 * comment says that too — the waiting-room and password paths are in that
 * second group, as of the night this was written.
 *
 * ---------------------------------------------------------------------------
 *  THE FOUR TRAPS, in the order you will meet them
 *
 *  1. joinMeeting() has two different 200s. { status:'joined' } carries a
 *     token; { status:'waiting' } does not. lib/connect.js returns a `kind`
 *     so this file cannot read a token that is not there.
 *
 *  2. setScreenShareEnabled(true) fails in TWO ways when consent is refused:
 *     on the emulator it resolved undefined; on the Samsung it THREW, with
 *     name="Error" and the meaning in the message — inverted from the W3C
 *     shape, so `err.name === 'NotAllowedError'` never matches. Both exits go
 *     through isRefusal.
 *
 *  3. The capture can stop without anyone pressing anything. On the Samsung,
 *     the screen going off revoked MediaProjection while the socket and the
 *     foreground service stayed alive. Without RoomEvent.LocalTrackUnpublished
 *     this screen would go on saying "sharing" with nothing being sent. That
 *     is worse than stopping: it is the wrong story, told confidently.
 *
 *  4. RoomEvent.Disconnected hands you a NUMBER. Log the name.
 * ---------------------------------------------------------------------------
 *
 *  useKeepAwake() is here because of trap 3. It keeps the display on for the
 *  whole meeting, which turns "the screen timed out and the share died" into
 *  something that can only happen if the person locks the phone on purpose.
 *  That case is then fair to treat as the share ending, and it is reported.
 *
 *  Microphone on, camera off, on join. Joining from a phone with the camera on
 *  by default is the wrong surprise; joining muted is the wrong default for a
 *  device whose whole point is to be spoken into.
 *
 *  SDK NOTE. useRoom, useParticipant and VideoView are marked @deprecated in
 *  @livekit/react-native 2.12 in favour of <LiveKitRoom> and the
 *  components-react hooks. They are still exported, and reading their source
 *  shows they are thin wrappers over the same Room events the proven spike
 *  used. This file stays on the proven path; the migration is a follow-up
 *  that should be done with a phone in hand, not at night without one.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  StyleSheet, BackHandler, PermissionsAndroid, Platform, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context'; // see App.js
import { Ionicons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import { Room, RoomEvent, DisconnectReason, Track } from 'livekit-client';
import {
  AudioSession, VideoView, useRoom, useParticipant, registerGlobals,
} from '@livekit/react-native';

import { joinMeeting, pollWait, getLobby, admitFromLobby, denyFromLobby } from '../lib/connect';
import { isRefusal, describeError } from '../lib/refusal';
import { watchEngines, reapEngines } from '../lib/engineReaper';
import { brand } from '../theme';

registerGlobals();

const log = (line) => console.log(`[meeting] ${line}`);

function reasonName(reason) {
  if (reason === undefined || reason === null) return 'no reason given';
  const name = Object.keys(DisconnectReason)
    .find((k) => DisconnectReason[k] === reason && Number.isNaN(Number(k)));
  return name ? `${name} (${reason})` : `unmapped reason ${reason}`;
}

const REFUSED = 'Screen sharing needs your permission. Nothing was shared.';
const WAIT_POLL_MS = 2000; // docs/CONNECT_API.md: "client polls every 2 s"
const LOBBY_POLL_MS = 3000; // host side has no push either (Open Question §4)

/**
 * Ask Android for the runtime permissions a call needs, BEFORE the first
 * getUserMedia. Asked here rather than left to the WebRTC layer so that a
 * refusal is a named thing in the log and not a track that silently never
 * publishes. POST_NOTIFICATIONS is in the list because on Android 13+ the
 * screen-share foreground service's notification is invisible without it —
 * and "notification appears" is in the definition of done.
 *
 * Returns the map of permission -> 'granted' | 'denied' | 'never_ask_again'.
 * Nothing here is fatal: a person who refuses the microphone can still watch.
 */
async function askPermissions() {
  if (Platform.OS !== 'android') return {};
  try {
    // Everything inside the try, including reading the constants: a missing
    // native module here must cost the permission prompt, not the join.
    const wanted = [
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    ].filter(Boolean);
    const result = await PermissionsAndroid.requestMultiple(wanted);
    log(`permissions: ${wanted.map((p) => `${p.split('.').pop()}=${result[p]}`).join(' ')}`);
    return result;
  } catch (e) {
    log(`permission request failed: ${describeError(e)}`);
    return {};
  }
}

// What the screen says when the connection drops without anyone pressing
// Leave. Honest about what happened and what to do; never "You have left",
// which is what this said on 16 Sept while Amit had done nothing but lock the
// phone.
function dropSentence(reason) {
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
    return 'This account joined the meeting from another device, so this phone was taken out.';
  }
  return 'The connection to the meeting dropped. This often happens after the phone is locked.';
}

/**
 * The meeting screen, plus Rejoin.
 *
 * Rejoin mounts a brand-new session (new Room, new token, new engine) rather
 * than calling connect() again on the old Room. The old Room is the one whose
 * engine lost a race with its own reconnect (lib/engineReaper.js); it is not
 * something to reuse, and a fresh mount goes through exactly the join path
 * that is already proven on the phone, waiting room and password included.
 */
export default function Meeting(props) {
  const [attempt, setAttempt] = useState(0);
  return (
    <MeetingSession
      key={attempt}
      {...props}
      onRejoin={() => { log(`rejoining (attempt ${attempt + 2})`); setAttempt((n) => n + 1); }}
    />
  );
}

function MeetingSession({ session, meeting, onLeave, onRejoin }) {
  useKeepAwake();

  // ── THE TOKEN IS READ FRESH; THE SESSION IS NOT A REASON TO RECONNECT. ──
  //
  // Access tokens last fifteen minutes and api.js now renews one when a
  // request meets an expired token (16 Sept 2026). The renewal hands App.js a
  // NEW session object. The join effect below used to list `session` as a
  // dependency — and its cleanup disconnects the room and stops the audio. So
  // a host's lobby poll hitting 401 at minute fifteen would have renewed the
  // token, re-run that effect, and dropped the call for everyone watching
  // them, every fifteen minutes. Reading the token through this ref keeps each
  // request current without the effect ever noticing the session changed.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // One Room per mount. useState's initialiser runs once, which is what makes
  // useRoom below stable across renders.
  const [room] = useState(() => new Room());
  const { participants } = useRoom(room);

  // Every engine this Room uses, kept by us because the Room drops its own
  // reference before it has finished closing it. See lib/engineReaper.js.
  const [engines] = useState(() => watchEngines(room, log));

  // joining | password | waiting | in | blocked | failed | dropped
  const [status, setStatus] = useState('joining');
  const [notice, setNotice] = useState('');
  const [password, setPassword] = useState('');
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [facing, setFacing] = useState('user');
  const [share, setShare] = useState(false);

  // One screen at a time, or several — the host's choice (Connect PR #130).
  // The SERVER enforces it: in 'single' mode everyone else's grant narrows the
  // moment somebody presents, so pressing Share would fail. This state only
  // lets the screen SAY who is presenting instead of offering a button that
  // cannot work. A server that predates the setting sends nothing, and what it
  // did was 'multiple'.
  const [shareMode, setShareMode] = useState(meeting?.shareMode === 'single' ? 'single' : 'multiple');
  const [speaker, setSpeaker] = useState(true);
  const [role, setRole] = useState(null); // host | cohost | participant, once admitted
  const [lobby, setLobby] = useState([]); // people waiting, host/cohost only
  const leaving = useRef(false);
  const waitTimer = useRef(null);
  const gone = useRef(false); // set on unmount; every async path checks it

  function stopWaiting() {
    if (waitTimer.current) { clearTimeout(waitTimer.current); waitTimer.current = null; }
  }

  // The part after we hold a LiveKit token. Shared by the direct join, the
  // password retry and the waiting-room admission, so there is one place that
  // connects, one place that turns the mic on, and one place that sets the
  // speaker to match what the button says.
  async function enter(admitted) {
    await room.connect(admitted.wsUrl, admitted.token);
    engines.note();
    if (gone.current) { room.disconnect().catch(() => {}).finally(() => reapEngines(engines, log)); return; }
    log(`in the room as ${admitted.identity} (${admitted.role})`);
    setRole(admitted.role);
    setStatus('in');

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMic(true);
    } catch (e) {
      // Joining without a mic is recoverable; not knowing why is not.
      log(`microphone did not start: ${describeError(e)}`);
      setNotice(isRefusal(e)
        ? 'Your microphone is off: the app was not given permission.'
        : 'Your microphone is off. Tap the mic to try again.');
    }

    // The speaker button starts in the "on" position. Make that true rather
    // than assume it. If the phone does not offer 'speaker' the button state
    // is corrected instead, so it never claims an output it does not have.
    try {
      const outputs = await AudioSession.getAudioOutputs();
      log(`audio outputs: ${outputs.join(', ') || 'none reported'}`);
      if (outputs.includes('speaker')) await AudioSession.selectAudioOutput('speaker');
      else setSpeaker(false);
    } catch (e) {
      log(`could not select the speaker: ${describeError(e)}`);
      setSpeaker(false);
    }
  }

  // Try to get in with whatever we have. Sets the screen state for every
  // answer the API can give, including the ones that are not "yes".
  async function admit(pw) {
    let admitted;
    try {
      admitted = await joinMeeting(sessionRef.current.accessToken, meeting.id, pw);
    } catch (e) {
      if (gone.current) return;
      if (e?.status === 403) {
        // The meeting has a password and we did not send the right one. Not
        // an error to the person; a question. UNTESTED on a phone as of the
        // night this was written — the API contract says 403, the screen
        // believes it.
        log(pw ? 'password rejected' : 'meeting needs a password');
        setStatus('password');
        setNotice(pw ? 'That password was not accepted.' : 'This meeting needs a password.');
        return;
      }
      throw e;
    }
    if (gone.current) return;

    if (admitted.kind === 'joined') { await enter(admitted); return; }

    if (admitted.kind === 'waiting') {
      // Trap 1. A 200 that did not admit us. Wait, and keep asking.
      log('parked in the waiting room; polling');
      setStatus('waiting');
      setNotice(admitted.message);
      const poll = async () => {
        if (gone.current) return;
        try {
          const answer = await pollWait(sessionRef.current.accessToken, admitted.waitToken);
          if (gone.current) return;
          if (answer.kind === 'waiting') {
            waitTimer.current = setTimeout(poll, WAIT_POLL_MS);
            return;
          }
          if (answer.kind === 'joined') {
            log('admitted from the waiting room');
            setNotice('');
            await enter(answer);
            return;
          }
          // denied, gone, unexpected: all terminal, all named
          log(`waiting room ended: ${answer.kind}${answer.detail ? ' ' + answer.detail : ''}`);
          setStatus('blocked');
          setNotice(answer.message);
        } catch (e) {
          if (gone.current) return;
          log(`wait poll failed: ${describeError(e)}`);
          setStatus('failed');
          setNotice('Lost contact with the waiting room.');
        }
      };
      waitTimer.current = setTimeout(poll, WAIT_POLL_MS);
      return;
    }

    log(`not admitted: ${admitted.kind} ${admitted.detail ?? ''}`);
    setStatus('blocked');
    setNotice(admitted.message);
  }

  useEffect(() => {
    gone.current = false;

    room.on(RoomEvent.Disconnected, (reason) => {
      log(`disconnected: ${reasonName(reason)}`);
      if (!leaving.current) {
        // Nobody pressed Leave. Say so, offer the way back, and make sure the
        // library is not quietly rejoining behind the screen's back — the
        // ghost the laptop saw on 16 Sept.
        stopWaiting();
        setStatus('dropped');
        setShare(false);
        setMic(false);
        setCam(false);
        setNotice(dropSentence(reason));
        reapEngines(engines, log);
      }
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub?.source === Track.Source.ScreenShare) {
        // Trap 3. This fires whether the person pressed Stop or the OS took the
        // capture away; either way "sharing" is no longer true.
        log('screen share track unpublished — the share has stopped');
        setShare(false);
        setNotice('Screen sharing stopped.');
      }
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => log(`connection -> ${state}`));

    // The web host's "Screens at once" select broadcasts {shareMode} on the
    // data channel (Stage.tsx changeShareMode). Everything else on that channel
    // — hands, reactions, chat — is not ours to read and is ignored. Decoded by
    // hand rather than with TextDecoder: the message is short ASCII JSON, and
    // whether Hermes provides TextDecoder depends on which polyfills happen to
    // be loaded, which is not a thing to find out from a silent catch.
    room.on(RoomEvent.DataReceived, (payload) => {
      try {
        let text = '';
        for (let i = 0; i < payload.length; i++) text += String.fromCharCode(payload[i]);
        const msg = JSON.parse(text);
        if (msg && (msg.shareMode === 'single' || msg.shareMode === 'multiple')) {
          log(`share mode is now ${msg.shareMode}`);
          setShareMode(msg.shareMode);
        }
      } catch { /* not a message for this screen */ }
    });
    room.on(RoomEvent.ParticipantConnected, (p) => log(`joined: ${p.identity}`));
    room.on(RoomEvent.ParticipantDisconnected, (p) => log(`left: ${p.identity}`));

    (async () => {
      try {
        await askPermissions();
        if (gone.current) return;
        await AudioSession.startAudioSession();
        await admit(undefined);
      } catch (e) {
        if (gone.current) return;
        log(`join failed: ${describeError(e)}${e?.status ? ` (HTTP ${e.status})` : ''}`);
        setStatus('failed');
        // 409 carries the server's own sentence ("This meeting is locked.");
        // it is better than anything we would write here.
        setNotice(e?.message ? `Could not join: ${e.message}` : 'Could not join the meeting.');
      }
    })();

    return () => {
      gone.current = true;
      stopWaiting();
      // A live capture outlives a React tree, and the foreground service keeps
      // it alive. Leaving on unmount is not tidiness; it is what stops a share
      // running after the screen that started it has gone.
      room.disconnect().catch(() => {}).finally(() => reapEngines(engines, log));
      AudioSession.stopAudioSession().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // NOT `session`: see sessionRef at the top. A renewed token must never
    // re-run this effect, because its cleanup ends the call.
  }, [room, meeting]);

  // Waiting room, host side. Only a host or cohost may ask; everyone else gets
  // a 403, and a 403 stops the polling for good rather than being retried
  // every three seconds for the length of the meeting. The list is compared
  // before it is logged, so a quiet lobby does not fill the log.
  useEffect(() => {
    if (status !== 'in' || !(role === 'host' || role === 'cohost')) return undefined;
    let stopped = false;
    let timer = null;
    let lastKey = '';
    const poll = async () => {
      if (stopped) return;
      try {
        const waiting = await getLobby(sessionRef.current.accessToken, meeting.id);
        if (stopped) return;
        const key = waiting.map((w) => w.requestId).join(',');
        if (key !== lastKey) {
          lastKey = key;
          log(`lobby: ${waiting.length} waiting${waiting.length ? ' — ' + waiting.map((w) => w.displayName).join(', ') : ''}`);
          setLobby(waiting);
        }
      } catch (e) {
        if (stopped) return;
        if (e?.status === 403) { log('lobby: not allowed to see it; will not ask again'); return; }
        log(`lobby poll failed: ${describeError(e)}`);
      }
      timer = setTimeout(poll, LOBBY_POLL_MS);
    };
    poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [status, role, meeting]);   // not `session` — the ref keeps the token current

  async function decide(requestId, verdict) {
    const call = verdict === 'admit' ? admitFromLobby : denyFromLobby;
    try {
      await call(sessionRef.current.accessToken, meeting.id, requestId);
      log(`lobby: ${verdict} ${requestId}`);
      setLobby((l) => l.filter((w) => w.requestId !== requestId));
    } catch (e) {
      log(`lobby ${verdict} failed: ${describeError(e)}`);
      setNotice(`Could not ${verdict === 'admit' ? 'admit' : 'turn away'} that person.`);
    }
  }

  // The invite is the meeting's joinUrl from the API — the same link the web
  // shows — handed to the system share sheet. The URL is a capability, so it
  // is not written to the log.
  async function invite() {
    if (!meeting?.joinUrl) { setNotice('This meeting has no link to share.'); return; }
    try {
      await Share.share({ message: `Join "${meeting.title || 'Meeting'}" on TatvaOS Connect: ${meeting.joinUrl}` });
      log('invite link handed to the share sheet');
    } catch (e) {
      log(`share sheet failed: ${describeError(e)}`);
      setNotice('Could not open the share sheet.');
    }
  }

  // The Android back button leaves the meeting, the same as the Leave button.
  // There is no "minimised call" in v1, so the honest thing back can do is
  // the thing it looks like it does. Returning true stops the app itself from
  // being backgrounded with a call still running in it.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      log('back button: leaving');
      leave();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitPassword() {
    if (!password) return;
    setStatus('joining');
    setNotice('');
    try {
      await admit(password);
    } catch (e) {
      if (gone.current) return;
      log(`join with password failed: ${describeError(e)}`);
      setStatus('failed');
      setNotice(e?.message ? `Could not join: ${e.message}` : 'Could not join the meeting.');
    }
  }

  async function toggleMic() {
    try {
      await room.localParticipant.setMicrophoneEnabled(!mic);
      setMic(!mic);
    } catch (e) {
      log(`mic toggle failed: ${describeError(e)}`);
      setNotice(isRefusal(e) ? 'The microphone needs your permission.' : 'Could not change the microphone.');
    }
  }

  async function toggleCam() {
    try {
      await room.localParticipant.setCameraEnabled(!cam, { facingMode: facing });
      setCam(!cam);
    } catch (e) {
      log(`camera toggle failed: ${describeError(e)}`);
      setNotice(isRefusal(e) ? 'The camera needs your permission.' : 'Could not change the camera.');
    }
  }

  // Front/back. restartTrack re-acquires the capture with new constraints on
  // the same publication, so the other side sees a swap, not a drop. UNTESTED
  // on a phone as of the night this was written; the failure is reported.
  async function flipCam() {
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (!pub?.track) { setNotice('Turn the camera on first.'); return; }
      await pub.track.restartTrack({ facingMode: next });
      setFacing(next);
      log(`camera now ${next}`);
    } catch (e) {
      log(`camera flip failed: ${describeError(e)}`);
      setNotice('Could not switch cameras.');
    }
  }

  async function toggleShare() {
    setNotice('');
    if (share) {
      try { await room.localParticipant.setScreenShareEnabled(false); } catch (e) { log(`stop share: ${describeError(e)}`); }
      setShare(false);
      return;
    }
    try {
      log('requesting screen capture; the system consent sheet is next');
      const pub = await room.localParticipant.setScreenShareEnabled(true);
      if (!pub) {
        // Trap 2, exit one: resolved with nothing. The emulator does this.
        log('setScreenShareEnabled resolved with no publication — refused, or nothing to publish');
        setNotice(REFUSED);
        return;
      }
      log(`sharing screen: ${pub.trackSid}`);
      setShare(true);
    } catch (e) {
      // Trap 2, exit two: threw. The Samsung does this, with the inverted shape.
      if (isRefusal(e)) {
        log(`refused by the person — ${describeError(e)}`);
        setNotice(REFUSED);
        return;
      }
      log(`share failed — ${describeError(e)}`);
      setNotice('Screen sharing could not start. Nothing was shared.');
    }
  }

  async function toggleSpeaker() {
    try {
      const outputs = await AudioSession.getAudioOutputs();
      log(`audio outputs: ${outputs.join(', ') || 'none reported'}`);
      const want = speaker ? 'earpiece' : 'speaker';
      if (!outputs.includes(want)) {
        setNotice(`This phone offers: ${outputs.join(', ') || 'no audio outputs'}.`);
        return;
      }
      await AudioSession.selectAudioOutput(want);
      setSpeaker(!speaker);
    } catch (e) {
      log(`speaker toggle failed: ${describeError(e)}`);
      setNotice('Could not change the audio output.');
    }
  }

  async function leave() {
    if (leaving.current) return;
    leaving.current = true;
    stopWaiting();
    log('leaving');
    await room.disconnect().catch(() => {});
    reapEngines(engines, log);
    onLeave();
  }

  const title = meeting?.title || 'Meeting';
  const inCall = status === 'in';
  const others = Math.max(0, participants.length - 1);

  // Who else is presenting, in a one-at-a-time meeting. Never ourselves: a
  // person already sharing keeps their Stop button.
  const otherPresenter = shareMode === 'single' && !share
    ? participants.find((p) => !p.isLocal && p.isScreenShareEnabled)
    : undefined;

  let headline;
  if (status === 'in') headline = others === 0 ? 'Only you so far' : `${others + 1} in the meeting`;
  else if (status === 'joining') headline = 'Joining…';
  else if (status === 'waiting') headline = 'In the waiting room';
  else if (status === 'password') headline = 'Password needed';
  else if (status === 'dropped') headline = 'Connection dropped';
  else headline = 'Not in the meeting';

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          <Text style={s.count}>{headline}</Text>
        </View>
        {meeting?.joinUrl ? (
          <Pressable style={s.invite} onPress={invite} accessibilityRole="button" accessibilityLabel="Invite">
            <Ionicons name="share-social-outline" size={18} color="#EAE6F3" />
            <Text style={s.inviteText}>Invite</Text>
          </Pressable>
        ) : null}
      </View>

      {lobby.length ? (
        <View style={s.lobby}>
          <Text style={s.lobbyTitle}>Waiting to join</Text>
          {lobby.map((w) => (
            <View key={w.requestId} style={s.lobbyRow}>
              <Text style={s.lobbyName} numberOfLines={1}>
                {w.displayName || 'Someone'}{w.isGuest ? ' (guest)' : ''}
              </Text>
              <Pressable style={s.lobbyAdmit} onPress={() => decide(w.requestId, 'admit')} accessibilityLabel={`Admit ${w.displayName || 'guest'}`}>
                <Text style={s.lobbyAdmitText}>Admit</Text>
              </Pressable>
              <Pressable style={s.lobbyDeny} onPress={() => decide(w.requestId, 'deny')} accessibilityLabel={`Turn away ${w.displayName || 'guest'}`}>
                <Text style={s.lobbyDenyText}>Deny</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {notice ? (
        <View style={s.notice}>
          <Ionicons name="information-circle-outline" size={18} color="#C9C4D8" />
          <Text style={s.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {status === 'joining' || status === 'waiting' ? (
        <View style={s.centre}>
          <ActivityIndicator color={brand.soft} />
          <Text style={s.sub}>
            {status === 'waiting' ? 'Waiting for the host to let you in…' : 'Joining…'}
          </Text>
        </View>
      ) : status === 'password' ? (
        <View style={s.centre}>
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Meeting password"
            placeholderTextColor="#7C7890"
            secureTextEntry
            autoFocus
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={submitPassword}
            accessibilityLabel="Meeting password"
          />
          <Pressable style={[s.primary, !password && s.primaryDisabled]} onPress={submitPassword} disabled={!password}>
            <Text style={s.primaryText}>Join</Text>
          </Pressable>
        </View>
      ) : inCall ? (
        <ScrollView contentContainerStyle={s.tiles}>
          {participants.map((p) => <Tile key={p.sid || p.identity} participant={p} />)}
        </ScrollView>
      ) : (
        <View style={s.centre}>
          {status === 'dropped' ? (
            <>
              <Text style={s.sub}>You are no longer in the meeting.</Text>
              <Pressable style={s.primary} onPress={onRejoin} accessibilityRole="button" accessibilityLabel="Rejoin the meeting">
                <Text style={s.primaryText}>Rejoin</Text>
              </Pressable>
            </>
          ) : (
            <Text style={s.sub}>{notice || 'Not in the meeting.'}</Text>
          )}
        </View>
      )}

      <View style={s.bar}>
        {inCall && otherPresenter ? (
          <Text style={s.hint}>
            {otherPresenter.name || 'Someone'} is sharing — one screen at a time in this meeting.
          </Text>
        ) : inCall && cam ? <Text style={s.hint}>Hold the camera button to switch cameras.</Text> : null}
        <View style={s.controls}>
        <Control icon={mic ? 'mic' : 'mic-off'} label={mic ? 'Mute' : 'Unmute'} on={mic} onPress={toggleMic} disabled={!inCall} />
        <Control icon={cam ? 'videocam' : 'videocam-off'} label={cam ? 'Cam off' : 'Camera'} on={cam} onPress={toggleCam} onLongPress={cam ? flipCam : undefined} disabled={!inCall} />
        <Control icon="phone-portrait-outline" label={share ? 'Stop share' : 'Share'} on={share} onPress={toggleShare} disabled={!inCall || !!otherPresenter} />
        <Control icon={speaker ? 'volume-high' : 'ear-outline'} label={speaker ? 'Speaker' : 'Earpiece'} on={speaker} onPress={toggleSpeaker} disabled={!inCall} />
        <Control icon="call" label="Leave" danger onPress={leave} />
        </View>
      </View>
    </SafeAreaView>
  );
}

function Tile({ participant }) {
  const {
    cameraPublication, screenSharePublication, microphonePublication, isSpeaking, isLocal,
  } = useParticipant(participant);
  const screenTrack = screenSharePublication?.track;
  const camTrack = cameraPublication?.track;
  const screenLive = screenTrack && !screenSharePublication?.isMuted;
  const camLive = camTrack && !cameraPublication?.isMuted;

  // For OTHER people, a shared screen wins over a face: it is the thing they
  // chose to show. For YOURSELF, showing your own screen share on the very
  // screen being shared is a hall of mirrors — the camera (or the avatar)
  // stays, and the label says the screen is going out.
  let track = null;
  if (!isLocal && screenLive) track = screenTrack;
  else if (camLive) track = camTrack;

  const micOff = !microphonePublication || microphonePublication.isMuted;
  const name = participant.name || participant.identity || 'Someone';
  const initial = name.replace(/^user:|^guest:/, '').slice(0, 1).toUpperCase();

  return (
    <View style={[s.tile, isSpeaking && s.tileSpeaking]}>
      {track ? (
        <VideoView
          style={s.video}
          videoTrack={track}
          objectFit={track === screenTrack ? 'contain' : 'cover'}
          mirror={isLocal && track === camTrack}
        />
      ) : (
        <View style={s.avatar}><Text style={s.avatarText}>{initial}</Text></View>
      )}
      <View style={s.tileBar}>
        {micOff ? <Ionicons name="mic-off" size={13} color="#FFB4AB" /> : null}
        <Text style={s.tileName} numberOfLines={1}>
          {name}{isLocal ? ' (you)' : ''}
          {isLocal && screenLive ? ' · sharing screen' : ''}
          {!isLocal && track === screenTrack && track ? ' · screen' : ''}
        </Text>
      </View>
    </View>
  );
}

function Control({ icon, label, on, danger, disabled, onPress, onLongPress }) {
  const ink = danger || on ? '#FFFFFF' : '#EAE6F3';
  return (
    <Pressable
      style={[s.control, on && s.controlOn, danger && s.controlDanger, disabled && s.controlDisabled]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={22} color={ink} />
      <Text style={[s.controlLabel, { color: ink }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#15141B' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 8 },
  invite: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#2A2536',
  },
  inviteText: { color: '#EAE6F3', fontSize: 13, fontWeight: '600' },
  lobby: { marginHorizontal: 18, marginBottom: 8, padding: 10, borderRadius: 8, backgroundColor: '#2A2536', gap: 8 },
  lobbyTitle: { color: '#C9C4D8', fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  lobbyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lobbyName: { flex: 1, color: '#FFFFFF', fontSize: 14 },
  lobbyAdmit: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: brand.base },
  lobbyAdmitText: { color: brand.onBase, fontSize: 13, fontWeight: '600' },
  lobbyDeny: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: '#3A3548' },
  lobbyDenyText: { color: '#EAE6F3', fontSize: 13, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  count: { fontSize: 13, color: '#9C99AB', marginTop: 2 },
  notice: {
    flexDirection: 'row', gap: 8, alignItems: 'center',
    marginHorizontal: 18, marginBottom: 8, padding: 10,
    backgroundColor: '#2A2536', borderRadius: 8,
  },
  noticeText: { flex: 1, color: '#EAE6F3', fontSize: 13, lineHeight: 18 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  sub: { color: '#9C99AB', fontSize: 15, textAlign: 'center' },
  input: {
    alignSelf: 'stretch', height: 48, borderRadius: 8, paddingHorizontal: 14,
    backgroundColor: '#242030', color: '#FFFFFF', fontSize: 16,
    borderWidth: 1, borderColor: '#3A3548',
  },
  primary: {
    alignSelf: 'stretch', height: 48, borderRadius: 8, backgroundColor: brand.base,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: brand.onBase, fontSize: 16, fontWeight: '500' },
  tiles: { padding: 12, gap: 10 },
  tile: {
    height: 220, borderRadius: 12, overflow: 'hidden', backgroundColor: '#242030',
    borderWidth: 2, borderColor: 'transparent', justifyContent: 'center', alignItems: 'center',
  },
  tileSpeaking: { borderColor: brand.soft },
  video: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  avatar: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: brand.base,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: brand.onBase, fontSize: 30, fontWeight: '600' },
  tileBar: {
    position: 'absolute', left: 10, bottom: 8, maxWidth: '90%',
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
  },
  tileName: { color: '#FFFFFF', fontSize: 13, flexShrink: 1 },
  bar: { borderTopWidth: 1, borderTopColor: '#2A2536', backgroundColor: '#1B1824' },
  controls: { flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 8, gap: 6 },
  control: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 8, borderRadius: 10, backgroundColor: '#2A2536' },
  controlOn: { backgroundColor: brand.base },
  controlDanger: { backgroundColor: '#B3261E' },
  controlDisabled: { opacity: 0.4 },
  controlLabel: { fontSize: 11 },
  hint: { color: '#7C7890', fontSize: 11, textAlign: 'center', paddingTop: 8 },
});
