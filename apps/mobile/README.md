# apps/mobile — Expo / React Native

**iOS and Android from one codebase.** There is deliberately no separate `android/` or `ios/` project.

## Layout

| Folder | Contents |
|---|---|
| `app/` | Screens (Expo Router — file path = navigation path) |
| `components/` | Reusable UI |
| `assets/` | `images/`, `fonts/`, `icons/` bundled into the app |
| `lib/` | Helpers, API setup, local database |
| `hooks/` | Custom hooks |
| `native/` | Platform-specific native config. Keep this small |

## Two things that decide whether users keep the app

**The app never speaks IMAP.** iOS cannot hold a background IMAP connection at all. Clients talk to our own delta-sync REST API; IMAP exists only for third-party clients like Outlook and Thunderbird.

**Push must be server-driven and fast.** New mail arrives → event on the queue → notification service → APNs/FCM → device wakes → delta sync. Payloads carry an identifier and change token only — never a subject line or body, because those would pass through Apple's and Google's infrastructure.

## Building

Windows cannot build iOS locally. EAS Build compiles on Expo's cloud Macs, which is why this stack was chosen. A Mac Mini becomes worth buying around the push-pipeline sprint — see the delivery plan.

### A build for Google Play (21 September 2026)

Play wants an **app bundle** (`.aab`) signed with **our upload key**, not the APK the phone tests use.

```
gradlew bundleRelease -PtatvaosUpload=true -x lintVitalAnalyzeRelease -x lintVitalRelease -x lintVitalReportRelease -PreactNativeArchitectures=arm64-v8a --max-workers=1 "-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=768m" "-Pkotlin.compiler.execution.strategy=in-process"
```

- Run it in the short build checkout (`C:\Users\amitd\tvb\apps\mobile\android`), for the reason in `plugins/withShortNativeObjectPaths.js`.
- The file lands in `android/app/build/outputs/bundle/release/app-release.aab`.
- `-PtatvaosUpload=true` is what signs it with the upload key (`plugins/withUploadSigning.js`). Without it the build uses the debug key, which Play refuses; that is on purpose, so phone test builds still update the installed app in place.
- **The key is not in this repository and must never be.** It lives in `~/.tatvaos-signing` on the build laptop (or `TATVAOS_SIGNING_DIR`): `tatvaos-upload.jks` and `upload-password.txt`. Keep a copy somewhere safe off the laptop. Its certificate SHA-256 is `EA:A2:0F:9C:92:C6:10:BB:80:73:96:C1:92:A2:F3:E7:42:FC:E4:59:10:14:34:A0:DF:AD:0D:51:31:F6:82:08`, which is what the Play Console shows as the upload certificate.
- **Raise `android.versionCode` in `app.json` for every upload** (and in the generated `android/app/build.gradle` until the next prebuild). Play refuses a number it has seen.
- `arm64-v8a` only: every phone sold in India in the last several years is 64-bit, and building the 32-bit library as well roughly doubles the native build on this laptop. Old 32-bit-only phones cannot install it.
- The icon is the TatvaOS brand mark, drawn from `apps/web/public/brand/tatvaos-mark.svg` by `scripts/make-icons.py`. `store/play-store-icon-512.png` is the one the Play listing asks for.
