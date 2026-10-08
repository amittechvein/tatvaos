// Change password (FR-C10). The backend ends every session of the login when its password
// changes, the app's included, so the app signs this login out and asks for the new password.
import React from "react";
import { Alert, ScrollView } from "react-native";
import { router } from "expo-router";
import { api } from "@/core/api";
import { useAccounts } from "@/core/accounts";
import { useT } from "@/core/i18n";
import { PasswordForm } from "@/ui/PasswordForm";
import { Screen } from "@/ui/Screen";
import { size } from "@/ui/theme";

export default function ChangePassword() {
  const { t } = useT();
  const { active, token, signOut } = useAccounts();
  return (
    <Screen title={t("changePassword")}>
      <ScrollView contentContainerStyle={{ padding: size.side }} keyboardShouldPersistTaps="handled">
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
    </Screen>
  );
}
