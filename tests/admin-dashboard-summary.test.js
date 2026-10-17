const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { buildMonthlySeries } = require('../controllers/AdminController/adminDashboardController');

test('buildMonthlySeries returns months oldest-first and zero-fills gaps', () => {
  const now = new Date(2026, 9, 16); // October 2026
  const series = buildMonthlySeries(
    [
      { year: '2026', month: '10', count: '4' },
      { year: 2025, month: 12, count: 2 },
    ],
    now,
    4
  );

  assert.deepEqual(series, [
    { year: 2026, month: 7, count: 0 },
    { year: 2026, month: 8, count: 0 },
    { year: 2026, month: 9, count: 0 },
    { year: 2026, month: 10, count: 4 },
  ]);
});

test('buildMonthlySeries keeps the same month of different years apart', () => {
  const now = new Date(2026, 0, 10); // January 2026
  const series = buildMonthlySeries(
    [
      { year: 2026, month: 1, count: 3 },
      { year: 2025, month: 1, count: 9 },
    ],
    now,
    13
  );

  assert.equal(series[0].count, 9);
  assert.equal(series[12].count, 3);
  assert.equal(series[0].year, 2025);
  assert.equal(series[12].year, 2026);
});
