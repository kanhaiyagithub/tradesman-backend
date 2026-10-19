const assert = require("node:assert/strict");
const test = require("node:test");
const { Parser } = require("json2csv");

const { neutralizeCsvCell, sanitizeCsvRows } = require("../utils/csvSafe");

test("text that spreadsheets would run as a formula gets a leading quote", () => {
  for (const dangerous of ['=HYPERLINK("http://evil","x")', "+1+1", "-2+3", "@SUM(A1)", "\t=1+1", "\r=1+1"]) {
    assert.equal(neutralizeCsvCell(dangerous), `'${dangerous}`);
  }
});

test("ordinary text, numbers, booleans, dates and nulls are left alone", () => {
  const date = new Date("2026-10-17T00:00:00Z");
  for (const safe of ["Alex Smith", "a=b", "user+tag@example.com", " =padded", "", 42, -7, 0, true, false, null, undefined, date]) {
    assert.equal(neutralizeCsvCell(safe), safe);
  }
});

test("sanitizeCsvRows does not mutate its input and keeps every column", () => {
  const rows = [{ name: "=cmd|' /C calc'!A0", email: "a@b.com", price: -5, isVerified: false }];
  const cleaned = sanitizeCsvRows(rows);

  assert.equal(rows[0].name, "=cmd|' /C calc'!A0");
  assert.deepEqual(cleaned, [
    { name: "'=cmd|' /C calc'!A0", email: "a@b.com", price: -5, isVerified: false },
  ]);
});

test("a generated CSV never has a cell that starts with a formula character", () => {
  const rows = sanitizeCsvRows([
    { user: "=1+1", email: "x@y.com", plan: "@Pro", price: 10, status: "active" },
    { user: "-bad", email: "+evil@y.com", plan: "Basic", price: 0, status: "canceled" },
  ]);
  const csv = new Parser().parse(rows);

  const cells = csv
    .split("\n")
    .slice(1)
    .flatMap((line) => line.split(",").map((cell) => cell.replace(/^"/, "")));
  assert.ok(cells.length > 0);
  for (const cell of cells) {
    assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `cell "${cell}" would be run as a formula`);
  }
});
