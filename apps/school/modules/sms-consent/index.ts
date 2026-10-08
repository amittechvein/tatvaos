// Fills the SMS code on Android with the user's consent (see SmsConsentModule.kt). Missing in
// Expo Go and on iOS, where nothing happens: iOS offers the code above the keyboard by itself
// (textContentType="oneTimeCode").
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

type SmsConsent = {
  start(): void;
  stop(): void;
  addListener(event: "onMessage", fn: (e: { message: string }) => void): { remove(): void };
};

const native = Platform.OS === "android" ? requireOptionalNativeModule<SmsConsent>("SmsConsent") : null;

/** The 6-digit code in an SMS, or null. */
export function codeFromSms(message: string): string | null {
  const m = /(?:^|\D)(\d{6})(?!\d)/.exec(message);
  return m ? m[1] : null;
}

/**
 * While `active`, the next code SMS the user allows is passed to `onCode`. Android listens for one
 * message at a time, so change `round` (for example on "Send a new code") to listen again.
 */
export function useSmsCode(active: boolean, round: number, onCode: (code: string) => void) {
  const latest = useRef(onCode);
  latest.current = onCode;
  useEffect(() => {
    if (!active || !native) return;
    const sub = native.addListener("onMessage", ({ message }) => {
      const code = codeFromSms(message);
      if (code) latest.current(code);
    });
    try {
      native.start();
    } catch {
      // Play services missing: the code is typed by hand
    }
    return () => {
      sub.remove();
      try {
        native.stop();
      } catch {}
    };
  }, [active, round]);
}
