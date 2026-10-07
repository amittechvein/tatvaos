import { Platform } from "react-native";

/** The phone's model, sent at sign-in so the school's session list can say which phone it is. */
export function name(): string {
  const c: any = Platform.constants ?? {};
  const model = [c.Manufacturer, c.Model].filter(Boolean).join(" ").trim();
  return (model || (Platform.OS === "ios" ? "iPhone" : "Android phone")).slice(0, 60);
}
