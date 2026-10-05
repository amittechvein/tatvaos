// ============================================================================
//  Lookup and statistical functions, checked against what Google Sheets shows.
//    node --import ./tests/sheets/register.mjs --test tests/sheets/
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, calc, shown } from './harness.ts';
import type { CellError } from '../../apps/web/lib/sheets/engine/types.ts';

// A grade table sorted by its first column, and a name list, side by side.
const GRADES = {
  A1: '0', B1: 'F',
  A2: '40', B2: 'D',
  A3: '60', B3: 'C',
  A4: '75', B4: 'B',
  A5: '90', B5: 'A',
  D1: 'Rahul Sharma', E1: '100',
  D2: 'Priya Singh', E2: '200',
  D3: 'Amit Das', E3: '300',
};

test('VLOOKUP: approximate on sorted data by default, exact with wildcards on FALSE', () => {
  assert.equal(calc('=VLOOKUP(72,A1:B5,2)', GRADES), 'C');
  assert.equal(calc('=VLOOKUP(90,A1:B5,2)', GRADES), 'A');
  assert.equal(calc('=VLOOKUP(1000,A1:B5,2,TRUE)', GRADES), 'A');
  assert.equal(shown(calc('=VLOOKUP(-1,A1:B5,2)', GRADES)), '#N/A');   // below the first key
  assert.equal(shown(calc('=VLOOKUP(72,A1:B5,2,FALSE)', GRADES)), '#N/A');
  assert.equal(calc('=VLOOKUP(60,A1:B5,2,FALSE)', GRADES), 'C');
  assert.equal(calc('=VLOOKUP("Pri*",D1:E3,2,FALSE)', GRADES), 200);
  assert.equal(calc('=VLOOKUP("?mit*",D1:E3,2,FALSE)', GRADES), 300);
  assert.equal(calc('=VLOOKUP("amit das",D1:E3,2,FALSE)', GRADES), 300); // no regard to case
  assert.equal(calc('=VLOOKUP("Amit Das",D:E,2,FALSE)', GRADES), 300);   // whole columns
  // The number 60 does not find the text "60".
  assert.equal(shown(calc('=VLOOKUP("60",A1:B5,2,FALSE)', GRADES)), '#N/A');
  assert.equal(shown(calc('=VLOOKUP(60,A1:B5,3,FALSE)', GRADES)), '#REF!');
  assert.equal(shown(calc('=VLOOKUP(60,A1:B5,0,FALSE)', GRADES)), '#VALUE!');
  const miss = calc('=VLOOKUP("Zed",D1:E3,2,FALSE)', GRADES) as CellError;
  assert.equal(miss.code, '#N/A');
  assert.equal(miss.message, "Did not find value 'Zed' in VLOOKUP evaluation.");
});

test('HLOOKUP searches the first row', () => {
  const cells = { A1: 'Q1', B1: 'Q2', C1: 'Q3', A2: '10', B2: '20', C2: '30' };
  assert.equal(calc('=HLOOKUP("Q2",A1:C2,2,FALSE)', cells), 20);
  assert.equal(calc('=HLOOKUP("q3",A1:C2,2,FALSE)', cells), 30);
  assert.equal(shown(calc('=HLOOKUP("Q4",A1:C2,2,FALSE)', cells)), '#N/A');
  assert.equal(shown(calc('=HLOOKUP("Q2",A1:C2,3,FALSE)', cells)), '#REF!');
});

const STUDENTS = {
  A1: '101', B1: 'Asha', C1: '5000', D1: '500',
  A2: '102', B2: 'Ravi', C2: '4000', D2: '400',
  A3: '103', B3: 'Asha', C3: '5500', D3: '550',
};

