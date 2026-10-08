// One assignment (FR-S04): the task and its files, the student's submission and its marks or
// remark, and submitting an answer with photos or PDFs before the due time (or late, when the
// teacher allows it).
import React, { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/core/api";
import { useActive, useMe } from "@/core/useSchool";
import { pickPdf, pickPhoto, PickedFile } from "@/core/upload";
import { useDates, useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Button, Card, Field, Loading, Notice } from "@/ui/parts";
import { RichText } from "@/ui/RichText";
import { Attachments } from "@/ui/Attachments";
import { Screen, SectionTitle } from "@/ui/Screen";
import { colors, size } from "@/ui/theme";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Typed text as simple HTML paragraphs, as the website stores answers. */
const toHtml = (text: string) => text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

export default function AssignmentDetail() {
  const { t } = useT();
  const { longToday } = useDates();
  const qc = useQueryClient();
  const { host, token, id: accountId } = useActive();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const q = useMe("assignment-detail", (h, tk) => api.assignmentDetail(h, tk, id), [id], Number.isFinite(id));
  const [answer, setAnswer] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (q.isPending) return <Screen title={t("assignmentsTitle")}><Loading /></Screen>;
  if (q.error || !q.data)
    return (
      <Screen title={t("assignmentsTitle")}>
        <View style={{ padding: size.side }}><Notice tone="error" text={(q.error as Error | null)?.message ?? t("errorGeneric")} /></View>
      </Screen>
    );

  const { assignment: a, submission: s } = q.data;
  const due = a.due_date_enabled && a.due_date ? new Date(Date.parse(a.due_date) + 330 * 60000).toISOString().slice(0, 10) : null;
  const pastDue = a.due_date_enabled && a.due_date ? Date.parse(a.due_date) < Date.now() : false;
  const accepted = ["ACCEPTED", "GRADED", "CHECKED"].includes((s?.status ?? "").toUpperCase());
  const canSubmit = a.status === "PUBLISHED" && !accepted && (!pastDue || a.allow_late_submission);

  const add = async (kind: "camera" | "gallery" | "pdf") => {
    setError(null);
    if (files.length >= 5) return;
    try {
      const f = kind === "pdf" ? await pickPdf() : await pickPhoto(kind);
      if (f) setFiles((x) => [...x, f].slice(0, 5));
    } catch (e) {
      setError((e as Error).message === "too-big" ? t("pdfTooBig") : t("errorGeneric"));
    }
  };

  const submit = async () => {
    setError(null);
    if (!answer.trim() && !files.length) return setError(t("answerNeeded"));
    setBusy(true);
    try {
      // the website asks for a title and an answer; a files-only answer says so in words
      await api.submitAssignment(host, token!, id, toHtml(answer.trim() || t("seeAttached")), a.title.slice(0, 255), files);
      setAnswer("");
      setFiles([]);
      qc.invalidateQueries({ queryKey: [accountId, "assignment-detail", id] });
      qc.invalidateQueries({ queryKey: [accountId, "assignment-pages"] });
      Alert.alert(t("submittedOk"));
    } catch (e) {
      // no answer back (timeout, dropped connection): the answer may still have arrived, so look
      // before saying it failed, rather than letting the student send it twice
      if (e instanceof ApiError && e.offline) {
        const before = s?.submitted_at ?? null;
        const now = await q.refetch().then((r) => r.data?.submission?.submitted_at ?? null).catch(() => null);
        if (now && now !== before) {
          setAnswer("");
          setFiles([]);
          qc.invalidateQueries({ queryKey: [accountId, "assignment-pages"] });
          Alert.alert(t("submittedOk"));
          return;
        }
      }
      setError(e instanceof ApiError ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={a.subject_name ?? t("assignmentsTitle")} sub={due ? t("dueOn", { date: longToday(due) }) : undefined}>
      <ScrollView contentContainerStyle={{ padding: size.side, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" size={20} weight={800}>{a.title}</Text>
        <Card><RichText html={a.content_html} /></Card>
        <Attachments items={a.attachments} />

        {s ? (
          <>
            <SectionTitle text={t("yourAnswer")} />
            <Card style={{ gap: 10 }}>
              <Text size={12} weight={800} color={colors.indigo}>{s.status}</Text>
              <RichText html={s.answer_html} />
              {s.marks_obtained !== undefined && s.marks_obtained !== null ? (
                <Text size={14} weight={800}>{t("marksLabel")}: {s.marks_obtained}{a.max_marks ? ` / ${a.max_marks}` : ""}</Text>
              ) : null}
              {s.grade ? <Text size={14} weight={800}>{s.grade}</Text> : null}
              {s.teacher_remark ? <Text size={13} weight={600} color={colors.textMid}>{t("teacherRemark")}: {s.teacher_remark}</Text> : null}
            </Card>
            <Attachments items={s.attachments} />
          </>
        ) : null}

        {canSubmit ? (
          <Card style={{ gap: 12 }}>
            <Field label={s ? t("submitAgain") : t("yourAnswer")} placeholder={t("answerPlaceholder")} value={answer} onChangeText={setAnswer} multiline maxLength={5000} style={{ minHeight: 110, textAlignVertical: "top", paddingTop: 12 }} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button small kind="outline" label={t("takePhoto")} onPress={() => add("camera")} style={{ flex: 1 }} disabled={files.length >= 5} />
              <Button small kind="outline" label={t("fromGallery")} onPress={() => add("gallery")} style={{ flex: 1 }} disabled={files.length >= 5} />
              <Button small kind="outline" label={t("addPdf")} onPress={() => add("pdf")} style={{ flex: 0.6 }} disabled={files.length >= 5} />
            </View>
            {files.map((f, i) => (
              <View key={f.uri} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text size={13} weight={700} style={{ flex: 1 }} numberOfLines={1}>{f.name}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`${t("removeFile")} ${f.name}`} onPress={() => setFiles((x) => x.filter((_, j) => j !== i))} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}>
                  <Text size={13} weight={800} color={colors.absentText}>{t("removeFile")}</Text>
                </Pressable>
              </View>
            ))}
            <Text size={12} weight={500} color={colors.textSoft}>{t("maxFiles")}</Text>
            {error ? <Notice tone="error" text={error} /> : null}
            <Button label={s ? t("submitAgain") : t("submit")} onPress={submit} busy={busy} />
          </Card>
        ) : !accepted && pastDue ? (
          <Notice tone="warn" text={t("closedLabel")} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
