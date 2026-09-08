// FIFO debtor / creditor ageing.
//
// The module's whole claim is that it ages by actual knock-off rather than by
// invoice date, so the cases that matter are the ones where a receipt clears
// an older bill and leaves a newer one outstanding. Tally's built-in ageing
// gets exactly those wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureStore } from './helpers/fixtureStore';
import { ageParties, BUCKET_LABELS } from '../services/ageingFifo';

const AS_OF = '2026-03-31';

const entries = async () => (await fixtureStore()).getLedgerEntries();

test('debtor ageing clears the oldest bill first', async () => {
  const result = ageParties(await entries(), 'debtor', AS_OF);

  const alpha = result.parties.find((p) => p.party === 'Alpha Traders');
  assert.ok(alpha);

  // Alpha opens with 3,54,000, is invoiced 5,90,000 on 15-Apr-2025 and pays
  // 3,54,000 on 20-Jun-2025. FIFO applies that receipt to the OPENING bill,
  // so what remains outstanding is the April invoice, not the opening balance.
  assert.equal(alpha.outstanding, 590000);
  assert.equal(alpha.advance, 0);

  // 15-Apr-2025 to 31-Mar-2026 is 350 days.
  assert.equal(alpha.buckets['181-365'], 590000);
  assert.equal(alpha.buckets['0-30'], 0);
  assert.equal(alpha.buckets['>365'], 0);
});

test('a debtor with a single unpaid invoice ages from the invoice date', async () => {
  const result = ageParties(await entries(), 'debtor', AS_OF);

  const delta = result.parties.find((p) => p.party === 'Delta Enterprises');
  assert.ok(delta);
  assert.equal(delta.outstanding, 236000);
  // 12-Aug-2025 to 31-Mar-2026 is 231 days.
  assert.equal(delta.buckets['181-365'], 236000);
});

test('creditor ageing applies a payment to the opening bill', async () => {
  const result = ageParties(await entries(), 'creditor', AS_OF);

  const beta = result.parties.find((p) => p.party === 'Beta Industries');
  assert.ok(beta);

  // Opening 2,36,000, a fresh 2,36,000 bill on 10-May-2025, and a 2,36,000
  // payment in June. The payment clears the opening, leaving the May bill.
  assert.equal(beta.outstanding, 236000);
  // 10-May-2025 to 31-Mar-2026 is 325 days.
  assert.equal(beta.buckets['181-365'], 236000);
});

test('a recent creditor bill lands in a short bucket', async () => {
  const result = ageParties(await entries(), 'creditor', AS_OF);

  const zeta = result.parties.find((p) => p.party === 'Zeta Machines');
  assert.ok(zeta);
  assert.equal(zeta.outstanding, 472000);
  // 20-Jan-2026 to 31-Mar-2026 is 70 days.
  assert.equal(zeta.buckets['61-90'], 472000);
  assert.equal(zeta.buckets['181-365'], 0);
});

test('ageing totals agree with the balance sheet', async () => {
  const rows = await entries();

  const debtors = ageParties(rows, 'debtor', AS_OF);
  const creditors = ageParties(rows, 'creditor', AS_OF);

  // These must tie to Trade Receivables / Trade Payables on the face of the
  // balance sheet. A FIFO bug that dropped or duplicated a bill would break
  // the tie even while each individual party still looked plausible.
  assert.equal(debtors.grandOutstanding, 826000);
  assert.equal(creditors.grandOutstanding, 848000);
});

test('bucket totals reconcile to the outstanding total on each side', async () => {
  const rows = await entries();

  for (const side of ['debtor', 'creditor'] as const) {
    const result = ageParties(rows, side, AS_OF);
    const bucketSum = BUCKET_LABELS.reduce((s, k) => s + result.totals[k], 0);
    assert.equal(
      bucketSum,
      result.grandOutstanding,
      `${side} buckets do not sum to the outstanding total`,
    );
  }
});

test('only the correct side of the ledger is picked up', async () => {
  const rows = await entries();

  const debtors = ageParties(rows, 'debtor', AS_OF);
  const creditors = ageParties(rows, 'creditor', AS_OF);

  assert.deepEqual(
    debtors.parties.map((p) => p.party).sort(),
    ['Alpha Traders', 'Delta Enterprises'],
  );
  assert.deepEqual(
    creditors.parties.map((p) => p.party).sort(),
    ['Beta Industries', 'Epsilon Legal', 'Gamma Consultants', 'Zeta Machines'],
  );
});

test('an as-of date before a bill excludes it from the ageing', async () => {
  const rows = await entries();

  // Zeta's bill is dated 20-Jan-2026. Ageing as at 31-Dec-2025 must not see it.
  const result = ageParties(rows, 'creditor', '2025-12-31');
  assert.equal(result.parties.find((p) => p.party === 'Zeta Machines'), undefined);
  assert.equal(result.grandOutstanding, 848000 - 472000);
});
