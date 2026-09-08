// Builds a TallyStore from the committed CSV fixture.
//
// The fixture is stored as one CSV per table (the current TSF export layout)
// rather than as a binary .zip so that every number in it is reviewable in a
// diff. This helper zips those CSVs in memory and hands the blob to the real
// `TallyStore.fromZip`, so tests exercise the production import path end to
// end: JSZip -> PapaParse -> tableParsers -> store ingestion.
//
// Zipping in memory (rather than committing a .zip) has a second benefit: the
// CSV path never touches the SheetJS reader, which carries the open advisories
// documented in SECURITY.md.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { TallyStore } from '../../services/tally';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = join(here, '..', 'fixtures', 'tally-export');

/** Zip the fixture CSVs in memory, exactly as a Tally export ZIP would look. */
export const buildFixtureZip = async (): Promise<Blob> => {
  const zip = new JSZip();
  for (const file of readdirSync(FIXTURE_DIR)) {
    if (!file.endsWith('.csv')) continue;
    zip.file(file, readFileSync(join(FIXTURE_DIR, file)));
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return new Blob([buf]);
};

// One store shared across every test in a file. The store is immutable once
// built and each test only reads from it, so building it once keeps the suite
// fast without letting tests leak state into each other.
let cached: Promise<TallyStore> | null = null;

export const fixtureStore = (): Promise<TallyStore> => {
  if (!cached) cached = buildFixtureZip().then((blob) => TallyStore.fromZip(blob));
  return cached;
};

// ── Figures asserted across the suite ──────────────────────────────────────
// Declared once here so a deliberate change to the fixture updates one place
// and every test that depends on the number moves with it. A test that hard-
// codes a number instead is asserting something specific to that test.
export const FIXTURE = {
  companyName: 'Meridian Components Private Limited',
  periodFrom: '2025-04-01',
  periodTo: '2026-03-31',

  ledgerCount: 35,
  groupCount: 14,
  voucherCount: 13,
  accountingLineCount: 41,

  // getLedgerEntries() emits one row per accounting line, plus one master row
  // per ledger that never appears in a transaction (Share Capital, General
  // Reserve, HDFC Term Loan, Profit & Loss A/c).
  shimTransactionRows: 41,
  shimMasterRows: 4,

  // Trial balance, in rupees. Dr and Cr are equal by construction.
  trialBalanceTotal: 6004000,

  // Revenue 7,00,000 less expenses 12,50,000 (purchases 3,50,000, professional
  // 1,00,000, legal 50,000, rent 3,00,000, software 2,00,000, depreciation
  // 2,50,000).
  netLoss: 550000,
} as const;
