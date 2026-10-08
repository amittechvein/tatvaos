// Results (FR-S08): report cards the school has published, as PDF. Nothing shows before the
// school publishes. A card held for unpaid fees says so and cannot be opened.
import React, { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { useActive, useMe } from "@/core/useSchool";
import { openPdf } from "@/core/files";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { ListState, Screen } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";
import { ActivityIndicator } from "react-native";

export default function Results() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const qc = useQueryClient();
  const { host, token, id } = useActive();
  const q = useMe("report-cards", api.reportCards);
  const [opening, setOpening] = useState<number | null>(null);

  const open = async (cardId: number, exam: string) => {
    setOpening(cardId);
    try {
      const url = await api.reportCardUrl(host, token!, cardId);
      await openPdf(url, `Report card ${exam}`);
      qc.invalidateQueries({ queryKey: [id, "report-cards"] });
    } catch {
      Alert.alert(t("fileFailed"));
    } finally {
      setOpening(null);
    }
  };

  return (
    <Screen title={t("results")} right={<Icon name="results" size={32} />}>
      <FlatList
        data={q.data ?? []}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={{ padding: size.side, gap: 10, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        ListEmptyComponent={<ListState pending={q.isPending} error={q.error} emptyText={t("noReportCards")} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            disabled={item.held || opening !== null}
            onPress={() => open(item.id, item.exam)}
            style={[{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.white, borderRadius: 18, padding: 14, opacity: item.held ? 0.7 : 1 }, cardShadow]}
          >
            <View style={{ width: 48, height: 48, borderRadius: 15, backgroundColor: "#FFF3E0", alignItems: "center", justifyContent: "center" }}>
              <Icon name="results" size={32} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text size={15} weight={800} style={{ flexShrink: 1 }} numberOfLines={1}>{item.exam}</Text>
                {!item.seen && !item.held ? (
                  <View style={{ borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: colors.yellow }}>
                    <Text size={10} weight={800} color={colors.navy}>{t("newLabel")}</Text>
                  </View>
                ) : null}
              </View>
              <Text size={12} weight={600} color={item.held ? colors.absentText : colors.textSoft}>
                {item.held ? t("heldCard") : item.publishedAt ? t("publishedOn", { date: dayMonth(item.publishedAt.slice(0, 10)) }) : ""}
              </Text>
            </View>
            {opening === item.id ? <ActivityIndicator color={colors.indigo} /> : !item.held ? <Text size={13} weight={800} color={colors.indigo}>{t("openPdf")}</Text> : null}
          </Pressable>
        )}
      />
    </Screen>
  );
}
