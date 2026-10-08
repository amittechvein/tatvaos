// Profile (FR-C10, FR-C12): the child's details, language, change password, the school's contact,
// the app version and sign out.
import React, { useEffect, useState } from "react";
import { canUse, isOn, setOn, unlock } from "@/core/biometric";
import { Alert, Linking, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { APP_VERSION } from "@/core/api";
import { useAccounts } from "@/core/accounts";
import { useBoot } from "@/core/useSchool";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Card } from "@/ui/parts";
import { ChildAvatar } from "@/ui/ChildAvatar";
import { BottomNav } from "@/ui/BottomNav";
import { LanguagePicker } from "@/ui/LanguagePicker";
import { Screen } from "@/ui/Screen";
import { colors, size } from "@/ui/theme";

function Row({ label, value, onPress, danger }: { label: string; value?: string | null; onPress?: () => void; danger?: boolean }) {
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48, gap: 12 }}>
      <Text size={14} weight={onPress ? 700 : 600} color={danger ? colors.absentText : onPress ? colors.text : colors.textSoft} style={{ flex: 1 }}>
        {label}
      </Text>
      {value ? <Text size={14} weight={700} numberOfLines={1} style={{ maxWidth: "60%", textAlign: "right" }}>{value}</Text> : null}
      {onPress && !danger ? <Text size={18} weight={700} color={colors.textSoft}>›</Text> : null}
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress}>{body}</Pressable> : body;
}

const Line = () => <View style={{ height: 1, backgroundColor: colors.lineSoft }} />;

export default function Profile() {
  const { t } = useT();
  const qc = useQueryClient();
  const { active, signOut } = useAccounts();
  const b = useBoot().data!;
  const [langOpen, setLangOpen] = useState(false);
  const [bio, setBio] = useState<{ can: boolean; on: boolean }>({ can: false, on: false });
  useEffect(() => {
    if (!active) return;
    Promise.all([canUse(), isOn(active.id)]).then(([can, on]) => setBio({ can, on }));
  }, [active]);
  const s = b.student;
  const cls = s?.className ? (s.section ? `${s.className}-${s.section}` : s.className) : null;
  const contact = b.school.contact;

  return (
    <View style={{ flex: 1 }}>
      <Screen tab title={t("profileTitle")}>
        <ScrollView contentContainerStyle={{ padding: size.side, gap: 16, paddingBottom: 120 }}>
          <Card style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <ChildAvatar name={active?.name ?? ""} photoUrl={s?.photoUrl} size={56} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text size={18} weight={800} numberOfLines={1}>{active?.name}</Text>
              <Text size={13} weight={600} color={colors.textSoft} numberOfLines={1}>{[cls, b.school.name].filter(Boolean).join(" · ")}</Text>
            </View>
          </Card>
          <Card style={{ paddingVertical: 4 }}>
            {cls ? <><Row label={t("classLabel")} value={cls} /><Line /></> : null}
            {s?.admissionNo ? <><Row label={t("admissionNo")} value={s.admissionNo} /><Line /></> : null}
            <Row label={t("usernameShort")} value={active?.username} />
            <Line />
            <Row label={t("schoolLabel")} value={b.school.name} />
          </Card>
          <Card style={{ paddingVertical: 4 }}>
            <Row label={t("languageLabel")} value={t("language")} onPress={() => setLangOpen(true)} />
            <Line />
            <Row label={t("changePassword")} onPress={() => router.push("/change-password")} />
            {bio.can && active ? (
              <>
                <Line />
                <Row
                  label={t("fingerprintUnlock")}
                  value={bio.on ? t("onLabel") : t("offLabel")}
                  onPress={async () => {
                    const next = !bio.on;
                    if (next && !(await unlock(t("unlockPrompt"), t("cancel")))) return;
                    await setOn(active.id, next);
                    setBio({ can: true, on: next });
                  }}
                />
              </>
            ) : null}
          </Card>
          {contact.mobile || contact.email ? (
            <Card style={{ paddingVertical: 4 }}>
              <Text size={12} weight={800} color={colors.textSoft} style={{ paddingTop: 12 }}>{t("helpSupport").toUpperCase()}</Text>
              {contact.mobile ? <Row label={t("callSchool")} value={contact.mobile} onPress={() => Linking.openURL(`tel:${contact.mobile}`)} /> : null}
              {contact.mobile && contact.email ? <Line /> : null}
              {contact.email ? <Row label={t("emailSchool")} value={contact.email} onPress={() => Linking.openURL(`mailto:${contact.email}`)} /> : null}
            </Card>
          ) : null}
          <Card style={{ paddingVertical: 4 }}>
            <Row
              label={t("signOutOf", { name: active?.name ?? "" })}
              danger
              onPress={() =>
                Alert.alert(t("signOutOf", { name: active?.name ?? "" }), undefined, [
                  { text: t("cancel"), style: "cancel" },
                  {
                    text: t("signOut"),
                    style: "destructive",
                    onPress: async () => {
                      if (!active) return;
                      qc.removeQueries({ queryKey: [active.id] });
                      await signOut(active.id);
                      router.replace("/");
                    },
                  },
                ])
              }
            />
          </Card>
          <Text size={12} weight={500} color={colors.textSoft} style={{ textAlign: "center" }}>{t("appVersion", { v: APP_VERSION })}</Text>
        </ScrollView>
      </Screen>
      <BottomNav current="profile" />
      <LanguagePicker open={langOpen} onClose={() => setLangOpen(false)} />
    </View>
  );
}
