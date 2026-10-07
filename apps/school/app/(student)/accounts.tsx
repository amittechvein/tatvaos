// 1d Switch child (FR-S01, FR-C13, B-02). Every login saved on this phone, each with its own
// school; one tap opens it and the others stay signed in. "Add a child" signs in one more login
// (same school or another). Signing out removes only that login and its cached data.

import React from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useAccounts } from "@/core/accounts";
import { routeFor } from "@/core/nav";
import { useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { ChildAvatar } from "@/ui/ChildAvatar";
import { SchoolBadge } from "@/ui/SchoolBadge";
import { colors } from "@/ui/theme";

export default function Accounts() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { accounts, active, switchTo, signOut, school } = useAccounts();

  return (
    <View style={{ flex: 1, justifyContent: "flex-end" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("cancel")} onPress={() => router.back()} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(27,35,99,0.45)" }} />
      <View style={{ backgroundColor: colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 12, paddingHorizontal: 16, paddingBottom: insets.bottom + 24, maxHeight: "85%" }}>
        <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: colors.disabled, alignSelf: "center" }} />
        <ScrollView contentContainerStyle={{ gap: 12, paddingTop: 12 }}>
          <View style={{ paddingHorizontal: 4 }}>
            <Text accessibilityRole="header" size={20} weight={800}>
              {t("switchChild")}
            </Text>
            <Text size={13} weight={500} color={colors.textSoft} style={{ marginTop: 4 }}>
              {t("switchChildSub")}
            </Text>
          </View>

          {accounts.map((a) => {
            const on = a.id === active?.id;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${a.name}, ${a.school.name}`}
                onPress={async () => {
                  if (!on) await switchTo(a.id);
                  router.dismissAll();
                  router.replace(routeFor(a, a.school));
                }}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 20, borderWidth: on ? 2 : 1, borderColor: on ? colors.indigo : colors.line }}
              >
                <View>
                  <ChildAvatar name={a.name} size={48} />
                  <View style={{ position: "absolute", right: -4, bottom: -4, borderWidth: 2, borderColor: colors.white, borderRadius: 8 }}>
                    <SchoolBadge school={a.school} size={22} radius={7} />
                  </View>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text size={15} weight={700} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>
                    {a.school.name}
                  </Text>
                </View>
                {on ? (
                  <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: "#E3F3EA" }}>
                    <Text size={12} weight={700} color="#1C4D31">
                      {t("open")}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              router.back();
              router.push(school ? "/sign-in" : "/find-school");
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 20, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.disabled, backgroundColor: "#F8F9FB" }}
          >
            <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.disabled, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" }}>
              <Text size={24} weight={600}>
                +
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text size={15} weight={700}>
                {t("addChild")}
              </Text>
              <Text size={12} weight={600} color={colors.textSoft}>
                {t("addChildSub")}
              </Text>
            </View>
          </Pressable>

          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", padding: 14, borderRadius: 14, backgroundColor: colors.indigoSoft }}>
            <Icon name="bell" size={18} color={colors.navy} />
            <Text size={12} weight={600} color={colors.navy} style={{ flex: 1, lineHeight: 18 }}>
              {t("alertsBoth")}
            </Text>
          </View>

          {active ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                Alert.alert(t("signOutOf", { name: active.name }), undefined, [
                  { text: t("cancel"), style: "cancel" },
                  {
                    text: t("signOut"),
                    style: "destructive",
                    onPress: async () => {
                      qc.removeQueries({ queryKey: [active.id] });
                      await signOut(active.id);
                      router.dismissAll();
                      router.replace("/");
                    },
                  },
                ])
              }
              style={{ minHeight: 48, alignItems: "center", justifyContent: "center" }}
            >
              <Text size={14} weight={700} color={colors.absentText}>
                {t("signOutOf", { name: active.name })}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}
