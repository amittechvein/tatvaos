# Welcome to TatvaOS — you're taking Mobile

Written 9 September 2026 by the CTO, the night before you started.
Corrected the same day, by the person it was written for, from what actually
happened. Every change below is marked with what proved it.

Read `docs/MOBILE_LANE_BRIEF.md` first — it is the decision record for *why*
this app exists and what v1 is. This document is different: it is what is
actually **in the repository today**, what is **blocked and on whom**, and the
specific things that will waste your first week if nobody tells you.

You are the first person to own this lane. Until today it moved only when Amit
and I sat up together, which is exactly why you were hired.

---

## 1. What exists, precisely

`apps/mobile` — Expo SDK 57, React Native 0.86, a handful of JavaScript files
(`App.js`, `api.js`, `theme.js`, `index.js`; sizes go stale, `wc -l` does not).
It is small, and it is real: it signs in against **production**, not a mock.

Working and proven on an emulator against `core.tatvaos.com`:

- Email + password sign-in, and the two-step verification screen
- Refresh token stored in the Android keystore (`expo-secure-store`)
- Coming back signed in after a restart
- Sign-out, including a server-side logout
- A dashboard showing the person's real entitlements — not six fixed tiles
- Every tile opens its product

Measured, so you can compare: login 3124ms cold, 513ms warm; `/api/auth/me`
526ms then 86ms.

**Empty:** `app/`, `components/`, `hooks/`, `lib/`, `native/`. There are no
native product screens at all. The honest number is about 8% of v1.

`spike/` holds `ScreenShareSpike.js` — a proving harness, not product code, and
nothing imports it. See section 5.

---

## 2. The one place this diverges from the brief — and it is on purpose

The brief says each product opens in a **web view** inside the shell. Tonight I
shipped the tiles opening in the **system browser** instead. You need to know
why, because it is not a preference.

The web apps authenticate by **cookie**. This app holds a **token**. A web view
therefore opens on a login page *inside our own app*: the person is signed in,
looking at a sign-in screen, with nothing to explain it. And a web view we
control looks like our app, so typing a password into it teaches people that a
screen inside an app is a fine place to type a password. It is not, and that is
a habit worth not teaching.

The system browser is honest: address bar, padlock, the person's existing
session, and a password manager that can fill it. The cost is one sign-in, and
the dashboard says so out loud.

**The brief's web-view plan becomes correct the moment the sign-in handoff
endpoint exists** — the app trades its token for a short-lived authenticated
URL. Then a web view opens already signed in and the objection disappears.

That endpoint is **Core's work and is not yet written**. It is the single
highest-value item on this lane and none of it is yours to build. Chase it.

---

## 3. Getting it to build — the things that will cost you a day each

Each was hit and solved on 8, 9 or 11 September. None is guessable; each
carries the date and the symptom so you can tell whether it is still true.

**1. `apps/mobile` is NOT in the pnpm workspace.** `pnpm-workspace.yaml`
excludes it. Inside that folder you must run:

```
pnpm install --ignore-workspace
```

Plain `pnpm install` walks up, finds the workspace, prints
`Scope: all 4 workspace projects`, installs the *others*, reports success, and
leaves `apps/mobile/node_modules` empty.

**2. Why it is excluded: Windows' 260-character path limit.** pnpm names each
package in its store after every peer it resolved against; `expo-modules-core`
lands in a 108-character directory, and Gradle's
`build/intermediates/cxx/Debug/<hash>/logs/x86_64/prefab_command.bat`
underneath took the path to **273 characters**. Gradle wrote the file and
Windows refused to *start* it — the error is
`CreateProcess error=2, The system cannot find the file specified`, about a
file that exists. `node-linker=hoisted` in `apps/mobile/.npmrc` gives a flat
`node_modules` and the same path is 153.

**3. `android/` is generated and gitignored.** `npx expo prebuild --platform android`
creates it from `app.json`. Do not commit it. `app.json` is the source of truth
for name, icon, permissions, scheme and SDK versions. The day you need a native
change Expo cannot express, that is a real decision with a real cost — you then
own those files on two platforms — and it should be made deliberately, not by
running `git add .` after a build.

