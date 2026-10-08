// Apply for leave (FR-S03): type, dates and reason. The student is the signed-in one (the server
// takes it from the session). A leave type that needs a document from some number of days on is
// sent to the website for now, because attaching a photo of a note comes with file uploads.
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/core/api";
import { useActive, useMe } from "@/core/useSchool";
import { todayIndia } from "@/core/format";
import { useDates, useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Button, Card, Field, Loading, Notice } from "@/ui/parts";
import { Screen } from "@/ui/Screen";
import { Icon } from "@/ui/Icon";
import { colors, size } from "@/ui/theme";

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000) + 1;

function DayStepper({ label, value, min, onChange }: { label: string; value: string; min: string; onChange: (v: string) => void }) {
  const { t } = useT();
  const { longToday } = useDates();
  const btn = (dir: -1 | 1) => {
    const disabled = dir < 0 && value <= min;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dir < 0 ? t("earlierDay") : t("laterDay")}
        disabled={disabled}
        onPress={() => onChange(addDays(value, dir))}
        style={{ width: 44, height: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1, transform: dir > 0 ? [{ scaleX: -1 }] : undefined }}
      >
        <Icon name="back" size={16} color={colors.text} />
      </Pressable>
    );
  };
  return (
    <View style={{ gap: 6 }}>
      <Text size={13} weight={700} color={colors.textMid}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {btn(-1)}
        <Text size={15} weight={800} style={{ flex: 1, textAlign: "center" }}>{longToday(value)}</Text>
        {btn(1)}
      </View>
    </View>
  );
}

export default function ApplyLeave() {
  const { t } = useT();
  const qc = useQueryClient();
  const { host, token, id } = useActive();
  const types = useMe("leave-types", api.leaveTypes);
  const active = useMemo(() => (types.data ?? []).filter((x) => x.is_active === undefined || x.is_active === 1 || x.is_active === true), [types.data]);
  const today = todayIndia();
  const [typeId, setTypeId] = useState<number | null>(null);
  const [from, setFrom] = useState(addDays(today, 1));
  const [to, setTo] = useState(addDays(today, 1));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeId === null && active.length === 1) setTypeId(active[0].id);
  }, [active, typeId]);
  useEffect(() => {
    if (to < from) setTo(from);
  }, [from, to]);

  const type = active.find((x) => x.id === typeId);
  const days = daysBetween(from, to);
  const needsDoc = !!type?.requires_document && days >= Number(type.min_days_for_document ?? 1);

  const submit = async () => {
    setError(null);
    if (!typeId || !reason.trim()) return setError(t("fillAll"));
    setBusy(true);
    try {
      await api.applyLeave(host, token!, { leave_type_id: typeId, start_date: from, end_date: to, reason: reason.trim() });
      qc.invalidateQueries({ queryKey: [id, "leaves"] });
      Alert.alert(t("leaveSent"));
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t("leaveTitle")}>
      {types.isPending ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={{ padding: size.side, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Card style={{ gap: 10 }}>
            <Text size={13} weight={700} color={colors.textMid}>{t("leaveType")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {active.map((x) => {
                const on = x.id === typeId;
                return (
                  <Pressable
                    key={x.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setTypeId(x.id)}
                    style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 12, justifyContent: "center", borderWidth: on ? 2 : 1, borderColor: on ? colors.indigo : colors.line, backgroundColor: on ? colors.indigoSoft : colors.white }}
                  >
                    <Text size={14} weight={700} color={on ? colors.indigo : colors.text}>{x.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
          <Card style={{ gap: 14 }}>
            <DayStepper label={t("fromDate")} value={from} min={today} onChange={setFrom} />
            <DayStepper label={t("toDate")} value={to} min={from} onChange={setTo} />
            <Text size={13} weight={700} color={colors.textSoft}>{t(days === 1 ? "day" : "days", { n: days })}</Text>
          </Card>
          <Field label={t("reasonLabel")} placeholder={t("reasonPlaceholder")} value={reason} onChangeText={setReason} multiline style={{ minHeight: 96, textAlignVertical: "top", paddingTop: 12 }} maxLength={500} />
          {needsDoc ? <Notice tone="warn" text={t("leaveDocNeeded", { n: Number(type?.min_days_for_document ?? 1) })} /> : null}
          {error ? <Notice tone="error" text={error} /> : null}
          <Button label={t("submit")} onPress={submit} busy={busy} disabled={needsDoc} />
        </ScrollView>
      )}
    </Screen>
  );
}
