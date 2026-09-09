/**
 * The second half of the screen-share spike: a REAL meeting.
 *
 * ScreenShareSpike.js proved the capture mechanism — consent, visible denial,
 * the foreground service surviving background and lock. It proved nothing about
 * whether anyone can SEE the screen, because it never joined a room. This does
 * that: sign in from the keychain, get into a Connect meeting, publish the
 * screen, and show a second participant arriving.
 *
 * The definition of done, from the CTO's brief:
 *   "One real Android phone, in a real meeting, sharing its screen to a second
 *    participant on the web who can see it."
 *
 * This gets everything except "real phone". An emulator cannot speak to
 * thermals, a call interrupting, or OEM variation in the consent sheet — see
 * WELCOME §5. What it can settle is whether the pipe works end to end.
 *
 * HOW TO RUN IT
 *   1. point index.js at this component, reload Metro
 *   2. the device must already be signed in — this reads the keychain and does
 *      not show a login form
 *   3. press Join. The join URL appears on screen; open it in a browser as a
 *      second person
 *   4. press Share screen, allow consent
 *   5. the browser should show the phone's screen, and Participants should read 1
 *
 * IT CREATES A REAL MEETING in the real tenant if none is upcoming — an instant
 * one called "Screen share spike". That is production data. It is cheap and
 * cancellable (DELETE /api/connect/meetings/{id}), but it is not nothing, and
 * it is why the screen says which meeting it picked rather than silently using
 * one.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView, StyleSheet, Text, View, Pressable,
} from 'react-native';
import { registerGlobals } from '@livekit/react-native';
import { Room, RoomEvent, DisconnectReason } from 'livekit-client';

import { restore } from '../api';
import { listMeetings, createMeeting, joinMeeting } from '../lib/connect';
import { brand, surface, text as ink } from '../theme';

registerGlobals();

const stamp = () => new Date().toISOString().slice(11, 23);

/**
 * RoomEvent.Disconnected hands you a NUMBER. Logging it raw produces
 * "room disconnected: 2", which tells the reader nothing and cost a round trip
 * looking the enum up — the value lives in @livekit/protocol, not in this
 * package's own typings. livekit-client re-exports the enum, so the name is
 * available and there is no reason to print the number alone.
 */
function reasonName(reason) {
  if (reason === undefined || reason === null) return 'no reason given';
  const name = Object.keys(DisconnectReason)
    .find((k) => DisconnectReason[k] === reason && Number.isNaN(Number(k)));
  return name ? `${name} (${reason})` : `unmapped reason ${reason}`;
}

