// 2 Student / parent home (FR-C07, FR-S01). Child and school in the header (tap to switch child),
// today's summary (attendance, homework, fees), quick-access tiles that follow the login's feature
// keys, and the bottom menu. Ask Ashu and Messages stay hidden until their phases.

import React from "react";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { api, FEATURES, hasFeature } from "@/core/api";
import { useActive, useBoot, useMe } from "@/core/useSchool";
import { inr, todayIndia } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { IconName } from "@/ui/icons";
import { Text } from "@/ui/Text";
import { BottomNav } from "@/ui/BottomNav";
import { ChildAvatar } from "@/ui/ChildAvatar";
import { cardShadow, colors, size } from "@/ui/theme";
import type { StringKey } from "@/core/strings";

function pctOf(v: number | string | null | undefined) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export default function Home() {
  const { t } = useT();
  const { longToday, dayMonth } = useDates();
  const insets = useSafeAreaInsets();
  const { active } = useActive();
  const boot = useBoot();
  const b = boot.data!;
  const today = todayIndia();

  const canAttendance = hasFeature(b, ...FEATURES.attendance);
  const canHomework = hasFeature(b, ...FEATURES.homework);
  const att = useMe("attendance", (h, tk) => api.attendance(h, tk, today.slice(0, 7)), [today.slice(0, 7)], canAttendance);
  const fees = useMe("fees", api.fees);
  const hw = useMe("homework", api.homework, [], canHomework);
  const unread = useMe("unread", api.unreadCount);

  const todayRow = att.data?.days.find((d) => d.date === today);
  const status: { label: StringKey; color: string } = !todayRow
    ? { label: "notMarked", color: colors.textSoft }
    : todayRow.status === "ABSENT"
      ? { label: "absentToday", color: colors.absentText }
      : todayRow.status === "LATE"
        ? { label: "lateToday", color: colors.late }
        : { label: "presentToday", color: colors.presentText };
  const pct = pctOf(att.data?.summary.attendance_percentage);
  const hwToday = (hw.data?.items ?? []).filter((h) => h.date?.slice(0, 10) === today && !h.noHomework).length;

  const hour = Number(new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(11, 13));
  const first = (active?.name ?? "").split(" ")[0];
  const greet = t(hour < 12 ? "goodMorning" : hour < 17 ? "goodAfternoon" : "goodEvening", { name: first });
  const student = b.student;
  const classLine = [student?.className && student?.section ? `${student.className}-${student.section}` : student?.className, b.school.name].filter(Boolean).join(" · ");

  const soon = () => Alert.alert(t("comingSoon"));
  const tiles: { icon: IconName; label: StringKey; show: boolean; go: () => void }[] = [
    { icon: "attendance", label: "attendance", show: canAttendance, go: () => router.push("/attendance") },
    { icon: "homework", label: "homework", show: canHomework, go: () => router.push("/homework") },
    { icon: "fees", label: "fees", show: true, go: () => router.push("/fees") },
    { icon: "results", label: "results", show: hasFeature(b, ...FEATURES.results), go: () => router.push("/results") },
    { icon: "timetable", label: "timetable", show: hasFeature(b, ...FEATURES.timetable), go: () => router.push("/timetable") },
    { icon: "notices", label: "notices", show: hasFeature(b, ...FEATURES.notices), go: () => router.push("/notices") },
    { icon: "library", label: "library", show: hasFeature(b, ...FEATURES.library), go: () => router.push("/library") },
    // Transport stays hidden until TatvaOS has a transport module (FR-S12).
  ];
  const refreshing = boot.isRefetching || att.isRefetching || fees.isRefetching;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.white}
            onRefresh={() => {
              boot.refetch();
              att.refetch();
              fees.refetch();
              hw.refetch();
              unread.refetch();
            }}
          />
        }
      >
        <View style={{ backgroundColor: colors.navy, paddingTop: insets.top + 12, paddingHorizontal: size.side, paddingBottom: 72, overflow: "hidden" }}>
          <View style={{ position: "absolute", right: -70, top: -60, width: 240, height: 240, borderRadius: 120, backgroundColor: "rgba(255,255,255,0.06)" }} />
          <View style={{ position: "absolute", left: -40, bottom: -90, width: 200, height: 200, borderRadius: 100, backgroundColor: "rgba(245,158,11,0.10)" }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityHint={t("switchChild")}
              onPress={() => router.push("/accounts")}
              style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}
            >
              <ChildAvatar name={active?.name ?? ""} photoUrl={student?.photoUrl} size={44} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Text size={16} weight={800} color={colors.white} numberOfLines={1} style={{ flexShrink: 1 }}>
                    {active?.name}
                  </Text>
                  <Icon name="chevronDown" size={16} color={colors.white} />
                </View>
                <Text size={12} weight={600} color={colors.whiteSoft} numberOfLines={1}>
                  {classLine}
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("notifications", { n: unread.data ?? 0 })}
              onPress={() => router.push("/inbox")}
              style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="bell" size={22} color={colors.white} />
              {unread.data ? (
                <View style={{ position: "absolute", top: 6, right: 6, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
                  <Text size={11} weight={800} color={colors.navy}>
                    {unread.data > 99 ? "99+" : unread.data}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          </View>
          <View style={{ marginTop: 22 }}>
            <Text size={13} weight={600} color={colors.whiteSoft}>
              {longToday(today)}
            </Text>
            <Text accessibilityRole="header" size={24} weight={800} color={colors.white} style={{ marginTop: 2 }}>
              {greet}
            </Text>
          </View>
        </View>

        {/* today summary */}
        <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: size.side, marginTop: -52 }}>
          {canAttendance ? (
            <Summary onPress={() => router.push("/attendance")}>
              <View style={{ width: 40, height: 40, borderRadius: 20, borderWidth: 4, borderColor: colors.present, alignItems: "center", justifyContent: "center" }}>
                <Text size={12} weight={800}>
                  {pct ?? "–"}
                </Text>
              </View>
              <Text size={14} weight={800} color={status.color} numberOfLines={2}>
                {t(status.label)}
              </Text>
              <Text size={11} weight={600} color={colors.textSoft} numberOfLines={2}>
                {pct !== null ? t("todayTerm", { pct }) : t("attendance")}
              </Text>
            </Summary>
          ) : null}
          {canHomework ? (
            <Summary onPress={() => router.push("/homework")}>
              <Icon name="homework" size={36} />
              <Text size={14} weight={800} numberOfLines={2}>
                {hwToday === 0 ? t("hwNone") : hwToday === 1 ? t("hwOne") : t("hwToday", { n: hwToday })}
              </Text>
              <Text size={11} weight={600} color={colors.textSoft}>
                {t("homework")}
              </Text>
            </Summary>
          ) : null}
          <Summary onPress={() => router.push("/fees")}>
            <Icon name="fees" size={36} />
            <Text size={14} weight={800} numberOfLines={2}>
              {fees.data ? (fees.data.dueNow > 0 ? inr(fees.data.dueNow) : t("noDues")) : "–"}
            </Text>
            <Text size={11} weight={600} color={colors.textSoft} numberOfLines={2}>
              {fees.data?.items.some((i) => i.active && i.due > 0 && i.status === "overdue")
                ? t("overdue")
                : fees.data?.nextDueDate
                  ? t("dueOn", { date: dayMonth(fees.data.nextDueDate) })
                  : t("fees")}
            </Text>
          </Summary>
        </View>

        <View style={{ paddingHorizontal: size.side, paddingTop: 24, paddingBottom: 12 }}>
          <Text size={16} weight={800}>
            {t("quickAccess")}
          </Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: size.side - 4 }}>
          {tiles
            .filter((x) => x.show)
            .map((x) => (
              <Pressable key={x.label} accessibilityRole="button" onPress={x.go} style={{ width: "25%", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 4 }}>
                <View style={[{ width: size.tile, height: size.tile, borderRadius: size.tileRadius, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" }, cardShadow]}>
                  <Icon name={x.icon} size={32} />
                </View>
                <Text size={12} weight={700} numberOfLines={1} style={{ textAlign: "center" }}>
                  {t(x.label)}
                </Text>
              </Pressable>
            ))}
        </View>
      </ScrollView>
      <BottomNav current="home" />
    </View>
  );
}

function Summary({ children, onPress }: { children: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[{ flex: 1, backgroundColor: colors.white, borderRadius: size.cardRadius, padding: 12, gap: 6, minHeight: 132 }, cardShadow]}
    >
      {children}
    </Pressable>
  );
}
