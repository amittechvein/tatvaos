//
// The mail search box's chips: which tokens earn one, and what they say.
//
// WHY THIS EXISTS. Amit searched his inbox for the subject line "New sign-in
// to your account" on 23 September 2026 and got FIVE chips - "contains New",
// "contains sign-in", "contains to", "contains your", "contains account" -
// in three rows, ON TOP OF the message list, which was an `absolute` overlay
// hanging off the search box. The first result was behind them.
//
// Two separate faults, both fixed, and this pins both halves of the first:
// a run of plain words is ONE chip, and a query of only words earns no chip
// row at all. (The overlay half is layout - SearchChips.tsx carries it.)
//
// The chip wording is duplicated in `show()` below on purpose: if
// SearchChips.tsx changes how a chip reads, this must be changed to match,
// and the mismatch is the point at which somebody re-reads both.
//
// Usage: bash tests/mail-search-chips/run.sh
//
// The compiled lib/mailSearchTokens.ts — run.sh builds it next to this file.
const { chipsFor, withoutTokens, tokenise } = require('./.built/mailSearchTokens.js');
let pass = 0, fail = 0;
// Mirrors SearchChips.tsx's wording exactly; if that changes, this must.
const show = (c) => `${c.field ? (c.negated ? 'not ' : '') + c.field + ' ' : (c.negated ? 'without ' : 'contains ')}${c.value}`;
function is(what, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`    ok  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}\n          got  ${g}\n          want ${w}`); }
}

console.log('\n  mail search chips\n  =================\n');

// THE SCREENSHOT. Five chips over three rows, covering the message list.
const q1 = 'New sign-in to your account';
is('Amit\'s query is ONE chip, not five',
   chipsFor(q1).map(show), ['contains New sign-in to your account']);
is('...and a query of only words draws NO row at all',
   chipsFor(q1).some((c) => c.field !== null), false);

// Operators still earn their chip - that is the whole point of chips.
is('an operator is confirmed back',
   chipsFor('from:priya is:unread').map(show), ['from priya', 'is unread']);
is('words beside an operator collapse into one chip',
   chipsFor('New sign-in to your account from:priya').map(show),
   ['contains New sign-in to your account', 'from priya']);
is('a row is drawn as soon as one operator is present',
   chipsFor('holiday from:priya').some((c) => c.field !== null), true);

// The typo that used to look understood.
is('an UNKNOWN operator is shown as text, as the server treats it',
   chipsFor('form:priya').map(show), ['contains form:priya']);
is('...while the real one is shown as a field',
   chipsFor('from:priya').map(show), ['from priya']);

// Negation must not be swallowed into a run.
is('a removal stays its own chip',
   chipsFor('-holiday party').map(show), ['without holiday', 'contains party']);

// Quoted phrases stay one token and keep their words.
is('a quoted phrase is one chip',
   chipsFor('subject:"q3 report" urgent').map(show), ['subject "q3 report"', 'contains urgent']);

// Removing a merged chip removes EVERY word it stood for.
is('removing the words chip removes all five words',
   withoutTokens('New sign-in to your account from:priya', chipsFor('New sign-in to your account from:priya')[0].indices),
   'from:priya');
is('removing the operator leaves the words',
   withoutTokens('New sign-in to your account from:priya', chipsFor('New sign-in to your account from:priya')[1].indices),
   'New sign-in to your account');

// A chip must be able to be wrong. If KNOWN_FIELDS ever went empty every
// operator would read as text - this is the shape of that failure.
is('tokenise itself is unchanged (5 tokens in, 5 tokens out)', tokenise(q1).length, 5);

console.log(`\n  =================\n  ${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
