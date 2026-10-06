// ============================================================================
//  The engine's core: parsing, operators, references, recalculation, cycles.
//    node --import ./tests/sheets/register.mjs --test tests/sheets/
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, calc, shown } from './harness.ts';

test('operators follow spreadsheet precedence', () => {
  assert.equal(calc('=1+2*3'), 7);
  assert.equal(calc('=(1+2)*3'), 9);
  assert.equal(calc('=-2^2'), 4);          // sign binds tighter than ^, as in Sheets and Excel
  assert.equal(calc('=2^3^2'), 64);        // ^ runs left to right
  assert.equal(calc('=50%'), 0.5);
  assert.equal(calc('=10-2-3'), 5);
  assert.equal(calc('="a"&1&TRUE'), 'a1TRUE');
  assert.equal(calc('=1=1'), true);
  assert.equal(calc('="abc"="ABC"'), true); // text compares without case
  assert.equal(calc('=0.1+0.2=0.3'), true); // floating-point dust is ignored
});

test('errors are values that flow through', () => {
  assert.equal(shown(calc('=1/0')), '#DIV/0!');
  assert.equal(shown(calc('=1+"x"')), '#VALUE!');
  assert.equal(shown(calc('=NOSUCHFN(1)')), '#NAME?');
  assert.equal(shown(calc('=(1/0)+1')), '#DIV/0!');
  assert.equal(shown(calc('=SUM(1,')), '#ERROR!');
  assert.equal(shown(calc('=Nowhere!A1')), '#REF!');
  assert.equal(shown(calc('=IF()')), '#N/A');
});

test('text that reads as a number takes part in arithmetic', () => {
  assert.equal(calc('="15"+1'), 16);
  assert.equal(calc('=A1*2', { A1: '₹1,25,000' }), 250000);
  assert.equal(calc('=A1+0', { A1: '85%' }), 0.85);
});

test('references: relative, absolute, ranges, whole columns, other sheets', () => {
  const wb = book({
    Sheet1: { A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)', B2: '=SUM(A:A)', B3: '=$A$2*10', B4: "='Fee 2026'!A1+Fees!B2" },
    'Fee 2026': { A1: '100' },
    Fees: { B2: '5' },
  });
  assert.equal(wb.get('B1'), 6);
  assert.equal(wb.get('B2'), 6);
  assert.equal(wb.get('B3'), 20);
  assert.equal(wb.get('B4'), 105);
});

test('changing an input recalculates everything downstream, and only that', () => {
  const wb = book({ Sheet1: { A1: '10', A2: '=A1*2', A3: '=A2+1', B1: '=SUM(A1:A3)', C1: '=7' } });
  assert.equal(wb.get('A3'), 21);
  assert.equal(wb.get('B1'), 51);
  assert.equal(wb.get('C1'), 7);
  wb.set('A1', '1');
  assert.equal(wb.get('A2'), 2);
  assert.equal(wb.get('A3'), 3);
  assert.equal(wb.get('B1'), 6);
  // A cell inside a range: the range's reader is recalculated too.
  wb.set('A2', '100');
  assert.equal(wb.get('B1'), 1 + 100 + 101);
});

test('a circular reference is an error, and fixing it clears it', () => {
  const wb = book({ Sheet1: { A1: '=B1', B1: '=A1' } });
  assert.equal(shown(wb.get('A1')), '#REF!');
  assert.equal(shown(wb.get('B1')), '#REF!');
  wb.set('B1', '5');
  assert.equal(wb.get('A1'), 5);
  const self = book({ Sheet1: { A1: '=A1+1' } });
  assert.equal(shown(self.get('A1')), '#REF!');
});

test('a 20,000-row chain calculates without overflowing the stack', () => {
  const cells: Record<string, string> = { A1: '1' };
  for (let i = 2; i <= 20_000; i += 1) cells[`A${i}`] = `=A${i - 1}+1`;
  const wb = book({ Sheet1: cells });
  assert.equal(wb.get('A20000'), 20_000);
  wb.set('A1', '101');
  assert.equal(wb.get('A20000'), 20_100);
});

test('a formula that returns a range asks for one cell instead', () => {
  assert.equal(shown(calc('=A1:A3', { A1: '1' })), '#VALUE!');
  assert.equal(calc('=A1', { A1: '7' }), 7);
});

test('element-wise arithmetic inside SUMPRODUCT', () => {
  const cells = { A1: 'Paid', A2: 'Due', A3: 'Paid', B1: '100', B2: '200', B3: '300' };
  assert.equal(calc('=SUMPRODUCT((A1:A3="Paid")*B1:B3)', cells), 400);
  assert.equal(calc('=SUMPRODUCT(B1:B3,B1:B3)', cells), 140000);
});

test('IF only evaluates the branch it takes', () => {
  assert.equal(calc('=IF(A1=0,0,1/A1)', { A1: '0' }), 0);
  assert.equal(calc('=IFERROR(1/0,"none")'), 'none');
  assert.equal(calc('=IF(FALSE,1)'), false);
});

test('aggregates skip text in ranges but convert direct arguments', () => {
  const cells = { A1: '10', A2: 'x', A3: 'TRUE', A4: '20' };
  assert.equal(calc('=SUM(A1:A4)', cells), 30);
  assert.equal(calc('=SUM("3",TRUE)'), 4);
  assert.equal(calc('=AVERAGE(A1:A4)', cells), 15);
  assert.equal(calc('=COUNT(A1:A4)', cells), 2);
  assert.equal(calc('=COUNTA(A1:A4)', cells), 4);
  assert.equal(shown(calc('=SUM(A1,1/0)', cells)), '#DIV/0!');
});

test('conditional totals', () => {
  const cells = {
    A1: 'Class', A2: '10', A3: '9', A4: '10', A5: '10',
    B1: 'Status', B2: 'Paid', B3: 'Pending', B4: 'Pending', B5: 'Paid',
    C1: 'Fee', C2: '5000', C3: '4000', C4: '5000', C5: '5500',
  };
  assert.equal(calc('=SUMIF(A2:A5,10,C2:C5)', cells), 15500);
  assert.equal(calc('=SUMIF(A2:A5,"10",C2:C5)', cells), 15500);
  assert.equal(calc('=SUMIF(C2:C5,">4500")', cells), 15500);
  assert.equal(calc('=COUNTIF(B2:B5,"Paid")', cells), 2);
  assert.equal(calc('=COUNTIF(B2:B5,"p*")', cells), 4);
  assert.equal(calc('=COUNTIF(B2:B5,"<>Paid")', cells), 2);
  assert.equal(calc('=COUNTIFS(A2:A5,10,B2:B5,"Pending")', cells), 1);
  assert.equal(calc('=SUMIFS(C2:C5,A2:A5,10,B2:B5,"Paid")', cells), 10500);
  // 15 significant digits, as a spreadsheet stores it — not JavaScript's 16.
  assert.equal(calc('=AVERAGEIF(A2:A5,10,C2:C5)', cells), 5166.66666666667);
});

test('rounding matches a spreadsheet, not JavaScript', () => {
  assert.equal(calc('=ROUND(2.675,2)'), 2.68);
  assert.equal(calc('=ROUND(-2.5,0)'), -3);
  assert.equal(calc('=ROUNDUP(1.21,1)'), 1.3);
  assert.equal(calc('=ROUNDDOWN(-1.29,1)'), -1.2);
  assert.equal(calc('=MOD(-3,2)'), 1);
  assert.equal(calc('=CEILING(12.1,5)'), 15);
});
