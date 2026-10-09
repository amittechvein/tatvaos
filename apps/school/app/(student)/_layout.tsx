// Every student and parent screen sits behind the app gate (ui/AppGate.tsx): the settings call,
// the update check, the school's switch and the temporary-password change.

import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAccounts } from "@/core/accounts";
import { Loading, useReduceMotion } from "@/ui/parts";
import { AppGate } from "@/ui/AppGate";
import { colors } from "@/ui/theme";

export default function StudentLayout() {
  const reduce = useReduceMotion();
  const { active, ready } = useAccounts();

  if (!ready) return <Loading />;
  if (!active) return <Redirect href="/" />;
  if (active.role !== "STUDENT") return <Redirect href="/staff" />;

  return (
    <AppGate>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: reduce ? "none" : "slide_from_right" }}>
        <Stack.Screen name="accounts" options={{ presentation: "transparentModal", animation: reduce ? "none" : "fade" }} />
      </Stack>
    </AppGate>
  );
}
