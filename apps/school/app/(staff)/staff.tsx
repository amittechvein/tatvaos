// Teacher home (Phase 2). For now: take attendance for the sections this login is class teacher
// of (an admin: every section), with today's state, and the saves still waiting to be sent.
// The other teacher screens (SRS FR-T01, FR-T03 to FR-T09) come next; until then the website.
import React, { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccounts } from "@/core/accounts";
import { api, ApiError, StaffSection } from "@/core/api";
import * as Queue from "@/core/attendanceQueue";
import { useMe } from "@/core/useSchool";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { Button, Notice, OfflineBanner } from "@/ui/parts";
import { ListState, SectionTitle } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";
import { useSendWaiting } from "@/core/useSendWaiting";

function SectionCard({ s, onPress }: { s: StaffSection; onPress: () => void }) {
  const { t } = useT();
  const name = `${s.className}-${s.section}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("takeAttendance")}: ${name}`}
      onPress={onPress}
      style={({ pressed }) => [
        { marginHorizontal: size.side, marginBottom: 10, padding: 16, borderRadius: 18, backgroundColor: pressed ? colors.lineSoft : colors.white, flexDirection: "row", alignItems: "center", gap: 14 },
        cardShadow,
      ]}
    >
      <Icon name="attendance" size={36} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={16} weight={800}>{name}</Text>
        <Text size={12} weight={600} color={colors.textSoft}>{t("studentsCount", { n: s.students })}</Text>
        <Text size={12} weight={700} color={s.today ? colors.presentText : colors.absentText}>
          {s.today ? t("takenToday", { p: s.today.present, a: s.today.absent, l: s.today.late }) : t("notTakenToday")}
        </Text>
      </View>
      <Icon name="arrowRight" size={20} color={colors.textSoft} />
    </Pressable>
  );
}

export default function StaffHome() {
  const { t } = useT();
  const { longToday } = useDates();
  const insets = useSafeAreaInsets();
  const { active, accounts, signOut, switchTo } = useAccounts();
  const sections = useMe("staff-sections", api.staffSections);
  const leaves = useMe("staff-leaves", (h, tk) => api.staffLeaves(h, tk, "PENDING"), ["PENDING"]);
  const waitingLeaves = leaves.data?.pagination.total ?? 0;
  const sendWaiting = useSendWaiting();
  const [waiting, setWaiting] = useState(0);
  const [sending, setSending] = useState(false);

  const countWaiting = useCallback(async () => {
    if (active) setWaiting((await Queue.read(active.id)).length);
  }, [active]);
  useFocusEffect(useCallback(() => { countWaiting(); sections.refetch(); leaves.refetch(); }, [countWaiting])); // eslint-disable-line react-hooks/exhaustive-deps

  const noFeature = sections.error instanceof ApiError && sections.error.status === 403;
  const student = accounts.find((a) => a.role === "STUDENT");
  const doSignOut = async () => {
    if (!active) return;
    await signOut(active.id);
    router.replace("/");
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ backgroundColor: colors.navy, paddingTop: insets.top + 16, paddingHorizontal: size.side, paddingBottom: 20, gap: 4 }}>
        <Text accessibilityRole="header" size={22} weight={800} color={colors.white}>{active?.name ?? ""}</Text>
        <Text size={13} weight={600} color={colors.whiteSoft}>{active?.school.name ?? ""}</Text>
        {sections.data ? <Text size={13} weight={600} color={colors.whiteSoft}>{longToday(sections.data.date)}</Text> : null}
      </View>
      <FlatList
        data={sections.data?.sections ?? []}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={sections.isRefetching} onRefresh={() => { sections.refetch(); leaves.refetch(); countWaiting(); }} />}
        ListHeaderComponent={
          <View style={{ gap: 12, paddingTop: 12 }}>
            <OfflineBanner at={sections.offlineAt} />
            {waiting ? (
              <View style={{ marginHorizontal: size.side, gap: 8 }}>
                <Notice tone="warn" text={waiting === 1 ? t("waitingToSendOne") : t("waitingToSend", { n: waiting })} />
                <Button
                  label={t("sendNow")}
                  kind="outline"
                  busy={sending}
                  onPress={async () => { setSending(true); await sendWaiting(); await countWaiting(); setSending(false); }}
                />
              </View>
            ) : null}
            {leaves.data ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t("leaveRequests")}: ${waitingLeaves === 1 ? t("leavesWaitingOne") : waitingLeaves ? t("leavesWaiting", { n: waitingLeaves }) : t("leavesNoneWaiting")}`}
                onPress={() => router.push("/leave-requests")}
                style={({ pressed }) => [
                  { marginHorizontal: size.side, padding: 16, borderRadius: 18, backgroundColor: pressed ? colors.lineSoft : colors.white, flexDirection: "row", alignItems: "center", gap: 14 },
                  cardShadow,
                ]}
              >
                <Icon name="notices" size={36} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text size={16} weight={800}>{t("leaveRequests")}</Text>
                  <Text size={12} weight={700} color={waitingLeaves ? colors.absentText : colors.textSoft}>
                    {waitingLeaves === 1 ? t("leavesWaitingOne") : waitingLeaves ? t("leavesWaiting", { n: waitingLeaves }) : t("leavesNoneWaiting")}
                  </Text>
                </View>
                <Icon name="arrowRight" size={20} color={colors.textSoft} />
              </Pressable>
            ) : null}
            {noFeature ? <View style={{ marginHorizontal: size.side }}><Notice text={t("noAttendanceFeature")} /></View> : null}
            {sections.data?.sections.length ? <SectionTitle text={t("takeAttendance")} /> : null}
          </View>
        }
        ListEmptyComponent={noFeature ? null : <ListState pending={sections.isPending} error={sections.error} emptyText={t("noSections")} onRetry={() => sections.refetch()} />}
        renderItem={({ item }) => (
          <SectionCard
            s={item}
            onPress={() => router.push({ pathname: "/take-attendance", params: { sectionId: String(item.id), name: `${item.className}-${item.section}`, date: sections.data!.date } })}
          />
        )}
        ListFooterComponent={
          <View style={{ padding: size.side, gap: 12 }}>
            <Text size={13} weight={500} color={colors.textSoft} style={{ lineHeight: 19 }}>{t("staffSoon")}</Text>
            {student ? <Button label={student.name} kind="outline" onPress={async () => { await switchTo(student.id); router.replace("/home"); }} /> : null}
            <Button
              label={t("signOut")}
              kind="outline"
              onPress={() =>
                waiting
                  ? Alert.alert(t("signOut"), t("signOutWaiting", { n: waiting }), [
                      { text: t("cancel"), style: "cancel" },
                      { text: t("signOut"), style: "destructive", onPress: doSignOut },
                    ])
                  : doSignOut()
              }
            />
          </View>
        }
      />
    </View>
  );
}
