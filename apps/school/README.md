# apps/school: the TatvaOS School app

Students and parents (Phase 1), later teachers and admins, on Android and iOS. Expo SDK 57,
React Native, TypeScript, Expo Router. It calls the TatvaOS school backend (TechveinERP); the API
is described in that repository's `backend/docs/api/mobile-v1.md`. This app is separate from
`apps/mobile` (mail and Connect) and shares no code with it.

## Layout

| Folder | Contents |
|---|---|
| `app/` | Screens by route: `(auth)` first run and sign-in, `(student)` student and parent screens |
| `core/` | API client, saved logins (several per phone), language, formats, data hooks |
| `ui/` | Theme from the approved design, shared parts, the design's icons |

## Install

This app is outside the pnpm workspace, like `apps/mobile` (see `pnpm-workspace.yaml`):

```
cd apps/school
pnpm install --ignore-workspace
```

To add a package, use `pnpm add --ignore-workspace <name>@~57.x` here. Do not use
`npx expo install`: it runs pnpm at the monorepo root, rewrites the root `pnpm-lock.yaml` and
installs the whole workspace.

## Run on a phone over USB (Expo Go 57)

```
npx expo start --lan --port 8081        # with REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8081 host.exp.exponent
```

`--localhost` is not enough on Windows: Metro then listens on IPv6 `::1` only, `adb reverse`
connects over IPv4, and Expo Go shows "Something went wrong" with nothing in Metro's log.

## Checks

```
npx tsc --noEmit
```

## Things that bite

- `accessibilityRole="tabbar"` passes the type check, but Android has no such role and the screen
  crashes with "Invalid accessibility role value: tabbar". Use `role="tablist"`.
- The school must have migration 112 (`mobile_app_settings`), or the settings call answers
  `app.enabled: false` and the app shows "has not switched on the app yet".
- Hindi, Bengali and Punjabi text in `core/strings.ts` needs a native speaker's check before a
  store release.

## Separate from Connect (apps/mobile)

TatvaOS School and the Connect app have no connection, and CI checks it
(`scripts/check-app-separation.js`, workflow `school-app-separation.yml`):

- No imports either way, no shared package (this app has its own `package.json` and lockfile).
- Its own identity: app ID `com.techvein.tatvaos.school` (Android and iOS), name "TatvaOS School",
  slug `tatvaos-school`, scheme `tatvaosschool`, its own icons and logos from the TatvaOS brand kit in `assets/brand/` (the logos are drawn from `assets/brand/svg` through `ui/brand.ts`; after replacing an SVG, run `node scripts/brand-svgs.js`).
- Its own Expo (EAS) project, Firebase app and Apple push key. Never reuse Connect's.
- It calls only the TatvaOS school backend (TechveinERP), plus Razorpay's checkout page for that
  backend's fee payments and Expo's push service.

Build settings, all School's own and kept in the School EAS project, never in Git:

| Name | What |
|---|---|
| `EAS_PROJECT_ID` | The School EAS project's id (push tokens, updates) |
| `GOOGLE_SERVICES_JSON` | EAS secret *file*: School's own Firebase `google-services.json` |
| `EXPO_PUBLIC_DEV_API` | Development only: a backend on the developer's PC |

Build profiles are in `eas.json`: `preview` (installable APK, channel `preview`) and
`production` (app bundle for the stores, channel `production`). Build from this folder only:
`npx eas build --profile preview --platform android`.
