# Security Notes

FinAnalyzer runs entirely on the user's machine. There is no server, no
telemetry and no upload path, so the threat model is narrow: the only
untrusted input is the **file the user opens**, and the realistic attacker is
a malicious or malformed Tally export ZIP / spreadsheet handed to an auditor
by a client.

That makes the spreadsheet parser the one component worth tracking.

---

## Open advisory: `xlsx` (SheetJS) 0.18.5

`npm audit --omit=dev` reports one high-severity finding, with **no fix
available on npm**:

| Advisory | Type |
|---|---|
| [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) | Prototype pollution |
| [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) | Regular expression denial of service (ReDoS) |

Both were fixed upstream in SheetJS **0.20.2**. There is no fixed version on
the npm registry because SheetJS stopped publishing to npm after 0.18.5 and
now distributes from `cdn.sheetjs.com`. So `npm audit fix` cannot resolve
this, and it will keep reporting until the dependency is repointed.

### Actual exposure in this codebase

Both advisories affect the **parse** path (`XLSX.read`), not the write path.
The two spreadsheet packages here are used asymmetrically:

| Package | Used for | Reads untrusted input? |
|---|---|---|
| `xlsx` (0.18.5) | Parsing, plus the TSF-raw-to-Excel writer | **Yes** |
| `xlsx-js-style` (1.2.0) | Styled workbook export only, 25 call sites, zero `read` calls | No |

The reachable parse sites are:

- `app/services/tally/unzip.ts`: parses `.xlsx` table files inside a
  user-supplied Tally export ZIP (legacy XLSX-per-table layout).
- `app/services/dataService.ts`: parses a user-supplied workbook.

Write-only, therefore not exposed by these advisories:

- `app/vite.config.ts` and `app/desktop-backend/backend.cjs`: both only call
  `json_to_sheet` / `book_append_sheet` / `write` for the TSF raw export.

So the exposure is real rather than theoretical (a hostile ZIP is a plausible
delivery route in an audit context), but it is confined to import, and it
requires the user to actively open the malicious file. Nothing is parsed in
the background and nothing is ever fetched from the network.

`xlsx-js-style` is a fork of the same vulnerable 0.18.5 base and is itself
unmaintained. Because it is never handed untrusted bytes here, it is not
currently a vulnerability, but it should not be given a `read` call without
revisiting this note.

### Remediation options

**Option 1: repoint `xlsx` to the vendor CDN build (upstream's recommendation).**

```bash
cd app
npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

This resolves both advisories, and the API is source-compatible with the
calls used here, so no application code changes.

The tradeoff is distribution, and it matters for this project specifically:
`npm install` would then need to reach `cdn.sheetjs.com` rather than only the
npm registry. The README already documents that corporate proxies block the
install step for some users, and CI would need the same host reachable. For a
tool whose install story is "double-click and it works", that is a real cost
and the reason this has not been applied unilaterally.

**Option 2: migrate exports to `exceljs` and drop both SheetJS packages.**

Larger change (25 export call sites plus the styling helpers in
`app/services/excelStyles.ts`), but it ends the dependency on an unmaintained
fork and an off-registry package in one move. Best done per module rather
than as a single sweep, so each workbook's formatting can be compared against
the previous output.

**Option 3: accept and contain (current state).**

Keep 0.18.5, and treat it as a documented, scoped risk. If you take this
route, the containment that costs nothing is to prefer the **CSV-per-table**
Tally export layout over the legacy XLSX-per-table one, since CSV files are
parsed by `papaparse` and never reach the SheetJS reader at all.

### CI behaviour

`.github/workflows/ci.yml` runs `npm audit --omit=dev` and reports the result
without failing the build. Enforcing it today would block every pull request
with no available remedy. Once one of the options above is applied, drop the
`|| true` from the audit step so regressions do go red.

---

## Client data handling

Confirmed by inspection, and worth restating because it is what makes the
tool usable on live client books:

- No network egress in the analysis path. No licence check, no crash
  reporting, no analytics.
- Data lives in memory for the session, or in a local `audit.sqlite`.
- `.gitignore` blocks `*.TSF`, `*.tsf`, `returns_R2B_*.json`, `TrialBal.pdf`
  and dashboard exports from being committed.

If you add a module that writes intermediate files, add its output pattern to
`.gitignore` in the same commit. A committed working paper is a client
confidentiality breach, not just a messy repo.

---

## Reporting

This is a fork for private practice use. Raise anything security-relevant as
an issue on this repository, and if it concerns upstream code, also report it
at [`dhruvdua88/FinAnalyzer-CSV-Version`](https://github.com/dhruvdua88/FinAnalyzer-CSV-Version/issues).
