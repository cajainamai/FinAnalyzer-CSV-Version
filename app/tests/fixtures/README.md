# Test fixture: Meridian Components Private Limited

A small, complete, synthetic set of books used by every test under `app/tests`.
No client data: every party, GSTIN, PAN and amount here is invented.

`tally-export/` holds one CSV per table, the same layout the current Tally
Standard Format (TSF) export produces. `tests/helpers/fixtureStore.ts` zips
these in memory and feeds the blob to the real `TallyStore.fromZip`, so the
tests exercise the production import path (JSZip, PapaParse, table parsers,
store ingestion) rather than a stub.

**Why CSVs and not a committed `.zip`:** a zip is opaque in review. When a test
asserts that trade payables are ₹12,25,000, a reviewer has to be able to see
where that comes from. A second benefit is that the CSV path never reaches the
SheetJS reader, which carries the open advisories noted in `SECURITY.md`.

---

## The company

| | |
|---|---|
| Name | Meridian Components Private Limited |
| Financial year | 2025-26 (01-Apr-2025 to 31-Mar-2026) |
| Ledgers | 35 |
| Groups | 14 |
| Vouchers | 13 |
| Accounting lines | 41 |
| Trial balance total | ₹60,04,000 Dr = ₹60,04,000 Cr |
| Balance sheet | ₹47,54,000 on both sides |
| Result for the year | Loss of ₹5,50,000 |

Revenue ₹7,00,000 against expenses ₹12,50,000 (purchases ₹3,50,000,
professional fees ₹1,00,000, legal ₹50,000, rent ₹3,00,000, software
₹2,00,000, depreciation ₹2,50,000). The loss exceeds the opening reserve, so
Reserves & Surplus closes negative at ₹-50,000, which is what an accumulated
loss looks like on the face of the balance sheet.

## Sign convention (read this before changing any amount)

Amounts follow Tally's own convention, which the whole application is built on:

- **A debit is negative. A credit is positive.**
- `mst_ledger.opening_balance` is signed the same way, so an asset opens
  negative.
- `closing_balance` on every ledger equals `opening_balance` plus the sum of
  that ledger's `trn_accounting.amount` rows. The tests assert this.

Two independent places in the codebase confirm this: `getTrialBalance` treats
`amount < 0` as Dr, and `ageingFifo` comments that "debtor invoice is a debit
(negative)".

## What each voucher is there to exercise

| Voucher | Date | What it covers |
|---|---|---|
| INV-001 Sales | 15-Apr-2025 | Intra-state sale, CGST + SGST, stock item with its own HSN and rate |
| PUR-001 Purchase | 10-May-2025 | B2B input credit, supplier invoice no. and date differing from the voucher's |
| PMT-001 Payment | 05-Jun-2025 | Clears a creditor's **opening** bill, so FIFO has something to knock off |
| RCP-001 Receipt | 20-Jun-2025 | Clears a debtor's **opening** bill |
| JV-001 Journal | 31-Jul-2025 | TDS u/s 194J; TDS sits under Duties & Taxes but must not read as GST |
| INV-002 Sales | 12-Aug-2025 | Inter-state sale, IGST |
| JV-002 Journal | 15-Sep-2025 | RCM on an unregistered supplier: input legs are credit, payable legs are not |
| JV-004 Journal | 05-Oct-2025 | TDS u/s 194I, expense with no GST at all |
| CON-001 Contra | 10-Nov-2025 | Bank to cash, touches no P&L head |
| JV-005 Journal | 05-Dec-2025 | Import of services from a foreign supplier: IGST, no GSTIN |
| PUR-002 Purchase | 20-Jan-2026 | Capital goods, IGST, classified Capital Goods not Inputs |
| PUR-003 Purchase | 14-Feb-2026 | Inter-state purchase whose supplier GSTIN was never entered |
| JV-003 Journal | 31-Mar-2026 | Year-end depreciation, dated so date-window filters can be tested |

### The pair that has to be told apart

JV-005 and PUR-003 are the reason the fixture carries a `mailing_country`
column. On the tax lines alone they are **identical**: both carry IGST, no
CGST, and no supplier GSTIN.

| | JV-005 | PUR-003 |
|---|---|---|
| Supplier | Omega Software Inc | Kappa Traders |
| Country | United States | India |
| Classified as | `IMPORTSERVICE` | `B2B` |
| Rule 36 GSTIN exception? | No, a foreign supplier has no Indian GSTIN | **Yes, the GSTIN was simply never entered** |

Only the party master separates them. Treating PUR-003 as an import would move
a genuine exception into a bucket that is never checked for a GSTIN, and it
would disappear from the working papers. A blank country is deliberately **not**
treated as evidence of an import: that leaves the voucher as B2B, where a
missing GSTIN gets reported. That is the safe direction to be wrong in.

## Deliberate imperfections

The fixture is not a clean set of books, on purpose. Two exceptions are built
in so the diagnostics that detect them stay covered:

1. **Stock register does not tie to the ledger.** `mst_stock_item` values stock
   at ₹4,16,000 but there is no Stock-in-Hand ledger, which is what a company
   that never passes a closing-stock journal looks like. This raises
   `STOCK_REGISTER_MISMATCH`. The balance sheet uses the ledger figure and
   still balances.
2. **Depreciation booked straight against the asset.** JV-003 credits Plant &
   Machinery rather than an accumulated-depreciation ledger, so the fixed-asset
   schedule shows no charge while the P&L shows ₹2,50,000. This raises
   `DEPR_MISMATCH`.

Stock items also cover the GST enrichment fallback: `Precision Bearing 6205`
carries its own rate and HSN on the item master, while `Steel Rod 12mm` leaves
both blank so they have to be back-filled from `mst_gst_effective_rate`
(CGST 9% + SGST 9% resolving to an 18% slab).

## Changing the fixture

Any change to an amount ripples into the assertions. The guard rails:

- `tallyStore.test.ts` asserts every voucher nets to zero and that opening
  balances net to zero across the ledger master.
- `trialBalance.test.ts` asserts the trial balance balances and that each
  ledger's closing reconciles to the master.
- `balanceSheet.test.ts` asserts the Schedule III statement balances.

So if you change a figure and only one test fails, look again: a genuine
change to the books should move several numbers together. Shared figures live
in the `FIXTURE` constant in `tests/helpers/fixtureStore.ts` rather than being
repeated across files.

To check the fixture is self-consistent after an edit:

```bash
cd app && npm run test:units
```
