// 1c Sign in (FR-C02, FR-C04, FR-C06). The same logins as the TatvaOS website; parents use their
// child's student login. The server counts wrong passwords (5 in a row lock the username for 15
// minutes) and its message is shown as sent. Also used to add a second child (B-02): signing in
// here adds the login to the phone and opens it, and the other logins stay signed in.

import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ApiError } from "@/core/api";
import { useAccounts } from "@/core/accounts";
import { routeFor } from "@/core/nav";
import { useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { SchoolBadge } from "@/ui/SchoolBadge";
import { BrandLogo } from "@/ui/BrandLogo";
import { Button, Field, Notice } from "@/ui/parts";
import { colors, size } from "@/ui/theme";

export default function SignIn() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { school, signIn } = useAccounts();
  const params = useLocalSearchParams<{ username?: string }>();
  const [username, setUsername] = useState(params.username ?? "");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "info" | "warn" } | null>(null);
  const passwordRef = useRef<TextInput>(null);

  if (!school) return <Redirect href="/find-school" />;

  const submit = async () => {
    if (!username.trim() || !password) {
      setMessage({ text: t("fillBoth"), tone: "error" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const acc = await signIn(school, username, password, keep);
      setPassword("");
      router.replace(routeFor(acc, school));
    } catch (e) {
      if (e instanceof ApiError) {
        const extra = e.triesLeft !== undefined && e.triesLeft > 0 && e.triesLeft < 5 ? ` ${t("triesLeft", { n: e.triesLeft })}` : "";
        setMessage({ text: e.message + extra, tone: e.code === "LOCKED" ? "warn" : "error" });
      } else {
        setMessage({ text: t("errorGeneric"), tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.navy }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 24, paddingBottom: 28, alignItems: "center", overflow: "hidden" }}>
          <View style={{ position: "absolute", right: -80, top: -60, width: 260, height: 260, borderRadius: 130, backgroundColor: "rgba(255,255,255,0.05)" }} />
          <View style={{ alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <BrandLogo name="horizontalOndark" width={130} />
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/find-school")}
              style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.10)", justifyContent: "center" }}
            >
              <Text size={13} weight={700} color={colors.white}>
                {t("changeSchool")}
              </Text>
            </Pressable>
          </View>
          <View style={{ marginTop: 20, padding: 6, borderRadius: 26, backgroundColor: colors.white }}>
            <SchoolBadge school={school} size={76} radius={22} />
          </View>
          <Text accessibilityRole="header" size={22} weight={800} color={colors.white} style={{ marginTop: 14, textAlign: "center" }}>
            {school.name}
          </Text>
          {school.city ? (
            <Text size={13} weight={600} color={colors.whiteSoft} style={{ marginTop: 4 }}>
              {school.city}
            </Text>
          ) : null}
        </View>

        <View style={{ flex: 1, backgroundColor: colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: insets.bottom + 24, gap: 16 }}>
          <Text size={22} weight={800}>
            {t("signIn")}
          </Text>
          <Field
            label={t("usernameLabel")}
            placeholder={t("usernamePlaceholder")}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <View>
            <Field
              ref={passwordRef}
              label={t("passwordLabel")}
              placeholder={t("passwordLabel")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={submit}
              style={{ paddingRight: 56 }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={show ? t("hidePassword") : t("showPassword")}
              onPress={() => setShow((s) => !s)}
              style={{ position: "absolute", right: 4, bottom: 4, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
            >
              <Text size={12} weight={800} color={colors.indigo}>
                {show ? "Aa" : "••"}
              </Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: keep }}
              onPress={() => setKeep((k) => !k)}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}
            >
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: keep ? colors.indigo : "#C5CBD6", backgroundColor: keep ? colors.indigo : colors.white, alignItems: "center", justifyContent: "center" }}>
                {keep ? <Icon name="check" size={16} color={colors.white} /> : null}
              </View>
              <Text size={14} weight={600}>
                {t("keepSignedIn")}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: "/forgot", params: { username: username.trim() } })} style={{ minHeight: 44, justifyContent: "center" }}>
              <Text size={14} weight={700} color={colors.indigo}>
                {t("forgot")}
              </Text>
            </Pressable>
          </View>
          {message ? <Notice text={message.text} tone={message.tone} /> : null}
          <Button label={t("signIn")} onPress={submit} busy={busy} />
          <Text size={12} weight={500} color={colors.textSoft} style={{ textAlign: "center", lineHeight: 18, marginTop: 4 }}>
            {t("parentsHint")}
            {"\n"}
            {t("twoChildrenHint")}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
