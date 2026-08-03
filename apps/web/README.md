# apps/web — Next.js

Desktop web, mobile web and the installable PWA. One responsive codebase.

## Layout

| Folder | Contents |
|---|---|
| `app/` | Routes and pages (App Router). File path = URL path |
| `components/ui/` | Generic building blocks — buttons, inputs, dialogs |
| `components/mail/` | Mail-specific — message list, thread view, composer |
| `components/admin/` | Admin console |
| `styles/` | `globals.css` and Tailwind config. **Only** file-level CSS lives here |
| `lib/` | Helpers, API setup, formatting |
| `hooks/` | Custom React hooks |
| `public/` | Static assets served as-is — `images/`, `fonts/`, `icons/` |

## Where styling lives

Tailwind classes go **in the component**, not in a separate stylesheet. `styles/` holds `globals.css` and theme config only. This is the framework's convention and fighting it creates work with no benefit.

## Non-negotiables here

- **Virtualise every long list** (TanStack Virtual). A 50,000-message folder must scroll at 60fps.
- **Render untrusted email HTML in a sandboxed iframe on a separate origin**, with DOMPurify and a strict CSP, remote images blocked by default. This is the highest-severity attack surface in the whole product — every message is attacker-controlled HTML sent by strangers.
