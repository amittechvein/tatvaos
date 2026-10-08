// The fingerprint lock shown on opening the app when the person turned it on (FR-C05).
// "Use password instead" goes to sign-in for the same school; signing in again replaces the token.
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccounts } from "@/core/accounts";
import { unlock } from "@/core/biometric";
import { useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/parts";
import { ChildAvatar } from "@/ui/ChildAvatar";
import { colors } from "@/ui/theme";

export default function Unlock() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { active, chooseSchool } = useAccounts();
  const [busy, setBusy] = useState(false);

  const tryUnlock = useCallback(async () => {
    setBusy(true);
    try {
      if (await unlock(t("unlockPrompt"), t("cancel"))) router.replace("/home");
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    tryUnlock();
  }, [tryUnlock]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.navy, alignItems: "center", justifyContent: "center", padding: 24, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <ChildAvatar name={active?.name ?? ""} size={72} />
      <Text accessibilityRole="header" size={22} weight={800} color={colors.white}>{active?.name}</Text>
      <Text size={14} weight={500} color={colors.whiteSoft}>{active?.school.name}</Text>
      <View style={{ height: 24 }} />
      <Button label={t("unlockButton")} onPress={tryUnlock} busy={busy} icon={<Icon name="fingerprint" size={20} color={colors.white} />} style={{ alignSelf: "stretch" }} />
      <Button
        label={t("usePassword")}
        kind="ghostOnNavy"
        style={{ alignSelf: "stretch" }}
        onPress={async () => {
          if (active) await chooseSchool(active.school);
          router.replace("/sign-in");
        }}
      />
    </View>
  );
}
