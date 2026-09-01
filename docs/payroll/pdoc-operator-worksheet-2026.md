# PDOC Operator Worksheet — 2026 Alberta Payroll Golden Fixtures

**Purpose:** the 3B-5B-2 calculator cannot be implemented until four independently-sourced CRA PDOC gross-to-net expected results are captured. Per Payroll-3B-5B-1d §10-11, the Spectre development environment cannot interact with CRA PDOC directly (canada.ca returns HTTP 403 to automated fetches), so a human operator must run each scenario through PDOC and paste the outputs verbatim.

**Do NOT** compute expected values from Spectre or from any Claude formula. Only the PDOC output is authoritative per §10.

---

## Operator instructions

1. Open CRA PDOC: https://apps.cra-arc.gc.ca/ebci/rhpd/beta/entry
2. For each of the four scenarios below, select the inputs exactly as specified.
3. Copy PDOC's calculated values from its results page.
4. Open the fixture file at [tests/payroll/fixtures/2026/ca-ab/pdoc-gross-to-net-2026.json](../../tests/payroll/fixtures/2026/ca-ab/pdoc-gross-to-net-2026.json).
5. Replace every `SOURCE_PENDING_PDOC_TRANSCRIPTION` in the matching case's `expected` block with the PDOC value.
6. Update the file's top-level `sourceRetrievedAt` (YYYY-MM-DD) and `sourceRetrievedBy` (use `HUMAN_OPERATOR`; do NOT store your name).
7. Commit the file with message: `chore(payroll): transcribe 4 CRA PDOC fixtures for 2026 Alberta`.
8. Push to `origin/payroll-3b`.

---

## Scenario 1 — `pdoc-basic-hourly-biweekly-alberta-h1`

Basic ordinary Alberta hourly Employee, biweekly, mid-year 2026 H1, no prior YTD, default TD1 (federal BPA + Alberta BPA only), no additional tax.

| PDOC field | Enter |
|-|-|
| Province of employment | Alberta |
| Pay period date | **2026-03-13** (H1 window — any Jan 1 – Jun 30 2026 date; use this to match the fixture) |
| Pay frequency | Biweekly (26 pay periods per year) |
| Gross remuneration | **$2,000.00** |
| Pensionable earnings | 2,000.00 |
| Insurable earnings | 2,000.00 |
| Federal TD1 total claim (Line 13) | **16,452** (federal BPA — 2026 maximum) |
| Alberta TD1 total claim (Line 13) | **22,769** (Alberta BPA — 2026) |
| Additional federal tax to be deducted | 0 |
| Additional provincial tax to be deducted | 0 |
| Prior YTD pensionable earnings | 0 |
| Prior YTD insurable earnings | 0 |
| CPP contributions received prior in year (from this employer) | 0 |
| EI premiums received prior in year (from this employer) | 0 |

Capture from PDOC:
- CPP contribution (employee)
- CPP2 contribution (if any)
- EI premium (employee)
- Federal income tax
- Provincial income tax
- Total deductions
- Net pay

---

## Scenario 2 — `pdoc-custom-td1-alberta-h2`

Alberta Employee with a NON-BPA-only TD1 claim (higher federal TCP + higher Alberta TCP).

| PDOC field | Enter |
|-|-|
| Province of employment | Alberta |
| Pay period date | **2026-09-11** (H2 window) |
| Pay frequency | Biweekly (26) |
| Gross remuneration | **$2,000.00** |
| Federal TD1 total claim | **20,000** |
| Alberta TD1 total claim | **26,000** |
| Additional federal tax | 0 |
| Additional provincial tax | 0 |
| Prior YTD | 0 across the board |

Capture the same 7 output fields as Scenario 1.

---

## Scenario 3 — `pdoc-additional-tax-alberta`

Alberta Employee whose TD1 requests additional per-pay tax on both federal and provincial.

| PDOC field | Enter |
|-|-|
| Province of employment | Alberta |
| Pay period date | **2026-04-24** (H1 window) |
| Pay frequency | Biweekly (26) |
| Gross remuneration | **$2,000.00** |
| Federal TD1 total claim | **16,452** (federal BPA) |
| Alberta TD1 total claim | **22,769** (Alberta BPA) |
| Additional federal tax per pay | **$50.00** |
| Additional provincial tax per pay | **$25.00** |
| Prior YTD | 0 |

Capture the same 7 output fields. **Also confirm:** the federal tax output should equal (Scenario 1 federal tax + $50.00), and Alberta tax should equal (Scenario 1 Alberta tax + $25.00). This confirms the "added AFTER `T4`" contract.

---

## Scenario 4 — `pdoc-zero-claim-more-than-one-employer`

Alberta Employee with the federal TD1 "more than one employer/payer" checkbox → federal claim = 0 (no BPA credit).

| PDOC field | Enter |
|-|-|
| Province of employment | Alberta |
| Pay period date | **2026-05-08** (H1 window) |
| Pay frequency | Biweekly (26) |
| Gross remuneration | **$2,000.00** |
| Federal TD1 total claim | **0** (zero — no BPA) |
| Alberta TD1 total claim | **22,769** (Alberta BPA remains) |
| Additional federal tax | 0 |
| Additional provincial tax | 0 |
| Prior YTD | 0 |

Capture the same 7 output fields. **Also confirm:** the federal tax output should be MATERIALLY HIGHER than Scenario 1 (because the BPA credit is not being applied).

---

## Fixture format reference

Each case in [pdoc-gross-to-net-2026.json](../../tests/payroll/fixtures/2026/ca-ab/pdoc-gross-to-net-2026.json) currently contains:

```json
{
  "id": "pdoc-basic-hourly-biweekly-alberta-h1",
  "inputs": { ...as above... },
  "expected": {
    "cppEeBase": "SOURCE_PENDING_PDOC_TRANSCRIPTION",
    "cppEeFirstAdd": "SOURCE_PENDING_PDOC_TRANSCRIPTION",
    ...
  }
}
```

Replace every `SOURCE_PENDING_PDOC_TRANSCRIPTION` with the exact PDOC value as a decimal string (e.g. `"105.75"`).

For CPP components: PDOC reports the combined CPP amount. Set `cppEeCombined` to that value. The individual `cppEeBase` and `cppEeFirstAdd` split values can be derived via:
- `cppEeBase = round(cppEeCombined × (0.0495 / 0.0595), 2, HALF_UP)`
- `cppEeFirstAdd = cppEeCombined − cppEeBase`

This split is the Spectre §17 decomposition rule (verified against CRA K2 formula). Since PDOC does not report the split directly, the fixture accepts the derived split — the CRA-authoritative value is `cppEeCombined`.

---

## After transcription

Verify by running:

```
npx vitest run tests/payroll/cra-closure.test.ts
```

The `pdoc-fixture-integrity` test (currently marked `.todo`) should be un-`.todo`'d in the same commit; it enforces that no `SOURCE_PENDING_PDOC_TRANSCRIPTION` or `AWAITING_VERIFICATION` markers remain in the four required scenarios.

Once transcription is complete and pushed, Payroll-3B-5B-2 can begin.
