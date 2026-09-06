# Canadian Statutory Treatment Library — SPECTRE_LIBRARY

**Payroll-3C-3C (2026-09-09)** · Founder-approved: pending 3C-3C acceptance.

## What SPECTRE_LIBRARY is

A code-only registry of verified Canadian payroll rules that a
`PayrollComponent` may claim as its statutory-treatment source. Each
rule is versioned, effective-dated, jurisdiction-scoped, and carries
its authoritative CRA source metadata. Snapshots freeze the rule
provenance at PREPARE time so historical batches can explain "why was
this taxable?" without re-reading live library code.

## What SPECTRE_LIBRARY is NOT

- Not CRA certification. The label means **"Spectre-maintained rule
  based on authoritative published guidance"**, not "CRA-approved".
- Not tenant-editable. A rule addition requires a code + PR change.
- Not a substitute for plan-specific fact-finding. Some rules depend
  on plan attributes (e.g. RRSP withdrawal restrictions) that must be
  founder-confirmed for each Club.

## Adding a rule

1. Read the authoritative CRA source in full (e.g. T4130 chapter).
2. Append a `StatutoryLibraryRule` entry to `RULES` in
   [src/lib/payroll/statutory-library.ts](../src/lib/payroll/statutory-library.ts)
   with `sourceTitle`, `sourceReference`, `sourceLastVerifiedAt`, and a
   `notes` block that summarises the CRA condition being modelled.
3. Add a targeted test in `tests/payroll/statutory-library-3c3c.test.ts`
   asserting `findLibraryRule` resolves the key on a valid pay date and
   returns the expected directional effects.
4. Update this document with the new rule row.

## Currently registered rules

| ruleKey | variant | tax | CPP | EI | cashExpectation | source |
|---|---|---|---|---|---|---|
| `CA-ER-AD-AND-D-PREMIUM-V1` | DEFAULT | ADD | ADD | NONE | NO_NET_PAY_EFFECT | CRA T4130 — Employer-paid AD&D non-cash taxable benefit |
| `CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1` | DEFAULT | ADD | ADD | NONE | NO_NET_PAY_EFFECT | CRA T4130 — Group term life insurance policies |
| `CA-ER-GROUP-RRSP-CONTRIBUTION-WITHDRAWABLE-V1` | RRSP_WITHDRAWABLE | ADD | ADD | ADD | NO_NET_PAY_EFFECT | CRA T4130 — Group RRSP, withdrawable variant |
| `CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1` | RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION | ADD | ADD | NONE | NO_NET_PAY_EFFECT | CRA T4130 — Group RRSP, withdrawal-restricted variant |

## Components still CUSTOM / CUSTOM_PENDING

| code | current source | reason pending |
|---|---|---|
| `CELL_PHONE_ALLOWANCE` | CUSTOM | §13 — actual arrangement (flat allowance vs. reimbursement vs. accountable business-use reimbursement) must be founder-confirmed. Present treatment (taxable + CPP, non-EI) reflects the source paystub structure but is not independently reconciled to CRA guidance for a cash allowance. |
| `DEPENDENT_LIFE_ER_PREMIUM` | CUSTOM | §6 — CRA guidance is not sufficiently specific without knowing the exact policy wording. Marked CUSTOM_PENDING_VERIFICATION until Silver Springs plan is confirmed. |
| `RRSP_EE` | CUSTOM_TEST | §11 — employee-side RRSP tax-at-source deduction depends on whether the employer has reasonable grounds to believe the contribution is deductible at source. Current test treatment stops at cash-decrease with statutory effects = NONE. |
| `LTD_EE` | CUSTOM | §12 — employee LTD taxability depends on plan funding (employee-pay-all vs. shared vs. employer-funded). Kept CUSTOM until plan facts are confirmed. |

## Provenance freeze

Every snapshot row carries the resolved rule identity + version +
source authority + source title + source reference at PREPARE time.
A later library-code change does not mutate historical snapshots —
this is the "historical immutability" guarantee (§16 + §17 of the
3C-3C brief).

## Club-specific questions the founder still needs to answer

1. **Silver Springs group RRSP withdrawal restrictions** — required
   to promote `RRSP_ER` from the synthetic RESTRICTED test variant to
   a Club-confirmed configuration.
2. **Dependent Life policy type** — required to move
   `DEPENDENT_LIFE_ER_PREMIUM` from CUSTOM_PENDING to a SPECTRE_LIBRARY
   rule.
3. **Cell-phone arrangement** — flat allowance, reimbursement,
   employer-paid phone, or accountable business-use reimbursement.
4. **LTD plan funding** — employee-pay-all, employer-paid, or shared.
