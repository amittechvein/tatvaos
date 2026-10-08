// Sign in with mobile OTP: the mobile number the school has for the student (father's, mother's
// or the student's own) or for a staff member, a 6-digit SMS code, then the login. When the number
// belongs to more than one login (two children, or a parent who also works at the school) the
// server sends a list and a choose token that works once, for 5 minutes. The server limits codes
// (3 per number per 15 minutes) and wrong tries (5 lock the number); its messages are shown as sent.
// An OTP sign-in never asks for a password change: changing it needs the current password.
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ApiError, LoginAnswer, OtpLoginChoice } from "@/core/api";
import { useAccounts } from "@/core/accounts";
import * as Device from "@/core/device";
import { routeFor } from "@/core/nav";
import { tenDigits } from "@/core/format";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { BackButton, Button, Field, Notice } from "@/ui/parts";
import { colors, size } from "@/ui/theme";

type Step = "mobile" | "code" | "choose";
const RESEND_SECONDS = 30;

export default function OtpSignIn() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { school, addLogin } = useAccounts();
  const params = useLocalSearchParams<{ keep?: string }>();
  const keep = params.keep !== "0";
  const [step, setStep] = useState<Step>("mobile");
  const [mobile, setMobile] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState<{ sentTo: string; minutes: number } | null>(null);
  const [wait, setWait] = useState(0);
  const [choice, setChoice] = useState<{ token: string; accounts: OtpLoginChoice[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; tone: "error" | "warn" } | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  if (!school) return <Redirect href="/find-school" />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError) setError({ text: e.message, tone: e.status === 429 ? "warn" : "error" });
      else setError({ text: t("errorGeneric"), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const signedIn = async (r: LoginAnswer) => {
    const acc = await addLogin(school, r, keep);
    router.replace(routeFor(acc, school));
  };

  const sendCode = () =>
    run(async () => {
      const m = tenDigits(mobile);
      if (!m) throw new ApiError(t("mobileInvalid"), 400);
      const r = await api.loginOtpRequest(school.host, m);
      setSent({ sentTo: r.sentTo, minutes: r.expiresInMinutes });
      setOtp("");
      setWait(RESEND_SECONDS);
      setStep("code");
    });

  const verify = () =>
    run(async () => {
      if (!/^\d{6}$/.test(otp)) throw new ApiError(t("fillAll"), 400);
      const r = await api.loginOtpVerify(school.host, tenDigits(mobile)!, otp, Device.name());
      if ("choose" in r && r.choose) {
        setChoice({ token: r.token, accounts: r.accounts });
        setStep("choose");
        return;
      }
      await signedIn(r as LoginAnswer);
    });

  const choose = (userId: number) =>
    run(async () => {
      if (!choice) return;
      try {
        await signedIn(await api.loginOtpChoose(school.host, choice.token, userId, Device.name()));
      } catch (e) {
        // the choose token works once and for 5 minutes: start again from a new code
        if (e instanceof ApiError && e.code === "TICKET_EXPIRED") {
          setChoice(null);
          setStep("mobile");
        }
        throw e;
      }
    });

  const changeNumber = () => {
    setStep("mobile");
    setOtp("");
    setError(null);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.white }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ padding: size.side, paddingTop: insets.top + 12, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <BackButton label={t("backToSignIn")} />
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" size={24} weight={800}>
            {step === "choose" ? t("chooseLogin") : t("otpSignIn")}
          </Text>
          <Text size={14} weight={500} color={colors.textSoft} style={{ lineHeight: 20 }}>
            {step === "mobile" ? t("otpSignInSub") : step === "code" && sent ? t("codeSentTo", { to: sent.sentTo, m: sent.minutes }) : t("chooseLoginSub")}
          </Text>
          <Text size={13} weight={700} color={colors.indigo}>
            {school.name}
          </Text>
        </View>

        {step === "mobile" ? (
          <>
            <Field
              label={t("mobileLabel")}
              placeholder={t("mobilePlaceholder")}
              value={mobile}
              onChangeText={(v) => setMobile(v.replace(/[^\d+ ]/g, "").slice(0, 16))}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              autoFocus
              returnKeyType="send"
              onSubmitEditing={sendCode}
            />
            {error ? <Notice tone={error.tone} text={error.text} /> : null}
            <Button label={t("sendCode")} onPress={sendCode} busy={busy} />
          </>
        ) : null}

        {step === "code" ? (
          <>
            <Field
              label={t("otpLabel")}
              value={otp}
              onChangeText={(v) => setOtp(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              autoFocus
              returnKeyType="go"
              onSubmitEditing={verify}
            />
            {error ? <Notice tone={error.tone} text={error.text} /> : null}
            <Button label={t("signIn")} onPress={verify} busy={busy} />
            <Button label={wait > 0 ? t("resendIn", { s: wait }) : t("resendCode")} kind="outline" onPress={sendCode} disabled={busy || wait > 0} />
            <Pressable accessibilityRole="button" onPress={changeNumber} style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}>
              <Text size={14} weight={700} color={colors.indigo}>
                {t("changeNumber")}
              </Text>
            </Pressable>
          </>
        ) : null}

        {step === "choose" && choice ? (
          <View style={{ gap: 10 }}>
            {choice.accounts.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityLabel={[a.name, a.detail].filter(Boolean).join(", ")}
                disabled={busy}
                onPress={() => choose(a.id)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 14,
                  padding: 14,
                  minHeight: 64,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: colors.line,
                  backgroundColor: pressed ? colors.lineSoft : colors.white,
                  opacity: busy ? 0.6 : 1,
                })}
              >
                <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: colors.indigoSoft, alignItems: "center", justifyContent: "center" }}>
                  <Text size={17} weight={800} color={colors.indigo}>
                    {a.name.trim().charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text size={16} weight={700}>
                    {a.name}
                  </Text>
                  {a.detail ? (
                    <Text size={13} weight={500} color={colors.textSoft}>
                      {a.detail}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
            {error ? <Notice tone={error.tone} text={error.text} /> : null}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
