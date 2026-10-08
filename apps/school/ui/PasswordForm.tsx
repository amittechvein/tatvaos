// New-password fields with the website's rule: at least 8 characters, upper and lower case
// letters, a number and a special character. Used by Change password, the forced change on a
// temporary password (FR-C04) and Forgot password (FR-C03).
import React, { useState } from "react";
import { View } from "react-native";
import { useT } from "@/core/i18n";
import { Text } from "./Text";
import { Button, Field, Notice } from "./parts";
import { colors } from "./theme";

export const strongEnough = (p: string) => p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

export function PasswordForm({
  askCurrent,
  submitLabel,
  onSubmit,
}: {
  askCurrent?: boolean;
  submitLabel: string;
  onSubmit: (current: string, next: string) => Promise<void>;
}) {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if ((askCurrent && !current) || !next || !again) return setError(t("fillAll"));
    if (!strongEnough(next)) return setError(t("passwordWeak"));
    if (next !== again) return setError(t("passwordsDiffer"));
    setBusy(true);
    try {
      await onSubmit(current, next);
    } catch (e) {
      setError((e as Error).message || t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      {askCurrent ? (
        <Field label={t("currentPassword")} value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" />
      ) : null}
      <Field label={t("newPassword")} value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" />
      <Field label={t("confirmPassword")} value={again} onChangeText={setAgain} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" onSubmitEditing={submit} />
      <Text size={12} weight={500} color={colors.textSoft} style={{ lineHeight: 18 }}>{t("passwordRule")}</Text>
      {error ? <Notice tone="error" text={error} /> : null}
      <Button label={submitLabel} onPress={submit} busy={busy} />
    </View>
  );
}
