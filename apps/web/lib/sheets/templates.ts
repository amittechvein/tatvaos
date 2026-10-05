// ============================================================================
//  Ready-made spreadsheets for "Start from a template".
//
//  Small on purpose: each is the shape of a real register with its formulas
//  already in place, and a few example rows so the formulas show a result.
//  People replace the examples; the structure is what saves them time.
// ============================================================================

import { cellKey, emptySheet, type CellFormat, type SheetData, type WorkbookData } from './workbook';

const HEAD: CellFormat = { b: true, bg: '#e6f4ea', bb: { style: 'thin', color: '#188038' } };
const RUPEES: CellFormat = { nf: '₹#,##0' };
const DATE: CellFormat = { nf: 'dd/mm/yyyy' };

function sheet(name: string, rows: (string | null)[][], opts: {
  formats?: Record<string, CellFormat>; widths?: Record<number, number>; freeze?: number;
} = {}): SheetData {
  const s = emptySheet(name);
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === null) return;
    s.cells.set(cellKey(r, c), { input: v, format: r === 0 ? HEAD : undefined });
  }));
  for (const [a1, f] of Object.entries(opts.formats ?? {})) {
    // "C2:C9" → every cell in the column range gets the format.
    const m = /^([A-Z])(\d+):([A-Z])(\d+)$/.exec(a1);
    if (!m) continue;
    for (let r = Number(m[2]) - 1; r <= Number(m[4]) - 1; r += 1) {
      for (let c = m[1]!.charCodeAt(0) - 65; c <= m[3]!.charCodeAt(0) - 65; c += 1) {
        const k = cellKey(r, c);
        const cell = s.cells.get(k) ?? { input: null };
        s.cells.set(k, { ...cell, format: { ...cell.format, ...f } });
      }
    }
  }
  s.colWidths = opts.widths ?? {};
  s.frozenRows = opts.freeze ?? 1;
  return s;
}

export interface Template { id: string; name: string; group: 'School' | 'Business' | 'HR'; description: string; build: () => WorkbookData }

