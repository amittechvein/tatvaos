// Teacher, staff and admin screens (Phase 2, SRS section 13), behind the same app gate as the
// student screens. Attendance saves that waited for a connection are sent whenever the app
// comes back to the front (core/attendanceQueue.ts).
import React, { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { Redirect, Stack } from "expo-router";
import { useAccounts } from "@/core/accounts";
import { useSendWaiting } from "@/core/useSendWaiting";
import { Loading, useReduceMotion } from "@/ui/parts";
import { AppGate } from "@/ui/AppGate";
import { colors } from "@/ui/theme";

function Sender() {
  const send = useSendWaiting();
  const latest = useRef(send);
  latest.current = send; // the login that is active now, not the one at first render
  const { active } = useAccounts();
  useEffect(() => {
    latest.current();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") latest.current(); });
    return () => sub.remove();
  }, [active?.id]);
  return null;
}

export default function StaffLayout() {
  const reduce = useReduceMotion();
  const { active, ready } = useAccounts();

  if (!ready) return <Loading />;
  if (!active) return <Redirect href="/" />;
  if (active.role === "STUDENT") return <Redirect href="/home" />;

  return (
    <AppGate>
      <Sender />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: reduce ? "none" : "slide_from_right" }} />
    </AppGate>
  );
}
