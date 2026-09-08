// Purchase ITC register and the issues derived from it.
//
// Backs the Purchase GST Register module. The fixture deliberately contains a
// registered B2B purchase, an RCM journal, a capital-goods purchase, an import
// of services, a domestic purchase whose supplier GSTIN was never filled in,
// and three journals with no GST at all, so every classification branch and
// every issue bucket is covered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStore } from './helpers/fixtureStore';
import { getPurchaseITCRegister, deriveItcIssues, isValidGstin } from '../services/tally';
import type { ItcRow } from '../services/tally';

// Every voucher carrying at least one Purchase / Expense / Fixed Asset line.
// Sales, receipts, payments and the contra entry are correctly absent.
test('the register picks up exactly the vouchers with an expense-side line', async () => {
  const store = await fixtureStore();
  const rows = getPurchaseITCRegister(store);

  assert.deepEqual(
    rows.map((r) => r.voucherNumber),
    ['PUR-001', 'JV-001', 'JV-002', 'JV-004', 'JV-005', 'PUR-002', 'PUR-003', 'JV-003'],
  );

  // Sorted by invoice date, so the year-end depreciation journal lands last.
  assert.deepEqual(
    rows.map((r) => r.date),
    [
      '2025-05-08', '2025-07-31', '2025-09-15', '2025-10-05',
      '2025-12-05', '2026-01-18', '2026-02-12', '2026-03-31',
    ],
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
  assert.equal(
    totalTax,
    -180000,
    'CGST/SGST 36,000 + RCM 9,000 + capital IGST 72,000 + import 36,000 + inter-state 27,000',
  );
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
  assert.deepEqual(q4.map((r) => r.voucherNumber), ['PUR-002', 'PUR-003', 'JV-003']);
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

// ── Rule 36 documentation checks ───────────────────────────────────────────
// These were previously gated on `tax > 0`. ITC is availed by debiting input
// GST, which is negative under Tally's sign convention, so that gate meant the
// checks never fired on a single genuine purchase. They now test the magnitude
// of the tax, and skip the row types where no supplier GSTIN can exist.

const itcRow = (over: Partial<ItcRow>): ItcRow => ({
  partyGstinUin: '27AABCB2345B1Z7',
  partyName: 'A Supplier',
  vchNo: 'BILL-1',
  date: '2025-05-08',
  taxable: -100000,
  igst: 0,
  cgst: -9000,
  sgst: -9000,
  tax: -18000,
  placeOfSupply: 'Maharashtra',
  reverseCharge: 'N',
  itcAvailability: 'Y',
  type: 'B2B',
  m3b: 'May',
  booksMonth: 'May',
  fy: '2025-26',
  postingDate: '2025-05-10',
  expenseLedgers: 'Purchase - Raw Material',
  voucherType: 'Purchase',
  voucherNumber: 'PUR-9',
  primaryGroup: 'Purchase Accounts',
  itcType: 'Inputs',
  narration: '',
  reviewFlag: '',
  guid: 'vch-test',
  ...over,
});

test('a B2B purchase claiming ITC without a valid GSTIN is flagged', () => {
  const blank = itcRow({ partyGstinUin: '', guid: 'blank' });
  const malformed = itcRow({ partyGstinUin: '27AABCA1234C1X5', guid: 'malformed' });
  const valid = itcRow({ partyGstinUin: '27AABCB2345B1Z7', guid: 'valid' });

  const issues = deriveItcIssues([blank, malformed, valid]);

  assert.deepEqual(issues.blankInvalidGstin.map((r) => r.guid), ['blank', 'malformed']);
});

test('the GSTIN check fires on a debit and on a reversal alike', () => {
  // A purchase debits input GST (negative); a credit note reversing ITC
  // credits it (positive). Both are rows where tax was booked.
  const purchase = itcRow({ tax: -18000, partyGstinUin: '', guid: 'purchase' });
  const reversal = itcRow({ tax: 18000, partyGstinUin: '', guid: 'reversal' });

  const issues = deriveItcIssues([purchase, reversal]);

  assert.deepEqual(issues.blankInvalidGstin.map((r) => r.guid), ['purchase', 'reversal']);
});

test('a blank GSTIN is not an exception where no supplier GSTIN can exist', () => {
  // RCM on an unregistered supplier is availed on a self-invoice under
  // s.31(3)(f); an import of services has no Indian GSTIN at all. Flagging
  // these would bury the B2B rows that genuinely put ITC at risk.
  const rcm = itcRow({ type: 'RCM-UR', partyGstinUin: '', reverseCharge: 'Y', guid: 'rcm' });
  const imported = itcRow({ type: 'IMPORTSERVICE', partyGstinUin: '', guid: 'import' });

  const issues = deriveItcIssues([rcm, imported]);

  assert.equal(issues.blankInvalidGstin.length, 0);
});

test('a row with no tax is a review item, not a Rule 36 exception', () => {
  const noTax = itcRow({ tax: 0, cgst: 0, sgst: 0, partyGstinUin: '', vchNo: '', guid: 'no-tax' });

  const issues = deriveItcIssues([noTax]);

  assert.deepEqual(issues.rcmReview.map((r) => r.guid), ['no-tax']);
  assert.equal(issues.blankInvalidGstin.length, 0, 'no ITC claimed, so nothing is at risk');
  assert.equal(issues.noInvoiceNumber.length, 0);
});

test('a missing invoice number on a taxed row is flagged', () => {
  const missing = itcRow({ vchNo: '', guid: 'missing' });
  const whitespace = itcRow({ vchNo: '   ', guid: 'whitespace' });
  const present = itcRow({ vchNo: 'BILL-1', guid: 'present' });

  const issues = deriveItcIssues([missing, whitespace, present]);

  assert.deepEqual(issues.noInvoiceNumber.map((r) => r.guid), ['missing', 'whitespace']);
});

test('the invoice-number check applies to every taxed row, including RCM', () => {
  // Unlike the GSTIN check, a document reference is required whatever the
  // supply type — the self-invoice has a number too.
  const rcm = itcRow({ type: 'RCM-UR', partyGstinUin: '', vchNo: '', guid: 'rcm' });

  const issues = deriveItcIssues([rcm]);

  assert.deepEqual(issues.noInvoiceNumber.map((r) => r.guid), ['rcm']);
  assert.equal(issues.blankInvalidGstin.length, 0);
});

test('rcmReview and the Rule 36 checks partition the rows by whether tax was booked', () => {
  const rows = [
    itcRow({ tax: -18000, guid: 'taxed' }),
    itcRow({ tax: 0, cgst: 0, sgst: 0, guid: 'untaxed' }),
  ];

  const issues = deriveItcIssues(rows);

  // Every row is either a review item or eligible for the Rule 36 checks;
  // none can be both, and none can fall through neither.
  assert.deepEqual(issues.rcmReview.map((r) => r.guid), ['untaxed']);
  assert.equal(issues.rcmReview.length + 1, rows.length);
});

test('on the fixture, only the genuine exception is reported', async () => {
  const store = await fixtureStore();
  const rows = getPurchaseITCRegister(store);
  const issues = deriveItcIssues(rows);

  // Three rows in the register carry tax and no GSTIN. Only one of them is an
  // exception, and telling them apart is the whole job:
  //   JV-002  RCM-UR         unregistered supplier, self-invoice  -> not an issue
  //   JV-005  IMPORTSERVICE  foreign supplier, no Indian GSTIN    -> not an issue
  //   PUR-003 B2B            domestic supplier, GSTIN not entered -> AT RISK
  assert.deepEqual(issues.blankInvalidGstin.map((r) => r.voucherNumber), ['PUR-003']);
  assert.equal(issues.noInvoiceNumber.length, 0);
});

// ── Import of services vs. a supplier GSTIN that was never filled in ───────
// On the tax lines alone these are indistinguishable: both carry IGST, no CGST
// and no GSTIN. Classifying the second as an import would move a real Rule 36
// exception into a bucket that is not checked for a GSTIN, so the register
// requires positive evidence (a non-Indian country on the party master) before
// calling anything an import.

test('a purchase from a foreign supplier is classified as an import of services', async () => {
  const store = await fixtureStore();
  const row = getPurchaseITCRegister(store).find((r) => r.voucherNumber === 'JV-005');

  assert.ok(row);
  assert.equal(row.type, 'IMPORTSERVICE');
  assert.equal(row.partyName, 'Omega Software Inc');
  assert.equal(row.partyGstinUin, '', 'a foreign supplier has no Indian GSTIN');
  assert.equal(row.igst, -36000);
  assert.equal(row.cgst, 0);
  assert.equal(row.sgst, 0);
  assert.equal(row.taxable, -200000);
  assert.equal(row.itcType, 'Input Services');
});

test('a domestic purchase with a missing GSTIN stays B2B and is reported', async () => {
  const store = await fixtureStore();
  const rows = getPurchaseITCRegister(store);
  const row = rows.find((r) => r.voucherNumber === 'PUR-003');

  assert.ok(row);
  // Kappa Traders is in Tamil Nadu, so IGST is correct, but the GSTIN was never
  // entered on the ledger. It looks exactly like the import above on the tax
  // lines, and must NOT be excused as one.
  assert.equal(row.type, 'B2B');
  assert.equal(row.partyGstinUin, '');
  assert.equal(row.igst, -27000);
  assert.equal(row.cgst, 0);

  assert.deepEqual(
    deriveItcIssues(rows).blankInvalidGstin.map((r) => r.voucherNumber),
    ['PUR-003'],
  );
});

test('the import branch does not swallow the registered inter-state purchase', async () => {
  const store = await fixtureStore();
  const row = getPurchaseITCRegister(store).find((r) => r.voucherNumber === 'PUR-002');

  // Zeta Machines is in Gujarat with a valid GSTIN: IGST, but plainly domestic.
  assert.equal(row?.type, 'B2B');
  assert.equal(row?.igst, -72000);
});
