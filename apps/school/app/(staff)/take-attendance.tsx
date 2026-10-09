// Take attendance for one section (FR-T02, design screen 5 "Teacher attendance"). Everyone starts
// present; tap A for absent or L for late. The statuses are the website's: Present, Absent, Late.
// A student on approved leave starts absent with "On leave" (as on the website) and can still be
// changed if they came. Days that are not working days, and locked days, are shown but not saved.
//
// Saving: online, the website's own save runs on the server. With no connection, the marks are
// kept on the phone and sent later (core/attendanceQueue.ts). Every save says which version of
// the day it was made from (`based_on`); if someone saved after that, theirs is kept and the
// teacher is told who and when.
import React, { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useAccounts } from "@/core/accounts";
import { api, ApiError, AttendanceMark, RosterRow } from "@/core/api";
import * as Queue from "@/core/attendanceQueue";
import { addDays, timeIndia, todayIndia } from "@/core/format";
import { useMe } from "@/core/useSchool";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { BackButton, Button, Notice, OfflineBanner } from "@/ui/parts";
import { ListState } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";

const TINTS = [["#FFF3E0", "#8A4B00"], ["#E7F2FF", "#0C4A80"], ["#E3F7F6", "#0B5452"], ["#FFECEF", "#8A1636"], ["#EEECFF", "#33278F"], ["#E8F7F0", "#0B4F35"]];
const ON: Record<AttendanceMark, [string, string]> = {
  PRESENT: [colors.presentText, colors.white],
  ABSENT: [colors.absentText, colors.white],
  LATE: [colors.saffron, colors.navy],
};

function Mark({ label, a11y, on, mark, disabled, onPress }: { label: string; a11y: string; on: boolean; mark: AttendanceMark; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={a11y}
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: on ? ON[mark][0] : "transparent" }}
    >
      <Text size={13} weight={800} color={on ? ON[mark][1] : colors.textSoft}>{label}</Text>
    </Pressable>
  );
}

const nameOf = (r: RosterRow) => [r.first_name, r.last_name].filter(Boolean).join(" ");

