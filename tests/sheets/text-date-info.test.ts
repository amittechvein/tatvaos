// ============================================================================
//  Text, date and info functions.
//    node --import ./tests/sheets/register.mjs --test tests/sheets/
//
//  The harness clock is 24 September 2026, 10:30 local; the workbook locale
//  is India (dd/mm/yyyy, 1,25,000). 24 Sep 2026 is serial 46289, a Thursday.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, calc, shown } from './harness.ts';

const SEP24 = 46289;

/** Any error at all — for cases where the value is certain but Sheets' exact code is not. */
const isErr = (v: unknown) => typeof v === 'string' && v.startsWith('#');

// ---------------------------------------------------------------------------
//  Text
// ---------------------------------------------------------------------------

test('joining text: CONCATENATE, CONCAT, TEXTJOIN', () => {
  assert.equal(calc('=CONCATENATE("Class ",10,"-",TRUE)'), 'Class 10-TRUE');
  assert.equal(calc('=CONCATENATE(A1:A3)', { A1: 'a', A2: 'b', A3: 'c' }), 'abc');
  assert.equal(calc('=CONCAT("Rs ",500)'), 'Rs 500');
  assert.equal(shown(calc('=CONCATENATE("a",1/0)')), '#DIV/0!');
  const cells = { A1: 'Ravi', A3: 'Meena', A4: 'Arjun' };
  assert.equal(calc('=TEXTJOIN(", ",TRUE,A1:A4)', cells), 'Ravi, Meena, Arjun');
  assert.equal(calc('=TEXTJOIN("-",FALSE,A1:A3)', cells), 'Ravi--Meena');
  assert.equal(shown(calc('=TEXTJOIN(",",TRUE,"a",NA())')), '#N/A');
});

test('cutting text: LEFT, RIGHT, MID, LEN', () => {
  assert.equal(calc('=LEFT("TatvaOS",5)'), 'Tatva');
  assert.equal(calc('=LEFT("TatvaOS")'), 'T');
  assert.equal(calc('=RIGHT("TatvaOS",2)'), 'OS');
  assert.equal(calc('=RIGHT("ab",5)'), 'ab');
  assert.equal(calc('=MID("abcdef",2,3)'), 'bcd');
  assert.equal(calc('=MID("abc",10,2)'), '');
  assert.equal(calc('=LEFT(12345,2)'), '12');
  assert.equal(calc('=LEN("नमस्ते")'), 6);
  assert.equal(calc('=LEN(A1)'), 0);
  assert.equal(shown(calc('=LEFT("abc",-1)')), '#VALUE!');
  assert.equal(shown(calc('=RIGHT("abc",-1)')), '#VALUE!');
  assert.equal(shown(calc('=MID("abc",0,1)')), '#VALUE!');
  assert.equal(shown(calc('=MID("abc",1,-1)')), '#VALUE!');
  assert.equal(shown(calc('=LEN(1/0)')), '#DIV/0!');
});

test('case and spacing: LOWER, UPPER, PROPER, TRIM, CLEAN', () => {
  assert.equal(calc('=LOWER("TatvaOS")'), 'tatvaos');
  assert.equal(calc('=UPPER("TatvaOS")'), 'TATVAOS');
  assert.equal(calc('=PROPER("ravi KUMAR sharma")'), 'Ravi Kumar Sharma');
  assert.equal(calc('=PROPER("o\'neil")'), "O'Neil");
  assert.equal(calc('=TRIM("   Ravi    Kumar  ")'), 'Ravi Kumar');
  assert.equal(calc('=CLEAN(CHAR(9)&"Fee"&CHAR(10))'), 'Fee');
  assert.equal(shown(calc('=UPPER(NA())')), '#N/A');
  assert.equal(shown(calc('=TRIM(1/0)')), '#DIV/0!');
});

test('replacing: SUBSTITUTE, REPLACE', () => {
  assert.equal(calc('=SUBSTITUTE("2026-09-24","-","/")'), '2026/09/24');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+",5)'), 'a-b-c');
  assert.equal(calc('=SUBSTITUTE("abc","","x")'), 'abc');
  assert.equal(shown(calc('=SUBSTITUTE("a-b","-","+",0)')), '#VALUE!');
  assert.equal(calc('=REPLACE("abcdef",2,3,"X")'), 'aXef');
  assert.equal(calc('=REPLACE("abc",10,1,"Z")'), 'abcZ');
  assert.equal(shown(calc('=REPLACE("abc",0,1,"Z")')), '#VALUE!');
});

