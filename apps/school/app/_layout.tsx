import React, { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from "@expo-google-fonts/manrope";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountsProvider } from "@/core/accounts";
import { I18nProvider } from "@/core/i18n";
import { ApiError } from "@/core/api";
import { useReduceMotion } from "@/ui/parts";
import { colors } from "@/ui/theme";

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // NF-05: no background polling; refresh when a screen opens
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2,
    },
  },
});

export default function RootLayout() {
  const [loaded] = useFonts({ Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold });
  const reduce = useReduceMotion();
  useEffect(() => {
    if (loaded) SplashScreen.hideAsync().catch(() => {});
  }, [loaded]);
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AccountsProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                // screens slide in with a fade; none when the phone asks for less motion
                animation: reduce ? "none" : "slide_from_right",
                animationDuration: 450,
              }}
            >
              <Stack.Screen name="index" options={{ animation: "none" }} />
            </Stack>
          </QueryClientProvider>
        </AccountsProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
