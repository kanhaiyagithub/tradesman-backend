/**
 * CSV formula-injection protection.
 *
 * Spreadsheet apps (Excel, Sheets, LibreOffice) run a cell as a formula when its text starts with
 * "=", "+", "-", "@", a tab or a carriage return. Names and emails are typed by users, so an
 * export could contain something like `=HYPERLINK("http://evil", "click")`. Prefixing such text
 * with a single quote makes the spreadsheet show it as plain text (OWASP's recommended fix).
 * Only strings are touched: numbers, booleans and dates keep their type.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

const neutralizeCsvCell = (value) =>
  typeof value === "string" && FORMULA_START.test(value) ? `'${value}` : value;

/** Returns copies of the rows with every string cell neutralized. */
const sanitizeCsvRows = (rows) =>
  rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, neutralizeCsvCell(value)]))
  );

module.exports = { neutralizeCsvCell, sanitizeCsvRows };