**4. `android/local.properties` holds `sdk.dir`.** Gradle reads it *before*
`ANDROID_HOME`, which matters because an environment variable only reaches
terminals opened after it was set. On 8 September the build failed with
"SDK location not found" in a terminal where `adb` worked perfectly.

**`prebuild --clean` DELETES that file**, so every clean prebuild needs it
recreated — comments and all. Copy it somewhere first: on 9 September the
one-line restore threw away the block explaining the escaping, and the repair
script then truncated the file to zero bytes. Having the backup is what made it
possible to *prove* the restore byte-for-byte instead of asserting it.

**5. Gradle downloads its own JDK 17** by toolchain auto-provisioning. It does
not use Android Studio's bundled Java, so `java` on your PATH is irrelevant.
A one-ABI build is about 4½ minutes cold and under a minute warm — see the next
item for why you want one ABI.

**6. Build ONE ABI, or this machine runs out of memory.** 9 September, the
first build after `@livekit/react-native-webrtc` landed: `clang++` reported
`The paging file is too small (0x5AF)` and then `Insufficient system resources
(0x5AA)`, the Gradle daemon *disappeared*, and it left an `hs_err_pid*.log`
saying `Native memory allocation (malloc) failed… out of physical RAM or swap`.
Host: 8 cores, 15 GB.

Nothing in that output points at the cause. It is
`android/gradle.properties`:

```
reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64
```

Four ABIs, each running its own CMake/ninja with parallel `clang++` jobs.
Survivable until a large native module lands, and WebRTC is one of the largest.
The file documents the fix on the line *above* the setting that causes it:

```
.\gradlew.bat --stop
.\gradlew.bat assembleDebug -PreactNativeArchitectures=x86_64 --no-parallel --max-workers=2
```

`x86_64` for the emulator, `arm64-v8a` for a real phone — **and they are not
interchangeable**: an arm64 APK will not install on an x86_64 emulator. Ask the
running device rather than guessing: `adb shell getprop ro.product.cpu.abi`.
Do not edit `gradle.properties`; prebuild regenerates it.

If it still dies, the durable fix is Windows' page file (System → Performance →
Virtual memory → system-managed), not anything in this repository. And do not
run Android Studio, Gradle and the emulator at once on this machine.

**`npx expo run:android` is the wrong entry point when you only want to know
whether it compiles.** It tries to boot the AVD first and can fail on
`could not connect to TCP port 5554` without ever running Gradle — no
`app/build/` to inspect, and nothing learned. `gradlew assembleDebug` answers
the build question with nothing plugged in.

If the emulator ignores your keyboard, set `hw.keyboard=yes` in
`~/.android/avd/<name>.avd/config.ini`. `adb shell input text` works meanwhile —
**never** use it for a password, it lands in your shell history.

**7. A successful Gradle build can install the OLD APK.** 11 September:
`BUILD SUCCESSFUL in 3m 50s`, `325 actionable tasks: 5 executed, 320
up-to-date`, then `adb install -r … Success` — and the phone was running the
previous day's build, because the earlier `gradlew` had been skipped and the
APK on disk was stale. Every line in that sequence is green. Before trusting
an install, look at the file:

```
Get-Item android\app\build\outputs\apk\debug\app-debug.apk | Select-Object LastWriteTime
```

If it is not minutes old, nothing was built. A related tell: a new native
library should mean many executed tasks; "5 executed" after adding one is a
build to distrust. The one true test that a library is in the APK is
`Get-ChildItem android -Recurse -Include PackageList.java,autolinking.json |
Select-String <library name>`.

**8. pnpm 9.15 on Windows with the hoisted layout has a re-link bug.** When
`pnpm install --ignore-workspace` must replace a package that is already in
`node_modules`, it renames the folder to `<name>_tmp_<pid>` and then fails:

```
ERR_PNPM_ENOENT  ENOENT: no such file or directory, scandir '…\node_modules\metro-source-map_tmp_19288\node_modules'
```

