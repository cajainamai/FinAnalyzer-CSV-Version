// Trial Balance query.
//
// This is the module every other numeric module is checked against, so the
// invariant that matters most is that it balances and that its per-ledger
// closing reconciles to the ledger master.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStore, FIXTURE } from './helpers/fixtureStore';
import { getTrialBalance } from '../services/tally';

test('trial balance balances and reconciles to the ledger master', async () => {
  const store = await fixtureStore();
  const tb = getTrialBalance(store);

  assert.equal(tb.flatLedgers.length, FIXTURE.ledgerCount);
  assert.ok(tb.balanceCheck.during.ok, 'movement Dr must equal movement Cr');
  assert.ok(tb.balanceCheck.opening.ok, 'opening Dr must equal opening Cr');
  assert.ok(tb.balanceCheck.closing.ok, 'closing Dr must equal closing Cr');
});

test('closing Dr and Cr both come to the expected total', async () => {
  const store = await fixtureStore();
  const tb = getTrialBalance(store);

  const closingDr = tb.flatLedgers.reduce((s, l) => s + l.closingDr, 0);
  const closingCr = tb.flatLedgers.reduce((s, l) => s + l.closingCr, 0);

  assert.equal(closingDr, FIXTURE.trialBalanceTotal);
  assert.equal(closingCr, FIXTURE.trialBalanceTotal);
});

test('a party ledger shows opening, movement and closing on the right side', async () => {
  const store = await fixtureStore();
  const tb = getTrialBalance(store);

  // Alpha Traders: opening Dr 3,54,000, a 5,90,000 invoice (Dr) and a
  // 3,54,000 receipt (Cr), closing Dr 5,90,000.
  const alpha = tb.flatLedgers.find((l) => l.ledger === 'Alpha Traders');
  assert.ok(alpha);
  assert.equal(alpha.openingDr, 354000);
  assert.equal(alpha.openingCr, 0);
  assert.equal(alpha.duringDr, 590000);
  assert.equal(alpha.duringCr, 354000);
  assert.equal(alpha.closingDr, 590000);
  assert.equal(alpha.closingCr, 0);

  // Share Capital is a credit balance with no movement in the year.
  const capital = tb.flatLedgers.find((l) => l.ledger === 'Share Capital');
  assert.ok(capital);
  assert.equal(capital.openingCr, 2000000);
  assert.equal(capital.duringDr, 0);
  assert.equal(capital.duringCr, 0);
  assert.equal(capital.closingCr, 2000000);
});

test('activity classification separates dormant, new and active ledgers', async () => {
  const store = await fixtureStore();
  const tb = getTrialBalance(store);

  const activityOf = (name: string) =>
    tb.flatLedgers.find((l) => l.ledger === name)?.activity;

  // Opening balance, no movement, still open at year end.
  assert.equal(activityOf('Share Capital'), 'dormant');
  assert.equal(activityOf('HDFC Term Loan'), 'dormant');
  // No opening, movement during the year.
  assert.equal(activityOf('Rent'), 'new');
  assert.equal(activityOf('Delta Enterprises'), 'new');
  // Opening and movement.
  assert.equal(activityOf('Alpha Traders'), 'active');
  // Nothing anywhere.
  assert.equal(activityOf('Profit & Loss A/c'), 'never-used');
});

test('the date filter excludes movement outside the window', async () => {
  const store = await fixtureStore();

  // Depreciation is posted on 2026-03-31. A window that ends a day earlier
  // must not pick it up.
  const tb = getTrialBalance(store, { dateFrom: '2025-04-01', dateTo: '2026-03-30' });
  const dep = tb.flatLedgers.find((l) => l.ledger === 'Depreciation');

  assert.ok(dep);
  assert.equal(dep.duringDr, 0, 'depreciation falls outside the window');

  // …and the full-year window does.
  const full = getTrialBalance(store, { dateFrom: '2025-04-01', dateTo: '2026-03-31' });
  const depFull = full.flatLedgers.find((l) => l.ledger === 'Depreciation');
  assert.equal(depFull?.duringDr, 250000);
});

test('a filtered trial balance still balances', async () => {
  const store = await fixtureStore();

  // Whatever window is chosen, movement Dr must equal movement Cr — a filter
  // that split a voucher across the boundary would break this.
  for (const dateTo of ['2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31']) {
    const tb = getTrialBalance(store, { dateFrom: '2025-04-01', dateTo });
    const dr = tb.flatLedgers.reduce((s, l) => s + l.duringDr, 0);
    const cr = tb.flatLedgers.reduce((s, l) => s + l.duringCr, 0);
    assert.equal(dr, cr, `movement unbalanced for window ending ${dateTo}`);
  }
});

test('grand totals match the sum of the flat ledger rows', async () => {
  const store = await fixtureStore();
  const tb = getTrialBalance(store);

  const flatDr = tb.flatLedgers.reduce((s, l) => s + l.closingDr, 0);
  const flatCr = tb.flatLedgers.reduce((s, l) => s + l.closingCr, 0);

  const topDr = tb.tree.reduce((s, g) => s + g.closingDr, 0);
  const topCr = tb.tree.reduce((s, g) => s + g.closingCr, 0);

  assert.equal(topDr, flatDr);
  assert.equal(topCr, flatCr);
});
