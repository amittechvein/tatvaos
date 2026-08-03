# packages/ — shared code

Used by **both** `apps/web` and `apps/mobile`. This is where the leverage is.

| Package | Contents | Hand-edited? |
|---|---|---|
| `core/` | ★ Business logic: message threading, MIME parsing, search query parsing, draft state machine, offline sync reconciliation | Yes |
| `api-client/` | Typed HTTP client generated from the API's OpenAPI spec | **No — generated** |
| `types/` | Domain types generated from C# | **No — generated** |
| `validation/` | Zod schemas shared by both apps and the API forms | Yes |
| `ui-tokens/` | Colours, spacing, typography — one source of truth | Yes |
| `i18n/` | Translations. English + Hindi at minimum | Yes |

## Why `core/` matters

Threading, MIME parsing and sync reconciliation are hard, subtle, highly testable, and **identical on every platform**. Write them once, test them hard, never think about them again.

Extract shared logic into `core/` *before* the second client needs it. Doing it early costs two weeks. Doing it late costs a rewrite plus every bug you already fixed once and now get to fix twice.

## What does NOT belong here

Layout and screens. A keyboard-driven desktop inbox and a thumb-driven mobile list are *supposed* to differ. Share the logic, not the layout — expect roughly 60–70% sharing, and be sceptical of anyone promising 90%.
