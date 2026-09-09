# Welcome to TatvaOS — you're taking Mobile

Written 9 September 2026 by the CTO, the night before you started.

Read `docs/MOBILE_LANE_BRIEF.md` first — it is the decision record for *why*
this app exists and what v1 is. This document is different: it is what is
actually **in the repository today**, what is **blocked and on whom**, and the
specific things that will waste your first week if nobody tells you.

You are the first person to own this lane. Until today it moved only when Amit
and I sat up together, which is exactly why you were hired.

---

## 1. What exists, precisely

`apps/mobile` — Expo SDK 57, React Native 0.86, ~640 lines. It is small, and it
is real: it signs in against **production**, not a mock.

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

## 3. Getting it to build — five things that will cost you a day each

All five were hit and solved on 8 September. None is guessable.

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

**5. Gradle downloads its own JDK 17** by toolchain auto-provisioning. It does
not use Android Studio's bundled Java, so `java` on your PATH is irrelevant.
First build ~10 minutes, subsequent ~3.

If the emulator ignores your keyboard, set `hw.keyboard=yes` in
`~/.android/avd/<name>.avd/config.ini`. `adb shell input text` works meanwhile —
**never** use it for a password, it lands in your shell history.

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

## 5. Screen sharing — do this first

The brief says so and I agree, more strongly after this week.

`getDisplayMedia` **does not exist on Android Chrome or iOS Safari**. Screen
sharing from a phone is not a thing any browser can do, which means it is the
one capability that justifies a native app at all. If it cannot be made to work,
the case for this lane changes — so prove it before building a shell around it.

Android: LiveKit's React Native SDK, a WebRTC native module, `MediaProjection`,
and a **foreground service with a persistent notification** (Android kills
capture without one). iOS: a Broadcast Upload Extension, effectively a second
app with its own signing and memory limits.

**Before you start, ask Connect for the current capacity numbers.** The box is
**4 vCPU and video recording works on it** — both tests passed on 21 August 2026,
including one with a camera on and a screen share running. What is tight is the
two at once: the recorder alone measured `maxCPU 4.254` on those four cores, so a
screen share *during* a recording sits on the ceiling. That is a real limit and a
measured one, and it is a reason to test the combination early rather than a
reason to doubt the spike.

Those numbers are not written down anywhere in this repository — which is why
this paragraph was wrong for three weeks. Ask Connect, then write down what you
are told.

---

## 6. What is blocked, and on whom

| Blocked | Owner | Why it matters |
|---|---|---|
| Sign-in handoff endpoint | **Core** | Removes the second sign-in; unblocks the web-view architecture |
| Push notifications (server half) | **Core** | Device-token table and a send path. No client can exist without it |
| Connect entitlement on Amit's org | **Amit** | Until `/api/auth/me` returns it, he cannot test Connect on his own login |
| Apple Developer account ($99/yr), Google Play ($25) | **Amit** | In his name; you cannot create them for him |
| Store-sized logo files | **Amit** | Also: `app.json` still carries the OLD green `#0F6E56` for splash and adaptive icon, while the web moved to violet `#6C3CE9` |

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
2. Read `App.js` end to end. It is 400 lines and it is the whole app.
3. Spike screen sharing on Android. Not polished — proven. One meeting, one
   share, one screen. That single result changes more decisions than anything
   else you could do.
4. Tell me what you'd change about the architecture. You will know more about
   React Native than I do by Wednesday, and section 2 is a decision I made
   under a constraint, not a conviction.

Two small things not worth a ticket but worth doing while you are in there:
`SafeAreaView` is deprecated in favour of `react-native-safe-area-context`, and
`api.js` hard-codes `https://core.tatvaos.com` where it should come from
`app.json` so a development build can point elsewhere.

---

## 9. One thing I would ask of you

This app's two real bugs were both invisible. Nothing crashed, nothing logged,
and both presented as something else entirely.

So: when you fix something, leave behind the thing that would have found it —
a log line, a check, a comment naming what the failure looked like from the
outside. Most of what is written down in this repository exists because someone
lost hours to something that could have said what was wrong and did not.

Welcome. Ask me anything, including whether I have got something wrong here.
