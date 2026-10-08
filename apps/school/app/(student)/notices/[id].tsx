// One notice: title, date, who sent it, the text and its attachments (signed links).
import React from "react";
import { ScrollView, View } from "react-native";
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

export default function NoticeDetail() {
  const { t } = useT();
  const { longToday } = useDates();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const q = useMe("notice-detail", (h, tk) => api.noticeDetail(h, tk, id), [id], Number.isFinite(id));
  const n = q.data;
  return (
    <Screen title={t("noticesTitle")}>
      {q.isPending ? (
        <Loading />
      ) : q.error || !n ? (
        <ScrollView contentContainerStyle={{ padding: size.side }}>
          <Notice tone="error" text={(q.error as Error | null)?.message ?? t("errorGeneric")} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: size.side, gap: 16, paddingBottom: 40 }}>
          <View style={{ gap: 4 }}>
            <Text accessibilityRole="header" size={20} weight={800}>{n.title}</Text>
            <Text size={13} weight={600} color={colors.textSoft}>
              {[longToday(n.publish_at?.slice(0, 10)), n.creator_name ? t("byTeacher", { name: n.creator_name }) : null].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Card>
            <RichText html={n.content_html} />
          </Card>
          <Attachments items={n.attachments} />
        </ScrollView>
      )}
    </Screen>
  );
}
