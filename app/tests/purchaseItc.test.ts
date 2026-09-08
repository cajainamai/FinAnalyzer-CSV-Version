// Purchase ITC register and the issues derived from it.
//
// Backs the Purchase GST Register module. The fixture deliberately contains a
// registered B2B purchase, an RCM journal, a capital-goods purchase and three
// journals with no GST at all, so the classification branches are all covered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStore } from './helpers/fixtureStore';
import { getPurchaseITCRegister, deriveItcIssues, isValidGstin } from '../services/tally';

// Every voucher carrying at least one Purchase / Expense / Fixed Asset line.
// Sales, receipts, payments and the contra entry are correctly absent.
test('the register picks up exactly the vouchers with an expense-side line', async () => {
  const store = await fixtureStore();
  const rows = getPurchaseITCRegister(store);

  assert.deepEqual(
    rows.map((r) => r.voucherNumber),
    ['PUR-001', 'JV-001', 'JV-002', 'JV-004', 'PUR-002', 'JV-003'],
  );

  // Sorted by invoice date, so the year-end depreciation journal lands last.
  assert.deepEqual(
    rows.map((r) => r.date),
    ['2025-05-08', '2025-07-31', '2025-09-15', '2025-10-05', '2026-01-18', '2026-03-31'],
  );
});

test('a registered B2B purchase splits CGST and SGST off the taxable value', async () => {
  const store = await fixtureStore();
  const row = getPurchaseITCRegister(store).find((r) => r.voucherNumber === 'PUR-001');

  assert.ok(row);
  // Amounts follow Tally's sign convention: a debit is negative. See the
  // fixture README — the register does not flip the sign.
  assert.equal(row.taxable, -200000);
  assert.equal(row.cgst, -18000);
  assert.equal(row.sgst, -18000);
  assert.equal(row.igst, 0);
  assert.equal(row.tax, -36000);

  assert.equal(row.type, 'B2B');
  assert.equal(row.reverseCharge, 'N');
  assert.equal(row.partyGstinUin, '27AABCB2345B1Z7');
  assert.equal(row.primaryGroup, 'Purchase Accounts');
  assert.equal(row.itcType, 'Inputs');
  // The supplier's own invoice number and date, not the internal voucher's.
  assert.equal(row.vchNo, 'BILL-B-101');
  assert.equal(row.date, '2025-05-08');
  assert.equal(row.postingDate, '2025-05-10');
  assert.equal(row.booksMonth, 'May');
  assert.equal(row.fy, '2025-26');
});

test('an RCM journal counts the RCM input but not the RCM payable', async () => {
  const store = await fixtureStore();
  const row = getPurchaseITCRegister(store).find((r) => r.voucherNumber === 'JV-002');

  assert.ok(row);
  // JV-002 books CGST/SGST 4,500 each on both sides. Only the input legs are
  // ITC; double-counting the payable legs would net the tax to zero.
  assert.equal(row.cgst, -4500);
  assert.equal(row.sgst, -4500);
  assert.equal(row.tax, -9000);
  assert.equal(row.taxable, -50000);

  assert.equal(row.type, 'RCM-UR');
  assert.equal(row.reverseCharge, 'Y');
  assert.equal(row.partyGstinUin, '', 'the supplier is unregistered');
  assert.equal(row.itcType, 'Input Services');
});

test('a capital-goods purchase is classified as Capital Goods, not Inputs', async () => {
  const store = await fixtureStore();
  const row = getPurchaseITCRegister(store).find((r) => r.voucherNumber === 'PUR-002');

  assert.ok(row);
  assert.equal(row.taxable, -400000);
  assert.equal(row.igst, -72000);
  assert.equal(row.cgst, 0);
  assert.equal(row.tax, -72000);
  assert.equal(row.primaryGroup, 'Fixed Assets');
  assert.equal(row.itcType, 'Capital Goods');
  assert.equal(row.type, 'B2B', 'a GSTIN is on file, so not an import of services');
});

test('output GST ledgers never leak into the input register', async () => {
  const store = await fixtureStore();
  const rows = getPurchaseITCRegister(store);

  // The two sales invoices carry Output CGST/SGST/IGST. If the "output"
  // keyword gate regressed, those would surface here as input credit.
  assert.equal(rows.find((r) => r.voucherNumber === 'INV-001'), undefined);
  assert.equal(rows.find((r) => r.voucherNumber === 'INV-002'), undefined);

  const totalTax = rows.reduce((s, r) => s + r.tax, 0);
  assert.equal(totalTax, -117000, 'CGST/SGST 36,000 + RCM 9,000 + IGST 72,000');
});

