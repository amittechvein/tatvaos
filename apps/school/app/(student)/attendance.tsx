// 3 Attendance (FR-S02, FR-S03). Month ring (present / late / absent / leave), the month's calendar
// with a coloured dot per marked day, the latest leave request, and Apply for leave.
// Statuses (design decision, 6 Oct 2026): Present green, Absent pink, Late blue, Leave amber,
// not marked or future blank. The percentage is the backend's, as the website shows it.

import React, { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Svg, { Circle } from "react-native-svg";
import { api, AttendanceMonth, FEATURES, hasFeature } from "@/core/api";
import { useActive, useBoot, useMe } from "@/core/useSchool";
import { todayIndia } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import type { StringKey } from "@/core/strings";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { Button, Card, Header, Loading, Notice } from "@/ui/parts";
import { colors, size } from "@/ui/theme";

const look = {
  PRESENT: colors.present,
  LATE: colors.late,
  ABSENT: colors.absent,
  LEAVE: colors.leave,
} as const;

function shift(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function Ring({ parts, label, sub }: { parts: { value: number; color: string }[]; label: string; sub: string }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const total = parts.reduce((n, p) => n + p.value, 0);
  let offset = 0;
  return (
    <View style={{ width: 104, height: 104, alignItems: "center", justifyContent: "center" }}>
      <Svg width={104} height={104} viewBox="0 0 104 104" style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={52} cy={52} r={r} stroke={colors.lineSoft} strokeWidth={12} fill="none" />
        {total > 0
          ? parts.map((p, i) => {
              const len = (p.value / total) * c;
              const el = <Circle key={i} cx={52} cy={52} r={r} stroke={p.color} strokeWidth={12} fill="none" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} />;
              offset += len;
              return el;
            })
          : null}
      </Svg>
      <Text size={24} weight={800}>
        {label}
      </Text>
      <Text size={11} weight={700} color={colors.textSoft}>
        {sub}
      </Text>
    </View>
  );
}

export default function Attendance() {
  const { t } = useT();
  const { months, weekdaysShort, dayMonth } = useDates();
  const insets = useSafeAreaInsets();
  const { active } = useActive();
  const b = useBoot().data!;
  const today = todayIndia();
  const [month, setMonth] = useState(today.slice(0, 7));
  const att = useMe("attendance", (h, tk) => api.attendance(h, tk, month), [month]);
  const canLeave = hasFeature(b, ...FEATURES.leave);
  const leaves = useMe("leaves", api.leaves, [], canLeave);

  const [y, m] = month.split("-").map(Number);
  const s = att.data?.summary;
  const leaveDays = (s?.approved_leave_days ?? 0) + (s?.excused_leave_days ?? 0);
  const pctNum = Number(s?.attendance_percentage);
  const pct = Number.isFinite(pctNum) && (s?.total_days ?? 0) > 0 ? `${Math.round(pctNum)}%` : "–";
  const rows: { key: StringKey; n: number; color: string }[] = [
    { key: "present", n: s?.present_days ?? 0, color: look.PRESENT },
    { key: "late", n: s?.late_days ?? 0, color: look.LATE },
    { key: "absent", n: s?.absent_days ?? 0, color: look.ABSENT },
    { key: "leave", n: leaveDays, color: look.LEAVE },
  ];

  const cells = useMemo(() => buildMonth(y, m, att.data), [y, m, att.data]);
  const latest = leaves.data?.items[0];
  const student = b.student;
  const sub = [active?.name, student?.className && student?.section ? `${student.className}-${student.section}` : student?.className].filter(Boolean).join(" · ");

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* white header: dark status bar icons, or they vanish on white */}
      <StatusBar style="dark" />
      <View style={{ backgroundColor: colors.white, paddingTop: insets.top }}>
        <Header title={t("attendanceTitle")} sub={sub} right={<Icon name="attendance" size={34} />} />
      </View>
      <ScrollView contentContainerStyle={{ padding: size.side, gap: 16, paddingBottom: insets.bottom + 100 }}>
        <Card style={{ flexDirection: "row", alignItems: "center", gap: 20, padding: 20 }}>
          <Ring parts={rows.map((r) => ({ value: r.n, color: r.color }))} label={pct} sub={months[m - 1]} />
          <View style={{ flex: 1, gap: 8 }}>
            {rows.map((r) => (
              <View key={r.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: r.color }} />
                <Text size={13} weight={700} style={{ flex: 1 }}>
                  {t(r.key)}
                </Text>
                <Text size={13} weight={800}>
                  {t(r.n === 1 ? "day" : "days", { n: r.n })}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 12 }}>
            <MonthButton label={t("prevMonth")} icon="back" onPress={() => setMonth(shift(month, -1))} />
            <Text size={15} weight={800}>
              {months[m - 1]} {y}
            </Text>
            <MonthButton label={t("nextMonth")} icon="back" flip disabled={month >= today.slice(0, 7)} onPress={() => setMonth(shift(month, 1))} />
          </View>
          {att.isPending ? (
            <Loading />
          ) : att.error ? (
            <Notice tone="error" text={(att.error as Error).message} />
          ) : (
            <>
              <View style={{ flexDirection: "row" }}>
                {weekdaysShort.map((w) => (
                  <Text key={w} size={11} weight={700} color={colors.textSoft} style={{ width: `${100 / 7}%`, textAlign: "center", paddingBottom: 4 }}>
                    {w}
                  </Text>
                ))}
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                {cells.map((c, i) => (
                  <View
                    key={i}
                    accessible={!!c.day}
                    accessibilityLabel={c.day ? `${c.day} ${months[m - 1]}${c.statusKey ? `, ${t(c.statusKey)}` : ""}` : undefined}
                    style={{ width: `${100 / 7}%`, height: 42, alignItems: "center", justifyContent: "center", gap: 3 }}
                  >
                    <Text size={13} weight={c.color ? 800 : 600} color={c.future ? colors.holiday : colors.text}>
                      {c.day || ""}
                    </Text>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.color ?? "transparent" }} />
                  </View>
                ))}
              </View>
              {att.data && att.data.days.length === 0 ? <Notice text={t("noAttendance")} /> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, paddingTop: 10, paddingHorizontal: 4 }}>
                {rows.map((r) => (
                  <View key={r.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: r.color }} />
                    <Text size={11} weight={700} color={colors.textSoft}>
                      {t(r.key)}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </Card>

        {latest ? (
          <Card style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: "#FFF3E0", alignItems: "center", justifyContent: "center" }}>
              <Icon name="notices" size={28} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text size={14} weight={700} numberOfLines={1}>
                {t("leave")} · {latest.from === latest.to ? dayMonth(latest.from) : `${dayMonth(latest.from)} – ${dayMonth(latest.to)}`}
              </Text>
              {latest.reason ? (
                <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>
                  {latest.reason}
                </Text>
              ) : null}
            </View>
            <LeaveStatus status={latest.status} />
          </Card>
        ) : null}
      </ScrollView>
      {canLeave ? (
        <View style={{ position: "absolute", left: size.side, right: size.side, bottom: insets.bottom + 16 }}>
          <Button label={t("applyLeave")} onPress={() => Alert.alert(t("comingSoon"))} />
        </View>
      ) : null}
    </View>
  );
}

