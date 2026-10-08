// 1a Welcome: first launch only. App preview cards, "Everything about school, in one app",
// Get started, I have a school code, and the language button.

import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { IconName } from "@/ui/icons";
import { Text } from "@/ui/Text";
import { Button, useReduceMotion } from "@/ui/parts";
import { LanguagePicker } from "@/ui/LanguagePicker";
import { BrandLogo } from "@/ui/BrandLogo";
import { colors } from "@/ui/theme";

function Float({ delay, children, style }: { delay: number; children: React.ReactNode; style: object }) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 2000, delay, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, delay, v]);
  return <Animated.View style={[style, { transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] }]}>{children}</Animated.View>;
}

function Chip({ icon, title, sub }: { icon: IconName; title: string; sub: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 6 }}>
      <Icon name={icon} size={28} />
      <View>
        <Text size={13} weight={800}>
          {title}
        </Text>
        <Text size={11} weight={600} color={colors.textSoft}>
          {sub}
        </Text>
      </View>
    </View>
  );
}

export default function Welcome() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [langOpen, setLangOpen] = useState(false);

  return (
    <View style={{ flex: 1, backgroundColor: colors.navy }}>
      <StatusBar style="light" />
      <View style={{ position: "absolute", right: -120, top: -100, width: 340, height: 340, borderRadius: 170, backgroundColor: "rgba(255,255,255,0.05)" }} />
      <View style={{ position: "absolute", left: -90, top: 300, width: 240, height: 240, borderRadius: 120, borderWidth: 36, borderColor: "rgba(255,255,255,0.04)" }} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 24 }}>
          <BrandLogo name="horizontalOndark" width={150} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("chooseLanguage")}
            onPress={() => setLangOpen(true)}
            style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.10)", justifyContent: "center" }}
          >
            <Text size={13} weight={700} color={colors.white}>
              {t("language")}
            </Text>
          </Pressable>
        </View>

        {/* app preview: a sample student card with floating alerts (sample data, as in the design) */}
        <View style={{ height: 330, marginTop: 24, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 230, backgroundColor: colors.white, borderRadius: 24, padding: 16, gap: 14, transform: [{ rotate: "-3deg" }], shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 24, shadowOffset: { width: 0, height: 16 }, elevation: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#F9E3C2", alignItems: "center", justifyContent: "center" }}>
                <Text size={16} weight={800} color="#8A5A00">
                  A
                </Text>
              </View>
              <View>
                <Text size={14} weight={800}>
                  Aarav Sharma
                </Text>
                <Text size={11} weight={600} color={colors.textSoft}>
                  Class 3-A
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.presentBg, borderRadius: 14, padding: 10 }}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.present, alignItems: "center", justifyContent: "center" }}>
                <Icon name="check" size={18} color={colors.white} />
              </View>
              <View>
                <Text size={13} weight={800} color={colors.presentText}>
                  {t("previewPresent")}
                </Text>
                <Text size={11} weight={600} color={colors.textSoft}>
                  {t("previewMarked")}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              {(["attendance", "homework", "fees", "results"] as IconName[]).map((n) => (
                <View key={n} style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
                  <Icon name={n} size={28} />
                </View>
              ))}
            </View>
          </View>
          <Float delay={0} style={{ position: "absolute", right: 20, top: 8 }}>
            <Chip icon="fees" title={t("previewFees")} sub={t("previewReceipt")} />
          </Float>
          <Float delay={1300} style={{ position: "absolute", left: 16, bottom: 12 }}>
            <Chip icon="notices" title={t("previewPtm")} sub={t("previewNotice")} />
          </Float>
        </View>

        <View style={{ paddingHorizontal: 24, marginTop: "auto", gap: 10 }}>
          <Text accessibilityRole="header" size={30} weight={800} color={colors.white} style={{ lineHeight: 38 }}>
            {t("welcomeTitle")}
          </Text>
          <Text size={15} weight={500} color={colors.whiteSoft}>
            {t("welcomeSub")}
          </Text>
          <View style={{ gap: 10, marginTop: 18 }}>
            <Button label={t("getStarted")} onPress={() => router.push("/find-school")} icon={<Icon name="arrowRight" size={20} color={colors.white} />} />
            <Button label={t("haveCode")} kind="ghostOnNavy" onPress={() => router.push({ pathname: "/find-school", params: { code: "1" } })} />
          </View>
        </View>
      </ScrollView>
      <LanguagePicker open={langOpen} onClose={() => setLangOpen(false)} />
    </View>
  );
}
