# apps/web — TatvaOS Mail web client

Next.js. Desktop web, mobile web and the installable PWA from one responsive codebase.

## Run it

**Machine:** Windows PowerShell · **Directory:** `C:\Users\amitd\Downloads\tatvaOS`

```powershell
pnpm install
pnpm web
```

Then http://localhost:3000

## Current state

Runs against **mock data** in `packages/core/src/mock.ts`. The API does not exist
until Phase 1, so the UI was built first and the data source swaps underneath it.
The mock mirrors the seeded local database — same tenants, same addresses — so
switching is a change of source, not of shape.

| Working | Not yet |
|---|---|
| Folder navigation, unread counts | Real data (Phase 1) |
| Message list, read/unread, starring | Sending (Phase 1) |
| Reading pane, attachments | Attachments upload |
| **Sandboxed HTML rendering** | Virtualised list — needed before 50k messages |
| Search across the loaded folder | Server-side search |
| Compose and reply UI | Threading view |
| Responsive three → two → one pane | Admin console |

## The component that matters most

`components/mail/SafeHtml.tsx` renders untrusted email HTML. Every message is
attacker-controlled input sent by strangers. Four independent layers — DOMPurify,
a sandboxed cross-origin iframe with no `allow-scripts`, a strict CSP, and remote
content blocked until asked for.

**Do not weaken the `sandbox` attribute to fix a layout problem.** Read the
comments in that file before changing anything in it.

## Layout

| Folder | Contents |
|---|---|
| `app/` | Routes. File path = URL path |
| `components/ui/` | Generic — Avatar, Icon |
| `components/mail/` | Sidebar, MessageList, MessageView, Composer, SafeHtml |
| `styles/` | `globals.css` and Tailwind config only |
| `lib/`, `hooks/` | Helpers and custom hooks |

Tailwind classes go in the component, not in a separate stylesheet. That is the
framework convention and fighting it buys nothing.
