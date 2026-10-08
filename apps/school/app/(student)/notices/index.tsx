// Notices (FR-C09, FR-S09): school and class notices for this student, pinned first, paged.
// Students only read notices; nothing here can create one (FR-S13).
import React from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { api } from "@/core/api";
import { useMePages } from "@/core/useSchool";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { ListState, Screen } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";

function Tag({ text, tone }: { text: string; tone: "pin" | "high" }) {
  const [bg, fg] = tone === "pin" ? [colors.indigoSoft, colors.indigo] : ["#FDECEF", colors.absentText];
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: bg }}>
      <Text size={11} weight={800} color={fg}>{text}</Text>
    </View>
  );
}

export default function NoticesList() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const q = useMePages("notice-pages", api.noticesPage);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Screen offlineAt={q.offlineAt} title={t("noticesTitle")} right={<Icon name="notices" size={34} />}>
      <FlatList
        data={items}
        keyExtractor={(n) => String(n.id)}
        contentContainerStyle={{ padding: size.side, gap: 10, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={<ListState onRetry={() => q.refetch()} pending={q.isPending} error={q.error} emptyText={t("noNotices")} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/notices/${item.id}`)}
            style={[{ backgroundColor: colors.white, borderRadius: 18, padding: 14, gap: 6 }, cardShadow]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {item.pinned ? <Tag text={t("pinned")} tone="pin" /> : null}
              {item.priority && item.priority !== "NORMAL" ? <Tag text={t("important")} tone="high" /> : null}
              <Text size={12} weight={600} color={colors.textSoft}>{dayMonth(item.publishedAt?.slice(0, 10))}</Text>
            </View>
            <Text size={15} weight={800}>{item.title}</Text>
            {item.preview ? (
              <Text size={13} weight={500} color={colors.textMid} numberOfLines={2}>{item.preview}</Text>
            ) : null}
          </Pressable>
        )}
      />
    </Screen>
  );
}
