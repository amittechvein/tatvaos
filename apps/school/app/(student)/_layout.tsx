// Every student and parent screen sits behind this gate. It loads the settings call (B-06) and
// stops early when the app must be updated (FR-C14), when the school has not switched the app on,
// or when the login still has a temporary password (FR-C04).

import React from "react";
import { View } from "react-native";
import { Redirect, Stack, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccounts } from "@/core/accounts";
import { useBoot, useForget } from "@/core/useSchool";
import { ApiError } from "@/core/api";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Button, Loading, Notice, useReduceMotion } from "@/ui/parts";
import { colors } from "@/ui/theme";

function Stop({ title, body, signOut, onRetry }: { title?: string; body: string; signOut?: boolean; onRetry?: () => void }) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { signOut: doSignOut, active } = useAccounts();
  const forget = useForget();
  return (
    <View style={{ flex: 1, backgroundColor: colors.navy, padding: 24, paddingTop: insets.top + 48, gap: 16 }}>
      {title ? (
        <Text accessibilityRole="header" size={24} weight={800} color={colors.white}>
          {title}
        </Text>
      ) : null}
      <Text size={16} weight={500} color={colors.whiteSoft} style={{ lineHeight: 24 }}>
        {body}
      </Text>
      {onRetry ? <Button label={t("retry")} onPress={onRetry} /> : null}
      {signOut && active ? (
        <Button
          label={t("signOut")}
          kind="ghostOnNavy"
          onPress={async () => {
            forget(active.id);
            await doSignOut(active.id);
            router.replace("/");
          }}
        />
      ) : null}
    </View>
  );
}

export default function StudentLayout() {
  const { t } = useT();
  const reduce = useReduceMotion();
  const { active, ready } = useAccounts();
  const boot = useBoot();

  if (!ready) return <Loading />;
  if (!active) return <Redirect href="/" />;
  if (active.role !== "STUDENT") return <Redirect href="/staff" />;
  if (boot.isPending) return <Loading />;
  if (boot.error) {
    const e = boot.error as ApiError;
    if (e.code === "APP_NOT_ENABLED") return <Stop body={t("notEnabled", { school: active.school.name })} signOut onRetry={() => boot.refetch()} />;
    if (e.code === "PASSWORD_CHANGE_REQUIRED") return <Stop body={t("mustChange")} signOut />;
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: "center", gap: 12 }}>
        <Notice tone="error" text={e.message} />
        <Button label={t("retry")} onPress={() => boot.refetch()} />
      </View>
    );
  }
  const b = boot.data!;
  if (b.app.updateRequired) return <Stop title={t("updateTitle")} body={t("updateBody")} />;
  if (!b.app.enabled) return <Stop body={t("notEnabled", { school: b.school.name })} signOut onRetry={() => boot.refetch()} />;
  if (b.user.mustChangePassword) return <Stop body={t("mustChange")} signOut />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: reduce ? "none" : "slide_from_right" }}>
      <Stack.Screen name="accounts" options={{ presentation: "transparentModal", animation: reduce ? "none" : "fade" }} />
    </Stack>
  );
}