test('finding: FIND matches case, SEARCH ignores it and takes wildcards', () => {
  assert.equal(calc('=FIND("O","TatvaOS")'), 6);
  assert.equal(calc('=FIND("a","TatvaOS",3)'), 5);
  assert.equal(shown(calc('=FIND("o","TatvaOS")')), '#VALUE!');
  assert.equal(shown(calc('=FIND("a","abc",0)')), '#VALUE!');
  assert.equal(calc('=SEARCH("o","TatvaOS")'), 6);
  assert.equal(calc('=SEARCH("v?o","TatvaOS")'), 4);
  assert.equal(calc('=SEARCH("t*s","TatvaOS")'), 1);
  assert.equal(calc('=SEARCH("~*","a*b")'), 2);
  assert.equal(calc('=SEARCH("a","banana",3)'), 4);
  assert.equal(shown(calc('=SEARCH("z","abc")')), '#VALUE!');
});

test('TEXT formats with the workbook locale', () => {
  assert.equal(calc('=TEXT(125000,"#,##0")'), '1,25,000');
  assert.equal(calc('=TEXT(1234.5,"#,##0.00")'), '1,234.50');
  assert.equal(calc('=TEXT(DATE(2026,9,24),"dd/mm/yyyy")'), '24/09/2026');
  assert.equal(calc('=TEXT(DATE(2026,9,24),"dddd")'), 'Thursday');
  assert.equal(calc('=TEXT(DATE(2026,9,24),"mmm yyyy")'), 'Sep 2026');
  assert.equal(calc('=TEXT(0.256,"0.0%")'), '25.6%');
  assert.equal(calc('=TEXT(7,"000")'), '007');
  assert.equal(calc('=TEXT(TIME(14,5,0),"h:mm AM/PM")'), '2:05 PM');
  assert.equal(calc('=TEXT("125000","#,##0")'), '1,25,000');
  assert.equal(shown(calc('=TEXT(1/0,"0")')), '#DIV/0!');
});

test('numbers from text and text from numbers: VALUE, FIXED, DOLLAR, T', () => {
  assert.equal(calc('=VALUE("1,25,000")'), 125000);
  assert.equal(calc('=VALUE("₹1,500")'), 1500);
  assert.equal(calc('=VALUE("85%")'), 0.85);
  assert.equal(calc('=VALUE("24/09/2026")'), SEP24);
  assert.equal(shown(calc('=VALUE("abc")')), '#VALUE!');
  assert.equal(calc('=FIXED(1234567.891)'), '12,34,567.89');
  assert.equal(calc('=FIXED(1234.567,1,TRUE)'), '1234.6');
  assert.equal(calc('=FIXED(1234.5,-2)'), '1,200');
  assert.equal(shown(calc('=FIXED("x")')), '#VALUE!');
  assert.equal(calc('=DOLLAR(125000)'), '₹1,25,000.00');
  assert.equal(calc('=DOLLAR(99.5,0)'), '₹100');
  assert.equal(shown(calc('=DOLLAR("x")')), '#VALUE!');
  assert.equal(calc('=T("Paid")'), 'Paid');
  assert.equal(calc('=T(15)'), '');
  assert.equal(shown(calc('=T(NA())')), '#N/A');
});

test('REPT, EXACT, CHAR, CODE, UNICHAR, UNICODE', () => {
  assert.equal(calc('=REPT("ab",3)'), 'ababab');
  assert.equal(calc('=REPT("*",0)'), '');
  assert.equal(shown(calc('=REPT("a",-1)')), '#VALUE!');
  assert.equal(calc('=EXACT("Paid","Paid")'), true);
  assert.equal(calc('=EXACT("Paid","paid")'), false);
  assert.equal(shown(calc('=EXACT(1/0,"a")')), '#DIV/0!');
  assert.equal(calc('=CHAR(65)'), 'A');
  assert.equal(shown(calc('=CHAR(0)')), '#VALUE!');
  assert.equal(calc('=CODE("Apple")'), 65);
  assert.equal(shown(calc('=CODE("")')), '#VALUE!');
  assert.equal(calc('=UNICHAR(8377)'), '₹');
  assert.equal(shown(calc('=UNICHAR(-1)')), '#VALUE!');
  assert.equal(calc('=UNICODE("₹")'), 8377);
  assert.equal(shown(calc('=UNICODE("")')), '#VALUE!');
});