test('XLOOKUP: exact, missing value, nearest, wildcard, from the end, whole row', () => {
  assert.equal(calc('=XLOOKUP(102,A1:A3,B1:B3)', STUDENTS), 'Ravi');
  assert.equal(shown(calc('=XLOOKUP(104,A1:A3,B1:B3)', STUDENTS)), '#N/A');
  assert.equal(calc('=XLOOKUP(104,A1:A3,B1:B3,"none")', STUDENTS), 'none');
  assert.equal(calc('=XLOOKUP(102.5,A1:A3,B1:B3,,-1)', STUDENTS), 'Ravi');
  assert.equal(calc('=XLOOKUP(102.5,A1:A3,C1:C3,,1)', STUDENTS), 5500);
  assert.equal(shown(calc('=XLOOKUP(102.5,A1:A3,B1:B3)', STUDENTS)), '#N/A');
  assert.equal(calc('=XLOOKUP("R*",B1:B3,A1:A3,,2)', STUDENTS), 102);
  // Without match_mode 2, * is an ordinary character.
  assert.equal(shown(calc('=XLOOKUP("R*",B1:B3,A1:A3)', STUDENTS)), '#N/A');
  assert.equal(calc('=XLOOKUP("Asha",B1:B3,C1:C3)', STUDENTS), 5000);
  assert.equal(calc('=XLOOKUP("Asha",B1:B3,C1:C3,,0,-1)', STUDENTS), 5500);
  // A two-column result range gives the whole row, which SUM can total.
  assert.equal(calc('=SUM(XLOOKUP(103,A1:A3,C1:D3))', STUDENTS), 6050);
  // Across a row.
  assert.equal(calc('=XLOOKUP(102,A1:C1,A2:C2)', { A1: '101', B1: '102', C1: '103', A2: 'x', B2: 'y', C2: 'z' }), 'y');
  assert.equal(shown(calc('=XLOOKUP(102,A1:A3,B1:B2)', STUDENTS)), '#VALUE!');
});

test('INDEX: a cell, a whole column or row with 0, and a reference SUM can read', () => {
  const cells = { A1: '1', B1: '2', C1: '3', A2: '4', B2: '5', C2: '6', A3: '7', B3: '8', C3: '9' };
  assert.equal(calc('=INDEX(A1:C3,2,3)', cells), 6);
  assert.equal(calc('=INDEX(A1:C3,3,1)', cells), 7);
  assert.equal(calc('=SUM(INDEX(A1:C3,0,2))', cells), 15);
  assert.equal(calc('=SUM(INDEX(A1:C3,2,0))', cells), 15);
  assert.equal(calc('=INDEX(A1:A3,2)', cells), 4);
  assert.equal(shown(calc('=INDEX(A1:C3,4,1)', cells)), '#REF!');
  assert.equal(shown(calc('=INDEX(A1:C3,1,4)', cells)), '#REF!');
  // INDEX + MATCH, the classic pair.
  assert.equal(calc('=INDEX(B1:B3,MATCH(7,A1:A3,0))', cells), 8);
});

test('INDEX follows a changed input', () => {
  const wb = book({ Sheet1: { A1: '1', A2: '2', B1: '=INDEX(A1:A2,2)' } });
  assert.equal(wb.get('B1'), 2);
  wb.set('A2', '20');
  assert.equal(wb.get('B1'), 20);
});

test('MATCH: sorted up, exact with wildcards, sorted down', () => {
  const cells = {
    A1: '0', A2: '40', A3: '60', A4: '75', A5: '90',
    B1: '90', B2: '75', B3: '60', B4: '40', B5: '0',
    C1: 'apple', C2: 'banana', C3: 'cherry',
  };
  assert.equal(calc('=MATCH(72,A1:A5)', cells), 3);
  assert.equal(calc('=MATCH(75,A1:A5,1)', cells), 4);
  assert.equal(calc('=MATCH(75,A1:A5,0)', cells), 4);
  assert.equal(shown(calc('=MATCH(72,A1:A5,0)', cells)), '#N/A');
  assert.equal(calc('=MATCH(70,B1:B5,-1)', cells), 2);   // smallest value ≥ 70 in descending data
  assert.equal(calc('=MATCH(60,B1:B5,-1)', cells), 3);
  assert.equal(shown(calc('=MATCH(100,B1:B5,-1)', cells)), '#N/A');
  assert.equal(calc('=MATCH("b*",C1:C3,0)', cells), 2);
  assert.equal(calc('=MATCH("CHERRY",C1:C3,0)', cells), 3);
  assert.equal(shown(calc('=MATCH(1,A1:B5,0)', cells)), '#N/A');
});

test('XMATCH: exact by default, nearest when asked', () => {
  const cells = { A1: '0', A2: '40', A3: '60', A4: '75', A5: '90' };
  assert.equal(calc('=XMATCH(75,A1:A5)', cells), 4);
  assert.equal(shown(calc('=XMATCH(70,A1:A5)', cells)), '#N/A');
  assert.equal(calc('=XMATCH(70,A1:A5,-1)', cells), 3);
  assert.equal(calc('=XMATCH(70,A1:A5,1)', cells), 4);
});

