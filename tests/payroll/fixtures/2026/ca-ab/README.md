# CRA 2026 Canada / Alberta Payroll Fixture Framework

Payroll-3B-5A — 2026-08-31.

This directory holds statutory calculation fixtures used by the
3B-5B calculator regression suite.

## Provenance policy

Every fixture file MUST carry the following metadata block:

```json
{
  "sourceAuthority": "CRA T4127 Payroll Deductions Formulas — 123rd Edition",
  "sourceEffectiveDate": "2026-07-01",
  "sourceUrl": "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
  "sourceRetrievedAt": "YYYY-MM-DD",
  "sourceRetrievedBy": "human-verified",
  "verificationNote": "Extracted manually from the linked CRA PDF on <date>; cross-checked against PDOC output."
}
```

## Fixture kinds

- `cpp/` — Canada Pension Plan (base + CPP2) expected results for a
  matrix of (period earnings, YTD earnings, pay frequency) triples.
- `ei/` — Employment Insurance expected employee premium results.
- `federal-tax/` — Federal withholding expected results for
  (period earnings, TD1F claim, pay frequency) triples.
- `ab-tax/` — Alberta withholding, same shape as federal.
- `pdoc/` — End-to-end fixtures capturing a full sample employee run
  through CRA's Payroll Deductions Online Calculator (PDOC).

## Forbidden

- No fixture may be authored from the Spectre calculator's own
  output (§24 — circular testing).
- No fixture may be derived from a blog post or third-party payroll
  summary.
- No fixture may be seeded here without a `sourceUrl` and a
  `sourceRetrievedAt` date.

## Status as of 2026-08-31

Fixtures are **empty pending official CRA source retrieval**. Spectre
cannot fetch canada.ca via automated tooling (403 Forbidden), so the
first batch of fixtures will land in a follow-up slice via human-
extracted PDF values pasted into these JSON files. Placeholders in
this directory do NOT constitute statutory authority.
