// An inner screen: white header with back button, then the content. Used by list and detail screens.
import React from "react";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Header, Loading, Notice, OfflineBanner } from "./parts";
import { useT } from "@/core/i18n";
import { colors } from "./theme";
import { Text } from "./Text";

export function Screen({ title, sub, right, tab, offlineAt, children }: { title: string; sub?: string; right?: React.ReactNode; tab?: boolean; offlineAt?: number; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="dark" />
      <View style={{ backgroundColor: colors.white, paddingTop: insets.top }}>
        <Header title={title} sub={sub} right={right} noBack={tab} />
      </View>
      <OfflineBanner at={offlineAt} />
      {children}
    </View>
  );
}

/** Loading, error or empty state for a list. */
export function ListState({ pending, error, emptyText, onRetry }: { pending: boolean; error: unknown; emptyText: string; onRetry?: () => void }) {
  const { t } = useT();
  if (pending) return <Loading />;
  if (error)
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <Notice tone="error" text={(error as Error).message} />
        {onRetry ? <Button small kind="outline" label={t("retry")} onPress={onRetry} /> : null}
      </View>
    );
  return <View style={{ padding: 16 }}><Notice text={emptyText} /></View>;
}

export function SectionTitle({ text }: { text: string }) {
  return (
    <Text size={12} weight={800} color={colors.textSoft} style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, letterSpacing: 0.3 }}>
      {text.toUpperCase()}
    </Text>
  );
}
