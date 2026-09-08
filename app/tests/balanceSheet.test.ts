// Schedule III balance sheet and statement of profit & loss.
//
// The single most important property is that the statement balances. Every
// ledger closing sums to zero across the trial balance, so any classification
// bug that drops or double-counts a ledger shows up immediately as a non-zero
// reconciliation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStore, FIXTURE } from './helpers/fixtureStore';
import {
  buildBranchFromStore,
  assertBranchInvariants,
  bsReconciliation,
  totalAssets,
  totalEquityLiabilities,
  shareCapital,
  reservesSurplus,
  surplusTransfer,
  tradeReceivables,
  tradePayables,
  longTermBorrowings,
  revenueFromOps,
  purchases,
  depreciation,
  totalExpenses,
  totalRevenue,
  profitBeforeTax,
  closingStock,
  type BranchData,
} from '../services/balanceSheet';

const branch = async (): Promise<BranchData> =>
  buildBranchFromStore(await fixtureStore(), 'Main');

test('the balance sheet balances', async () => {
  const b = await branch();

  assert.equal(bsReconciliation(b), 0);
  assert.equal(totalAssets(b), 4691000);
  assert.equal(totalEquityLiabilities(b), 4691000);
});

test('no ledger is left unclassified', async () => {
  const b = await branch();

  // An unclassified ledger with a balance is a balance-sheet risk: it means a
  // real figure would be silently missing from the face of the statement.
  assert.deepEqual(b.unclassified, []);
});

test('equity and liability lines carry the expected figures', async () => {
  const b = await branch();

  assert.equal(shareCapital(b), 2000000);
  assert.equal(longTermBorrowings(b), 1368000);
  assert.equal(tradePayables(b), 848000, 'Beta + Gamma + Epsilon + Zeta');

  // The year-end transfer JV has not been posted, so the loss is carried into
  // reserves: 5,00,000 opening reserve less the 2,00,000 loss.
  assert.equal(surplusTransfer(b), -FIXTURE.netLoss);
  assert.equal(reservesSurplus(b), 300000);
});

test('asset lines carry the expected figures', async () => {
  const b = await branch();

  assert.equal(tradeReceivables(b), 826000, 'Alpha 5,90,000 + Delta 2,36,000');
});

test('the profit and loss statement ties to the ledgers', async () => {
  const b = await branch();

  assert.equal(revenueFromOps(b), 700000);
  assert.equal(totalRevenue(b), 700000);
  assert.equal(purchases(b), 200000);
  assert.equal(depreciation(b), 250000);
  assert.equal(totalExpenses(b), 900000);

  // Revenue 7,00,000 less expenses 9,00,000.
  assert.equal(profitBeforeTax(b), -FIXTURE.netLoss);
});

test('the loss on the P&L equals the surplus carried into reserves', async () => {
  const b = await branch();

  // These are computed by two independent routes (the P&L face vs. the sum of
  // P&L-natured ledger closings). They must agree, or the balance sheet only
  // balances by accident.
  assert.equal(profitBeforeTax(b), surplusTransfer(b));
});

test('invariants add no BALANCE_BROKEN diagnostic for a balanced set of books', async () => {
  const b = await branch();
  assertBranchInvariants(b);

  const broken = b.diagnostics.filter((d) => d.code === 'BALANCE_BROKEN');
  assert.equal(broken.length, 0);
});

// ── Diagnostics the fixture deliberately triggers ──────────────────────────
// Both exceptions below are ordinary in real Tally books, and the point of the
// diagnostics is to surface them rather than silently paper over them. The
// fixture reproduces each so the detection stays covered.

test('a stock register that does not tie to the Stock-in-Hand ledger is reported', async () => {
  const b = await branch();

  // The fixture has stock items valued at 4,16,000 but no Stock-in-Hand
  // ledger, which is what a company that never passes a closing-stock JV
  // looks like.
  const stock = b.diagnostics.filter((d) => d.code === 'STOCK_REGISTER_MISMATCH');
  assert.equal(stock.length, 2, 'one for opening, one for closing');

  // The statement uses the ledger figure, so the balance sheet still balances.
  assert.equal(Math.abs(closingStock(b)), 0);
  assert.equal(bsReconciliation(b), 0);
});

test('depreciation booked straight against the asset is reported', async () => {
  const b = await branch();

  // JV-003 credits Plant & Machinery directly rather than an accumulated
  // depreciation ledger, so the fixed-asset schedule shows no charge while the
  // P&L shows 2,50,000.
  const depr = b.diagnostics.filter((d) => d.code === 'DEPR_MISMATCH');
  assert.equal(depr.length, 1);

  // The P&L figure wins: the statement must tie to the ledgers.
  assert.equal(depreciation(b), 250000);
});