test('LOOKUP: the sorted vector form', () => {
  assert.equal(calc('=LOOKUP(72,A1:A5,B1:B5)', GRADES), 'C');
  assert.equal(calc('=LOOKUP(72,A1:B5)', GRADES), 'C');
  assert.equal(shown(calc('=LOOKUP(-5,A1:A5,B1:B5)', GRADES)), '#N/A');
});

test('CHOOSECOLS and CHOOSEROWS, counting from either end', () => {
  const cells = { A1: '1', B1: '2', C1: '3', A2: '4', B2: '5', C2: '6', A3: '7', B3: '8', C3: '9' };
  assert.equal(calc('=SUM(CHOOSECOLS(A1:C3,1,-1))', cells), 30);
  assert.equal(calc('=SUM(CHOOSEROWS(A1:C3,2))', cells), 15);
  assert.equal(calc('=INDEX(CHOOSEROWS(A1:C3,-1),1,2)', cells), 8);
  assert.equal(shown(calc('=CHOOSECOLS(A1:C3,4)', cells)), '#VALUE!');
  assert.equal(shown(calc('=CHOOSEROWS(A1:C3,0)', cells)), '#VALUE!');
});

test('ROW and COLUMN: of a reference, or of the cell itself', () => {
  assert.equal(calc('=ROW()'), 1000);      // calc() puts its formula in Z1000
  assert.equal(calc('=COLUMN()'), 26);
  assert.equal(calc('=ROW(C5)'), 5);
  assert.equal(calc('=COLUMN(C5)'), 3);
  assert.equal(calc('=ROW(B2:D9)'), 2);
  assert.equal(calc('=COLUMN(B2:D9)'), 2);
});

test('ADDRESS: the four modes, R1C1, and a sheet name', () => {
  assert.equal(calc('=ADDRESS(1,1)'), '$A$1');
  assert.equal(calc('=ADDRESS(2,3,2)'), 'C$2');
  assert.equal(calc('=ADDRESS(2,3,3)'), '$C2');
  assert.equal(calc('=ADDRESS(2,3,4)'), 'C2');
  assert.equal(calc('=ADDRESS(1,27)'), '$AA$1');
  assert.equal(calc('=ADDRESS(2,3,1,FALSE)'), 'R2C3');
  assert.equal(calc('=ADDRESS(2,3,4,FALSE)'), 'R[2]C[3]');
  assert.equal(calc('=ADDRESS(1,1,1,TRUE,"Sheet2")'), 'Sheet2!$A$1');
  assert.equal(calc('=ADDRESS(1,1,1,TRUE,"Fee 2026")'), "'Fee 2026'!$A$1");
  assert.equal(shown(calc('=ADDRESS(0,1)')), '#VALUE!');
});

// The textbook set: mean 5, population standard deviation 2.
const DATA = { A1: '2', A2: '4', A3: '4', A4: '4', A5: '5', A6: '5', A7: '7', A8: '9', A9: 'n/a' };

test('MEDIAN and MODE', () => {
  assert.equal(calc('=MEDIAN(A1:A9)', DATA), 4.5);
  assert.equal(calc('=MEDIAN(3,1,2)'), 2);
  assert.equal(calc('=MODE(A1:A9)', DATA), 4);
  assert.equal(calc('=MODE.SNGL(1,2,2,3,3)'), 2);        // a tie goes to the first seen
  assert.equal(shown(calc('=MODE(1,2,3)')), '#N/A');
});

test('STDEV and VAR, sample and population', () => {
  assert.equal(calc('=STDEVP(A1:A9)', DATA), 2);
  assert.equal(calc('=STDEV.P(A1:A9)', DATA), 2);
  assert.equal(calc('=VARP(A1:A9)', DATA), 4);
  assert.equal(calc('=VAR.P(A1:A9)', DATA), 4);
  assert.equal(calc('=VAR(A1:A9)', DATA), 4.57142857142857);      // 32 / 7
  assert.equal(calc('=VAR.S(A1:A9)', DATA), 4.57142857142857);
  assert.equal(calc('=STDEV(A1:A9)', DATA), 2.13808993529940);
  assert.equal(calc('=STDEV.S(A1:A9)', DATA), 2.13808993529940);
  assert.equal(shown(calc('=STDEV(5)')), '#DIV/0!');                // a sample needs two numbers
  assert.equal(shown(calc('=VAR(5)')), '#DIV/0!');
  assert.equal(calc('=STDEVP(5)'), 0);
});