export default function ConnectShareSpike() {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('idle');
  const [detail, setDetail] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [peers, setPeers] = useState(0);
  const room = useRef(null);
  const scroller = useRef(null);

  const log = useCallback(
    (line) => setLines((prev) => [...prev, `${stamp()}  ${line}`]),
    [],
  );

  useEffect(() => {
    log('spike loaded — reads the keychain, shows no login form');
    return () => {
      // Leaving a room on unmount matters more than it looks: a live capture
      // outlives a React tree, and the foreground service keeps it alive.
      if (room.current) room.current.disconnect().catch(() => {});
    };
  }, [log]);

  async function join() {
    setStatus('joining');
    setDetail('');
    try {
      const session = await restore();
      if (!session?.accessToken) {
        setStatus('signed out');
        setDetail('No stored session. Sign in with the normal app first.');
        log('no session in the keychain — nothing to do');
        return;
      }
      log('session restored from the keychain');

      let meeting = (await listMeetings(session.accessToken, 'upcoming'))[0];
      if (meeting) {
        log(`using an existing meeting: ${meeting.title || meeting.id}`);
      } else {
        log('no upcoming meeting — creating one (this is real data)');
        meeting = await createMeeting(session.accessToken, 'Screen share spike');
        log(`created ${meeting.id}`);
      }
      setJoinUrl(meeting.joinUrl || '');

      const admitted = await joinMeeting(session.accessToken, meeting.id);
      if (admitted.kind !== 'joined') {
        setStatus(admitted.kind);
        setDetail(admitted.message);
        log(`join did not admit us: ${admitted.kind} — ${admitted.message}`);
        return;
      }
      log(`token minted, identity ${admitted.identity}, role ${admitted.role}`);

      const r = new Room();
      room.current = r;
      r.on(RoomEvent.ParticipantConnected, (p) => {
        log(`participant joined: ${p.identity}`);
        setPeers(r.remoteParticipants.size);
      });
      r.on(RoomEvent.ParticipantDisconnected, (p) => {
        log(`participant left: ${p.identity}`);
        setPeers(r.remoteParticipants.size);
      });
      r.on(RoomEvent.Disconnected, (reason) => {
        log(`room disconnected: ${reasonName(reason)}`);
        setStatus('disconnected');
      });

      await r.connect(admitted.wsUrl, admitted.token);
      setPeers(r.remoteParticipants.size);
      setStatus('in the meeting');
      setDetail(meeting.joinUrl || '');
      log(`connected to ${admitted.wsUrl}`);
    } catch (e) {
      setStatus('failed');
      setDetail(e?.message ?? String(e));
      log(`failed: ${e?.name ?? 'unknown'} ${e?.message ?? String(e)}`);
    }
  }

  async function share() {
    if (!room.current) {
      log('share pressed before joining');
      return;
    }
    try {
      log('publishing the screen — the consent sheet is next');
      const publication = await room.current.localParticipant.setScreenShareEnabled(true);
      if (!publication) {
        // setScreenShareEnabled resolves with undefined when nothing was
        // published. Consent refused looks exactly like this, and without the
        // line below it is silent.
        setStatus('not sharing');
        setDetail('The screen was not shared. Consent was most likely refused.');
        log('setScreenShareEnabled resolved with no publication — refused, or nothing to publish');
        return;
      }
      setStatus('sharing');
      setDetail(`published ${publication.trackSid}`);
      log(`screen published: ${publication.trackSid}`);
    } catch (e) {
      setStatus('share failed');
      setDetail(e?.message ?? String(e));
      log(`share failed: ${e?.name ?? 'unknown'} ${e?.message ?? String(e)}`);
    }
  }

  async function leave() {
    if (!room.current) { log('leave pressed with no room'); return; }
    await room.current.disconnect().catch(() => {});
    room.current = null;
    setStatus('left');
    setDetail('');
    setPeers(0);
    log('left the meeting');
  }

  const tone = status === 'sharing' ? '#1B6B45'
    : status === 'in the meeting' ? brand.base
      : /fail|not sharing|signed out|waiting|unexpected/.test(status) ? '#993556'
        : ink.secondary;

  return (
    <View style={s.screen}>
      <Text style={s.title}>Connect share spike</Text>

      <View style={[s.status, { borderColor: tone }]}>
        <Text style={[s.statusText, { color: tone }]}>{status.toUpperCase()}</Text>
        {detail ? <Text style={s.detail} selectable>{detail}</Text> : null}
        <Text style={s.peers}>Remote participants: {peers}</Text>
      </View>

      {joinUrl ? (
        <View style={s.urlBox}>
          <Text style={s.urlLabel}>OPEN THIS AS THE SECOND PERSON</Text>
          <Text style={s.url} selectable>{joinUrl}</Text>
        </View>
      ) : null}

      <View style={s.row}>
        <Pressable style={[s.button, { backgroundColor: brand.base }]} onPress={join}>
          <Text style={s.buttonText}>Join</Text>
        </Pressable>
        <Pressable style={[s.button, { backgroundColor: '#1B6B45' }]} onPress={share}>
          <Text style={s.buttonText}>Share screen</Text>
        </Pressable>
        <Pressable style={[s.button, { backgroundColor: ink.secondary }]} onPress={leave}>
          <Text style={s.buttonText}>Leave</Text>
        </Pressable>
      </View>

      <Text style={s.logLabel}>LOG</Text>
      <ScrollView
        style={s.log}
        ref={scroller}
        onContentSizeChange={() => scroller.current && scroller.current.scrollToEnd({ animated: false })}
      >
        {lines.map((l, i) => <Text key={i} style={s.line}>{l}</Text>)}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page, paddingTop: 52, paddingHorizontal: 18 },
  title: { fontSize: 21, fontWeight: '700', color: ink.primary, marginBottom: 14 },
  status: { borderWidth: 2, borderRadius: 6, padding: 12, marginBottom: 12, backgroundColor: surface.card },
  statusText: { fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  detail: { fontSize: 12, color: ink.secondary, marginTop: 4 },
  peers: { fontSize: 12, color: ink.secondary, marginTop: 6, fontWeight: '600' },
  urlBox: { backgroundColor: surface.card, borderWidth: 1, borderColor: surface.border, borderRadius: 6, padding: 10, marginBottom: 12 },
  urlLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1, color: ink.muted, marginBottom: 4 },
  url: { fontSize: 12, color: ink.primary, fontFamily: 'monospace' },
  row: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  button: { flex: 1, paddingVertical: 12, borderRadius: 6, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  logLabel: { fontSize: 10, fontWeight: '700', color: ink.muted, letterSpacing: 1, marginBottom: 5 },
  log: { flex: 1, backgroundColor: surface.card, borderWidth: 1, borderColor: surface.border, borderRadius: 6, padding: 9, marginBottom: 18 },
  line: { fontSize: 10.5, fontFamily: 'monospace', color: ink.primary, marginBottom: 2 },
});
