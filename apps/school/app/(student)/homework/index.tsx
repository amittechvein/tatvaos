// Homework list (FR-S04): the student's own homework, newest day first, paged 20 at a time.
import React, { useMemo } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { api, HomeworkRow } from "@/core/api";
import { useMePages } from "@/core/useSchool";
import { todayIndia } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { ListState, Screen, SectionTitle } from "@/ui/Screen";
import { Segments } from "@/ui/Segments";
import { FEATURES, hasFeature } from "@/core/api";
import { useBoot } from "@/core/useSchool";
import { cardShadow, colors, size } from "@/ui/theme";

type Row = { kind: "day"; key: string; label: string } | { kind: "hw"; key: string; hw: HomeworkRow };

export default function HomeworkList() {
  const { t } = useT();
  const { longToday } = useDates();
  const q = useMePages("homework-pages", api.homeworkPage);
  const showAssignments = hasFeature(useBoot().data, ...FEATURES.assignments);
  const today = todayIndia();
  const yesterday = new Date(Date.parse(today + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let day = "";
    for (const hw of q.data?.pages.flatMap((p) => p.items) ?? []) {
      const d = hw.date.slice(0, 10);
      if (d !== day) {
        day = d;
        out.push({ kind: "day", key: "d" + d, label: d === today ? t("todayLabel") : d === yesterday ? t("yesterdayLabel") : longToday(d) });
      }
      out.push({ kind: "hw", key: "h" + hw.id, hw });
    }
    return out;
  }, [q.data, today, yesterday, t, longToday]);

  return (
    <Screen offlineAt={q.offlineAt} title={t("homeworkTitle")} right={<Icon name="homework" size={34} />}>
      {showAssignments ? (
        <Segments value="homework" options={[{ key: "homework", label: t("homeworkTitle") }, { key: "assignments", label: t("assignmentsTitle") }]} onChange={() => router.replace("/assignments")} />
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={<ListState onRetry={() => q.refetch()} pending={q.isPending} error={q.error} emptyText={t("noHomeworkYet")} />}
        renderItem={({ item }) =>
          item.kind === "day" ? (
            <SectionTitle text={item.label} />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/homework/${item.hw.id}`)}
              style={[{ marginHorizontal: size.side, marginBottom: 10, backgroundColor: colors.white, borderRadius: 18, padding: 14, gap: 4 }, cardShadow]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text size={15} weight={800} style={{ flex: 1 }} numberOfLines={1}>
                  {item.hw.subject ?? t("homeworkTitle")}
                </Text>
                {item.hw.attachments > 0 ? (
                  <Text size={12} weight={700} color={colors.indigo}>
                    {item.hw.attachments === 1 ? t("attachmentOne") : t("attachmentsN", { n: item.hw.attachments })}
                  </Text>
                ) : null}
              </View>
              <Text size={13} weight={500} color={colors.textMid} numberOfLines={2}>
                {item.hw.preview}
              </Text>
            </Pressable>
          )
        }
      />
    </Screen>
  );
}
