// Timetable (FR-S05): today's periods, and any day of this week with one tap. Swapped periods
// (a substitute teacher or subject today) are marked.
import React, { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { api } from "@/core/api";
import { useMe } from "@/core/useSchool";
import { todayIndia } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { ListState, Screen } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const clean = (s: string | null) => (s ?? "").replace(/^SWAPPED → /, "");

export default function Timetable() {
  const { t } = useT();
  const { weekdaysShort, longToday } = useDates();
  const today = todayIndia();
  // this week, Monday to Saturday
  const week = useMemo(() => {
    const wd = new Date(today + "T12:00:00Z").getUTCDay();
    const monday = addDays(today, wd === 0 ? 1 : 1 - wd);
    return Array.from({ length: 6 }, (_, i) => addDays(monday, i));
  }, [today]);
  const [day, setDay] = useState(week.includes(today) ? today : week[0]);
  const q = useMe("timetable", (h, tk) => api.timetableDay(h, tk, day), [day]);
  const periods = q.data?.is_school_open ? q.data.periods : [];

  return (
    <Screen offlineAt={q.offlineAt} title={t("timetable")} sub={longToday(day)} right={<Icon name="timetable" size={32} />}>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: size.side, paddingVertical: 12, gap: 8 }}>
          {week.map((d) => {
            const on = d === day;
            const wd = new Date(d + "T12:00:00Z").getUTCDay();
            return (
              <Pressable
                key={d}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={longToday(d)}
                onPress={() => setDay(d)}
                style={{ width: 52, height: 64, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.indigo : colors.white, borderWidth: d === today && !on ? 2 : 0, borderColor: colors.indigo }}
              >
                <Text size={12} weight={700} color={on ? colors.white : colors.textSoft}>{weekdaysShort[wd]}</Text>
                <Text size={18} weight={800} color={on ? colors.white : colors.text}>{Number(d.slice(8))}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <FlatList
        data={periods}
        keyExtractor={(p) => String(p.slot_number)}
        contentContainerStyle={{ paddingHorizontal: size.side, paddingBottom: 32, gap: 10 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        ListEmptyComponent={<ListState onRetry={() => q.refetch()} pending={q.isPending} error={q.error} emptyText={t("noClassesDay")} />}
        renderItem={({ item }) => {
          const isBreak = item.type === "BREAK" || item.type === "LUNCH";
          const subject = clean(item.subject);
          return (
            <View style={[{ flexDirection: "row", gap: 12, alignItems: "center", backgroundColor: isBreak ? colors.bg : colors.white, borderRadius: 16, padding: 12 }, isBreak ? null : cardShadow]}>
              <View style={{ width: 64 }}>
                <Text size={13} weight={800}>{item.start_time?.slice(0, 5) ?? ""}</Text>
                <Text size={12} weight={600} color={colors.textSoft}>{item.end_time?.slice(0, 5) ?? ""}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text size={15} weight={isBreak ? 600 : 800} color={isBreak ? colors.textSoft : colors.text}>
                  {subject === "Free" ? t("freePeriod") : subject || item.label || ""}
                </Text>
                {item.teacher ? <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>{clean(item.teacher)}</Text> : null}
              </View>
              {item.is_swapped ? (
                <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: "#FFF3E0" }}>
                  <Text size={11} weight={800} color="#7A4D00">{t("changedToday")}</Text>
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </Screen>
  );
}