export const TEMPLATES: Template[] = [
  {
    id: 'fees', name: 'Fee collection', group: 'School', description: 'Fees, payments and dues by student, with totals by class.',
    build: () => ({ sheets: [
      sheet('Fees', [
        ['Admission No.', 'Student name', 'Class', 'Annual fee', 'Paid', 'Due', 'Status'],
        ['A-1001', 'Aarav Sharma', '10', '48000', '48000', '=D2-E2', '=IF(F2<=0,"Paid",IF(E2>0,"Partial","Pending"))'],
        ['A-1002', 'Diya Patel', '10', '48000', '24000', '=D3-E3', '=IF(F3<=0,"Paid",IF(E3>0,"Partial","Pending"))'],
        ['A-1003', 'Kabir Singh', '9', '45000', '0', '=D4-E4', '=IF(F4<=0,"Paid",IF(E4>0,"Partial","Pending"))'],
        ['A-1004', 'Ananya Iyer', '9', '45000', '45000', '=D5-E5', '=IF(F5<=0,"Paid",IF(E5>0,"Partial","Pending"))'],
        [null],
        ['Total', null, null, '=SUM(D2:D5)', '=SUM(E2:E5)', '=SUM(F2:F5)', '=COUNTIF(G2:G5,"Paid")&" of "&COUNTA(A2:A5)&" paid"'],
      ], { formats: { 'D2:F7': RUPEES }, widths: { 0: 110, 1: 160, 6: 150 } }),
      sheet('By class', [
        ['Class', 'Fee', 'Paid', 'Due'],
        ['9', '=SUMIF(Fees!C2:C500,A2,Fees!D2:D500)', '=SUMIF(Fees!C2:C500,A2,Fees!E2:E500)', '=B2-C2'],
        ['10', '=SUMIF(Fees!C2:C500,A3,Fees!D2:D500)', '=SUMIF(Fees!C2:C500,A3,Fees!E2:E500)', '=B3-C3'],
      ], { formats: { 'B2:D3': RUPEES } }),
    ] }),
  },
  {
    id: 'attendance', name: 'Attendance', group: 'School', description: 'A month of P/A marks with each student’s percentage.',
    build: () => {
      const head = ['Roll', 'Student name', ...Array.from({ length: 10 }, (_, i) => `${i + 1}`), 'Present', 'Attendance %'];
      const names = ['Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Ananya Iyer'];
      const rows: (string | null)[][] = [head];
      names.forEach((n, i) => {
        const r = i + 2;
        const marks = Array.from({ length: 10 }, (_, d) => ((i + d) % 7 === 3 ? 'A' : 'P'));
        rows.push([String(i + 1), n, ...marks, `=COUNTIF(C${r}:L${r},"P")`, `=M${r}/COUNTA(C${r}:L${r})`]);
      });
      rows.push([null], ['', 'Class average', ...Array(10).fill(null), null, '=AVERAGE(N2:N5)']);
      return { sheets: [sheet('Attendance', rows, {
        formats: { 'N2:N7': { nf: '0.0%' }, 'C1:L1': { ha: 'center' }, 'C2:L5': { ha: 'center' } },
        widths: { 0: 50, 1: 160, ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 2, 36])) },
      })] };
    },
  },
  {
    id: 'marks', name: 'Marks sheet', group: 'School', description: 'Subject marks, totals, percentage, grade and rank.',
    build: () => {
      const rows: (string | null)[][] = [['Roll', 'Student name', 'English', 'Hindi', 'Maths', 'Science', 'Social Sci.', 'Total', 'Percent', 'Grade', 'Rank']];
      const data = [['Aarav Sharma', 78, 82, 91, 88, 74], ['Diya Patel', 92, 88, 95, 90, 86], ['Kabir Singh', 58, 64, 39, 55, 61], ['Ananya Iyer', 85, 79, 88, 93, 80]];
      data.forEach((d, i) => {
        const r = i + 2;
        rows.push([String(i + 1), String(d[0]), ...d.slice(1).map(String), `=SUM(C${r}:G${r})`, `=H${r}/500`,
          `=IFS(I${r}>=0.9,"A1",I${r}>=0.8,"A2",I${r}>=0.7,"B1",I${r}>=0.6,"B2",I${r}>=0.5,"C1",I${r}>=0.4,"C2",TRUE,"Needs support")`,
          `=RANK(H${r},H$2:H$5)`]);
      });
      return { sheets: [sheet('Marks', rows, { formats: { 'I2:I5': { nf: '0.0%' } }, widths: { 1: 160, 9: 110 } })] };
    },
  },
  {
    id: 'expenses', name: 'Expense tracker', group: 'Business', description: 'Dated expenses by category, with a monthly summary.',
    build: () => ({ sheets: [
      sheet('Expenses', [
        ['Date', 'Description', 'Category', 'Amount', 'Paid by'],
        ['01/09/2026', 'Office rent', 'Rent', '35000', 'Bank transfer'],
        ['05/09/2026', 'Internet', 'Utilities', '1499', 'UPI'],
        ['12/09/2026', 'Stationery', 'Supplies', '2350', 'Cash'],
        ['20/09/2026', 'Electricity', 'Utilities', '6200', 'UPI'],
      ], { formats: { 'A2:A200': DATE, 'D2:D200': RUPEES }, widths: { 1: 180, 2: 120 } }),
      sheet('Summary', [
        ['Category', 'Total'],
        ['Rent', '=SUMIF(Expenses!C:C,A2,Expenses!D:D)'],
        ['Utilities', '=SUMIF(Expenses!C:C,A3,Expenses!D:D)'],
        ['Supplies', '=SUMIF(Expenses!C:C,A4,Expenses!D:D)'],
        ['All', '=SUM(B2:B4)'],
      ], { formats: { 'B2:B5': RUPEES } }),
    ] }),
  },
  {
    id: 'salary', name: 'Salary sheet', group: 'HR', description: 'Basic, allowances, PF and net pay per employee.',
    build: () => {
      const rows: (string | null)[][] = [['Emp. ID', 'Name', 'Basic', 'HRA (40%)', 'Allowances', 'Gross', 'PF (12%)', 'Net pay']];
      [['E-01', 'Priya Nair', 42000, 5000], ['E-02', 'Rahul Verma', 36000, 4000], ['E-03', 'Meera Das', 28000, 3000]].forEach((d, i) => {
        const r = i + 2;
        rows.push([String(d[0]), String(d[1]), String(d[2]), `=C${r}*40%`, String(d[3]), `=C${r}+D${r}+E${r}`, `=ROUND(C${r}*12%,0)`, `=F${r}-G${r}`]);
      });
      rows.push([null], ['Total', null, '=SUM(C2:C4)', '=SUM(D2:D4)', '=SUM(E2:E4)', '=SUM(F2:F4)', '=SUM(G2:G4)', '=SUM(H2:H4)']);
      return { sheets: [sheet('Salary', rows, { formats: { 'C2:H6': RUPEES }, widths: { 1: 150 } })] };
    },
  },
  {
    id: 'leave', name: 'Leave tracker', group: 'HR', description: 'Leave taken against entitlement, per employee.',
    build: () => ({ sheets: [sheet('Leave', [
      ['Name', 'Entitled', 'Casual', 'Sick', 'Earned', 'Taken', 'Balance'],
      ['Priya Nair', '24', '3', '1', '4', '=SUM(C2:E2)', '=B2-F2'],
      ['Rahul Verma', '24', '5', '2', '0', '=SUM(C3:E3)', '=B3-F3'],
      ['Meera Das', '24', '1', '0', '6', '=SUM(C4:E4)', '=B4-F4'],
    ], { widths: { 0: 150 } })] }),
  },
];
