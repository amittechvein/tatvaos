import type { ExpoConfig } from "expo/config";

// One config for the common TatvaOS School app. White-label school builds (SRS section 9) will
// read a per-school file here later; until then every value below is the common app's.
const config: ExpoConfig = {
  name: "TatvaOS School",
  slug: "tatvaos-school",
  version: "1.0.0",
  orientation: "portrait",
  scheme: "tatvaosschool",
  userInterfaceStyle: "light",
  backgroundColor: "#1B2363",
  ios: {
    bundleIdentifier: "com.techvein.tatvaos.school",
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: "com.techvein.tatvaos.school",
    versionCode: 1,
    // NF-06: only HTTPS. Cleartext stays off (Android's default since API 28).
    permissions: [],
    blockedPermissions: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-localization",
    "expo-font",
    ["expo-splash-screen", { backgroundColor: "#1B2363" }],
    // push: needs the TatvaOS School EAS project; Firebase config (google-services.json) is supplied per build
    ["expo-notifications", { color: "#1B2363" }],
    ["expo-local-authentication", { faceIDPermission: "TatvaOS School uses Face ID to open the app, only if you turn it on." }],
    // camera only for scanning the school's QR code (FR-C01), asked for at that moment
    ["expo-camera", { cameraPermission: "TatvaOS School uses the camera only to scan your school's QR code.", recordAudioAndroid: false }],
  ],
  // EAS project of TatvaOS School, set in the build environment (never committed)
  extra: process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : undefined,
  experiments: { typedRoutes: false },
};

export default config;
