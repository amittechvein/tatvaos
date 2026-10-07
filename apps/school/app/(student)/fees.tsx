// 4 Fees (FR-S06, FR-S07). Total due now and the next due date, what makes up the amount, the Pay
// button, and receipts. The amounts are the backend's (the same as the website's fee ledger, with
// live fines and waivers). Paying online and receipt PDFs come in the next build; until then the
// buttons say so.

import React from "react";
import { Alert, FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { api, FeeItem, Receipt } from "@/core/api";
import { useActive, useMe } from "@/core/useSchool";
import { ddmmyyyy, inr } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { BackButton, Button, Loading, Notice } from "@/ui/parts";
import { cardShadow, colors, size } from "@/ui/theme";

export default function Fees() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const insets = useSafeAreaInsets();
  const { active } = useActive();
  const fees = useMe("fees", api.fees);
  const receipts = useMe("receipts", (h, tk) => api.receipts(h, tk));

  const f = fees.data;
  const open = (f?.items ?? []).filter((i) => i.active && i.due > 0);
  const dueNow = open.filter((i) => i.status === "overdue" || i.status === "due_today");
  const overdue = open.some((i) => i.status === "overdue");
  // nothing due now: show what comes next, so the parent sees the next instalment
  const shown: FeeItem[] = dueNow.length ? dueNow : open.filter((i) => i.dueDate === f?.nextDueDate);

  const header = (
    <View>
      <View style={{ backgroundColor: colors.navy, paddingTop: insets.top + 12, paddingHorizontal: size.side, paddingBottom: 96, overflow: "hidden" }}>
        <View style={{ position: "absolute", right: -70, top: -60, width: 240, height: 240, borderRadius: 120, backgroundColor: "rgba(255,255,255,0.06)" }} />
        <View style={{ position: "absolute", left: -40, bottom: -90, width: 200, height: 200, borderRadius: 100, backgroundColor: "rgba(245,158,11,0.10)" }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <BackButton onNavy />
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header" size={18} weight={800} color={colors.white}>
              {t("feesTitle")}
            </Text>
            <Text size={12} weight={600} color={colors.whiteSoft} numberOfLines={1}>
              {active?.name}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 24 }}>
          <View style={{ flex: 1 }}>
            <Text size={13} weight={600} color={colors.whiteSoft}>
              {t("totalDueNow")}
            </Text>
            <Text size={38} weight={800} color={colors.white} style={{ marginTop: 2, letterSpacing: -1 }}>
              {f ? inr(f.dueNow) : "–"}
            </Text>
            {/* overdue money says so; the next date shows only when nothing is overdue */}
            {overdue || f?.nextDueDate ? (
              <View style={{ alignSelf: "flex-start", marginTop: 8, backgroundColor: overdue ? colors.absent : colors.yellow, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text size={12} weight={800} color={overdue ? colors.white : colors.navy}>
                  {overdue ? t("overdue") : f!.dueNow > 0 ? t("dueOn", { date: dayMonth(f!.nextDueDate) }) : t("nextDue", { date: dayMonth(f!.nextDueDate) })}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ width: 76, height: 76, borderRadius: 24, backgroundColor: colors.white, alignItems: "center", justifyContent: "center", transform: [{ rotate: "6deg" }] }}>
            <Icon name="fees" size={54} />
          </View>
        </View>
      </View>

      <View style={[{ marginTop: -72, marginHorizontal: size.side, backgroundColor: colors.white, borderRadius: size.cardRadius, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }, cardShadow]}>
        {fees.isPending ? (
          <Loading />
        ) : fees.error ? (
          <Notice tone="error" text={(fees.error as Error).message} />
        ) : shown.length === 0 ? (
          <View style={{ paddingVertical: 16 }}>
            <Text size={15} weight={800}>
              {t("nothingDue")}
            </Text>
          </View>
        ) : (
          <>
            <Text size={12} weight={800} color={colors.textSoft} style={{ paddingTop: 10, paddingBottom: 4, letterSpacing: 0.3 }}>
              {t("breakdown")}
            </Text>
            {shown.map((i) => (
              <View key={i.id} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.lineSoft, gap: 2 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <Text size={14} weight={600} color={colors.textMid} style={{ flex: 1 }}>
                    {i.name}
                    {i.group ? ` · ${i.group}` : ""}
                  </Text>
                  <Text size={14} weight={800}>
                    {inr(i.due - i.fine)}
                  </Text>
                </View>
                {i.fine > 0 ? (
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text size={12} weight={600} color={colors.absentText}>
                      {t("fine")}
                    </Text>
                    <Text size={12} weight={800} color={colors.absentText}>
                      {inr(i.fine)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))}
            {f && f.dueNow > 0 ? (
              <>
                <Button label={t("pay", { amount: inr(f.dueNow) })} onPress={() => Alert.alert(t("payComing"))} style={{ marginTop: 16 }} />
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 10 }}>
                  <Icon name="lock" size={14} color={colors.textSoft} />
                  <Text size={12} weight={600} color={colors.textSoft}>
                    {t("securePayment")}
                  </Text>
                </View>
              </>
            ) : null}
          </>
        )}
      </View>

      <View style={{ paddingHorizontal: size.side, paddingTop: 24, paddingBottom: 12 }}>
        <Text size={16} weight={800}>
          {t("receipts")}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <FlatList<Receipt>
        data={receipts.data?.items ?? []}
        keyExtractor={(r) => String(r.id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListEmptyComponent={
          receipts.isPending ? null : (
            <View style={{ paddingHorizontal: size.side }}>
              <Notice text={receipts.error ? (receipts.error as Error).message : t("noReceipts")} tone={receipts.error ? "error" : "info"} />
            </View>
          )
        }
        renderItem={({ item }) => (
          <View style={{ marginHorizontal: size.side, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.white, borderRadius: 18, padding: 12, opacity: item.reverted ? 0.6 : 1 }}>
            <View style={{ width: 48, height: 48, borderRadius: 15, backgroundColor: colors.presentBg, alignItems: "center", justifyContent: "center" }}>
              <Icon name="receipt" size={32} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text size={14} weight={800} numberOfLines={1}>
                {inr(item.amount)} · {item.receiptNo}
              </Text>
              <Text size={12} weight={600} color={item.reverted ? colors.absentText : colors.textSoft} numberOfLines={1}>
                {item.reverted ? t("reverted") : t("paidOn", { date: ddmmyyyy(item.paidOn), mode: item.mode ?? "" })}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("downloadReceipt")}
              onPress={() => Alert.alert(t("comingSoon"))}
              style={{ width: 44, height: 44, borderRadius: 14, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="download" size={18} color={colors.indigo} />
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}
