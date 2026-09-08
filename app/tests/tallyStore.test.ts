// Ingestion and the LedgerEntry shim.
//
// Every module in the app reads either the typed store collections or the flat
// LedgerEntry[] the shim produces, so a regression here breaks all 27 modules
// at once. These tests pin the shapes both consumers depend on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStore, FIXTURE } from './helpers/fixtureStore';
import { nameKey } from '../services/tally';

test('import reads every table out of the export zip', async () => {
  const store = await fixtureStore();

  assert.equal(store.ledgers.size, FIXTURE.ledgerCount);
  assert.equal(store.groups.size, FIXTURE.groupCount);
  assert.equal(store.vouchers.size, FIXTURE.voucherCount);
  assert.equal(store.accountingLines.length, FIXTURE.accountingLineCount);
  assert.equal(store.stockItems.size, 2);
  assert.equal(store.inventoryLines.length, 3);
  assert.equal(store.billRefs.length, 10);
  assert.equal(store.gstEffectiveRates.length, 3);
});

test('company metadata comes through config.csv', async () => {
  const store = await fixtureStore();

  assert.equal(store.meta.companyName, FIXTURE.companyName);
  assert.equal(store.meta.periodFrom, FIXTURE.periodFrom);
  assert.equal(store.meta.periodTo, FIXTURE.periodTo);
});

test('the books balance: every voucher nets to zero', async () => {
  const store = await fixtureStore();

  const byVoucher = new Map<string, number>();
  for (const line of store.accountingLines) {
    byVoucher.set(line.guid, (byVoucher.get(line.guid) || 0) + line.amount);
  }

  for (const [guid, net] of byVoucher) {
    assert.equal(net, 0, `voucher ${guid} does not balance (net ${net})`);
  }
  assert.equal(byVoucher.size, FIXTURE.voucherCount);
});

test('opening balances net to zero across the ledger master', async () => {
  const store = await fixtureStore();

  const openingSum = [...store.ledgers.values()]
    .reduce((s, l) => s + l.opening_balance, 0);

  assert.equal(openingSum, 0);
});

test('primary groups resolve through the ledger parent chain', async () => {
  const store = await fixtureStore();

  assert.equal(store.primaryGroupFor('Alpha Traders'), 'Sundry Debtors');
  assert.equal(store.primaryGroupFor('HDFC Bank Current A/c'), 'Bank Accounts');
  assert.equal(store.primaryGroupFor('Plant & Machinery'), 'Fixed Assets');
  assert.equal(store.primaryGroupFor('Input CGST'), 'Duties & Taxes');
  assert.equal(store.primaryGroupFor('Rent'), 'Indirect Expenses');
  assert.equal(store.primaryGroupFor('Sales - Finished Goods'), 'Sales Accounts');
});

test('ledger name lookups are whitespace- and case-insensitive', async () => {
  const store = await fixtureStore();

  // Tally names are space-noisy; joins must survive that or party-level
  // modules silently split one party into several.
  assert.ok(store.ledger('alpha traders'));
  assert.ok(store.ledger('  Alpha   Traders  '));
  assert.equal(store.ledger('ALPHA TRADERS')?.name, 'Alpha Traders');
});

test('shim emits one row per accounting line plus a master row per unused ledger', async () => {
  const store = await fixtureStore();
  const rows = store.getLedgerEntries();

  const tx = rows.filter((r) => !r.is_master_ledger);
  const masters = rows.filter((r) => r.is_master_ledger);

  assert.equal(tx.length, FIXTURE.shimTransactionRows);
  assert.equal(masters.length, FIXTURE.shimMasterRows);

  // The master rows are exactly the ledgers with no transaction, so trial
  // balance and ageing still see their opening/closing balances.
  assert.deepEqual(
    masters.map((m) => m.Ledger).sort(),
    ['General Reserve', 'HDFC Term Loan', 'Profit & Loss A/c', 'Share Capital'],
  );
});

