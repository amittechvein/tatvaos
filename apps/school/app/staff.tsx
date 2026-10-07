// Teacher, staff and admin logins: their screens come in Phase 2 (SRS section 13).
import React from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccounts } from "@/core/accounts";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/parts";
import { colors } from "@/ui/theme";

export default function Staff() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { active, accounts, signOut, switchTo } = useAccounts();
  const student = accounts.find((a) => a.role === "STUDENT");
  return (
    <View style={{ flex: 1, backgroundColor: colors.navy, padding: 24, paddingTop: insets.top + 48, gap: 16 }}>
      <Text accessibilityRole="header" size={22} weight={800} color={colors.white}>
        {active?.name ?? ""}
      </Text>
      <Text size={16} weight={500} color={colors.whiteSoft} style={{ lineHeight: 24 }}>
        {t("staffSoon")}
      </Text>
      {student ? (
        <Button label={student.name} onPress={async () => { await switchTo(student.id); router.replace("/home"); }} />
      ) : null}
      <Button
        label={t("signOut")}
        kind="ghostOnNavy"
        onPress={async () => {
          if (active) await signOut(active.id);
          router.replace("/");
        }}
      />
    </View>
  );
}