test('RANK: ties share a position; RANK.AVG averages them', () => {
  assert.equal(calc('=RANK(9,A1:A9)', DATA), 1);
  assert.equal(calc('=RANK(4,A1:A9)', DATA), 5);          // 5, 5, 7, 9 are above it
  assert.equal(calc('=RANK.EQ(4,A1:A9)', DATA), 5);
  assert.equal(calc('=RANK(4,A1:A9,1)', DATA), 2);        // ascending: only 2 is below
  assert.equal(calc('=RANK.AVG(4,A1:A9)', DATA), 6);      // the three 4s fill positions 5, 6, 7
  assert.equal(calc('=RANK.AVG(5,A1:A9)', DATA), 3.5);
  assert.equal(shown(calc('=RANK(3,A1:A9)', DATA)), '#N/A');
});

test('PERCENTILE and QUARTILE interpolate between numbers', () => {
  assert.equal(calc('=PERCENTILE({1,2,3,4},0.3)'), 1.9);
  assert.equal(calc('=PERCENTILE.INC(A1:A9,0.5)', DATA), 4.5);
  assert.equal(calc('=PERCENTILE(A1:A9,0)', DATA), 2);
  assert.equal(calc('=PERCENTILE(A1:A9,1)', DATA), 9);
  assert.equal(shown(calc('=PERCENTILE(A1:A9,1.5)', DATA)), '#NUM!');
  assert.equal(calc('=QUARTILE({1,2,3,4,5,6,7,8},1)'), 2.75);
  assert.equal(calc('=QUARTILE.INC({1,2,3,4,5,6,7,8},3)'), 6.25);
  assert.equal(calc('=QUARTILE(A1:A9,2)', DATA), 4.5);
  assert.equal(shown(calc('=QUARTILE(A1:A9,5)', DATA)), '#NUM!');
});

test('LARGE and SMALL', () => {
  assert.equal(calc('=LARGE(A1:A9,1)', DATA), 9);
  assert.equal(calc('=LARGE(A1:A9,2)', DATA), 7);
  assert.equal(calc('=SMALL(A1:A9,2)', DATA), 4);
  assert.equal(shown(calc('=LARGE(A1:A9,9)', DATA)), '#NUM!');
  assert.equal(shown(calc('=SMALL(A1:A9,0)', DATA)), '#NUM!');
});

test('AVERAGEA, MAXA, MINA count text in ranges as 0 and TRUE as 1', () => {
  const cells = { A1: '10', A2: 'x', A3: 'TRUE', B1: '-5', B2: 'x' };
  assert.equal(calc('=AVERAGEA(A1:A4)', cells), 3.66666666666667);  // (10 + 0 + 1) / 3, empty skipped
  assert.equal(calc('=AVERAGE(A1:A4)', cells), 10);
  assert.equal(calc('=MAXA(B1:B2)', cells), 0);
  assert.equal(calc('=MINA(A1:A3)', cells), 0);
  assert.equal(shown(calc('=AVERAGEA(C1:C3)')), '#DIV/0!');
});

test('CORREL, SLOPE, INTERCEPT, FORECAST fit a straight line', () => {
  const cells = {
    A1: '1', A2: '2', A3: '3', A4: '4', A5: '5',
    B1: '2', B2: '4', B3: '5', B4: '4', B5: '5',
    C1: '3', C2: '3', C3: '3', C4: '3', C5: '3',
  };
  assert.equal(calc('=SLOPE(B1:B5,A1:A5)', cells), 0.6);
  assert.equal(calc('=INTERCEPT(B1:B5,A1:A5)', cells), 2.2);
  assert.equal(calc('=FORECAST(6,B1:B5,A1:A5)', cells), 5.8);
  assert.equal(calc('=FORECAST.LINEAR(6,B1:B5,A1:A5)', cells), 5.8);
  assert.equal(calc('=CORREL(B1:B5,A1:A5)', cells), 0.774596669241483);   // 6 / √60
  assert.equal(calc('=CORREL(A1:A5,A1:A5)', cells), 1);
  assert.equal(shown(calc('=SLOPE(B1:B5,C1:C5)', cells)), '#DIV/0!');    // x never changes
  assert.equal(shown(calc('=CORREL(B1:B5,A1:A4)', cells)), '#N/A');
});