test('REGEXMATCH, REGEXEXTRACT, REGEXREPLACE', () => {
  assert.equal(calc('=REGEXMATCH("Paid on 24/09","\\d{2}/\\d{2}")'), true);
  assert.equal(calc('=REGEXMATCH("Pending","^Paid")'), false);
  assert.equal(calc('=REGEXMATCH("PAID","(?i)paid")'), true);
  assert.equal(shown(calc('=REGEXMATCH(123,"1")')), '#VALUE!');
  assert.equal(calc('=REGEXEXTRACT("Roll no 42, class 10","\\d+")'), '42');
  assert.equal(calc('=REGEXEXTRACT("ravi@school.in","@(.+)$")'), 'school.in');
  assert.equal(shown(calc('=REGEXEXTRACT("abc","\\d")')), '#N/A');
  assert.equal(calc('=REGEXREPLACE("a1b22c333","\\d+","#")'), 'a#b#c#');
  assert.equal(calc('=REGEXREPLACE("Kumar, Ravi","(\\w+), (\\w+)","$2 $1")'), 'Ravi Kumar');
  // Sheets rejects a broken pattern; the exact code is not asserted.
  assert.ok(isErr(shown(calc('=REGEXMATCH("a","(")'))));
});

// ---------------------------------------------------------------------------
//  Dates
// ---------------------------------------------------------------------------

test('TODAY and NOW read the injected clock', () => {
  assert.equal(calc('=TODAY()'), SEP24);
  assert.equal(calc('=NOW()'), SEP24 + 10.5 / 24);
  assert.equal(calc('=HOUR(NOW())'), 10);
  assert.equal(calc('=MINUTE(NOW())'), 30);
  assert.equal(calc('=SECOND(NOW())'), 0);
});

test('TODAY and NOW are recalculated when the clock moves', () => {
  // The harness hands this same Date to the engine's clock, so moving it moves "now".
  const now = new Date(2026, 8, 24, 10, 30);
  const wb = book({ Sheet1: { A1: '=TODAY()', A2: '=A1+1' } }, now);
  assert.equal(wb.get('A2'), SEP24 + 1);
  now.setDate(25);
  wb.engine.tickVolatile();
  assert.equal(wb.get('A1'), SEP24 + 1);
  assert.equal(wb.get('A2'), SEP24 + 2);
});

test('DATE and TIME carry over, as in Sheets', () => {
  assert.equal(calc('=DATE(2026,9,24)'), SEP24);
  assert.equal(calc('=DATE(2026,13,1)'), calc('=DATE(2027,1,1)'));
  assert.equal(calc('=DATE(2026,9,0)'), calc('=DATE(2026,8,31)'));
  assert.equal(calc('=DATE(2026,3,-1)'), calc('=DATE(2026,2,27)'));
  assert.equal(calc('=DATE(26,1,1)'), calc('=DATE(1926,1,1)'));
  assert.equal(shown(calc('=DATE("x",1,1)')), '#VALUE!');
  assert.equal(shown(calc('=DATE(-1,1,1)')), '#NUM!');
  assert.equal(calc('=TIME(10,30,0)'), 0.4375);
  assert.equal(calc('=TIME(0,90,0)'), 0.0625);
  assert.equal(calc('=TIME(25,0,0)'), 1 / 24);
  assert.equal(shown(calc('=TIME(-1,0,0)')), '#NUM!');
});

test('parts of a date and time: DAY, MONTH, YEAR, HOUR, MINUTE, SECOND', () => {
  const cells = { A1: '24/09/2026', A2: '24/09/2026 14:05:09' };
  assert.equal(calc('=DAY(A1)', cells), 24);
  assert.equal(calc('=MONTH(A1)', cells), 9);
  assert.equal(calc('=YEAR(A1)', cells), 2026);
  assert.equal(calc('=YEAR("24/09/2026")'), 2026);
  assert.equal(calc('=HOUR(A2)', cells), 14);
  assert.equal(calc('=MINUTE(A2)', cells), 5);
  assert.equal(calc('=SECOND(A2)', cells), 9);
  assert.equal(calc('=HOUR(0.75)'), 18);
  assert.equal(shown(calc('=DAY(-1)')), '#NUM!');
  assert.equal(shown(calc('=MONTH("soon")')), '#VALUE!');
  assert.equal(shown(calc('=HOUR(-0.5)')), '#NUM!');
});

