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
 *  compiling WebRTC (WELCOME §3).
 *
 *  Until 19 Sept 2026 the answer was a row of fourteen days and a grid of half
 *  hours. This comment said "if someone later needs a meeting in June, that is
 *  the moment to reconsider" - and the moment came sooner, from Amit on his own
 *  phone: "date and time give select option do not give list". The constraint
 *  did not move, so the pickers are written in JavaScript instead
 *  (components/DateTimeSelect.js): a calendar and an hour/minute sheet, any day
 *  in the future, any five minutes of it, and still no native code.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The server will not stop you scheduling a meeting in the past — it checks
 * that an end is not before its start and nothing else. So this screen does:
 * a time that has gone is not offered, and one that passes while the screen is
 * open is refused with a sentence rather than sent.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  StyleSheet, Keyboard, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { createMeeting, inviteToMeeting } from '../lib/connect';
import { DateSelect, TimeSelect, timeText } from '../components/DateTimeSelect';
import { brand, surface, text } from '../theme';

const log = (line) => console.log(`[schedule] ${line}`);

const STEP_MINUTES = 30;
const LENGTHS = [30, 45, 60, 90];

// Far enough ahead that the default cannot go stale between rendering and tapping.
const SOONEST_MINUTES = 10;

// The default start is never later in the evening than this; past it, the
// screen opens on tomorrow morning instead. Found at 21:39 on 16 Sept: a screen
// that opens on a time nobody would pick reads as broken.
const LATEST_DEFAULT_HOUR = 21;
const MORNING_HOUR = 9;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function dayLabel(date, today) {
  const diff = Math.round((startOfDay(date) - startOfDay(today)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function dateFieldLabel(date, today) {
  const full = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const diff = Math.round((startOfDay(date) - startOfDay(today)) / 86400000);
  if (diff === 0) return `Today · ${full}`;
  if (diff === 1) return `Tomorrow · ${full}`;
  return full;
}

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

/**
 * Where the screen opens: the next half hour that is at least ten minutes off,
 * or nine tomorrow morning when that would be late in the evening. Returns the
 * day and the minutes since midnight separately, because that is how they are
 * chosen and held.
 */
export function defaultStart(now) {
  const earliest = new Date(now.getTime() + SOONEST_MINUTES * 60000);
  const mins = earliest.getHours() * 60 + earliest.getMinutes();
  const rounded = Math.ceil(mins / STEP_MINUTES) * STEP_MINUTES;
  const sameDay = startOfDay(earliest).getTime() === startOfDay(now).getTime();
  if (sameDay && rounded <= LATEST_DEFAULT_HOUR * 60 + 30) return { date: startOfDay(now), minutes: rounded };
  const tomorrow = startOfDay(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { date: tomorrow, minutes: MORNING_HOUR * 60 };
}

const at = (date, minutes) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes, 0, 0);

export default function ScheduleMeeting({ session, onCreated, onBack }) {
  // Captured once per render pass rather than read repeatedly, so the day list
  // and the slot list cannot disagree about what "now" is.
  const now = useMemo(() => new Date(), []);

  // The day and the time are held apart because they are CHOSEN apart, in
  // either order; `chosen` is the instant the two of them name.
  const opening = useMemo(() => defaultStart(now), [now]);
  const [date, setDate] = useState(opening.date);
  const [minutes, setMinutes] = useState(opening.minutes);
  const chosen = useMemo(() => at(date, minutes), [date, minutes]);
  const [title, setTitle] = useState('');
  const [length, setLength] = useState(30);
  // Every setting the web's new-meeting page offers, with the same defaults
  // and the same words (apps/web/app/connect/(shell)/new/page.tsx). Amit on the
  // phone, 19 Sept 2026: "connect schedule for later give all option" - until
  // then a meeting scheduled here could only ever have the defaults, and
  // changing one meant finding a laptop.
  const [mode, setMode] = useState('recorded');
  const [waitingRoom, setWaitingRoom] = useState('guests');
  const [allowGuests, setAllowGuests] = useState(true);
  const [chatPolicy, setChatPolicy] = useState('everyone');
  const [sharePolicy, setSharePolicy] = useState('everyone');
  const [shareMode, setShareMode] = useState('multiple');
  const [autoRecord, setAutoRecord] = useState(false);
  const [password, setPassword] = useState('');
  const [invitees, setInvitees] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Said as soon as it is true rather than only when Schedule is pressed: a
  // calendar will happily give you today, and a time sheet 8 am, at four in
  // the afternoon. The button stays live and refuses with the same sentence -
  // a time can also go stale while the screen sits open, which only the press
  // can catch.
  const isPast = chosen.getTime() < now.getTime();

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  const schedule = useCallback(async () => {
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
        mode,
        waitingRoom,
        allowGuests,
        chatPolicy,
        sharePolicy,
        shareMode,
        // A private meeting cannot auto-record and the server refuses the pair.
        // Sent as false rather than trusting a toggle that is no longer shown.
        autoRecord: mode === 'private' ? false : autoRecord,
        password: password.length > 0 ? password : null,
      });
      // Never the title: people put customer names in them.
      log(`created ${meeting?.id ?? 'a meeting'} for ${chosen.toISOString()} (${length}m)`);

      // Invitations AFTER the meeting exists, as a second call: the meeting is
      // the thing that must not be lost. A 200 here is not "everyone was
      // mailed", so what did not go is SAID before the person is moved on to a
      // list that would otherwise look like success.
      if (invitees.trim().length > 0 && meeting?.id) {
        let problem = '';
        try {
          const out = await inviteToMeeting(session.accessToken, meeting.id, invitees);
          // Counts only, never the addresses.
          log(`invited: added ${out?.added ?? 0}, sent ${out?.sent ?? 0}, failed ${out?.failed ?? 0}, invalid ${out?.invalid?.length ?? 0}`);
          const parts = [];
          if (out?.invalid?.length) parts.push(`Not an email address: ${out.invalid.join(', ')}.`);
          if (out?.note) parts.push(out.note);
          if (out?.warning) parts.push(out.warning);
          problem = parts.join(' ');
        } catch (e) {
          log(`invite failed: ${e?.message ?? e}`);
          problem = e?.message || 'The invitations could not be sent.';
        }
        if (problem) {
          Alert.alert(
            'Meeting scheduled',
            `${problem}\n\nThe meeting itself is saved. You can invite people again from its page on the web.`,
            [{ text: 'OK', onPress: () => onCreated(meeting) }],
            { cancelable: false },
          );
          return;
        }
      }
      onCreated(meeting);
    } catch (e) {
      // The server's sentence when it sent one — it names the actual objection
      // (a title too long, an unknown setting) better than anything here could.
      log(`create failed: ${e?.message ?? e}`);
      setError(e?.message || 'Could not schedule that meeting.');
    } finally {
      setBusy(false);
    }
  }, [chosen, length, title, session, onCreated, mode, waitingRoom, allowGuests,
    chatPolicy, sharePolicy, shareMode, autoRecord, password, invitees]);

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

        <Text style={s.label}>Date</Text>
        <DateSelect value={date} min={now} label={dateFieldLabel(date, now)} disabled={busy}
                    onChange={(d) => { setDate(d); setError(''); }} />

        <Text style={s.label}>Time</Text>
        <TimeSelect value={minutes} disabled={busy}
                    onChange={(m) => { setMinutes(m); setError(''); }} />
        {isPast ? <Text style={s.error}>That time has already passed today. Pick a later one.</Text> : null}

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

        <Text style={s.label}>Invite by email</Text>
        <TextInput
          style={[s.input, s.inputTall]}
          value={invitees}
          onChangeText={(v) => { setInvitees(v); setError(''); }}
          placeholder="ravi@example.com, meera@example.com"
          placeholderTextColor={text.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          multiline
          editable={!busy}
          accessibilityLabel="Invite by email"
        />
        <Text style={s.hint}>
          Optional. Each person gets their own email with the link and a calendar invitation, sent from your mailbox.
        </Text>

        <Pressable
          style={s.optionsToggle}
          onPress={() => setShowOptions((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showOptions }}
          accessibilityLabel="Meeting options"
        >
          <Text style={s.optionsToggleText}>Meeting options</Text>
          <Ionicons name={showOptions ? 'chevron-up' : 'chevron-down'} size={18} color={brand.base} />
        </Pressable>
        {/* What the meeting will be, said even while the options are folded
            away - a default nobody saw is still a decision somebody made. */}
        {!showOptions ? (
          <Text style={s.hint} accessibilityLabel="Meeting options summary">
            {mode === 'private' ? 'Private' : 'Recorded'} · {WAITING[waitingRoom]} · {allowGuests ? 'Anyone with the link' : 'Colleagues only'}
            {password ? ' · Password set' : ''}
          </Text>
        ) : (
          <View>
            <Group label="Meeting type" hint="This cannot be changed once the meeting is created."
                   value={mode} onPick={setMode} disabled={busy}
                   options={[['recorded', 'Recorded', 'Can be recorded, transcribed and summarised. Everyone is told when recording starts.'],
                             ['private', 'Private', 'Audio and video are encrypted. It cannot be recorded.']]} />
            <Group label="Waiting room" value={waitingRoom} onPick={setWaitingRoom} disabled={busy}
                   options={[['off', 'Off', 'Anyone with the link walks straight in.'],
                             ['guests', 'Guests wait', 'You let people from outside in.'],
                             ['everyone', 'Everyone waits', 'Colleagues knock too.']]} />
            <Group label="Who can get in" value={allowGuests ? 'yes' : 'no'}
                   onPick={(v) => setAllowGuests(v === 'yes')} disabled={busy}
                   options={[['yes', 'Anyone with the link', 'Including people with no TatvaOS account.'],
                             ['no', 'Colleagues only', 'Signed-in accounts, and nobody else.']]} />
            <Group label="Who can send chat messages"
                   hint="Everyone can read, whichever you choose. Changeable during the meeting."
                   value={chatPolicy} onPick={setChatPolicy} disabled={busy}
                   options={[['everyone', 'Everyone'], ['cohost', 'Host and co-hosts'], ['off', 'Nobody']]} />
            <Group label="Who can share their screen" hint="Changeable during the meeting."
                   value={sharePolicy} onPick={setSharePolicy} disabled={busy}
                   options={[['everyone', 'Everyone'], ['cohost', 'Host and co-hosts'], ['host', 'Host only']]} />
            <Group label="Screens at once" value={shareMode} onPick={setShareMode} disabled={busy}
                   options={[['multiple', 'Several at once'], ['single', 'One at a time']]} />
            {mode === 'recorded' ? (
              <Group label="Recording"
                     hint="Audio only, started when the first person joins. If recording is off for your organisation the meeting simply runs unrecorded."
                     value={autoRecord ? 'yes' : 'no'} onPick={(v) => setAutoRecord(v === 'yes')} disabled={busy}
                     options={[['no', 'I will start it myself'], ['yes', 'Start it automatically']]} />
            ) : null}
            <Text style={s.label}>Password</Text>
            <TextInput
              style={s.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Optional. Most meetings do not need one."
              placeholderTextColor={text.muted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={64}
              editable={!busy}
              accessibilityLabel="Meeting password"
            />
          </View>
        )}

        {error ? <Text style={s.error}>{error}</Text> : null}

        {/* Says what is about to happen, in the words the list will use. A
            confirmation nobody can read back is how meetings land on Tuesday. */}
        <Text style={s.summary} accessibilityLabel="What will be scheduled">
          {dayLabel(date, now)}, {timeText(minutes)} · {length} minutes
        </Text>

        <Pressable
          style={[s.primary, busy && s.primaryBusy]}
          onPress={schedule}
          disabled={busy}
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

const WAITING = { off: 'No waiting room', guests: 'Guests wait', everyone: 'Everyone waits' };

/**
 * One setting: a label, and its choices as chips. `options` rows are
 * [value, title, note?]; the chosen one's note is shown underneath, so the
 * consequence is read at the moment of choosing and not on every row at once.
 */
function Group({ label, hint, value, onPick, options, disabled }) {
  const note = options.find((o) => o[0] === value)?.[2];
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <View style={s.wrap}>
        {options.map(([v, title]) => {
          const on = v === value;
          return (
            <Pressable
              key={v}
              onPress={() => onPick(v)}
              disabled={disabled}
              style={[s.chip, on && s.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${label}: ${title}`}
            >
              <Text style={[s.chipText, on && s.chipTextOn]}>{title}</Text>
            </Pressable>
          );
        })}
      </View>
      {note ? <Text style={s.hint}>{note}</Text> : null}
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
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
  inputTall: { height: undefined, minHeight: 46, paddingVertical: 10, textAlignVertical: 'top' },
  hint: { marginTop: 8, fontSize: 13, lineHeight: 19, color: text.secondary },
  optionsToggle: {
    marginTop: 22, paddingVertical: 12, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: surface.border,
  },
  optionsToggleText: { fontSize: 15, fontWeight: '600', color: brand.base },
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
