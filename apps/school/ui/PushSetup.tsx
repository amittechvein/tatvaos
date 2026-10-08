// Registers every signed-in login for pushes (and again when the language changes), and opens the
// right child and screen when a push is tapped. Renders nothing.
import { useEffect, useRef } from "react";
import type { NotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { useAccounts } from "@/core/accounts";
import { useT } from "@/core/i18n";
import { appRouteFor } from "@/core/links";
import { accountIdFor, notifications, pushToken, register } from "@/core/push";

notifications()?.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

export function PushSetup() {
  const { accounts, tokenOf, switchTo, ready } = useAccounts();
  const { lang } = useT();
  const done = useRef(new Set<string>());

  // register each login once per language per app run
  useEffect(() => {
    if (!ready || !accounts.length) return;
    let cancelled = false;
    (async () => {
      const expoToken = await pushToken();
      if (!expoToken || cancelled) return;
      for (const a of accounts) {
        const key = `${a.id}|${lang}|${expoToken}`;
        const t = tokenOf(a.id);
        if (!t || done.current.has(key)) continue;
        try {
          await register(a.school.host, t, expoToken, lang);
          done.current.add(key);
        } catch {
          // the school may not have the app yet (409) or the phone is offline: next launch tries again
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, accounts, tokenOf, lang]);

  // a tapped push: open that child's account, then the screen
  useEffect(() => {
    const Notifications = notifications();
    if (!ready || !Notifications) return;
    const open = async (response: NotificationResponse | null) => {
      const data = response?.notification.request.content.data as { school?: string; userId?: number; link?: string } | undefined;
      const id = accountIdFor(data);
      if (!id || !accounts.some((a) => a.id === id)) return;
      await switchTo(id);
      router.replace("/home");
      const to = appRouteFor(data?.link ?? null);
      router.push((to ?? "/inbox") as never);
    };
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [ready, accounts, switchTo]);

  return null;
}
