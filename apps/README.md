# apps/ — things that run

Three deployable applications. Each has its own README.

| Folder | What | Runs on |
|---|---|---|
| `web/` | Next.js — desktop web, mobile web and the installable PWA | Browser |
| `mobile/` | Expo / React Native — iOS **and** Android from one codebase | Phones |
| `api/` | ASP.NET Core — the backend everything talks to | Server |

**Three targets, two frontend codebases.** "Mobile web" is not a separate build; it is `web/` rendered responsively. A separate mobile site would mean three UIs to keep in sync forever.

Anything used by both `web/` and `mobile/` belongs in `packages/`, not duplicated here.