test('shim rows carry the joined voucher, ledger and group context', async () => {
  const store = await fixtureStore();
  const rows = store.getLedgerEntries();

  const alphaSale = rows.find(
    (r) => r.Ledger === 'Alpha Traders' && r.voucher_number === 'INV-001',
  );
  assert.ok(alphaSale, 'expected the Alpha Traders leg of INV-001');

  assert.equal(alphaSale.amount, -590000);          // debtor invoice is a debit
  assert.equal(alphaSale.date, '2025-04-15');
  assert.equal(alphaSale.voucher_type, 'Sales');
  assert.equal(alphaSale.Group, 'Sundry Debtors');
  assert.equal(alphaSale.TallyPrimary, 'Sundry Debtors');
  assert.equal(alphaSale.party_name, 'Alpha Traders');
  assert.equal(alphaSale.gstin, '27AABCA1234C1Z5');
  assert.equal(alphaSale.pan, 'AABCA1234C');
  assert.equal(alphaSale.place_of_supply, 'Maharashtra');
  assert.equal(alphaSale.bill_reference, 'INV-001');
  assert.equal(alphaSale.bill_credit_period, 30);
  assert.equal(alphaSale.is_invoice, 1);
});

test('a voucher guid is recoverable from any of its shim rows', async () => {
  const store = await fixtureStore();
  const rows = store.getLedgerEntries().filter((r) => !r.is_master_ledger);

  // The shim mints `<voucherGuid>-<n>`; stripping the single trailing segment
  // must regroup the legs. Getting this wrong shatters every voucher into
  // one-line groups, which is why it is pinned here.
  const legs = rows.filter((r) => String(r.guid).replace(/-\d+$/, '') === 'vch-007');
  assert.equal(legs.length, 6, 'JV-002 has six legs (expense, party, 2 RCM inputs, 2 RCM payables)');
});

test('GST rate falls back to the effective-rate master when the item is blank', async () => {
  const store = await fixtureStore();
  const rows = store.getLedgerEntries();

  // Precision Bearing carries its own rate on mst_stock_item.
  const sale = rows.find((r) => r.voucher_number === 'INV-001' && r.Ledger === 'Alpha Traders');
  assert.equal(sale?.gst_rate, 18);
  assert.equal(sale?.gst_hsn_code, '84821011');

  // Steel Rod has gst_rate 0 and no HSN on the item master, so both must be
  // back-filled from mst_gst_effective_rate (CGST 9 + SGST 9 = 18).
  const purchase = rows.find(
    (r) => r.voucher_number === 'PUR-001' && r.Ledger === 'Purchase - Raw Material',
  );
  assert.equal(purchase?.gst_rate, 18, 'CGST 9 + SGST 9 should resolve to an 18% slab');
  assert.equal(purchase?.gst_hsn_code, '72141010');
});

test('dates are normalised to ISO regardless of source format', async () => {
  const store = await fixtureStore();

  for (const v of store.vouchers.values()) {
    assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/, `voucher ${v.guid} has a non-ISO date`);
  }
  // reference_date is a separate field and must survive independently of the
  // posting date — the ITC register reports on the supplier's invoice date.
  assert.equal(store.voucher('vch-002')?.date, '2025-05-10');
  assert.equal(store.voucher('vch-002')?.reference_date, '2025-05-08');
});

test('store summary reports the period actually present in the vouchers', async () => {
  const store = await fixtureStore();
  const s = store.summary();

  assert.equal(s.vouchers, FIXTURE.voucherCount);
  assert.equal(s.minDate, '2025-04-15');
  assert.equal(s.maxDate, '2026-03-31');
  assert.equal(s.ledgers, FIXTURE.ledgerCount);
});

test('nameKey collapses the whitespace Tally exports carry', () => {
  assert.equal(nameKey('  Alpha   Traders \n'), 'alpha traders');
  assert.equal(nameKey('Input CGST - RCM'), 'input cgst - rcm');
});
