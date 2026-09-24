// ============================================================================
//  Which formulas may leave TatvaOS inside a file.
//
//  Formulas are ordinary spreadsheet content and are not blocked as a class
//  (Mr. Singh, 25 Sept 2026). What is refused is what turns a workbook into
//  an attack when someone opens it in Excel or another program:
//
//    |              DDE: =cmd|' /c calc'!A0 runs a program. Excel has no
//                   "|" operator, so outside quoted text it means only DDE.
//    [ … ]          a reference into ANOTHER workbook: ='[Budget.xlsx]S'!A1,
//                   =[1]Sheet1!A1 — a file fetched from wherever it points.
//                   Accepted cost: a sheet NAMED with brackets ("Q1 [draft]")
//                   cannot be referred to by a formula in the .xlsx copy —
//                   the formula still works in Sheets; in the file it is text.
//    call-out functions, which fetch from the internet or run code:
//                   WEBSERVICE, IMPORTDATA/IMPORTXML/IMPORTHTML/IMPORTFEED/
//                   IMPORTRANGE, RTD, CALL, REGISTER.ID, EXEC, DDE.
//
//  THE SERVER CHECKS THE SAME RULES (apps/api/Modules/Docs/XlsxGuard.cs) on
//  the .xlsx each checkpoint uploads, and refuses a file that breaks them.
//  The writer here applies them first and writes such a formula as plain
//  text, so an honest editor can never produce a file the server refuses —
//  a person who types =cmd|… into a cell must not stop the spreadsheet
//  saving for everyone. Change both files or neither.
// ============================================================================

export const CALL_OUT_FUNCTIONS = [
  'WEBSERVICE', 'IMPORTDATA', 'IMPORTXML', 'IMPORTHTML', 'IMPORTFEED', 'IMPORTRANGE',
  'RTD', 'CALL', 'REGISTER.ID', 'EXEC', 'DDE',
];

/** The formula with every "quoted text" blanked out, so rules never fire on text. */
function outsideStrings(formula: string): string {
  return formula.replace(/"(?:[^"]|"")*"?/g, (m) => ' '.repeat(m.length));
}

/**
 * May this formula be written into a file as a formula? The input may start
 * with "=" or not. Ordinary formulas, including HYPERLINK, return true.
 */
export function formulaIsSafe(formula: string): boolean {
  const bare = outsideStrings(formula.startsWith('=') ? formula.slice(1) : formula);
  if (bare.includes('|')) return false;
  if (bare.includes('[') || bare.includes(']')) return false;
  const upper = bare.toUpperCase();
  for (const fn of CALL_OUT_FUNCTIONS) {
    // The name as a function call: not preceded by a name character, followed by "(".
    const re = new RegExp(`(^|[^A-Z0-9_.])${fn.replace('.', '\\.')}\\s*\\(`);
    if (re.test(upper)) return false;
  }
  return true;
}

/**
 * CSV: text that a spreadsheet program would read as a formula (it starts
 * with = + - @, or a tab or carriage return that some programs skip first)
 * gets a leading apostrophe, the standard defence against CSV injection.
 * Only TEXT is touched — a real negative number is written as the number.
 */
export function csvSafeText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