test('TDS ledgers are not mistaken for GST despite sitting under Duties & Taxes', async () => {
  const store = await fixtureStore();
  const row = getPurchaseITCRegister(store).find((r) => r.voucherNumber === 'JV-001');

  assert.ok(row);
  // JV-001 credits TDS Payable - 194J. It has no gst_duty_head, so it must
  // not be counted as input GST.
  assert.equal(row.tax, 0);
  assert.equal(row.taxable, -100000);
});

test('the date filter narrows the register', async () => {
  const store = await fixtureStore();

  const q1 = getPurchaseITCRegister(store, { dateFrom: '2025-04-01', dateTo: '2025-06-30' });
  assert.deepEqual(q1.map((r) => r.voucherNumber), ['PUR-001']);

  const q4 = getPurchaseITCRegister(store, { dateFrom: '2026-01-01', dateTo: '2026-03-31' });
  assert.deepEqual(q4.map((r) => r.voucherNumber), ['PUR-002', 'JV-003']);
});

test('an explicit GST-ledger override replaces auto-detection', async () => {
  const store = await fixtureStore();

  // Naming only Input CGST means Input SGST stops counting as credit.
  const rows = getPurchaseITCRegister(store, { gstLedgerOverride: ['Input CGST'] });
  const pur = rows.find((r) => r.voucherNumber === 'PUR-001');

  assert.equal(pur?.cgst, -18000);
  assert.equal(pur?.sgst, 0);
  assert.equal(pur?.tax, -18000);
});

test('issues flag the zero-tax vouchers an auditor has to look at', async () => {
  const store = await fixtureStore();
  const issues = deriveItcIssues(getPurchaseITCRegister(store));

  // JV-001 (professional fees), JV-004 (rent) and JV-003 (depreciation) carry
  // an expense line but no GST — each is a "should RCM have applied?" review.
  assert.deepEqual(
    issues.rcmReview.map((r) => r.voucherNumber).sort(),
    ['JV-001', 'JV-003', 'JV-004'],
  );

  // CGST equals SGST on every intra-state voucher in the fixture.
  assert.equal(issues.cgstSgstMismatch.length, 0);
});

test('GSTIN validation accepts the fixture GSTINs and rejects malformed ones', () => {
  assert.ok(isValidGstin('27AABCA1234C1Z5'));
  assert.ok(isValidGstin('29AAECD5678D1ZA'));
  assert.ok(isValidGstin('24AABCZ6789Z1Z3'));

  assert.equal(isValidGstin(''), false);
  assert.equal(isValidGstin('27AABCA1234C1Z'), false, 'too short');
  assert.equal(isValidGstin('27AABCA1234C1X5'), false, 'the 14th character must be Z');
  assert.equal(isValidGstin('AA27ABCA1234C1Z5'), false, 'state code must lead');
});

// ── Documented current behaviour, not an endorsement ───────────────────────
// `deriveItcIssues` gates the Rule 36 checks on `tax > 0`, but a genuine
// purchase debits input GST, which is negative under Tally's sign convention.
// The two checks below therefore never fire on real purchase data — they can
// only trigger on ITC reversals (credit notes), where a missing GSTIN is not
// the point. This test pins the behaviour so the gap is visible and a fix is
// a deliberate, reviewed change rather than a silent one.
test('KNOWN GAP: the Rule 36 GSTIN and invoice-number checks cannot fire on purchases', async () => {
  const store = await fixtureStore();
  const rows = getPurchaseITCRegister(store);
  const issues = deriveItcIssues(rows);

  // JV-002 has tax of -9,000 and a blank GSTIN (unregistered supplier), which
  // is precisely what the Rule 36 check is meant to surface.
  const rcm = rows.find((r) => r.voucherNumber === 'JV-002');
  assert.equal(rcm?.partyGstinUin, '');
  assert.ok((rcm?.tax ?? 0) < 0);

  // Yet no row is reported, because every taxed row has tax < 0.
  assert.equal(issues.blankInvalidGstin.length, 0);
  assert.equal(issues.noInvoiceNumber.length, 0);
  assert.equal(rows.every((r) => r.tax <= 0), true);
});
