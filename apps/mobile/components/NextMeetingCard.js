/**
 * The dashboard's "next meeting" card, with a Join button.
 *
 * docs/MOBILE_LANE_BRIEF.md §4 puts it on the dashboard because joining a
 * meeting is the commonest reason someone opens the app on a phone, and making
 * them go through Connect's list first wastes that moment.
 *
 * Built 15 Sept 2026 from the brief's words and the app's existing look. The
 * mockup the brief says was approved on 3 Sept is not in the repository; if it
 * turns up and disagrees, it wins.
 *
 * Which meeting: lib/nextMeeting.js — read its opening comment before
 * "simplifying" this to the first row of the list. Loading and refresh:
 * hooks/useNextMeeting.js.
 */

import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useNextMeeting } from '../hooks/useNextMeeting';
import { describeWhen } from '../lib/nextMeeting';
import { brand, surface, text, products } from '../theme';

// Connect's own tile colours, so the card reads as Connect at a glance.
const connect = products.find((p) => p.key === 'connect');

export default function NextMeetingCard({ session, onJoin, onOpenConnect }) {
  const { status, meeting, reload } = useNextMeeting(session?.accessToken);

  let body;
  if (status === 'loading') {
    body = (
      <View style={s.textCol}>
        <Text style={s.eyebrow}>NEXT MEETING</Text>
        <View style={s.inline}>
          <ActivityIndicator size="small" color={brand.base} />
          <Text style={s.quietLine}>Checking your meetings…</Text>
        </View>
      </View>
    );
  } else if (status === 'failed') {
    body = (
      <>
        <View style={s.textCol}>
          <Text style={s.eyebrow}>NEXT MEETING</Text>
          <Text style={s.quietLine}>Could not check your meetings.</Text>
        </View>
        <Pressable onPress={reload} hitSlop={8} style={s.secondary} accessibilityLabel="Try again">
          <Text style={s.secondaryText}>Try again</Text>
        </Pressable>
      </>
    );
  } else if (!meeting) {
    body = (
      <>
        <View style={s.textCol}>
          <Text style={s.eyebrow}>NEXT MEETING</Text>
          <Text style={s.quietLine}>No meetings coming up.</Text>
        </View>
        <Pressable onPress={onOpenConnect} hitSlop={8} style={s.secondary} accessibilityLabel="Open Connect">
          <Text style={s.secondaryText}>Open Connect</Text>
        </Pressable>
      </>
    );
  } else {
    const title = meeting.title || 'Meeting';
    const live = meeting.status === 'active';
    body = (
      <>
        <View style={s.textCol}>
          <Text style={[s.eyebrow, live && s.eyebrowLive]}>{live ? 'LIVE NOW' : 'NEXT MEETING'}</Text>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          <Text style={s.when}>{describeWhen(meeting)}</Text>
        </View>
        <Pressable
          onPress={() => onJoin(meeting)}
          style={({ pressed }) => [s.join, pressed && s.joinPressed]}
          accessibilityRole="button"
          accessibilityLabel={`Join ${title}`}
        >
          <Text style={s.joinText}>Join</Text>
        </Pressable>
      </>
    );
  }

  return (
    <View style={s.card}>
      <View style={[s.icon, { backgroundColor: connect.tint }]}>
        <Ionicons name="videocam-outline" size={22} color={connect.ink} />
      </View>
      {body}
    </View>
  );
}

const s = StyleSheet.create({
  // Fixed minimum height: the four states swap in place, and a card that
  // changes size as it loads shoves the tiles under the person's thumb.
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 84,
    backgroundColor: surface.card, borderWidth: 1, borderColor: surface.border,
    borderRadius: 14, paddingVertical: 14, paddingHorizontal: 14, marginBottom: 20,
  },
  icon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: text.muted, marginBottom: 3 },
  eyebrowLive: { color: brand.base },
  title: { fontSize: 16, fontWeight: '600', color: text.primary },
  when: { fontSize: 13, color: text.secondary, marginTop: 2 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quietLine: { fontSize: 14, color: text.secondary },
  join: {
    height: 40, paddingHorizontal: 20, borderRadius: 8, backgroundColor: brand.base,
    alignItems: 'center', justifyContent: 'center',
  },
  joinPressed: { opacity: 0.8 },
  joinText: { color: brand.onBase, fontSize: 15, fontWeight: '600' },
  secondary: {
    height: 36, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: surface.border,
    alignItems: 'center', justifyContent: 'center',
  },
  secondaryText: { color: text.primary, fontSize: 14, fontWeight: '500' },
});
