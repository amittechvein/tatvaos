// Assignments (FR-S04): the student's assignments with due date and submission status, paged.
import React from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { api, AssignmentRow } from "@/core/api";
import { useMePages } from "@/core/useSchool";
import { useDates, useT } from "@/core/i18n";
import type { StringKey } from "@/core/strings";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { ListState, Screen } from "@/ui/Screen";
import { Segments } from "@/ui/Segments";
import { cardShadow, colors, size } from "@/ui/theme";

/** The submission state as a label and colours. */
function submissionLook(a: Pick<AssignmentRow, "submission" | "dueDate">): { key: StringKey; fg: string; bg: string } {
  const s = a.submission?.status?.toUpperCase();
  if (s === "ACCEPTED" || s === "GRADED" || s === "CHECKED") return { key: "checkedStatus", fg: colors.presentText, bg: colors.presentBg };
  if (s === "RETURNED" || s === "REJECTED") return { key: "returnedStatus", fg: "#7A4D00", bg: "#FFF3E0" };
  if (s) return { key: "submittedStatus", fg: colors.indigo, bg: colors.indigoSoft };
  const overdue = a.dueDate ? Date.parse(a.dueDate) < Date.now() : false;
  return { key: "notSubmitted", fg: overdue ? colors.absentText : colors.textSoft, bg: overdue ? "#FDECEF" : colors.bg };
}

export default function Assignments() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const q = useMePages("assignment-pages", api.assignmentsPage);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Screen title={t("homeworkTitle")} right={<Icon name="homework" size={34} />}>
      <Segments value="assignments" options={[{ key: "homework", label: t("homeworkTitle") }, { key: "assignments", label: t("assignmentsTitle") }]} onChange={() => router.replace("/homework")} />
      <FlatList
        data={items}
        keyExtractor={(a) => String(a.id)}
        contentContainerStyle={{ padding: size.side, gap: 10, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={<ListState onRetry={() => q.refetch()} pending={q.isPending} error={q.error} emptyText={t("noAssignments")} />}
        renderItem={({ item }) => {
          const look = submissionLook(item);
          const due = item.dueDate ? new Date(Date.parse(item.dueDate) + 330 * 60000).toISOString().slice(0, 10) : null;
          return (
            <Pressable accessibilityRole="button" onPress={() => router.push(`/assignments/${item.id}`)} style={[{ backgroundColor: colors.white, borderRadius: 18, padding: 14, gap: 6 }, cardShadow]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text size={12} weight={700} color={colors.textSoft} style={{ flex: 1 }} numberOfLines={1}>{item.subject ?? ""}</Text>
                <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: look.bg }}>
                  <Text size={11} weight={800} color={look.fg}>{t(look.key)}</Text>
                </View>
              </View>
              <Text size={15} weight={800}>{item.title}</Text>
              {due ? <Text size={12} weight={600} color={colors.textSoft}>{t("dueOn", { date: dayMonth(due) })}</Text> : null}
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
