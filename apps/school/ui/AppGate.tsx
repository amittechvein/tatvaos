// The checks every signed-in screen sits behind, for students and staff alike. It loads the
// settings call (B-06) and stops early when the app must be updated (FR-C14), when the school has
// not switched the app on, or when the login still has a temporary password (FR-C04).
import React from "react";
import { Alert, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccounts } from "@/core/accounts";
import { useBoot, useForget } from "@/core/useSchool";
import { api, ApiError } from "@/core/api";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Button, Loading, Notice } from "@/ui/parts";
import { PasswordForm } from "@/ui/PasswordForm";
import { colors } from "@/ui/theme";

export function Stop({ title, body, signOut, onRetry }: { title?: string; body: string; signOut?: boolean; onRetry?: () => void }) {
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

/** FR-C04: a temporary password must be replaced before anything else opens. */
function ForcedChange() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { active, token, signOut } = useAccounts();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.white }} contentContainerStyle={{ padding: 24, paddingTop: insets.top + 32, gap: 16 }} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" size={24} weight={800}>{t("mustChangeTitle")}</Text>
      <Text size={15} weight={500} color={colors.textSoft} style={{ lineHeight: 22 }}>{t("mustChangeBody")}</Text>
      <PasswordForm
        askCurrent
        submitLabel={t("save")}
        onSubmit={async (current, next) => {
          if (!active || !token) return;
          await api.changePassword(active.school.host, token, current, next);
          await signOut(active.id);
          Alert.alert(t("passwordChanged"));
          router.replace("/sign-in");
        }}
      />
    </ScrollView>
  );
}

/** Shows the screens once the settings call says this login may use the app. */
export function AppGate({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const { active } = useAccounts();
  const boot = useBoot();
  if (!active) return null;
  if (boot.isPending) return <Loading />;
  if (boot.error && !boot.data) {
    const e = boot.error as ApiError;
    if (e.code === "APP_NOT_ENABLED") return <Stop body={t("notEnabled", { school: active.school.name })} signOut onRetry={() => boot.refetch()} />;
    if (e.code === "PASSWORD_CHANGE_REQUIRED") return <ForcedChange />;
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
  if (b.user.mustChangePassword || active.mustChangePassword) return <ForcedChange />;
  return <>{children}</>;
}
