// Hostel (FR-S12): the student's hostel, block, room and bed, the wardens with a call button, and
// room-mates. Shown when the school uses the hostel module and the login has View hostel.
import React from "react";
import { Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { api } from "@/core/api";
import { useMe } from "@/core/useSchool";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Card, Loading, Notice } from "@/ui/parts";
import { Screen, SectionTitle } from "@/ui/Screen";
import { colors, size } from "@/ui/theme";

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <View style={{ minWidth: "45%", flexGrow: 1, gap: 2 }}>
      <Text size={12} weight={600} color={colors.textSoft}>{label}</Text>
      <Text size={16} weight={800}>{String(value)}</Text>
    </View>
  );
}

export default function Hostel() {
  const { t } = useT();
  const q = useMe("hostel", api.myHostel);
  const h = q.data;
  const a = h?.allocation;
  return (
    <Screen title={t("hostelTitle")}>
      {q.isPending ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={{ padding: size.side, gap: 12, paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}>
          {q.error ? <Notice tone="error" text={(q.error as Error).message} /> : null}
          {h && !h.has_allocation ? <Notice text={t("notInHostel")} /> : null}
          {a ? (
            <Card style={{ gap: 14 }}>
              <View>
                <Text size={20} weight={800}>{a.hostel_name}</Text>
                {a.hostel_address ? <Text size={13} weight={500} color={colors.textSoft}>{a.hostel_address}</Text> : null}
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
                <Fact label={t("blockLabel")} value={a.block_name} />
                <Fact label={t("roomLabel")} value={a.room_number} />
                <Fact label={t("floorLabel")} value={a.floor} />
                <Fact label={t("bedLabel")} value={a.bed_label} />
              </View>
              {a.is_ac ? <Text size={12} weight={700} color={colors.indigo}>{t("acRoom")}</Text> : null}
            </Card>
          ) : null}
          {h?.wardens?.length ? (
            <>
              <SectionTitle text={t("wardensTitle")} />
              {h.wardens.map((w) => (
                <Card key={w.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text size={15} weight={800} numberOfLines={1}>{w.warden_name?.trim()}</Text>
                    <Text size={12} weight={600} color={colors.textSoft}>{[w.role, w.block_name].filter(Boolean).join(" · ")}</Text>
                  </View>
                  {w.mobile ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={`${t("callLabel")} ${w.warden_name}`} onPress={() => Linking.openURL(`tel:${w.mobile}`)} style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.indigoSoft, justifyContent: "center" }}>
                      <Text size={14} weight={800} color={colors.indigo}>{t("callLabel")}</Text>
                    </Pressable>
                  ) : null}
                </Card>
              ))}
            </>
          ) : null}
          {h?.roommates?.length ? (
            <>
              <SectionTitle text={t("roommatesTitle")} />
              <Card style={{ gap: 10 }}>
                {h.roommates.map((r, i) => (
                  <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                    <Text size={14} weight={700} style={{ flex: 1 }} numberOfLines={1}>{r.roommate_name?.trim()}</Text>
                    <Text size={12} weight={600} color={colors.textSoft}>{[r.class_name && r.section_name ? `${r.class_name}-${r.section_name}` : r.class_name, r.bed_label].filter(Boolean).join(" · ")}</Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
