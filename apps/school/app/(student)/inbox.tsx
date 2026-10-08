// Notifications inbox (FR-C08, B-05): every push is also kept here; unread rows stand out.
// Tapping a row marks it read and opens the screen its link points to, when the app has one.
import React from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, InboxRow } from "@/core/api";
import { useActive } from "@/core/useSchool";
import { todayIndia } from "@/core/format";
import { appRouteFor } from "@/core/links";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { IconName } from "@/ui/icons";
import { Text } from "@/ui/Text";
import { ListState, Screen } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";

const iconFor = (type: string): IconName =>
  /home/i.test(type) ? "homework" : /fee|pay/i.test(type) ? "fees" : /attend|absent|leave/i.test(type) ? "attendance" : /result|report|exam/i.test(type) ? "results" : "notices";

export default function Inbox() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const { host, token, id } = useActive();
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: [id, "inbox"],
    queryFn: ({ pageParam }) => api.inboxPage(host, token!, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before ?? undefined,
    enabled: !!token,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const unread = q.data?.pages[0]?.unread_count ?? 0;
  const today = todayIndia();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: [id, "inbox"] });
    qc.invalidateQueries({ queryKey: [id, "unread"] });
  };
  const open = async (n: InboxRow) => {
    if (!n.is_read) api.markRead(host, token!, n.id).then(refresh).catch(() => {});
    const to = appRouteFor(n.link);
    if (to) router.push(to as never);
  };

  return (
    <Screen
      title={t("inboxTitle")}
      right={
        unread > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => api.markAllRead(host, token!).then(refresh).catch(() => {})} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
            <Text size={13} weight={800} color={colors.indigo}>{t("markAllRead")}</Text>
          </Pressable>
        ) : null
      }
    >
      <FlatList
        data={rows}
        keyExtractor={(n) => String(n.id)}
        contentContainerStyle={{ padding: size.side, gap: 10, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={<ListState pending={q.isPending} error={q.error} emptyText={t("noInbox")} />}
        renderItem={({ item }) => {
          const day = item.created_at ? new Date(Date.parse(item.created_at) + 330 * 60000).toISOString().slice(0, 10) : "";
          const when = day === today ? t("todayLabel") : dayMonth(day);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: !item.is_read }}
              onPress={() => open(item)}
              style={[{ flexDirection: "row", gap: 12, backgroundColor: item.is_read ? colors.white : "#F2F1FF", borderRadius: 18, padding: 12 }, cardShadow]}
            >
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
                <Icon name={iconFor(item.type)} size={28} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text size={14} weight={item.is_read ? 700 : 800} style={{ flex: 1 }} numberOfLines={2}>{item.title}</Text>
                  {!item.is_read ? <View accessibilityLabel="unread" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.indigo }} /> : null}
                </View>
                {item.body ? <Text size={13} weight={500} color={colors.textMid} numberOfLines={2}>{item.body}</Text> : null}
                <Text size={11} weight={600} color={colors.textSoft}>{when}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
