// Push notifications (SRS D-M09, section 8; backend B-04). Every login on the phone registers the
// phone at its own school with its own token (two children in two schools = two registrations),
// with the app language so the push words come in it. A tapped push carries
// { school, userId, link, notificationId }: the app opens that child's account, then the screen.
//
// Needs the TatvaOS School EAS project (its id comes from EAS_PROJECT_ID at build time, see
// app.config.ts) and a development or store build: Expo Go on Android cannot get push tokens.
// Until then registration is skipped quietly.
import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import { api, APP_VERSION, PLATFORM } from "./api";
import * as DeviceName from "./device";

/**
 * Push needs a development or store build. In Expo Go (Android, SDK 53+) even loading
 * expo-notifications throws and takes the whole app down, so it is loaded only outside Expo Go.
 */
export const pushAvailable = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
export function notifications(): typeof import("expo-notifications") | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return pushAvailable ? require("expo-notifications") : null;
}

export function projectId(): string | undefined {
  return (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** The phone's Expo push token, or null when this build or phone cannot have one (or the person said no). */
export async function pushToken(): Promise<string | null> {
  const id = projectId();
  const Notifications = notifications();
  if (!id || !Device.isDevice || !Notifications) return null;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "School", importance: Notifications.AndroidImportance.HIGH });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    return (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch {
    // Expo Go on Android, no Google services, or no network: try again on the next launch
    return null;
  }
}

/** Register this phone for one login at its school (B-04). Safe to repeat: the server keeps one row per token and login. */
export async function register(host: string, token: string, expoPushToken: string, language: string) {
  await api.registerDevice(host, token, {
    expoPushToken,
    platform: PLATFORM,
    appVersion: APP_VERSION,
    deviceName: DeviceName.name(),
    language,
  });
}

/** The saved login a tapped push belongs to: account ids are `${CODE}_${userId}` and the code is the slug in capitals. */
export function accountIdFor(data: { school?: unknown; userId?: unknown } | undefined) {
  if (!data || typeof data.school !== "string" || data.userId === undefined || data.userId === null) return null;
  return `${data.school.toUpperCase()}_${data.userId}`;
}
