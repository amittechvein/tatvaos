// Forgot password (FR-C03, B-03): a code to the number or email the school has for the login,
// then a new password. A student's code goes to the father's mobile first, then the mother's,
// then the student's own, then email (the server decides; the screen shows where it went).
// A reset also unlocks a locked sign-in.
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ApiError } from "@/core/api";
import { useAccounts } from "@/core/accounts";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { BackButton, Button, Field, Notice } from "@/ui/parts";
import { PasswordForm } from "@/ui/PasswordForm";
import { colors, size } from "@/ui/theme";

type Step = "username" | "code" | "password" | "done";

export default function Forgot() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { school } = useAccounts();
  const params = useLocalSearchParams<{ username?: string }>();
  const [step, setStep] = useState<Step>("username");
  const [username, setUsername] = useState(params.username ?? "");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState<{ sentTo: string; minutes: number } | null>(null);
  const [resetToken, setResetToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!school) return <Redirect href="/find-school" />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  };
  const sendCode = () =>
    run(async () => {
      if (!username.trim()) throw new ApiError(t("fillAll"), 400);
      const r = await api.otpRequest(school.host, username.trim());
      setSent({ sentTo: r.sentTo, minutes: r.expiresInMinutes });
      setOtp("");
      setStep("code");
    });
  const verify = () =>
    run(async () => {
      if (!/^\d{4,8}$/.test(otp.trim())) throw new ApiError(t("fillAll"), 400);
      const r = await api.otpVerify(school.host, username.trim(), otp.trim());
      setResetToken(r.resetToken);
      setStep("password");
    });

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.white }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ padding: size.side, paddingTop: insets.top + 12, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <BackButton label={t("backToSignIn")} />
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" size={24} weight={800}>{step === "password" ? t("setNewPassword") : t("forgotTitle")}</Text>
          <Text size={14} weight={500} color={colors.textSoft} style={{ lineHeight: 20 }}>
            {step === "username" ? t("forgotSub") : step === "code" && sent ? t("codeSentTo", { to: sent.sentTo, m: sent.minutes }) : school.name}
          </Text>
        </View>

        {step === "username" ? (
          <>
            <Field label={t("usernameLabel")} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} returnKeyType="send" onSubmitEditing={sendCode} />
            {error ? <Notice tone="error" text={error} /> : null}
            <Button label={t("sendCode")} onPress={sendCode} busy={busy} />
          </>
        ) : null}

        {step === "code" ? (
          <>
            <Field label={t("otpLabel")} value={otp} onChangeText={(v) => setOtp(v.replace(/\D/g, "").slice(0, 8))} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" autoFocus returnKeyType="go" onSubmitEditing={verify} />
            {error ? <Notice tone="error" text={error} /> : null}
            <Button label={t("verify")} onPress={verify} busy={busy} />
            <Button label={t("resendCode")} kind="outline" onPress={sendCode} disabled={busy} />
          </>
        ) : null}

        {step === "password" ? (
          <PasswordForm
            submitLabel={t("save")}
            onSubmit={async (_current, next) => {
              await api.otpReset(school.host, resetToken, next);
              setStep("done");
            }}
          />
        ) : null}

        {step === "done" ? (
          <>
            <Notice text={t("resetDone")} />
            <Button label={t("backToSignIn")} onPress={() => router.replace("/sign-in")} />
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
