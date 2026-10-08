// Calendar (FR-C09, FR-S09): the school's events and holidays for this student, a month at a time.
import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { api, FEATURES, hasFeature } from "@/core/api";
import { useBoot, useMe } from "@/core/useSchool";
import { todayIndia } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { BottomNav } from "@/ui/BottomNav";
import { ListState, Screen } from "@/ui/Screen";
import { Notice } from "@/ui/parts";
import { cardShadow, colors, size } from "@/ui/theme";

const shift = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
};
const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

export default function Calendar() {
  const { t } = useT();
  const { months, dayMonth, longToday } = useDates();
  const b = useBoot().data!;
  const allowed = hasFeature(b, ...FEATURES.calendar);
  const [month, setMonth] = useState(todayIndia().slice(0, 7));
  const q = useMe("calendar", (h, tk) => api.calendar(h, tk, `${month}-01`, lastDay(month)), [month], allowed);
  const [y, m] = month.split("-").map(Number);
  const events = [...(q.data ?? [])].sort((a, c) => a.start.localeCompare(c.start));

  return (
    <View style={{ flex: 1 }}>
      <Screen tab offlineAt={q.offlineAt} title={t("calendarTitle")} right={<Icon name="navCalendar" size={26} color={colors.indigo} />}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: size.side, paddingTop: 16 }}>
          <MonthButton label={t("prevMonth")} onPress={() => setMonth(shift(month, -1))} />
          <Text size={16} weight={800}>{months[m - 1]} {y}</Text>
          <MonthButton label={t("nextMonth")} flip onPress={() => setMonth(shift(month, 1))} />
        </View>
        {!allowed ? (
          <View style={{ padding: size.side }}><Notice text={t("comingSoon")} /></View>
        ) : (
          <FlatList
            data={events}
            keyExtractor={(e) => String(e.id)}
            contentContainerStyle={{ padding: size.side, gap: 10, paddingBottom: 120 }}
            refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
            ListEmptyComponent={<ListState pending={q.isPending} error={q.error} emptyText={t("noEvents")} />}
            renderItem={({ item }) => {
              const holiday = item.type === "HOLIDAY";
              const tint = holiday ? colors.holiday : item.color || colors.late;
              const [, , d] = item.start.split("-").map(Number);
              return (
                <View style={[{ flexDirection: "row", gap: 12, backgroundColor: colors.white, borderRadius: 18, padding: 12, alignItems: "center" }, cardShadow]}>
                  <View style={{ width: 52, height: 56, borderRadius: 14, backgroundColor: holiday ? colors.bg : colors.indigoSoft, alignItems: "center", justifyContent: "center" }}>
                    <Text size={20} weight={800} color={holiday ? colors.textSoft : colors.indigo}>{d}</Text>
                    <Text size={11} weight={700} color={colors.textSoft}>{months[m - 1].slice(0, 3)}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
                      <Text size={12} weight={700} color={colors.textSoft}>{holiday ? t("holidayLabel") : t("eventLabel")}</Text>
                    </View>
                    <Text size={15} weight={800}>{item.title}</Text>
                    <Text size={12} weight={600} color={colors.textSoft}>
                      {item.end && item.end !== item.start ? `${dayMonth(item.start)} – ${dayMonth(item.end)}` : longToday(item.start)}
                      {item.startTime ? ` · ${item.startTime.slice(0, 5)}` : ""}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        )}
      </Screen>
      <BottomNav current="calendar" />
    </View>
  );
}

function MonthButton({ label, onPress, flip }: { label: string; onPress: () => void; flip?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ width: 44, height: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: "center", justifyContent: "center", transform: flip ? [{ scaleX: -1 }] : undefined }}
    >
      <Icon name="back" size={16} color={colors.text} />
    </Pressable>
  );
}
