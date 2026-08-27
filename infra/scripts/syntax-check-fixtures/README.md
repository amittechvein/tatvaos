# Fixtures for web-syntax-check

Five deliberately broken (and one deliberately fine) files, one per rule. They
exist so the checker is itself checked: a rule that has quietly stopped firing
is worse than no rule, because it is trusted.

Run them:

    node infra/scripts/web-syntax-check.js infra/scripts/syntax-check-fixtures

Expect **exactly five problems, and `e-clean.tsx` untouched**:

| file | rule | the real incident it stands for |
|---|---|---|
| `a-parse.tsx` | `parse` | 22 Aug — a backtick in a CSS comment. Blocked every deploy on the platform. |
| `b-truncated.tsx` | `css-truncated` | the version of that failure which still compiles, so the deploy goes green with half a stylesheet. |
| `c-hooks.tsx` | `hook-order` | 23 Aug — a `useRef`, a `useState` and a `useEffect` that had drifted below an early return. Three build errors in one file. |
| `d-danger.tsx` | `no-danger` | `react/no-danger` is an error everywhere except `components/mail/SafeHtml.tsx`. |
| `f-unused-import.tsx` | `unused-import` | 26 Aug — `Choice` imported into the share dialog while it was being designed, and still there after the design changed. Caught here, not by a red deploy. |
| `e-clean.tsx` | — | hooks above the early return. Must produce nothing; a rule that fires here is a rule nobody will keep running. |

`f-unused-import.tsx` also mentions the unused name in a comment and in a
string, because a text search would call both a use and be wrong. The rule
counts identifiers from the syntax tree instead.

**These files are not compiled by anything.** They live outside `apps/`, so
Next.js never sees them and `tsc` is never pointed at them. If that ever
changes, they will break the build — which is a fair warning to move them, not
to fix them, because being broken is the whole job.
