/**
 * Plan a meeting for later, from the phone.
 *
 * Until now the app could only start a meeting NOW: Connect's empty state said
 * "Start one above, or open Connect on the web to plan one", which is an app
 * telling somebody to go and use a browser. Amit asked for this on 16 Sept.
 *
 * ── NO DATE-PICKER LIBRARY, ON PURPOSE. ──────────────────────────────────
 *  Every React Native date picker is a NATIVE module. Adding one means a
 *  prebuild, a Gradle rebuild of native code, and another entry in the list of
 *  things that can break a build on a laptop that already runs out of memory
 *  compiling WebRTC (WELCOME §3). The cost would buy a calendar widget for a
 *  task that is almost always "some time in the next fortnight" — which a row
 *  of days and a grid of times answers in two taps, with no native code.
 *
 *  If someone later needs a meeting in June, that is the moment to reconsider,
 *  and the decision should be made deliberately rather than by npm install.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The server will not stop you scheduling a meeting in the past — it checks
 * that an end is not before its start and nothing else. So this screen does:
 * a time that has gone is not offered, and one that passes while the screen is
 * open is refused with a sentence rather than sent.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  StyleSheet, Keyboard, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { createMeeting } from '../lib/connect';
import { brand, surface, text } from '../theme';

const log = (line) => console.log(`[schedule] ${line}`);

const DAYS_OFFERED = 14;
const FIRST_HOUR = 7;
const LAST_HOUR = 21;
const STEP_MINUTES = 30;
const LENGTHS = [30, 45, 60, 90];

// Far enough ahead that a slot cannot go stale between rendering and tapping.
const SOONEST_MINUTES = 10;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function dayLabel(date, today) {
  const diff = Math.round((startOfDay(date) - startOfDay(today)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const timeLabel = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The device's own zone, so a meeting made on a phone in Mumbai and one made on
 * a laptop in Mumbai agree. Hermes has Intl, but this is defensive: if it is
 * missing the field is omitted and the server applies its own default rather
 * than the app inventing one.
 */
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function slotsFor(date, now) {
  const slots = [];
  const earliest = new Date(now.getTime() + SOONEST_MINUTES * 60000);
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    for (let m = 0; m < 60; m += STEP_MINUTES) {
      const slot = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0);
      if (slot >= earliest) slots.push(slot);
    }
  }
  return slots;
}