export default function TakeAttendance() {
  const { t } = useT();
  const { longToday } = useDates();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { active, token } = useAccounts();
  const params = useLocalSearchParams<{ sectionId: string; name: string; date?: string }>();
  const sectionId = Number(params.sectionId);
  const today = todayIndia();
  const [date, setDate] = useState(params.date && params.date <= today ? params.date : today);
  const roster = useMe("staff-roster", (h, tk) => api.staffRoster(h, tk, sectionId, date), [sectionId, date]);
  const [marks, setMarks] = useState<Record<number, AttendanceMark>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "warn" | "error" } | null>(null);

  // a fresh roster (another day, or after a save) starts from what the server has
  useEffect(() => {
    if (!roster.data) return;
    setMarks(Object.fromEntries(roster.data.roster.map((r) => [r.student_profile_id, r.status])));
  }, [roster.data]);
  useEffect(() => setMessage(null), [date]);

  const r = roster.data;
  const working = r?.day_status.status === "WORKING";
  const editable = !!r && working && r.lock_status.can_edit;
  const counts = useMemo(() => {
    const v = Object.values(marks);
    return { present: v.filter((m) => m === "PRESENT").length, absent: v.filter((m) => m === "ABSENT").length, late: v.filter((m) => m === "LATE").length };
  }, [marks]);
  const label = `${params.name} · ${longToday(date)}`;

  const save = async () => {
    if (!r || !active || !token) return;
    const body = {
      section_id: sectionId,
      attendance_date: date,
      based_on: r.session?.updated_at ?? null,
      records: r.roster.map((row) => {
        const status = marks[row.student_profile_id] ?? row.status;
        // the leave stays linked only while the student is marked absent
        return { student_profile_id: row.student_profile_id, status, leave_application_id: status === "ABSENT" ? row.leave_application_id : null, remark: status === "ABSENT" ? row.remark : null };
      }),
    };
    setSaving(true);
    setMessage(null);
    try {
      await api.saveAttendance(active.school.host, token, body);
      qc.invalidateQueries({ queryKey: [active.id, "staff-sections"] });
      await roster.refetch();
      setMessage({ text: t("attendanceSaved"), tone: "info" });
      Alert.alert(t("attendanceSaved"), label, [{ text: "OK", onPress: () => router.back() }]);
    } catch (e) {
      if (e instanceof ApiError && (e.offline || e.status >= 500)) {
        await Queue.enqueue(active.id, { save: body, label, queuedAt: Date.now() });
        setMessage({ text: t("savedOnPhone"), tone: "warn" });
      } else if (e instanceof ApiError && e.code === "CHANGED") {
        if (e.changed?.byId === active.userId) {
          setMessage({ text: t("attendanceSaved"), tone: "info" });
        } else {
          setMessage({ text: t("theirSaveKept", { by: e.changed?.by ?? t("someone"), label, time: timeIndia(e.changed?.at) }), tone: "warn" });
        }
        await roster.refetch(); // show what is saved now
      } else {
        setMessage({ text: e instanceof ApiError ? e.message : t("errorGeneric"), tone: "error" });
      }
    } finally {
      setSaving(false);
    }
  };

  const reason = r && !working ? (r.day_status.title || r.day_status.remark || r.day_status.status) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ backgroundColor: colors.navy, paddingTop: insets.top + 12, paddingHorizontal: size.side, paddingBottom: 56, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <BackButton onNavy label={t("cancel")} />
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header" size={18} weight={800} color={colors.white}>{t("sectionAttendance", { name: params.name })}</Text>
            <Text size={12} weight={600} color={colors.whiteSoft}>
              {longToday(date)}{r ? ` · ${t("studentsCount", { n: r.roster.length })}` : ""}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("previousDay")} onPress={() => setDate(addDays(date, -1))} style={{ flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center" }}>
            <Text size={13} weight={700} color={colors.white}>‹ {t("previousDay")}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t("nextDay")} disabled={date >= today} onPress={() => setDate(addDays(date, 1))} style={{ flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center", opacity: date >= today ? 0.4 : 1 }}>
            <Text size={13} weight={700} color={colors.white}>{t("nextDay")} ›</Text>
          </Pressable>
        </View>
      </View>

      <View style={[{ marginTop: -40, marginHorizontal: size.side, backgroundColor: colors.white, borderRadius: 20, padding: 16, flexDirection: "row" }, cardShadow]}>
        {[
          { n: counts.present, label: t("present"), color: colors.presentText },
          { n: counts.absent, label: t("absent"), color: colors.absentText },
          { n: counts.late, label: t("late"), color: "#B45309" },
        ].map((c, i) => (
          <View key={c.label} style={{ flex: 1, alignItems: "center", borderLeftWidth: i ? 1 : 0, borderLeftColor: colors.line }}>
            <Text size={26} weight={800} color={c.color}>{String(c.n)}</Text>
            <Text size={12} weight={700} color={colors.textSoft}>{c.label}</Text>
          </View>
        ))}
      </View>

      <FlatList
        data={r?.roster ?? []}
        keyExtractor={(row) => String(row.student_profile_id)}
        contentContainerStyle={{ padding: size.side, paddingBottom: 16, gap: 0 }}
        refreshControl={<RefreshControl refreshing={roster.isRefetching} onRefresh={() => roster.refetch()} />}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 10 }}>
            <OfflineBanner at={roster.offlineAt} />
            {message ? <Notice tone={message.tone} text={message.text} /> : null}
            {reason ? <Notice tone="warn" text={t("dayNotWorking", { reason })} /> : null}
            {r && working && !r.lock_status.can_edit && r.session ? <Notice tone="warn" text={t("dayLocked", { reason: r.lock_status.lock_reason })} /> : null}
            {r?.session ? <Text size={12} weight={600} color={colors.textSoft}>{t("savedBy", { name: r.session.marker_name ?? t("someone"), time: timeIndia(r.session.updated_at) })}</Text> : null}
            {editable ? <Text size={13} weight={600} color={colors.textSoft}>{t("marksHint")}</Text> : null}
          </View>
        }
        ListEmptyComponent={<ListState pending={roster.isPending} error={roster.error} emptyText={t("noSections")} onRetry={() => roster.refetch()} />}
        renderItem={({ item, index }) => {
          const m = marks[item.student_profile_id] ?? item.status;
          const tint = TINTS[index % TINTS.length];
          const name = nameOf(item);
          const set = (v: AttendanceMark) => setMarks((x) => ({ ...x, [item.student_profile_id]: v }));
          return (
            <View style={{ backgroundColor: colors.white, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: colors.lineSoft, borderTopLeftRadius: index === 0 ? 18 : 0, borderTopRightRadius: index === 0 ? 18 : 0 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tint[0], alignItems: "center", justifyContent: "center" }}>
                <Text size={14} weight={800} color={tint[1]}>{name.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text size={14} weight={700} numberOfLines={1}>{name}</Text>
                <Text size={11} weight={600} color={colors.textSoft} numberOfLines={1}>
                  {[item.roll_number ? `Roll ${item.roll_number}` : null, item.admission_no].filter(Boolean).join(" · ")}
                </Text>
                {item.leave_application_id ? (
                  <Text size={11} weight={700} color="#B45309" numberOfLines={1}>{`${t("onLeave")}${item.leave_type_name ? ` · ${item.leave_type_name}` : ""}`}</Text>
                ) : null}
              </View>
              <View accessibilityRole="radiogroup" accessibilityLabel={name} style={{ flexDirection: "row", gap: 2, backgroundColor: colors.bg, borderRadius: 12, padding: 3 }}>
                <Mark label="P" a11y={t("present")} mark="PRESENT" on={m === "PRESENT"} disabled={!editable} onPress={() => set("PRESENT")} />
                <Mark label="A" a11y={t("absent")} mark="ABSENT" on={m === "ABSENT"} disabled={!editable} onPress={() => set("ABSENT")} />
                <Mark label="L" a11y={t("late")} mark="LATE" on={m === "LATE"} disabled={!editable} onPress={() => set("LATE")} />
              </View>
            </View>
          );
        }}
      />

      {editable ? (
        <View style={{ paddingHorizontal: size.side, paddingTop: 8, paddingBottom: insets.bottom + 16, backgroundColor: colors.bg }}>
          <Button label={t("saveAttendance")} onPress={save} busy={saving} />
        </View>
      ) : null}
    </View>
  );
}
