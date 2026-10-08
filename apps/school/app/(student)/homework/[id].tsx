// One homework: subject, day, the teacher's text and the attachments.
import React from "react";
import { ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api } from "@/core/api";
import { useMe } from "@/core/useSchool";
import { useDates, useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Card, Loading, Notice } from "@/ui/parts";
import { RichText } from "@/ui/RichText";
import { Attachments } from "@/ui/Attachments";
import { Screen } from "@/ui/Screen";
import { colors, size } from "@/ui/theme";

export default function HomeworkDetail() {
  const { t } = useT();
  const { longToday } = useDates();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const q = useMe("homework-detail", (h, tk) => api.homeworkDetail(h, tk, id), [id], Number.isFinite(id));
  const hw = q.data;
  return (
    <Screen title={hw?.subject_name ?? t("homeworkTitle")} sub={hw ? longToday(hw.for_date.slice(0, 10)) : undefined}>
      {q.isPending ? (
        <Loading />
      ) : q.error || !hw ? (
        <ScrollView contentContainerStyle={{ padding: size.side }}>
          <Notice tone="error" text={(q.error as Error | null)?.message ?? t("errorGeneric")} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: size.side, gap: 16, paddingBottom: 40 }}>
          <Card>
            {hw.is_no_homework ? (
              <Text size={15} weight={600} color={colors.textSoft}>{t("noHomeworkYet")}</Text>
            ) : (
              <RichText html={hw.content_html} />
            )}
          </Card>
          <Attachments items={hw.attachments} />
        </ScrollView>
      )}
    </Screen>
  );
}