It is deterministic, not a race — retrying gives the same package. On 11
September five packages tripped in one install (`metro-source-map`, `metro`,
`@livekit/react-native-webrtc`, `@expo/cli`, `react-native`). The workaround:
delete the package pnpm tripped on and the `*_tmp_*` leftovers, run the
install again, repeat until it finishes. As a loop:

```
for ($i = 0; $i -lt 20; $i++) {
  $out = pnpm install --ignore-workspace 2>&1 | Out-String
  if ($out -match "node_modules\\(.+?)_tmp_\d+") {
    $pkg = $Matches[1]
    Get-ChildItem node_modules -Directory -Filter "*_tmp_*" | Remove-Item -Recurse -Force
    Remove-Item "node_modules\$pkg" -Recurse -Force -ErrorAction SilentlyContinue
  } else { Write-Host $out; break }
}
```

Two rules that follow from it. **Never regenerate `apps/mobile/pnpm-lock.yaml`
with a different pnpm** — a lockfile written by pnpm 10 elsewhere re-linked a
dozen packages and made the bug unavoidable; let the pnpm on this machine
extend the lockfile. And after the loop deletes `react-native` or
`@livekit/react-native-webrtc`, the next Gradle build recompiles their native
code; that is expected and slow, not a sign something else broke.

**9. Metro keeps serving the OLD JavaScript after you change branches — and
the app looks fine.** 16 September 2026. Trap 7's sibling, one layer up: there
the APK was stale, here the bundle is. `CI=1 expo start` prints *"Metro is
running in CI mode, reloads are disabled"*, which also means it does not watch.
A Metro started on one branch went on serving that branch's bundle after a
`git checkout` — the app launched, signed in, the dashboard drew, a tile opened
the browser. Every one of those was true and none of it exercised the code
under test.

**The tell was a line that was NOT there.** `api.js` logs every request, so the
new code had to produce `POST /api/auth/handoff -> 404`. The log had no such
line and no `[handoff]` line either — the mint was never attempted, because the
running bundle had never heard of it. A screenshot would have looked perfect.

So: **before believing a device run, assert something that can only be true of
the new bundle** — a log line the new code emits, not the absence of a crash.
And restart Metro with `--clear` after changing branches; the pnpm-level
caching is not the only cache in this stack.

*Also, while you are here: Docker, an emulator and Metro together exhaust this
laptop's commit limit — `adb` itself stops answering and everything times out
with no error naming memory. Check `(Get-CimInstance
Win32_OperatingSystem).FreeVirtualMemory` before blaming your change. The
durable fix is Windows' page file set to system-managed, which is Amit's to do.*

---

## 4. Two bugs I fixed that tell you what this codebase's failures look like

**The app could hang on its splash screen forever.** `App.js` called
`restore().then(...)` with no `.catch`, and `restore()` guarded only the network
call — the keychain read sat outside every `try`. A throw there pinned the app
on a spinner with no error and no timeout.

It presented as *"I can't type the email."* There was nothing to type into: the
login form was never on screen. Twenty minutes went on the emulator's keyboard
before anyone asked which screen was actually rendered.

**The app logged nothing.** A 401, a DNS failure, a keychain error and a person
who never pressed the button produced an identical empty log. There is now one
`[api]` line per request — method, path, status, duration — plus the three
moments that decide a sign-in. **It never logs bodies, tokens, passwords or
email addresses.** Keep it that way.

The pattern in both: **a failure that produces no signal.** You will meet more.
When something looks wrong, measure it before reasoning about it.

---

## 5. Screen sharing — done, on hardware, and here is what it found

`getDisplayMedia` **does not exist on Android Chrome or iOS Safari**. Screen
sharing from a phone is not a thing any browser can do, which means it is the
one capability that justifies a native app at all.

**It works, in a real meeting, on a real phone.** Proven 9 September 2026 on
a Samsung phone, from the tree at `d9d1520`, with
`apps/mobile/spike/ConnectShareSpike.js`, against production Connect, with a
second participant in a browser on a laptop:

