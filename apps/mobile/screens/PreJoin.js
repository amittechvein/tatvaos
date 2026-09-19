/**
 * The moment before a meeting: what you walk in with.
 *
 * Amit on his own phone, 19 Sept 2026: "in mobile app join meeting also give
 * all options". Until then a tap on Join WAS the join — microphone live,
 * camera off, loudspeaker on, no question asked. That is the wrong default in
 * exactly the cases that matter: joining a 300-person meeting from a corridor
 * with a hot mic, or wanting to be seen from the first second. The web has had
 * this screen (PreJoin.tsx) since Phase 1; the phone now has the same choices.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO: open the camera or the microphone.
 * The web previews both. Here a preview would mean acquiring capture before
 * the Room exists and handing it over afterwards — a second owner for the two
 * devices whose ownership bugs have already cost this app days (the lock/unlock
 * ghost, the offer race). So this screen only COLLECTS the choices; Meeting.js
 * remains the one place that turns a device on, and the permission prompt
 * still appears there, at the moment the device is actually wanted.
 *
 * Every route into a meeting passes through here because Meeting.js itself
 * renders it: the dashboard card, the Connect list, Start now, and a pasted
 * code. A route that skipped it would be a route with a hot mic.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler, StatusBar, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context'; // see App.js
import { Ionicons } from '@expo/vector-icons';
import { brand, radius, tone } from '../theme';

/** What a join did before this screen existed. Checks pass this to skip the screen. */
export const DEFAULT_JOIN_PREFS = Object.freeze({ mic: true, cam: false, speaker: true });

export default function PreJoin({ meeting, onJoin, onCancel }) {
  // Microphone OFF by default, unlike the old behaviour: once there is a
  // question, the safe answer is the one that cannot embarrass anybody.
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [speaker, setSpeaker] = useState(true);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onCancel(); return true; });
    return () => sub.remove();
  }, [onCancel]);

  const live = meeting?.status === 'active';

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <View style={s.header}>
        <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </Pressable>
      </View>

      <View style={s.body}>
        <Text style={s.eyebrow}>{live ? 'LIVE NOW' : 'READY TO JOIN'}</Text>
        <Text style={s.title} numberOfLines={2}>{meeting?.title || 'Meeting'}</Text>
        <Text style={s.sub}>Choose how you walk in. You can change all of this once you are inside.</Text>

        <View style={s.card}>
          <Row icon={mic ? 'mic' : 'mic-off'} label="Microphone"
               note={mic ? 'People will hear you as soon as you join.' : 'You join muted.'}
               value={mic} onChange={setMic} />
          <View style={s.rule} />
          <Row icon={cam ? 'videocam' : 'videocam-off'} label="Camera"
               note={cam ? 'People will see you as soon as you join.' : 'You join with the camera off.'}
               value={cam} onChange={setCam} />
          <View style={s.rule} />
          <Row icon={speaker ? 'volume-high' : 'ear'} label="Loudspeaker"
               note={speaker ? 'Sound plays out loud.' : 'Sound plays through the earpiece, like a phone call.'}
               value={speaker} onChange={setSpeaker} />
        </View>

        {meeting?.mode === 'private' ? (
          <Text style={s.foot}>This is a private meeting. It cannot be recorded.</Text>
        ) : (
          <Text style={s.foot}>You are told on screen if this meeting is being recorded.</Text>
        )}
      </View>

      <Pressable style={s.primary} onPress={() => onJoin({ mic, cam, speaker })}
                 accessibilityRole="button" accessibilityLabel="Join now">
        <Ionicons name="videocam" size={20} color={brand.base} />
        <Text style={s.primaryText}>Join now</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function Row({ icon, label, note, value, onChange }) {
  return (
    <Pressable style={s.row} onPress={() => onChange(!value)}
               accessibilityRole="switch" accessibilityState={{ checked: value }}
               accessibilityLabel={label}>
      <View style={[s.iconWrap, value && s.iconWrapOn]}>
        <Ionicons name={icon} size={20} color={value ? brand.base : '#fff'} />
      </View>
      <View style={s.rowText}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowNote}>{note}</Text>
      </View>
      {/* The whole row is the control; the switch only shows its state. */}
      <Switch value={value} onValueChange={onChange} importantForAccessibility="no"
              trackColor={{ false: 'rgba(255,255,255,0.22)', true: '#B9A8FF' }} thumbColor="#fff" />
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tone.deeper, paddingHorizontal: 20 },
  header: { height: 48, justifyContent: 'center' },
  body: { flex: 1, justifyContent: 'center' },
  eyebrow: { color: '#8EE6B8', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 8 },
  sub: { color: 'rgba(255,255,255,0.72)', fontSize: 15, lineHeight: 22, marginTop: 10 },
  card: {
    marginTop: 28, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 16, paddingVertical: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 14 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.18)' },
  iconWrap: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  iconWrapOn: { backgroundColor: '#fff' },
  rowText: { flex: 1 },
  rowLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  rowNote: { color: 'rgba(255,255,255,0.68)', fontSize: 13, lineHeight: 18, marginTop: 2 },
  foot: { color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 19, marginTop: 18 },
  primary: {
    height: 54, borderRadius: radius.pill, backgroundColor: '#fff', marginBottom: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  primaryText: { color: brand.base, fontSize: 17, fontWeight: '700' },
});
