// Shared pieces built to the design's one set of sizes (SRS section 14, "Sizes").

import React, { useEffect, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleProp, TextInput, TextInputProps, View, ViewStyle } from "react-native";
import { router } from "expo-router";
import { colors, cardShadow, size } from "./theme";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { useT } from "@/core/i18n";

/** True when the phone asks for less motion; every animation checks it. */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
  busy,
  small,
  style,
  icon,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "outline" | "light" | "ghostOnNavy";
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: React.ReactNode;
}) {
  const off = disabled || busy;
  const bg = { primary: off ? colors.disabled : colors.indigo, outline: colors.white, light: colors.indigoSoft, ghostOnNavy: "rgba(255,255,255,0.10)" }[kind];
  const fg = { primary: off ? colors.textSoft : colors.white, outline: colors.text, light: colors.indigo, ghostOnNavy: colors.white }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: small ? size.smallButton : size.button,
          borderRadius: small ? size.smallButtonRadius : size.buttonRadius,
          backgroundColor: bg,
          borderWidth: kind === "outline" ? 1 : kind === "ghostOnNavy" ? 1 : 0,
          borderColor: kind === "ghostOnNavy" ? "rgba(255,255,255,0.22)" : colors.disabled,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          paddingHorizontal: 16,
          opacity: pressed ? 0.85 : 1,
        },
        kind === "primary" && !off ? { shadowColor: colors.indigo, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 8 }, elevation: 4 } : null,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon}
      <Text size={small ? 14 : 16} weight={800} color={fg}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ backgroundColor: colors.card, borderRadius: size.cardRadius, padding: 16 }, cardShadow, style]}>{children}</View>;
}

export const Field = React.forwardRef<TextInput, TextInputProps & { label: string }>(function Field({ label, ...input }, ref) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text size={13} weight={700} color={colors.textMid}>
        {label}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor="#7A8394"
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        {...input}
        style={[
          {
            minHeight: size.input,
            borderRadius: size.inputRadius,
            borderWidth: focus ? 2 : 1,
            borderColor: focus ? colors.indigo : colors.line,
            backgroundColor: colors.white,
            paddingHorizontal: 14,
            fontSize: 16,
            color: colors.text,
            fontFamily: "Manrope_600SemiBold",
          },
          input.style,
        ]}
      />
    </View>
  );
});

/** The white header with a back button used by inner screens (Attendance). */
export function Header({ title, sub, right, noBack }: { title: string; sub?: string; right?: React.ReactNode; noBack?: boolean }) {
  const { t } = useT();
  return (
    <View style={{ backgroundColor: colors.white, paddingHorizontal: size.side, paddingBottom: 16, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      {noBack ? null : <BackButton label={t("cancel")} />}
      <View style={{ flex: 1 }}>
        <Text size={18} weight={800}>
          {title}
        </Text>
        {sub ? (
          <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function BackButton({ onNavy, label }: { onNavy?: boolean; label?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? "Back"}
      onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      hitSlop={6}
      style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: onNavy ? "rgba(255,255,255,0.10)" : colors.bg, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="back" size={20} color={onNavy ? colors.white : colors.text} />
    </Pressable>
  );
}

export function Notice({ text, tone = "info" }: { text: string; tone?: "info" | "error" | "warn" }) {
  const bg = { info: colors.indigoSoft, error: "#FDECEF", warn: "#FFF6E0" }[tone];
  const fg = { info: colors.navy, error: colors.absentText, warn: "#7A4D00" }[tone];
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: bg, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 }}>
      <Text size={13} weight={600} color={fg} style={{ lineHeight: 19 }}>
        {text}
      </Text>
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <ActivityIndicator color={colors.indigo} size="large" />
    </View>
  );
}

/** "Offline. Showing the copy from 10:42 am." on a screen answered from its offline copy. */
export function OfflineBanner({ at }: { at?: number }) {
  const { t } = useT();
  if (!at) return null;
  const d = new Date(at + 330 * 60000);
  const hh = d.getUTCHours(), mm = String(d.getUTCMinutes()).padStart(2, "0");
  const time = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${hh % 12 || 12}:${mm} ${hh < 12 ? "am" : "pm"}`;
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: "#FFF6E0", paddingHorizontal: 16, paddingVertical: 8 }}>
      <Text size={12} weight={700} color="#7A4D00">{t("offlineCopy", { time })}</Text>
    </View>
  );
}
