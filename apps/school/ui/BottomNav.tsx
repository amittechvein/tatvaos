// The student bottom menu: Home, Calendar, Profile. Ask Ashu (Phase 3, after the child-safety
// sign-off) and Messages (only when the school switches messaging on, FR-S10) are not shown yet.

import React from "react";
import { Alert, Pressable, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "@/core/i18n";
import type { StringKey } from "@/core/strings";
import { Icon } from "./Icon";
import { IconName } from "./icons";
import { Text } from "./Text";
import { colors } from "./theme";

const items: { key: string; icon: IconName; label: StringKey; go?: string }[] = [
  { key: "home", icon: "navHome", label: "navHome", go: "/home" },
  { key: "calendar", icon: "navCalendar", label: "navCalendar", go: "/calendar" },
  { key: "profile", icon: "navProfile", label: "navProfile", go: "/profile" },
];

export function BottomNav({ current }: { current: string }) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  return (
    <View
      // "tabbar" passes the type check but Android has no such role and throws at runtime
      role="tablist"
      style={{ position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line, paddingBottom: insets.bottom + 6, paddingTop: 8 }}
    >
      {items.map((it) => {
        const on = it.key === current;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => (it.go ? (on ? null : router.replace(it.go as any)) : Alert.alert(t("comingSoon")))}
            style={{ flex: 1, alignItems: "center", gap: 3, minHeight: 48, justifyContent: "center" }}
          >
            <Icon name={it.icon} size={22} color={on ? colors.indigo : colors.textSoft} />
            <Text size={11} weight={on ? 800 : 600} color={on ? colors.indigo : colors.textSoft}>
              {t(it.label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
