// Library (FR-S11): the books the student has, due dates, overdue books and fines. Search and
// reserve stay on the website for now.
import React from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { api, ApiError } from "@/core/api";
import { useMe } from "@/core/useSchool";
import { inr } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { Card, Notice } from "@/ui/parts";
import { ListState, Screen, SectionTitle } from "@/ui/Screen";
import { cardShadow, colors, size } from "@/ui/theme";

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text size={22} weight={800} color={tone === "bad" ? colors.absentText : colors.text}>{value}</Text>
      <Text size={12} weight={600} color={colors.textSoft}>{label}</Text>
    </View>
  );
}

export default function Library() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const me = useMe("library-me", api.libraryMe);
  const loans = useMe("library-loans", api.libraryLoans, [], !!me.data);
  const notMember = me.error instanceof ApiError && me.error.status === 404;

  return (
    <Screen title={t("library")} right={<Icon name="library" size={32} />}>
      <FlatList
        data={loans.data ?? []}
        keyExtractor={(l) => String(l.id)}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={me.isRefetching || loans.isRefetching} onRefresh={() => { me.refetch(); loans.refetch(); }} />}
        ListHeaderComponent={
          notMember ? (
            <View style={{ padding: size.side }}><Notice text={t("notMember")} /></View>
          ) : me.data ? (
            <View>
              <Card style={{ margin: size.side, marginBottom: 0, gap: 12 }}>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Stat label={t("booksWithYou")} value={String(me.data.counts.open)} />
                  <Stat label={t("overdueBooks")} value={String(me.data.counts.overdue)} tone={me.data.counts.overdue ? "bad" : undefined} />
                  <Stat label={t("libraryFine")} value={inr(me.data.counts.pending_fine)} tone={me.data.counts.pending_fine ? "bad" : undefined} />
                </View>
                {me.data.rule ? <Text size={12} weight={600} color={colors.textSoft}>{t("libraryRule", { n: me.data.rule.max_books, d: me.data.rule.loan_days })}</Text> : null}
              </Card>
              <SectionTitle text={t("booksWithYou")} />
            </View>
          ) : null
        }
        ListEmptyComponent={notMember ? null : <ListState pending={me.isPending || loans.isPending} error={me.error || loans.error} emptyText={t("noLoans")} />}
        renderItem={({ item }) => (
          <View style={[{ marginHorizontal: size.side, marginBottom: 10, flexDirection: "row", gap: 12, alignItems: "center", backgroundColor: colors.white, borderRadius: 18, padding: 12 }, cardShadow]}>
            <Icon name="library" size={32} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text size={15} weight={800} numberOfLines={2}>{item.title ?? ""}</Text>
              {item.authors ? <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>{item.authors}</Text> : null}
            </View>
            {item.due_on ? (
              <Text size={12} weight={800} color={item.is_overdue ? colors.absentText : colors.textMid}>
                {item.is_overdue ? t("overdue") : t("dueOn", { date: dayMonth(item.due_on.slice(0, 10)) })}
              </Text>
            ) : null}
          </View>
        )}
      />
    </Screen>
  );
}
