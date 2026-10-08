// 1 Splash: shown on every launch (about 2.5 s), then the right first screen:
// signed in → home; a school saved → sign in; else → welcome (FR-C01).

import React, { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { router } from "expo-router";
import { useAccounts } from "@/core/accounts";
import { routeFor } from "@/core/nav";
import { isOn } from "@/core/biometric";
import { useT } from "@/core/i18n";
import { BrandLogo } from "@/ui/BrandLogo";
import { Text } from "@/ui/Text";
import { useReduceMotion } from "@/ui/parts";
import { colors } from "@/ui/theme";

const SPLASH_MS = 2500;

export default function Splash() {
  const { t } = useT();
  const { ready, active, school } = useAccounts();
  const reduce = useReduceMotion();
  const pop = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(0)).current;
  const load = useRef(new Animated.Value(0)).current;
  const started = useRef(Date.now());

  useEffect(() => {
    if (reduce) {
      pop.setValue(1);
      rise.setValue(1);
      load.setValue(1);
      return;
    }
    Animated.parallel([
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 60, useNativeDriver: true }),
      Animated.timing(rise, { toValue: 1, duration: 600, delay: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(load, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }),
    ]).start();
  }, [reduce, pop, rise, load]);

  useEffect(() => {
    if (!ready) return;
    const wait = Math.max(0, (reduce ? 600 : SPLASH_MS) - (Date.now() - started.current));
    const timer = setTimeout(async () => {
      // FR-C05: a login with fingerprint unlock on opens at the lock screen
      const locked = active ? await isOn(active.id) : false;
      router.replace(locked ? "/unlock" : routeFor(active, school));
    }, wait);
    return () => clearTimeout(timer);
  }, [ready, active, school, reduce]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.navy, alignItems: "center", justifyContent: "center" }}>
      {/* the TatvaOS School logo from the brand kit (on navy: the -ondark artwork) */}
      <Animated.View style={{ opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] }}>
        <BrandLogo name="verticalOndark" width={220} />
      </Animated.View>
      <Animated.View style={{ alignItems: "center", opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }}>
        <Text size={15} weight={500} color={colors.whiteSoft} style={{ marginTop: 8 }}>
          {t("tagline")}
        </Text>
      </Animated.View>
      <View style={{ position: "absolute", bottom: 64, alignItems: "center", gap: 14 }}>
        <View style={{ width: 120, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.14)", overflow: "hidden" }}>
          <Animated.View style={{ height: 4, borderRadius: 2, backgroundColor: colors.saffron, width: load.interpolate({ inputRange: [0, 1], outputRange: [0, 120] }) }} />
        </View>
        <Text size={12} weight={500} color="rgba(255,255,255,0.55)">
          {t("byTechvein")}
        </Text>
      </View>
    </View>
  );
}
