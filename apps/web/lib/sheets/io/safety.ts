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
//    HYPERLINK      allowed, but its target must be a quoted "http:",
//                   "https:" or "mailto:" link (what follows may be joined
//                   on: "https://…?id="&A2). file: and \server paths make
//                   Windows sign in to someone else's server and leak the
//                   person's password hash (Mr. Singh, 25 Sept 2026); a
//                   target built from a cell cannot be checked, so it too
//                   stays text.
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
  if (!hyperlinksAreSafe(formula.startsWith('=') ? formula.slice(1) : formula, bare)) return false;
  const upper = bare.toUpperCase();
  for (const fn of CALL_OUT_FUNCTIONS) {
    // The name as a function call: not preceded by a name character, followed by "(".
    const re = new RegExp(`(^|[^A-Z0-9_.])${fn.replace('.', '\\.')}\\s*\\(`);
    if (re.test(upper)) return false;
  }
  return true;
}

/** Every HYPERLINK( in the formula starts with a quoted http:, https: or mailto: target. */
function hyperlinksAreSafe(src: string, bare: string): boolean {
  const re = /(^|[^A-Z0-9_.])HYPERLINK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    if (src[i] !== '"') return false;               // not a literal: cannot be checked
    let target = '';
    for (i += 1; i < src.length; i += 1) {
      if (src[i] === '"') { if (src[i + 1] === '"') { target += '"'; i += 1; continue; } break; }
      target += src[i];
    }
    if (!/^\s*(https?:|mailto:)/i.test(target)) return false;
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
