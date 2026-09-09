/**
 * Screen-share spike. NOT part of the app, and not on any path a user reaches.
 *
 * It exists to answer one question before anything is built around it: can an
 * Android phone capture its screen through LiveKit's WebRTC stack, and does it
 * fail VISIBLY when the person says no?
 *
 * It deliberately needs no sign-in, no meeting and no Connect entitlement. The
 * MediaProjection consent dialog is raised by getDisplayMedia, not by joining a
 * room, so the consent path, the persistent notification and the background and
 * lock behaviour can all be proven with nothing but this screen. The half that
 * needs a real meeting is a separate question and is blocked on the entitlement.
 *
 * THE LOG IS ON SCREEN ON PURPOSE. The two real bugs this codebase has produced
 * were both invisible - an empty log and a spinner. Whoever runs this should be
 * able to see what happened without adb, and should be able to photograph it.
 *
 * To run it: point index.js at this component instead of App, run the app, then
 * put index.js back. It never imports App.js, so it cannot break the real app.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AppState, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { registerGlobals } from '@livekit/react-native';
import { mediaDevices } from '@livekit/react-native-webrtc';

//  Must run before any WebRTC API is touched: it installs the browser-shaped
//  globals the stack expects. Doing it at module scope means it cannot be
//  forgotten by a code path that renders the screen some other way.
registerGlobals();

const stamp = () => new Date().toISOString().slice(11, 23);

export default function ScreenShareSpike() {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('idle');
  const [detail, setDetail] = useState('');
  const stream = useRef(null);
  const scroller = useRef(null);

  const log = (line) => setLines((prev) => [...prev, `${stamp()}  ${line}`]);

  useEffect(() => {
    log(`spike loaded - Android API ${Platform.Version}`);
    //  Backgrounding and locking are two of the things being proven, so they
    //  leave a line rather than relying on someone remembering what they did.
    const sub = AppState.addEventListener('change', (next) => {
      log(`app state -> ${next}${stream.current ? '   (capture is running)' : ''}`);
    });
    return () => sub.remove();
  }, []);

  //  Android 13+ will not show the persistent notification without this, and
  //  without the notification the OS kills the capture. That presents as "the
  //  share randomly stopped", so the grant is logged either way.
  async function askForNotifications() {
    if (Platform.OS !== 'android' || Platform.Version < 33) return true;
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  async function start() {
    setStatus('requesting');
    setDetail('');
    try {
      const notified = await askForNotifications();
      log(notified
        ? 'POST_NOTIFICATIONS granted'
        : 'POST_NOTIFICATIONS DENIED - no notification, so Android will kill the capture');

      log('getDisplayMedia: asking. The OS consent dialog is next.');
      const got = await mediaDevices.getDisplayMedia();
      stream.current = got;

      const track = got.getTracks()[0];
      setStatus('sharing');
      setDetail(track ? `${track.kind} track, readyState=${track.readyState}` : 'no track returned');
      log(`getDisplayMedia GRANTED - ${got.getTracks().length} track(s)`);
      if (track) {
        log(`track id=${track.id} kind=${track.kind} readyState=${track.readyState}`);
        //  The interesting failure: the system stops the capture on its own.
        //  Without this listener that is silent, which is the whole problem.
        try {
          track.addEventListener('ended', () => {
            log('TRACK ENDED - capture stopped. If nobody pressed Stop, the system did.');
            setStatus('ended');
            setDetail('the capture ended on its own');
            stream.current = null;
          });
        } catch (e) {
          log(`could not attach the ended listener: ${String(e)}`);
        }
      }
    } catch (err) {
      //  MediaStreamError is NOT an Error subclass: no .stack, and
      //  `instanceof Error` is false. Reading err.stack here would log
      //  undefined and teach the next person that denial produces nothing.
      const name = (err && err.name) || 'unknown';
      const message = (err && err.message) || String(err);
      setStatus('denied');
      setDetail(`${name}: ${message}`);
      log(`getDisplayMedia REJECTED   name=${name}   message=${message}`);
    }
  }

  function stop() {
    if (!stream.current) {
      log('Stop pressed with nothing running');
      return;
    }
    stream.current.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setStatus('idle');
    setDetail('');
    log('stopped by the button');
  }

  const tone = {
    idle: '#5F5E5A', requesting: '#185FA5', sharing: '#0F6E56',
    denied: '#993556', ended: '#993C1D',
  }[status] || '#5F5E5A';

  return (
    <View style={s.screen}>
      <Text style={s.title}>Screen share spike</Text>

      <View style={[s.status, { borderColor: tone }]}>
        <Text style={[s.statusText, { color: tone }]}>{status.toUpperCase()}</Text>
        {detail ? <Text style={s.detail}>{detail}</Text> : null}
      </View>

      <View style={s.row}>
        <Pressable
          style={[s.button, { backgroundColor: '#0F6E56' }]}
          onPress={start}
          accessibilityLabel="Start screen share"
        >
          <Text style={s.buttonText}>Start screen share</Text>
        </Pressable>
        <Pressable
          style={[s.button, { backgroundColor: '#5F5E5A' }]}
          onPress={stop}
          accessibilityLabel="Stop screen share"
        >
          <Text style={s.buttonText}>Stop</Text>
        </Pressable>
      </View>

      <Text style={s.logLabel}>Log</Text>
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
  screen: { flex: 1, backgroundColor: '#FFFFFF', paddingTop: 56, paddingHorizontal: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#17141F', marginBottom: 16 },
  status: { borderWidth: 2, borderRadius: 6, padding: 12, marginBottom: 16 },
  statusText: { fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  detail: { fontSize: 13, color: '#443E52', marginTop: 4 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  button: { flex: 1, paddingVertical: 14, borderRadius: 6, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  logLabel: { fontSize: 12, fontWeight: '700', color: '#6E6880', letterSpacing: 1, marginBottom: 6 },
  log: { flex: 1, backgroundColor: '#F3F1F8', borderRadius: 6, padding: 10, marginBottom: 20 },
  line: { fontSize: 11, fontFamily: 'monospace', color: '#17141F', marginBottom: 2 },
});
