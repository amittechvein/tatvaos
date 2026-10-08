// Fingerprint / Face ID unlock (FR-C05; design decision 6 Oct 2026): never on the first sign-in.
// After a password sign-in the app asks once, per login, "Use fingerprint next time?". When on,
// opening the app asks for the fingerprint before anything shows; the token itself stays in
// secure storage either way. The choice is per login and per phone.
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

const key = (kind: "bio" | "bioAsked", id: string) => `${kind}_${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;

/** The phone has a fingerprint or face sensor and the person has enrolled one. */
export async function canUse(): Promise<boolean> {
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

export async function isOn(accountId: string) {
  return (await SecureStore.getItemAsync(key("bio", accountId)).catch(() => null)) === "1";
}

export async function setOn(accountId: string, on: boolean) {
  if (on) await SecureStore.setItemAsync(key("bio", accountId), "1");
  else await SecureStore.deleteItemAsync(key("bio", accountId)).catch(() => {});
  await SecureStore.setItemAsync(key("bioAsked", accountId), "1");
}

/** Whether to offer it now: the phone can, it is off, and this login was not asked before. */
export async function shouldOffer(accountId: string) {
  if (!(await canUse())) return false;
  if (await isOn(accountId)) return false;
  return (await SecureStore.getItemAsync(key("bioAsked", accountId)).catch(() => null)) !== "1";
}

/** Shows the phone's own fingerprint prompt. */
export async function unlock(prompt: string, cancelLabel: string) {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel, disableDeviceFallback: false });
  return r.success;
}

/** Forget the choice when the login is signed out. */
export async function forget(accountId: string) {
  await SecureStore.deleteItemAsync(key("bio", accountId)).catch(() => {});
  await SecureStore.deleteItemAsync(key("bioAsked", accountId)).catch(() => {});
}
