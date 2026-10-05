// ============================================================================
//  Display formats and reading typed input.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue } from '../../apps/web/lib/sheets/engine/format.ts';
import { parseInput } from '../../apps/web/lib/sheets/engine/input.ts';
import { INDIA, type Locale } from '../../apps/web/lib/sheets/engine/types.ts';

const WEST: Locale = { ...INDIA, grouping: 'western', dateOrder: 'mdy', currency: '$' };
const f = (v: number | string, code: string, l = INDIA) => formatValue(v, code, l).text;

test('Indian and western grouping from the same code', () => {
  assert.equal(f(125000, '#,##0'), '1,25,000');
  assert.equal(f(12345678.5, '#,##0.00'), '1,23,45,678.50');
  assert.equal(f(125000, '#,##0', WEST), '125,000');
  assert.equal(f(999, '#,##0'), '999');
  assert.equal(f(-1500, '₹#,##0.00'), '-₹1,500.00');
});

test('scaling commas, percent, scientific, sections', () => {
  assert.equal(f(12345678, '#,##0,,'), '12');
  assert.equal(f(12345678, '0.0,'), '12345.7');
  assert.equal(f(0.853, '0%'), '85%');
  assert.equal(f(0.853, '0.00%'), '85.30%');
  assert.equal(f(123456, '0.00E+00'), '1.23E+05');
  assert.equal(f(-5, '0;(0)'), '(5)');
  assert.equal(f(0, '0;-0;"nil"'), 'nil');
  assert.equal(f(1.005, '0.00'), '1.01');
  assert.equal(f(3.5, '0.##'), '3.5');
  assert.equal(formatValue(-5, '0;[Red]-0', INDIA).color, '#d93025');
});

test('dates and times', () => {
  const d = 46289; // 24 Sep 2026
  assert.equal(f(d, 'dd/mm/yyyy'), '24/09/2026');
  assert.equal(f(d, 'd mmm yyyy'), '24 Sep 2026');
  assert.equal(f(d, 'dddd, d mmmm'), 'Thursday, 24 September');
  assert.equal(f(d + 0.4375, 'dd/mm/yyyy h:mm AM/PM'), '24/09/2026 10:30 AM');
  assert.equal(f(0.75, 'hh:mm'), '18:00');
  assert.equal(f(1.5, '[h]:mm'), '36:00');
});

test('typed input implies a value and a format', () => {
  const p = (s: string) => parseInput(s, INDIA);
  assert.deepEqual([p('₹1,25,000').value, p('₹1,25,000').format], [125000, '₹#,##0']);
  assert.deepEqual([p('85%').value, p('85%').format], [0.85, '0%']);
  assert.deepEqual([p('24/09/2026').value, p('24/09/2026').format], [46289, 'dd/mm/yyyy']);
  assert.equal(p('10:30 AM').value, 0.4375);
  assert.equal(p('(1,500)').value, -1500);
  assert.equal(p("'0012").value, '0012');
  assert.equal(p('1,2,3').value, '1,2,3');       // not a valid grouping: text
  assert.equal(p('31/02/2026').value, '31/02/2026'); // no such date: text
  assert.equal(p('=SUM(A1)').kind, 'formula');
  assert.equal(p('TRUE').value, true);
});