function LeaveStatus({ status }: { status: string }) {
  const { t } = useT();
  const s = status.toUpperCase();
  const [key, fg, bg]: [StringKey, string, string] =
    s === "APPROVED" ? ["approved", "#0B6B46", colors.presentBg] : s === "REJECTED" ? ["rejected", colors.absentText, "#FDECEF"] : s === "CANCELLED" ? ["cancelled", colors.textSoft, colors.bg] : ["pending", "#7A4D00", "#FFF3E0"];
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: bg }}>
      <Text size={12} weight={800} color={fg}>
        {t(key)}
      </Text>
    </View>
  );
}

function MonthButton({ label, onPress, flip, disabled }: { label: string; icon: "back"; onPress: () => void; flip?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ width: 44, height: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1, transform: flip ? [{ scaleX: -1 }] : undefined }}
    >
      <Icon name="back" size={16} color={colors.text} />
    </Pressable>
  );
}

/** The month as calendar cells: blanks before the 1st, then one cell per day with its status colour. */
function buildMonth(y: number, m: number, data: AttendanceMonth | undefined) {
  const byDate = new Map((data?.days ?? []).map((d) => [d.date.slice(0, 10), d]));
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayIndia();
  const cells: { day: number; color?: string; statusKey?: StringKey; future?: boolean }[] = [];
  for (let i = 0; i < first; i++) cells.push({ day: 0 });
  for (let d = 1; d <= last; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const row = byDate.get(iso);
    if (!row) cells.push({ day: d, future: iso > today });
    else if (row.onLeave) cells.push({ day: d, color: look.LEAVE, statusKey: "leave" });
    else if (row.status === "ABSENT") cells.push({ day: d, color: look.ABSENT, statusKey: "absent" });
    else if (row.status === "LATE") cells.push({ day: d, color: look.LATE, statusKey: "late" });
    else cells.push({ day: d, color: look.PRESENT, statusKey: "present" });
  }
  return cells;
}
