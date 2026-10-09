// One student leave request (FR-T04): the dates, type, reason, the documents the parent attached,
// the leave balance, and for a waiting request Approve or Reject with an optional note. The
// server decides who may approve (the school's setting: admin, class teacher or either) and its
// message is shown as sent. Approving uses the student's leave balance; when attendance is taken
// the student shows "On leave".
import React, { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAccounts } from "@/core/accounts";
import { api, ApiError } from "@/core/api";
import { useMe } from "@/core/useSchool";
import { useDates, useT } from "@/core/i18n";
import { Attachments } from "@/ui/Attachments";
import { Text } from "@/ui/Text";
import { Button, Card, Field, Loading, Notice } from "@/ui/parts";
import { ListState, Screen } from "@/ui/Screen";
import { colors, size } from "@/ui/theme";
import { leaveName, useLeaveText } from "@/core/leaveText";

function Line({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={{ gap: 2 }}>
      <Text size={12} weight={700} color={colors.textSoft}>{label}</Text>
      <Text size={15} weight={600}>{value}</Text>
    </View>
  );
}

export default function LeaveRequest() {
  const { t } = useT();
  const { dayMonth } = useDates();
  const text = useLeaveText();
  const qc = useQueryClient();
  const { active, token } = useAccounts();
  const { id } = useLocalSearchParams<{ id: string }>();
  const leave = useMe("staff-leave", (h, tk) => api.staffLeave(h, tk, Number(id)), [id]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const l = leave.data;
  if (!l) {
    return (
      <Screen title={t("leaveRequests")}>
        {leave.isPending ? <Loading /> : <ListState pending={false} error={leave.error} emptyText="" onRetry={() => leave.refetch()} />}
      </Screen>
    );
  }
  const name = leaveName(l);
  const statusWord = { PENDING: t("pending"), APPROVED: t("approved"), REJECTED: t("rejected"), CANCELLED: t("cancelled") }[l.status];

  const review = (status: "APPROVED" | "REJECTED") =>
    Alert.alert(
      status === "APPROVED" ? t("approve") : t("reject"),
      t(status === "APPROVED" ? "confirmApprove" : "confirmReject", { name, days: text.days(l) }),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: status === "APPROVED" ? t("approve") : t("reject"),
          style: status === "APPROVED" ? "default" : "destructive",
          onPress: async () => {
            if (!active || !token) return;
            setBusy(status);
            setError(null);
            try {
              await api.reviewLeave(active.school.host, token, l.id, status, note);
              qc.invalidateQueries({ queryKey: [active.id, "staff-leaves"] });
              await leave.refetch();
              Alert.alert(status === "APPROVED" ? t("leaveApprovedMsg") : t("leaveRejectedMsg"), "", [{ text: "OK", onPress: () => router.back() }]);
            } catch (e) {
              setError(e instanceof ApiError ? e.message : t("errorGeneric"));
              leave.refetch(); // someone may have reviewed it meanwhile
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );

  return (
    <Screen title={name} sub={text.klass(l)}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: size.side, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Card style={{ gap: 12 }}>
            <Text size={13} weight={800} color={l.status === "APPROVED" ? colors.presentText : l.status === "REJECTED" ? colors.absentText : "#B45309"}>
              {statusWord.toUpperCase()}
            </Text>
            <Line label={t("leaveType")} value={l.leave_type_name} />
            <Line label={t("leaveDates")} value={`${text.dates(l)} · ${text.days(l)}`} />
            <Line label={t("reasonLabel")} value={l.reason} />
            {l.current_available_quota !== null && l.current_available_quota !== undefined ? (
              <Text size={13} weight={700} color={l.status === "PENDING" && l.exceeds_quota ? colors.absentText : colors.textSoft}>
                {l.status === "PENDING" && l.exceeds_quota ? t("overBalance", { n: Number(l.current_available_quota) }) : t("balanceLeft", { n: Number(l.current_available_quota) })}
              </Text>
            ) : null}
            {l.applied_by_name ? <Text size={12} weight={600} color={colors.textSoft}>{t("appliedOn", { name: l.applied_by_name, date: dayMonth(l.applied_at) })}</Text> : null}
            {l.status !== "PENDING" && l.reviewed_by_name ? (
              <Text size={12} weight={600} color={colors.textSoft}>
                {t("reviewedOn", { status: statusWord, name: l.reviewed_by_name, date: dayMonth(l.reviewed_at) })}{l.review_remark ? `: ${l.review_remark}` : ""}
              </Text>
            ) : null}
          </Card>

          <Attachments items={l.documents?.map((d) => ({ id: d.id, file_name: d.file_name, mime_type: d.mime_type ?? undefined, url: d.download_url }))} />

          {l.status === "PENDING" ? (
            <View style={{ gap: 12 }}>
              <Field label={t("reviewNote")} value={note} onChangeText={setNote} multiline maxLength={500} style={{ minHeight: 80, textAlignVertical: "top", paddingTop: 12 }} />
              {error ? <Notice tone="error" text={error} /> : null}
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Button label={t("reject")} kind="outline" onPress={() => review("REJECTED")} busy={busy === "REJECTED"} disabled={!!busy} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label={t("approve")} onPress={() => review("APPROVED")} busy={busy === "APPROVED"} disabled={!!busy} />
                </View>
              </View>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
