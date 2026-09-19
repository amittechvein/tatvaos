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
import { brand, surface, text, products, radius, space, type, shadow, tone } from '../theme';

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
          {/* Light on the violet card; brand.base would vanish into it. */}
          <ActivityIndicator size="small" color={tone.onDeep} />
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
  // ── THE HERO OF THE DASHBOARD, 18 SEPT 2026. ─────────────────────────
  //  The one card the brief says everyone opens the app for is now the one
  //  thing on the page in the brand's own colour: deep violet, big corners,
  //  a lift, and a white Join pill that is the brightest object on screen.
  //  Everything else on the dashboard is cream and white, so this is where
  //  the eye goes first — which is the argument the brief made for putting
  //  it above the tiles in the first place.
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 96,
    backgroundColor: tone.deep,
    borderRadius: radius.xl, paddingVertical: space.lg, paddingHorizontal: space.lg,
    marginBottom: space.xl, ...shadow.float,
  },
  icon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1, minWidth: 0 },
  eyebrow: { ...type.eyebrow, color: tone.onDeepMuted, marginBottom: 4 },
  eyebrowLive: { color: '#7CE8B5' },   // a live meeting is green, everywhere in Connect
  title: { ...type.heading, color: tone.onDeep },
  when: { ...type.caption, fontWeight: '400', fontSize: 13, color: tone.onDeepMuted, marginTop: 3 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quietLine: { ...type.body, color: tone.onDeepMuted },
  join: {
    height: 44, paddingHorizontal: 22, borderRadius: radius.pill, backgroundColor: surface.card,
    alignItems: 'center', justifyContent: 'center',
  },
  joinPressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  joinText: { color: tone.ink, fontSize: 15, fontWeight: '800' },
  secondary: {
    height: 38, paddingHorizontal: 14, borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  secondaryText: { color: tone.onDeep, fontSize: 14, fontWeight: '600' },
});