| Criterion | Emulator (API 36, `2a3485b`) | Samsung (`d9d1520`) |
|---|---|---|
| Consent dialog appears | yes | yes |
| Denial fails visibly | `REJECTED name=Error message=NotAllowedError` | `REFUSED` — but see the trap below: the first build said `SHARE FAILED` |
| Notification appears | Android's red cast chip | yes, and the service stays `isForeground=true` in `dumpsys` |
| Backgrounding does not kill it | Home for 29 s, alive | alive |
| Lock/unlock does not kill it | screen off 10 s, alive | **killed.** The OS revokes MediaProjection on screen-off; socket and service stay alive |
| A real meeting, second participant sees it | not possible | **yes** — the phone's screen, labelled with the sharer's name, on the laptop |

Read the lock row twice. The emulator said yes; the phone said no. That is
not a Samsung bug to work around — it is the whole argument of the next
subsection. The product screen (`apps/mobile/screens/Meeting.js`, merged as
`fb61236` on 11 September and proven the same way: real phone, real meeting,
a guest admitted from the phone's own lobby, the laptop showing the phone's
screen) handles it with `RoomEvent.LocalTrackUnpublished` — so the app stops
*saying* "sharing" the moment it stops *being* true — and `useKeepAwake` for
the length of a meeting, so only a deliberate lock ends a share. What happens
on unlock — the share does not resume, and LiveKit logs a `NegotiationError`
— is open.

### The configuration is armed to fail by default

`@livekit/react-native-expo-plugin`'s `enableScreenShareService` defaults to
**false**, and the plugin is a complete **no-op if you list it as a bare
string** — every branch of it sits inside `if (options)`. The natural way to
add it produces an app that installs, runs, starts a share, and has Android
kill the capture minutes later with nothing in the log. In `app.json`:

```json
["@livekit/react-native-expo-plugin",
 { "android": { "audioType": "communication", "enableScreenShareService": true } }]
```

The `<service>` itself is declared by `@livekit/react-native-webrtc`'s own
manifest and merges in automatically. The **permissions are declared by no
library** and are ours: `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS`, camera, mic.
Verify after a build in
`android/app/build/intermediates/packaged_manifests/debug/**/AndroidManifest.xml`
— that is the one inside the APK.

### Three API traps for whoever touches the production path

**The denial error is inverted from the W3C shape.** It arrives as
`name="Error"`, `message="NotAllowedError"`. Every example anywhere writes
`if (err.name === 'NotAllowedError')` and on this stack that check **silently
never matches** — a denial falls through to a generic error branch and gets
reported as something else. `lib/refusal.js` is the one place that knows
this; use `isRefusal`, and run `lib/refusal.check.js` if you doubt it.
(`MediaStreamError` is also not an `Error` subclass: no `.stack`, and
`instanceof Error` is false.)

**A refusal exits two different ways.** `setScreenShareEnabled(true)`
*resolved `undefined`* on the emulator and *threw* on the Samsung. Code that
handles one and not the other reports a refusal as a failure — the first
hardware run did exactly that. Both exits go through `isRefusal`.

**The app is backgrounded while the consent sheet is open.** Any code that
tears down or resets state on background will break the share flow before it
has started.

### On the emulator

Prove it on hardware. The emulator can show you the API working and tell you
nothing about whether the feature works.

The reason is in the table above. Consent, visible denial, the notification
and surviving a backgrounding are properties of the capture and the service,
and the emulator ran those honestly. Then it said lock/unlock was fine, and
the phone revoked the capture on screen-off. The emulator is where you find
out whether your code calls the API correctly; it is not where you find out
whether the person gets a working share. Use it for the first half and never
let it stand in for the second.

### Capacity

**Ask Connect for the current numbers.** The box is **4 vCPU and video
recording works on it** — both tests passed on 21 August 2026, including one
with a camera on and a screen share running. What is tight is the two at once:
the recorder alone measured `maxCPU 4.254` on those four cores, so a screen
share *during* a recording sits on the ceiling. Test that combination early,
with Connect watching, at a time you have agreed. I did not, on 9 September:
the hardware runs went against production without telling Connect first.
That was wrong, it is owned, and the rule stands.

