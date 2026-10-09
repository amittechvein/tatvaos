// Student leave requests (FR-T04): a class teacher sees their sections' requests (an admin: all),
// waiting ones first, and opens one to approve or reject it. The website's list, unchanged.
import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { api, ApiError, LeaveStatus, StaffLeave } from "@/core/api";
import { useMe } from "@/core/useSchool";
import { useT } from "@/core/i18n";
import { leaveName, useLeaveText } from "@/core/leaveText";
import { Text } from "@/ui/Text";
import { Notice } from "@/ui/parts";
import { ListState, Screen } from "@/ui/Screen";
import { Segments } from "@/ui/Segments";
import { cardShadow, colors, size } from "@/ui/theme";

function Row({ l }: { l: StaffLeave }) {
  const { t } = useT();
  const text = useLeaveText();
  const name = leaveName(l);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${text.dates(l)}`}
      onPress={() => router.push({ pathname: "/leave-request", params: { id: String(l.id) } })}
      style={({ pressed }) => [{ marginHorizontal: size.side, marginBottom: 10, padding: 14, borderRadius: 18, backgroundColor: pressed ? colors.lineSoft : colors.white, gap: 4 }, cardShadow]}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text size={15} weight={800} numberOfLines={1} style={{ flex: 1 }}>{name}</Text>
        <Text size={12} weight={700} color={colors.textSoft}>{text.klass(l)}</Text>
      </View>
      <Text size={13} weight={700} color={colors.indigo}>{`${text.dates(l)} · ${text.days(l)}${l.leave_type_name ? ` · ${l.leave_type_name}` : ""}`}</Text>
      {l.reason ? <Text size={13} weight={500} color={colors.textMid} numberOfLines={2}>{l.reason}</Text> : null}
      {l.status === "PENDING" && l.exceeds_quota ? (
        <Text size={12} weight={700} color={colors.absentText}>{t("overBalance", { n: Number(l.current_available_quota ?? 0) })}</Text>
      ) : null}
      {l.status !== "PENDING" && l.reviewed_by_name ? (
        <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>{l.review_remark ? `${l.reviewed_by_name}: ${l.review_remark}` : l.reviewed_by_name}</Text>
      ) : null}
    </Pressable>
  );
}

export default function LeaveRequests() {
  const { t } = useT();
  const [tab, setTab] = useState<LeaveStatus>("PENDING");
  const list = useMe("staff-leaves", (h, tk) => api.staffLeaves(h, tk, tab), [tab]);
  const noFeature = list.error instanceof ApiError && list.error.status === 403;

  return (
    <Screen title={t("leaveRequests")}>
      <Segments
        value={tab}
        onChange={setTab}
        options={[
          { key: "PENDING", label: t("pending") },
          { key: "APPROVED", label: t("approved") },
          { key: "REJECTED", label: t("rejected") },
        ]}
      />
      <FlatList
        data={list.data?.data ?? []}
        keyExtractor={(l) => String(l.id)}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => list.refetch()} />}
        ListHeaderComponent={noFeature ? <View style={{ margin: size.side }}><Notice text={t("noLeaveFeature")} /></View> : null}
        ListEmptyComponent={noFeature ? null : <ListState pending={list.isPending} error={list.error} emptyText={t("noLeaveRequests")} onRetry={() => list.refetch()} />}
        renderItem={({ item }) => <Row l={item} />}
      />
    </Screen>
  );
}
