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