Those numbers are not written down anywhere in this repository — which is why
this paragraph was wrong for three weeks. Ask Connect, then write down what you
are told.

---

## 6. What is blocked, and on whom

| Blocked | Owner | Why it matters |
|---|---|---|
| Sign-in handoff endpoint | **Core** | Removes the second sign-in; unblocks the web-view architecture |
| Push notifications (server half) | **Core** | Device-token table and a send path. No client can exist without it |
| Apple Developer account ($99/yr), Google Play ($25) | **Amit** | In his name; you cannot create them for him |
| Store-sized logo files | **Amit** | The splash and adaptive-icon colours in `app.json` were moved to the web's violet on 9 September; the artwork itself is still the placeholder |

Two rows that were here on day one are gone because they were resolved on
day two: the Connect entitlement (fixed on the server side by adding the
missing `product_access` rows — if `/api/auth/me` ever returns `mail` only
again, that table is where to look) and the old green splash colour.

**Push notifications are, in my view, the most valuable thing you can build
after the handoff lands.** They are the reason someone keeps an app installed.
A launcher that opens web pages is a home-screen bookmark with extra steps.

---

## 7. How we work

- Read `docs/HOUSE_RULES.md`. It is the canonical copy; anything contradicting
  it is out of date.
- Branch off `main`, push, open a PR, wait for CI, `gh pr merge --merge` — not
  squash, the commit messages are the record.
- **Every lane merges and deploys itself.** A deploy ships all of `main`, so a
  deploy that breaks someone else's work is still your deploy: roll back first,
  diagnose after, and say so immediately. Nobody is in trouble for a rollback.
- **Never work in `C:\Users\amitd\Downloads\tatvaOS`** — that is the integration
  and deploy checkout. Work left there has needed rescuing more than once.
- Amit is not a developer. Give him one command at a time and tell him what
  success looks like. He is on Windows PowerShell 5.1: **no `&&`**.

---

## 8. Your first week — a suggestion

1. Build it. Emulator, real sign-in, see the `[api]` lines. If any of section 3
   bites you anyway, tell me — the instructions are wrong and I want to fix them.
2. Read `App.js` end to end. It is the whole app.
3. Spike screen sharing on Android. Not polished — proven. **Done 9 September;
   section 5 is the result.** The half that needs a real meeting is still open.
4. Tell me what you'd change about the architecture. You will know more about
   React Native than I do by Wednesday, and section 2 is a decision I made
   under a constraint, not a conviction.

Two small things not worth a ticket but worth doing while you are in there:
`SafeAreaView` is deprecated in favour of `react-native-safe-area-context`, and
the API host is hard-coded where it should come from `app.json` so a development
build can point elsewhere. **That second one is bigger than it looks:** it is
`api.js` *and* `theme.js`, which hard-codes every product URL —
`mail.tatvaos.com`, `core.tatvaos.com/family`, `core.tatvaos.com/org`. Changing
one line fixes nothing. The same applies to the old green: it is not two lines
in `app.json`, it is `theme.js`'s palette base and the Mail tile's ink, so it is
a palette change rather than a colour swap.

---

## 9. One thing I would ask of you

This app's two real bugs were both invisible. Nothing crashed, nothing logged,
and both presented as something else entirely.

So: when you fix something, leave behind the thing that would have found it —
a log line, a check, a comment naming what the failure looked like from the
outside. Most of what is written down in this repository exists because someone
lost hours to something that could have said what was wrong and did not.

A companion learned the hard way on 9 September, four times in one day: **a
check that claims something is ABSENT must print what it actually searched.**
Every one of those four was a pattern that did not match the data's shape — a
boolean rendered `false` not `f`, an XML element split across lines, a parser
that cannot read JSX, a library not named after its project. Three produced a
false red. One produced a false green, which is the direction that ships.

Welcome. Ask me anything, including whether I have got something wrong here.
