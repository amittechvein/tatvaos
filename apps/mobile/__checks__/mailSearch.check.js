// Gmail-style search on the phone: the query the form writes, the chips, and
// the one server quirk the phone must route around.
//
// Amit, 24 Sept 2026: "search in mail" — parity with the web's PR 232. The
// grammar is the server's; these hold the client's half.

const { buildSearchQuery, groupValue, mentionsBin, chipsFor, hasOperators, SEARCH_OPERATORS, KNOWN_FIELDS } = require('../lib/mailSearch');

describe('the operator list', () => {
  test('every operator the list offers is one the server knows', () => {
    for (const o of SEARCH_OPERATORS) expect(KNOWN_FIELDS.has(o.op.replace(/:.*$/, ''))).toBe(true);
  });
  test('the unsupported Gmail operators are NOT offered', () => {
    // Offering has:drive and then treating it as a word is how a search box
    // loses trust; the server has no answer for these.
    const ops = SEARCH_OPERATORS.map((o) => o.op);
    for (const bad of ['has:drive', 'category:', 'is:important', 'header:', 'list:']) expect(ops).not.toContain(bad);
  });
  test('no example uses a quoted operator value — the server cannot parse one', () => {
    for (const o of SEARCH_OPERATORS) expect(o.example).not.toMatch(/^[a-z_]+:"/);
  });
});

describe('buildSearchQuery', () => {
  test('writes the query the way the web writes it, free words last, each exclusion its own -', () => {
    expect(buildSearchQuery({
      from: 'priya', subject: 'invoice', where: 'inbox', within: '7d',
      sizeOp: 'larger', sizeVal: '2', sizeUnit: 'M', hasAttachment: true, unreadOnly: true,
      words: 'q3 numbers', without: 'draft holiday',
    })).toBe('from:priya subject:invoice in:inbox newer_than:7d larger:2M has:attachment is:unread q3 numbers -draft -holiday');
  });

  test('A MULTI-WORD VALUE IS GROUPED, NOT QUOTED', () => {
    // subject:"q3 report" finds nothing on the server (MailSearch.cs treats a
    // quoted operator token as free text). subject:(q3 report) works.
    expect(buildSearchQuery({ subject: 'q3 report' })).toBe('subject:(q3 report)');
    expect(buildSearchQuery({ from: 'John Smith' })).toBe('from:(John Smith)');
    expect(groupValue('  one  ')).toBe('one');
    expect(groupValue('')).toBe('');
  });

  test('a non-numeric size is ignored rather than sent as nonsense', () => {
    expect(buildSearchQuery({ sizeVal: 'big' })).toBe('');
    expect(buildSearchQuery({ sizeVal: '10', sizeOp: 'smaller', sizeUnit: 'K' })).toBe('smaller:10K');
  });

  test('an empty form is an empty query', () => {
    expect(buildSearchQuery({})).toBe('');
    expect(buildSearchQuery()).toBe('');
  });
});

describe('mentionsBin', () => {
  test('the words the server looks for', () => {
    for (const q of ['in:trash', 'x in:spam', 'in:anywhere y', 'in:all', 'IN:Junk', '-in:trash']) expect(mentionsBin(q)).toBe(true);
  });
  test('and not otherwise', () => {
    for (const q of ['trash', 'in:inbox', 'subject:trash', '']) expect(mentionsBin(q)).toBe(false);
  });
});

describe('chipsFor', () => {
  test('one chip per known operator, a run of words as one chip', () => {
    expect(chipsFor('from:priya q3 numbers has:attachment')).toEqual([
      { field: 'from', value: 'priya', negated: false },
      { field: null, value: 'q3 numbers', negated: false },
      { field: 'has', value: 'attachment', negated: false },
    ]);
  });
  test('a grouped or quoted value comes back as its words; negation is kept', () => {
    expect(chipsFor('subject:(q3 report) -holiday')).toEqual([
      { field: 'subject', value: 'q3 report', negated: false },
      { field: null, value: 'holiday', negated: true },
    ]);
  });
  test('an unknown operator is plain text, as the server treats it', () => {
    // A field the server has no operator for. (has:drive is a KNOWN field with
    // an unknown value; the server treats that as text too, but the chip
    // splitter, like the web's, only knows fields — same as SearchChips.tsx.)
    expect(chipsFor('foo:bar hello')).toEqual([{ field: null, value: 'foo:bar hello', negated: false }]);
  });
  test('the chips row exists only when there is an operator or an exclusion', () => {
    expect(hasOperators('just words')).toBe(false);
    expect(hasOperators('is:unread')).toBe(true);
    expect(hasOperators('-holiday')).toBe(true);
    expect(chipsFor('')).toEqual([]);
  });
});