test('WEEKDAY, WEEKNUM, ISOWEEKNUM', () => {
  assert.equal(calc('=WEEKDAY(DATE(2026,9,24))'), 5);    // Thursday, Sunday = 1
  assert.equal(calc('=WEEKDAY(DATE(2026,9,24),2)'), 4);  // Monday = 1
  assert.equal(calc('=WEEKDAY(DATE(2026,9,24),3)'), 3);  // Monday = 0
  assert.equal(calc('=WEEKDAY(DATE(2026,9,27))'), 1);    // Sunday
  assert.equal(shown(calc('=WEEKDAY(DATE(2026,9,24),9)')), '#NUM!');
  assert.equal(calc('=WEEKNUM(DATE(2026,1,1))'), 1);
  assert.equal(calc('=WEEKNUM(DATE(2026,1,4))'), 2);     // 1 Jan 2026 is a Thursday; the 4th a Sunday
  assert.equal(calc('=WEEKNUM(DATE(2026,1,4),2)'), 1);   // weeks from Monday: still week 1
  assert.equal(calc('=WEEKNUM(DATE(2026,9,24))'), 39);
  assert.equal(shown(calc('=WEEKNUM(DATE(2026,1,1),5)')), '#NUM!');
  assert.equal(calc('=ISOWEEKNUM(DATE(2026,9,24))'), 39);
  assert.equal(calc('=ISOWEEKNUM(DATE(2027,1,1))'), 53);
  assert.equal(calc('=ISOWEEKNUM(DATE(2025,12,29))'), 1);
  assert.equal(shown(calc('=ISOWEEKNUM("x")')), '#VALUE!');
});

test('EDATE and EOMONTH keep to the end of shorter months', () => {
  assert.equal(calc('=EDATE(DATE(2026,1,31),1)'), calc('=DATE(2026,2,28)'));
  assert.equal(calc('=EDATE(DATE(2026,9,24),-9)'), calc('=DATE(2025,12,24)'));
  assert.equal(calc('=EDATE(DATE(2024,1,31),1)'), calc('=DATE(2024,2,29)'));
  assert.equal(shown(calc('=EDATE("x",1)')), '#VALUE!');
  assert.equal(calc('=EOMONTH(DATE(2026,9,24),0)'), calc('=DATE(2026,9,30)'));
  assert.equal(calc('=EOMONTH(DATE(2026,9,24),-1)'), calc('=DATE(2026,8,31)'));
  assert.equal(calc('=EOMONTH(DATE(2026,1,15),1)'), calc('=DATE(2026,2,28)'));
  assert.equal(shown(calc('=EOMONTH(DATE(1900,1,1),-2)')), '#NUM!');
});

test('DATEDIF: a student\'s age and the parts of it', () => {
  const cells = { A1: '15/05/2000', A2: '24/09/2026' };
  assert.equal(calc('=DATEDIF(A1,A2,"Y")', cells), 26);
  assert.equal(calc('=DATEDIF(A1,A2,"M")', cells), 316);
  assert.equal(calc('=DATEDIF(A1,A2,"YM")', cells), 4);
  assert.equal(calc('=DATEDIF(A1,A2,"MD")', cells), 9);
  assert.equal(calc('=DATEDIF(A1,A2,"YD")', cells), 132);
  assert.equal(calc('=DATEDIF(A1,A2,"D")', cells), calc('=A2-A1', cells));
  assert.equal(calc('=DATEDIF(DATE(2026,1,31),DATE(2026,2,28),"M")'), 0);
  assert.equal(shown(calc('=DATEDIF(A2,A1,"Y")', cells)), '#NUM!');
  assert.equal(shown(calc('=DATEDIF(A1,A2,"W")', cells)), '#NUM!');
});