export default function ScheduleMeeting({ session, onCreated, onBack }) {
  // Captured once per render pass rather than read repeatedly, so the day list
  // and the slot list cannot disagree about what "now" is.
  const now = useMemo(() => new Date(), []);

  const days = useMemo(() => {
    const out = [];
    for (let i = 0; i < DAYS_OFFERED; i++) {
      const d = startOfDay(now);
      d.setDate(d.getDate() + i);
      out.push(d);
    }
    return out;
  }, [now]);

  const [dayIndex, setDayIndex] = useState(0);
  const [title, setTitle] = useState('');
  const [length, setLength] = useState(30);
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const slots = useMemo(() => slotsFor(days[dayIndex], now), [days, dayIndex, now]);

  // Today runs out of slots after the last hour offered; the day is still
  // shown, and says why it is empty rather than rendering a blank space.
  useEffect(() => { setChosen(slots[0] ?? null); }, [slots]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const schedule = useCallback(async () => {
    if (!chosen) { setError('Pick a time first.'); return; }

    // The screen may have been open for a while. A slot that was valid when it
    // rendered can be in the past by the time it is tapped, and the server
    // would accept it — a meeting scheduled for this morning.
    if (chosen.getTime() < Date.now()) {
      setError('That time has passed. Pick another.');
      return;
    }

    Keyboard.dismiss();
    setBusy(true);
    setError('');
    try {
      const end = new Date(chosen.getTime() + length * 60000);
      const meeting = await createMeeting(session.accessToken, title.trim(), {
        kind: 'scheduled',
        scheduledStart: chosen.toISOString(),
        scheduledEnd: end.toISOString(),
        timezone: deviceTimeZone(),
      });
      // Never the title: people put customer names in them.
      log(`created ${meeting?.id ?? 'a meeting'} for ${chosen.toISOString()} (${length}m)`);
      onCreated(meeting);
    } catch (e) {
      // The server's sentence when it sent one — it names the actual objection
      // (a title too long, an unknown setting) better than anything here could.
      log(`create failed: ${e?.message ?? e}`);
      setError(e?.message || 'Could not schedule that meeting.');
    } finally {
      setBusy(false);
    }
  }, [chosen, length, title, session, onCreated]);

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={text.primary} />
        </Pressable>
        <Text style={s.title}>Schedule a meeting</Text>
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.label}>Title</Text>
        <TextInput
          style={s.input}
          value={title}
          onChangeText={(v) => { setTitle(v); setError(''); }}
          placeholder="Optional — we'll name it after you"
          placeholderTextColor={text.muted}
          maxLength={200}
          editable={!busy}
          accessibilityLabel="Meeting title"
        />

        <Text style={s.label}>Day</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
          {days.map((d, i) => {
            const on = i === dayIndex;
            return (
              <Pressable
                key={d.toISOString()}
                onPress={() => { setDayIndex(i); setError(''); }}
                style={[s.chip, on && s.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={dayLabel(d, now)}
              >
                <Text style={[s.chipText, on && s.chipTextOn]}>{dayLabel(d, now)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={s.label}>Time</Text>
        {slots.length === 0 ? (
          <Text style={s.empty}>No times left today. Pick another day.</Text>
        ) : (
          <View style={s.wrap}>
            {slots.map((slot) => {
              const on = chosen && slot.getTime() === chosen.getTime();
              return (
                <Pressable
                  key={slot.toISOString()}
                  onPress={() => { setChosen(slot); setError(''); }}
                  style={[s.chip, on && s.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!on }}
                  accessibilityLabel={timeLabel(slot)}
                >
                  <Text style={[s.chipText, on && s.chipTextOn]}>{timeLabel(slot)}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text style={s.label}>Length</Text>
        <View style={s.wrap}>
          {LENGTHS.map((m) => {
            const on = m === length;
            return (
              <Pressable
                key={m}
                onPress={() => setLength(m)}
                style={[s.chip, on && s.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${m} minutes`}
              >
                <Text style={[s.chipText, on && s.chipTextOn]}>{m} min</Text>
              </Pressable>
            );
          })}
        </View>

        {error ? <Text style={s.error}>{error}</Text> : null}

        {/* Says what is about to happen, in the words the list will use. A
            confirmation nobody can read back is how meetings land on Tuesday. */}
        {chosen ? (
          <Text style={s.summary}>
            {dayLabel(days[dayIndex], now)}, {timeLabel(chosen)} · {length} minutes
          </Text>
        ) : null}

        <Pressable
          style={[s.primary, (busy || !chosen) && s.primaryBusy]}
          onPress={schedule}
          disabled={busy || !chosen}
          accessibilityLabel="Schedule this meeting"
        >
          {busy
            ? <ActivityIndicator color={brand.onBase} />
            : <Text style={s.primaryText}>Schedule</Text>}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page, paddingHorizontal: 20, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  title: { fontSize: 22, fontWeight: '700', color: text.primary },
  body: { paddingBottom: 40 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: text.muted, marginTop: 20, marginBottom: 8 },
  input: {
    height: 46, borderWidth: 1, borderColor: surface.border, borderRadius: 8,
    backgroundColor: surface.card, paddingHorizontal: 12, fontSize: 15, color: text.primary,
  },
  row: { gap: 8, paddingRight: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    borderWidth: 1, borderColor: surface.border, backgroundColor: surface.card,
  },
  chipOn: { backgroundColor: brand.base, borderColor: brand.base },
  chipText: { fontSize: 14, color: text.primary },
  chipTextOn: { color: brand.onBase, fontWeight: '600' },
  empty: { color: text.secondary, fontSize: 15, lineHeight: 22 },
  error: { color: '#993556', marginTop: 16, fontSize: 14 },
  summary: { marginTop: 22, fontSize: 15, color: text.secondary },
  primary: {
    height: 48, borderRadius: 8, backgroundColor: brand.base, marginTop: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryBusy: { opacity: 0.7 },
  primaryText: { color: brand.onBase, fontSize: 16, fontWeight: '500' },
});
