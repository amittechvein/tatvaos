/**
 * The Connect tile's native screen: your upcoming meetings, and a way to start
 * one now. Tapping a meeting hands it to the Meeting screen.
 *
 * This replaces the browser for Connect only. Every other tile still opens the
 * web — see openProduct in App.js for why, and for the handoff endpoint that
 * would change that. Connect is native because it is the one product a mobile
 * browser cannot do: no browser on a phone can share its screen.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet,
  RefreshControl, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context'; // see App.js
import { Ionicons } from '@expo/vector-icons';

import { listMeetings, createMeeting } from '../lib/connect';
import { describeWhen } from '../lib/nextMeeting';
import { brand, surface, text, radius, space, type, shadow, tone } from '../theme';

const log = (line) => console.log(`[meetings] ${line}`);

export default function Meetings({ session, onJoin, onBack, onSchedule }) {
  const [meetings, setMeetings] = useState(null); // null = still loading
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await listMeetings(session.accessToken, 'upcoming');
      log(`${list.length} upcoming`);
      setMeetings(list);
    } catch (e) {
      // An empty list and a failed load look identical without this. They are
      // not: one means "nothing scheduled", the other "we could not ask".
      log(`load failed: ${e?.message ?? e}`);
      setMeetings([]);
      setError('Could not load your meetings. Pull down to try again.');
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  // "Pull down to try again" has to be true. It is also how the list catches
  // up after a meeting ends, since nothing pushes that to the phone.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  // Android back goes home rather than out of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  async function startNow() {
    setBusy(true);
    setError('');
    try {
      const m = await createMeeting(session.accessToken, 'Meeting');
      log(`created ${m.id}`);
      onJoin(m);
    } catch (e) {
      log(`create failed: ${e?.message ?? e}`);
      setError('Could not start a meeting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={text.primary} />
        </Pressable>
        <Text style={s.title}>Connect</Text>
      </View>

      <Pressable
        style={[s.primary, busy && s.primaryBusy]}
        onPress={startNow}
        disabled={busy}
        accessibilityLabel="Start a meeting now"
      >
        {busy
          ? <ActivityIndicator color={brand.onBase} />
          : (
            <>
              <Ionicons name="videocam" size={18} color={brand.onBase} />
              <Text style={s.primaryText}>Start a meeting now</Text>
            </>
          )}
      </Pressable>

      {/* Secondary on purpose: starting a meeting now is what people open
          Connect on a phone to do. Planning one is the rarer errand, and until
          16 Sept it was not possible here at all — the empty state below used
          to send people to a browser to do it. */}
      <Pressable
        style={s.secondary}
        onPress={onSchedule}
        disabled={busy}
        accessibilityLabel="Schedule a meeting for later"
      >
        <Ionicons name="calendar-outline" size={18} color={brand.base} />
        <Text style={s.secondaryText}>Schedule for later</Text>
      </Pressable>

      {error ? <Text style={s.error}>{error}</Text> : null}

      <Text style={s.section}>UPCOMING</Text>

      {/* The ScrollView wraps the empty state too, so pull-to-refresh works
          when there is nothing to pull on. */}
      <ScrollView
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[brand.base]} tintColor={brand.base} />}
      >
        {meetings === null ? (
          <ActivityIndicator color={brand.base} style={{ marginTop: 24 }} />
        ) : meetings.length === 0 ? (
          <Text style={s.empty}>Nothing scheduled. Start one now, or schedule one for later — both are above.</Text>
        ) : meetings.map((m) => (
          <Pressable
            key={m.id}
            style={({ pressed }) => [s.row, pressed && s.rowPressed]}
            onPress={() => onJoin(m)}
            accessibilityRole="button"
            accessibilityLabel={`Join ${m.title || 'meeting'}`}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle} numberOfLines={1}>{m.title || 'Meeting'}</Text>
              <Text style={s.rowWhen}>{describeWhen(m)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={text.muted} />
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// 18 Sept 2026, "modern ui for Gen-Z": the two actions are the page. Start
// now is a tall pill that glows; Schedule is its quiet twin beneath. Upcoming
// meetings are cards with room to breathe rather than bordered rows.
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page, paddingHorizontal: space.lg, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.lg },
  title: { ...type.title, color: text.primary },
  primary: {
    height: 58, borderRadius: 29, backgroundColor: brand.base,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    ...shadow.glow,
  },
  primaryBusy: { opacity: 0.7 },
  primaryText: { color: brand.onBase, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  secondary: {
    height: 52, borderRadius: radius.pill, backgroundColor: tone.wash, marginTop: space.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  secondaryText: { color: tone.ink, fontSize: 15, fontWeight: '700' },
  error: { color: '#993556', marginTop: 12, fontSize: 14 },
  section: { ...type.eyebrow, color: text.muted, marginTop: space.xl, marginBottom: space.md },
  empty: { ...type.body, color: text.secondary, marginTop: 8 },
  list: { gap: space.md, paddingBottom: 24, flexGrow: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: surface.card, borderRadius: radius.lg,
    paddingVertical: space.lg, paddingHorizontal: space.lg,
    ...shadow.card,
  },
  rowPressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  rowTitle: { ...type.heading, color: text.primary },
  rowWhen: { ...type.caption, fontWeight: '400', fontSize: 13, color: text.secondary, marginTop: 4 },
});