test('DAYS and DAYS360', () => {
  assert.equal(calc('=DAYS(DATE(2026,9,24),DATE(2026,1,1))'), 266);
  assert.equal(calc('=DAYS("24/09/2026","23/09/2026")'), 1);
  assert.equal(calc('=DAYS(DATE(2026,1,1),DATE(2026,9,24))'), -266);
  assert.equal(shown(calc('=DAYS("x",1)')), '#VALUE!');
  assert.equal(calc('=DAYS360(DATE(2026,1,1),DATE(2026,12,31))'), 360);
  assert.equal(calc('=DAYS360(DATE(2026,1,30),DATE(2026,3,31))'), 60);
  assert.equal(calc('=DAYS360(DATE(2026,1,1),DATE(2026,12,31),TRUE)'), 359);
  assert.equal(shown(calc('=DAYS360("x",1)')), '#VALUE!');
});

test('NETWORKDAYS and WORKDAY skip weekends and holidays', () => {
  const hol = { A1: '02/10/2026', A2: '25/09/2026' };  // Gandhi Jayanti; a school holiday
  assert.equal(calc('=NETWORKDAYS(DATE(2026,9,21),DATE(2026,9,27))'), 5);
  assert.equal(calc('=NETWORKDAYS(DATE(2026,9,28),DATE(2026,10,4),A1)', hol), 4);
  assert.equal(calc('=NETWORKDAYS(DATE(2026,9,1),DATE(2026,9,30))'), 22);
  assert.equal(calc('=NETWORKDAYS(DATE(2026,9,27),DATE(2026,9,21))'), -5);
  assert.equal(shown(calc('=NETWORKDAYS("x",DATE(2026,9,21))')), '#VALUE!');
  assert.equal(calc('=NETWORKDAYS.INTL(DATE(2026,9,21),DATE(2026,9,27),11)'), 6);
  assert.equal(calc('=NETWORKDAYS.INTL(DATE(2026,9,21),DATE(2026,9,27),"0000001")'), 6);
  assert.equal(shown(calc('=NETWORKDAYS.INTL(DATE(2026,9,21),DATE(2026,9,27),9)')), '#NUM!');
  assert.equal(calc('=WORKDAY(DATE(2026,9,24),2)'), calc('=DATE(2026,9,28)'));
  assert.equal(calc('=WORKDAY(DATE(2026,9,24),2,A1:A2)', hol), calc('=DATE(2026,9,29)'));
  assert.equal(calc('=WORKDAY(DATE(2026,9,28),-1)'), calc('=DATE(2026,9,25)'));
  assert.equal(calc('=WORKDAY(DATE(2026,9,24),0)'), SEP24);
  assert.equal(calc('=WORKDAY.INTL(DATE(2026,9,26),1,11)'), calc('=DATE(2026,9,28)'));
  assert.equal(shown(calc('=WORKDAY("x",2)')), '#VALUE!');
});

test('DATEVALUE and TIMEVALUE read text in the workbook locale', () => {
  assert.equal(calc('=DATEVALUE("24/09/2026")'), SEP24);
  assert.equal(calc('=DATEVALUE("2026-09-24")'), SEP24);
  assert.equal(calc('=DATEVALUE("24 Sep 2026")'), SEP24);
  assert.equal(calc('=DATEVALUE("24/09/2026 10:30")'), SEP24);
  assert.equal(shown(calc('=DATEVALUE("31/02/2026")')), '#VALUE!');
  assert.equal(shown(calc('=DATEVALUE("hello")')), '#VALUE!');
  assert.equal(calc('=TIMEVALUE("10:30 AM")'), 0.4375);
  assert.equal(calc('=TIMEVALUE("18:00")'), 0.75);
  assert.equal(calc('=TIMEVALUE("24/09/2026 06:00")'), 0.25);
  assert.equal(shown(calc('=TIMEVALUE("abc")')), '#VALUE!');
});

test('YEARFRAC for day counts 0 and 1', () => {
  assert.equal(calc('=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1))'), 0.5);
  assert.equal(calc('=YEARFRAC(DATE(2026,7,1),DATE(2026,1,1))'), 0.5);
  const actual = calc('=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),1)') as number;
  assert.ok(Math.abs(actual - 181 / 365) < 1e-12);
  const leap = calc('=YEARFRAC(DATE(2024,1,1),DATE(2024,12,31),1)') as number;
  assert.ok(Math.abs(leap - 365 / 366) < 1e-12);
  assert.equal(calc('=YEARFRAC(DATE(2026,1,1),DATE(2027,1,1),3)'), 1);
  assert.equal(shown(calc('=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),5)')), '#NUM!');
  assert.equal(shown(calc('=YEARFRAC("x",1)')), '#VALUE!');
});

