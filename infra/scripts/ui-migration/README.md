# UI migration tooling — stage 3 and stage 4 of `docs/UI_LANE_BRIEF.md`

Run every script from `apps/web`. None of them changes anything unless told to.

| Script | What it answers |
|---|---|
| `class-inventory.cjs <outDir>` | Which class names the web app uses, sorted into Tailwind-only, Bootstrap-only, YZEN-only, **both** (the same name in both frameworks), icon-font or unknown. It asks Tailwind and the two YZEN stylesheets themselves, not a hand-written list. Writes `summary.txt` and `files.json`. |
| `decls.cjs <outDir>` | The real CSS declarations behind every legacy and colliding class, from Bootstrap, YZEN and Tailwind side by side. This is the evidence behind every mapping in the codemod. |
| `codemod-utilities.cjs --dry\|--write <files…>` | Rewrites Bootstrap/YZEN **utility** classes into the Tailwind class that renders the same value, and reports the component classes it left (btn, form-*, card, badge, alert, row/col…). |
| `check-generated.cjs` | Every `!`-prefixed class added in the working tree makes Tailwind emit an `!important` rule. A class Tailwind does not recognise is dropped silently. |
| `codemod-unimportant.cjs --dry\|--write <files…>` | Stage 4's second pass: strips the temporary `!` and folds pinned values back onto the scale (`!mb-[1rem]` → `mb-4`). Only inside `className` contexts, only tokens that look like utilities, and it **refuses a file** if anything outside a string literal would change. |
| `snapshot.js` | In the browser: `tvSnap('save')` before a change, `tvSnap('compare')` after. Lists every element whose computed style moved. |

## Why the output is full of `!`

Every Bootstrap utility is `!important`, and YZEN's stylesheet loads after
Tailwind's. A plain `flex` in place of `d-flex` can lose to a YZEN rule that
`d-flex` used to beat. So each replacement keeps the `!important`
(`!flex`). Where the two frameworks share a name with different values, the
replacement keeps the value that renders **today** (`mb-3` → `!mb-[1rem]`,
because Bootstrap's `mb-3` is 1rem and it wins).

That is deliberate and temporary. When stage 4 deletes `styles/yzen/`, nothing
is left to fight, and a second mechanical pass removes the `!` and folds the
arbitrary values back onto Tailwind's scale (`!mb-[1rem]` → `mb-4`).

## The two failures this tooling has already caught

1. `[display:grid]` with `!` put after the colon inside the brackets is not a
   class. Tailwind turned it into invalid CSS and **every page** returned 500.
   `check-generated.cjs` exists for that class of mistake.
2. `rounded-pill` was mapped to `rounded-full`. That is 9999px; Bootstrap's pill
   is 50rem. Invisible on a badge, and still not "the same". `snapshot.js`
   found it.

A dev server keeps every class it has ever generated until it restarts. After
fixing a bad class, restart it (and delete `apps/web/.next`), or the old
broken rule stays in the stylesheet and the page stays broken.

## The third failure, from the second pass

The first `codemod-unimportant` scanned every string literal in a file. A
backtick inside a **comment** opened a fake template literal that ran to the
next backtick, and every `!` in the code between them was treated as a class
prefix: `meeting !== null` → `meeting == null`, `!over` → `over`, across 35
files. Typecheck caught three of the changes. The files were reverted from git
and the script rewritten with the guard it now has: with all string literals
blanked, the file must be byte-identical before and after, or nothing is
written. **A codemod that edits source needs that guard from its first run**,
not after it has proven the point.
