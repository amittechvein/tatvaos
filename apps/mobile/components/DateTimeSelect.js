/**
 * A date you select from a calendar, and a time you select from hours and
 * minutes — each a field you tap, which opens a sheet.
 *
 * Amit on his own phone, 19 Sept 2026: "in schedule meeting date and time give
 * select option do not give list". The screen used to lay out fourteen days
 * and every half hour from 7 am to 9.30 pm as chips: quick for "tomorrow at
 * ten", but it could not say 10:15, or 6 am, or the 12th of next month, and
 * thirty chips is a lot of screen to read for one answer.
 *
 * STILL NO NATIVE DATE PICKER, and still on purpose (ScheduleMeeting.js says
 * why: a native module means a prebuild and a native rebuild on a laptop that
 * runs out of memory doing those). Everything here is React Native's own
 * Modal, ScrollView and Pressable — a JavaScript-only change, shipped with the
 * forty-six-second build.
 *
 * Both pickers are DUMB about what is allowed beyond "not before `min`" for
 * the date. Whether a TIME is in the past depends on the date, and the two are
 * chosen in either order — so that judgement stays with the screen that holds
 * both, and is made when both are known.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { brand, surface, text, radius } from '../theme';

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const two = (n) => String(n).padStart(2, '0');

/** "3:30 pm" from minutes since midnight. Written out, not left to the locale: the check reads it. */
export function timeText(minutes) {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${two(m)} ${h24 < 12 ? 'am' : 'pm'}`;
}

/** The field itself: looks like a select, says its value, opens on a tap. */
function Field({ icon, label, value, onPress, disabled }) {
  return (
    <Pressable style={s.field} onPress={onPress} disabled={disabled}
               accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: value }}>
      <Ionicons name={icon} size={18} color={brand.base} />
      <Text style={s.fieldText} numberOfLines={1}>{value}</Text>
      <Ionicons name="chevron-down" size={18} color={text.muted} />
    </Pressable>
  );
}

function Sheet({ visible, title, onClose, children, footer }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close">
        {/* The sheet swallows its own touches, or every tap inside would close it. */}
        <Pressable style={s.sheet} onPress={() => {}} accessible={false}>
          <Text style={s.sheetTitle}>{title}</Text>
          {children}
          {footer}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── date ───────────────────────────────────────────────────────────────────

/**
 * `value` and `min` are Dates; only their calendar day is read. `min` is the
 * first day that may be chosen — today. `label` is what the field says.
 */
export function DateSelect({ value, min, label, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  // The month on show, as its first day. Follows the value each time it opens,
  // so reopening never lands on a month the chosen day is not in.
  const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  useEffect(() => { if (open) setMonth(new Date(value.getFullYear(), value.getMonth(), 1)); }, [open, value]);

  const first = startOfDay(min);
  const atFirstMonth = month.getFullYear() === first.getFullYear() && month.getMonth() === first.getMonth();

  const cells = useMemo(() => {
    const out = [];
    const lead = month.getDay(); // Sunday first, as the calendars on these phones are
    for (let i = 0; i < lead; i++) out.push(null);
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= count; d++) out.push(new Date(month.getFullYear(), month.getMonth(), d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [month]);

  const monthTitle = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <>
      <Field icon="calendar-outline" label="Date" value={label} onPress={() => setOpen(true)} disabled={disabled} />
      <Sheet visible={open} title="Select a date" onClose={() => setOpen(false)}>
        <View style={s.monthRow}>
          <Pressable hitSlop={10} disabled={atFirstMonth} accessibilityLabel="Previous month"
                     onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
            <Ionicons name="chevron-back" size={22} color={atFirstMonth ? surface.border : text.primary} />
          </Pressable>
          <Text style={s.monthTitle}>{monthTitle}</Text>
          <Pressable hitSlop={10} accessibilityLabel="Next month"
                     onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
            <Ionicons name="chevron-forward" size={22} color={text.primary} />
          </Pressable>
        </View>
        <View style={s.grid}>
          {WEEKDAYS.map((w, i) => <Text key={`w${i}`} style={[s.cell, s.weekday]}>{w}</Text>)}
          {cells.map((d, i) => {
            if (!d) return <View key={`e${i}`} style={s.cell} />;
            const past = d < first;
            const on = sameDay(d, value);
            const today = sameDay(d, first);
            return (
              <Pressable key={d.toISOString()} style={s.cell} disabled={past}
                         onPress={() => { onChange(d); setOpen(false); }}
                         accessibilityRole="button" accessibilityState={{ selected: on, disabled: past }}
                         accessibilityLabel={d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}>
                <View style={[s.day, today && s.dayToday, on && s.dayOn]}>
                  <Text style={[s.dayText, past && s.dayPast, on && s.dayTextOn]}>{d.getDate()}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}

// ── time ───────────────────────────────────────────────────────────────────

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const ROW = 44;

/** `value` is minutes since midnight. Nothing is changed until Done. */
export function TimeSelect({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [h12, setH12] = useState(12);
  const [min, setMin] = useState(0);
  const [pm, setPm] = useState(false);
  const hourList = useRef(null);
  const minList = useRef(null);

  // Each opening starts from the time in the field, not from wherever the
  // person wandered to last time before closing without Done.
  useEffect(() => {
    if (!open) return undefined;
    const h24 = Math.floor(value / 60);
    const nextH = h24 % 12 === 0 ? 12 : h24 % 12;
    // The field can hold a minute the list does not (10:07 from somewhere
    // else); show the nearest one the list has, rounding down.
    const nextM = Math.floor((value % 60) / 5) * 5;
    setH12(nextH); setMin(nextM); setPm(h24 >= 12);
    // Bring the chosen rows into view. After layout, or there is nothing to scroll.
    const t = setTimeout(() => {
      hourList.current?.scrollTo({ y: Math.max(0, HOURS.indexOf(nextH) - 1) * ROW, animated: false });
      minList.current?.scrollTo({ y: Math.max(0, MINUTES.indexOf(nextM) - 1) * ROW, animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [open, value]);

  const done = () => {
    const h24 = (h12 % 12) + (pm ? 12 : 0);
    onChange(h24 * 60 + min);
    setOpen(false);
  };

  return (
    <>
      <Field icon="time-outline" label="Time" value={timeText(value)} onPress={() => setOpen(true)} disabled={disabled} />
      <Sheet
        visible={open}
        title="Select a time"
        onClose={() => setOpen(false)}
        footer={(
          <Pressable style={s.done} onPress={done} accessibilityRole="button" accessibilityLabel="Use this time">
            <Text style={s.doneText}>Use {`${h12}:${two(min)} ${pm ? 'pm' : 'am'}`}</Text>
          </Pressable>
        )}
      >
        <View style={s.columns}>
          <Column listRef={hourList} heading="Hour" items={HOURS} value={h12} onPick={setH12}
                  text={(h) => String(h)} a11y={(h) => `Hour ${h}`} />
          <Column listRef={minList} heading="Minute" items={MINUTES} value={min} onPick={setMin}
                  text={two} a11y={(m) => `Minute ${two(m)}`} />
          <Column heading=" " items={[false, true]} value={pm} onPick={setPm}
                  text={(v) => (v ? 'pm' : 'am')} a11y={(v) => (v ? 'PM' : 'AM')} />
        </View>
      </Sheet>
    </>
  );
}

function Column({ heading, items, value, onPick, text: show, a11y, listRef }) {
  return (
    <View style={s.column}>
      <Text style={s.columnHead}>{heading}</Text>
      <ScrollView ref={listRef} style={s.columnList} showsVerticalScrollIndicator={false} nestedScrollEnabled>
        {items.map((it) => {
          const on = it === value;
          return (
            <Pressable key={String(it)} style={[s.item, on && s.itemOn]} onPress={() => onPick(it)}
                       accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={a11y(it)}>
              <Text style={[s.itemText, on && s.itemTextOn]}>{show(it)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  field: {
    height: 50, borderWidth: 1, borderColor: surface.border, borderRadius: radius.sm,
    backgroundColor: surface.card, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  fieldText: { flex: 1, fontSize: 16, color: text.primary },

  backdrop: { flex: 1, backgroundColor: 'rgba(20,12,48,0.55)', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: surface.card, borderRadius: radius.lg, padding: 20 },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: text.primary, marginBottom: 14 },

  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  monthTitle: { fontSize: 16, fontWeight: '600', color: text.primary },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: 44, alignItems: 'center', justifyContent: 'center', textAlign: 'center' },
  weekday: { height: 28, lineHeight: 28, fontSize: 12, fontWeight: '700', color: text.muted },
  day: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  dayToday: { borderWidth: 1, borderColor: brand.base },
  dayOn: { backgroundColor: brand.base },
  dayText: { fontSize: 15, color: text.primary },
  dayPast: { color: surface.border },
  dayTextOn: { color: brand.onBase, fontWeight: '700' },

  columns: { flexDirection: 'row', gap: 10 },
  column: { flex: 1 },
  columnHead: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: text.muted, textAlign: 'center', marginBottom: 6 },
  columnList: { height: ROW * 5, borderWidth: 1, borderColor: surface.border, borderRadius: radius.sm },
  item: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  itemOn: { backgroundColor: brand.base },
  itemText: { fontSize: 17, color: text.primary },
  itemTextOn: { color: brand.onBase, fontWeight: '700' },

  done: {
    height: 48, borderRadius: radius.sm, backgroundColor: brand.base, marginTop: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  doneText: { color: brand.onBase, fontSize: 16, fontWeight: '600' },
});