// ---------------------------------------------------------------------------
//  Info
// ---------------------------------------------------------------------------

test('ISBLANK: an empty cell is blank; a formula showing "" is not', () => {
  const cells = { A2: '=""', A3: '0' };
  assert.equal(calc('=ISBLANK(A1)', cells), true);
  assert.equal(calc('=ISBLANK(A2)', cells), false);
  assert.equal(calc('=ISBLANK(A3)', cells), false);
  assert.equal(calc('=ISBLANK("")'), false);
});

test('type checks: ISNUMBER, ISTEXT, ISNONTEXT, ISLOGICAL', () => {
  const cells = { A1: '24/09/2026', A2: 'Paid', A3: 'TRUE', A4: '₹1,500' };
  assert.equal(calc('=ISNUMBER(A1)', cells), true);   // a date is a number
  assert.equal(calc('=ISNUMBER(A4)', cells), true);
  assert.equal(calc('=ISNUMBER(A2)', cells), false);
  assert.equal(calc('=ISNUMBER("15")'), false);       // text, even if it looks like a number
  assert.equal(calc('=ISTEXT(A2)', cells), true);
  assert.equal(calc('=ISTEXT(A5)', cells), false);
  assert.equal(calc('=ISNONTEXT(A5)', cells), true);  // empty is not text
  assert.equal(calc('=ISNONTEXT(A2)', cells), false);
  assert.equal(calc('=ISLOGICAL(A3)', cells), true);
  assert.equal(calc('=ISLOGICAL("TRUE")'), false);
  assert.equal(calc('=ISNUMBER(1/0)'), false);        // an error is not passed on
});

test('error checks: ISERROR, ISERR, ISNA, ERROR.TYPE', () => {
  assert.equal(calc('=ISERROR(1/0)'), true);
  assert.equal(calc('=ISERROR(1)'), false);
  assert.equal(calc('=ISERR(1/0)'), true);
  assert.equal(calc('=ISERR(NA())'), false);
  assert.equal(calc('=ISNA(NA())'), true);
  assert.equal(calc('=ISNA(1/0)'), false);
  assert.equal(calc('=ERROR.TYPE(1/0)'), 2);
  assert.equal(calc('=ERROR.TYPE(NA())'), 7);
  assert.equal(calc('=ERROR.TYPE("x"+1)'), 3);
  assert.equal(shown(calc('=ERROR.TYPE(1)')), '#N/A');
});

test('ISEVEN and ISODD drop the fraction; text is an error', () => {
  assert.equal(calc('=ISEVEN(4)'), true);
  assert.equal(calc('=ISEVEN(-3)'), false);
  assert.equal(calc('=ISODD(3.7)'), true);
  assert.equal(calc('=ISODD(0)'), false);
  assert.equal(shown(calc('=ISEVEN("x")')), '#VALUE!');
  assert.equal(shown(calc('=ISODD(1/0)')), '#DIV/0!');
});

test('ISFORMULA, ISREF, TYPE', () => {
  const cells = { A1: '=1+1', A2: '2' };
  assert.equal(calc('=ISFORMULA(A1)', cells), true);
  assert.equal(calc('=ISFORMULA(A2)', cells), false);
  assert.equal(calc('=ISFORMULA(A3)', cells), false);
  assert.ok(isErr(shown(calc('=ISFORMULA(1)'))));
  assert.equal(calc('=ISREF(A1)', cells), true);
  assert.equal(calc('=ISREF(A1:B2)'), true);
  assert.equal(calc('=ISREF(1)'), false);
  assert.equal(calc('=TYPE(1)'), 1);
  assert.equal(calc('=TYPE(A5)'), 1);
  assert.equal(calc('=TYPE("a")'), 2);
  assert.equal(calc('=TYPE(TRUE)'), 4);
  assert.equal(calc('=TYPE(1/0)'), 16);
  assert.equal(calc('=TYPE({1,2})'), 64);
});

test('ISFORMULA follows an edit to the cell it looks at', () => {
  const wb = book({ Sheet1: { A1: '5', B1: '=ISFORMULA(A1)' } });
  assert.equal(wb.get('B1'), false);
  wb.set('A1', '=2+3');
  assert.equal(wb.get('B1'), true);
});
