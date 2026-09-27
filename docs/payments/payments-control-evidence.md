# Spectre Payments — Control Evidence

**Version:** 2026-09-26 (PAY-1C/1)
**Purpose:** answer, for each control in
`payments-control-register.md`:
- What is the control?
- Where is it implemented?
- How is it tested?
- What was the latest result?
- What evidence proves it?

**Regeneration:** the evidence rows below are refreshed by re-running
the referenced test suite and pasting the resulting pass count. This
document is NOT hand-maintained prose — it is a report of test
reality.

## How to regenerate

```
npm run typecheck
npx vitest run tests/payments/
npx playwright test tests/e2e/pay1a1-deployed-lifecycle.staging.spec.ts \
                    tests/e2e/pay1a1-return-scenario.staging.spec.ts \
                    tests/e2e/pay1a2-timeout-retry.staging.spec.ts \
                    tests/e2e/pay1b-staging-scenarios.staging.spec.ts \
                    tests/e2e/pay1b1-outage-scenario.staging.spec.ts
```

Then copy the pass counts into the tables below.

## Unit / integration evidence (as of PAY-1C closeout)

| Suite | Pass count | Controls exercised |
|---|---:|---|
| `pay1a1-primitives.test.ts` | 21 | A-02, A-03, B-01, B-02, B-03, F-04, G-03 |
| `pay1a1-cross-tenant.test.ts` | 7 | F-02 |
| `pay1a2-payroll-handoff.test.ts` | 8 | B-02, E-01 |
| `pay1a2-retry.test.ts` | 21 | B-04, C-04, C-05 |
| `pay1a3-authorization.test.ts` | 6 | A-01, A-02, A-03, A-04 |
| `pay1a4-provider-accounting.test.ts` | 14 | B-05, E-01, E-02, E-03 |
| `pay1b1-connection-controls.test.ts` | 6 | C-01, C-02, F-04, G-02 |
| `pay1b1-simulator-conformance.test.ts` | (harness) | C-05, D-04 |
| `pay1b2-connection.test.ts` | 8 | F-01, F-04 |
| `pay1b3-external-events.test.ts` | 10 | D-01, D-02, D-03, D-04, E-04 |
| `pay1b4-exceptions-health.test.ts` | 4 | G-01, G-04 |
| `pay1c1-incident.test.ts` | 7 | G-05 |
| `pay1c2-rail-mapping.test.ts` | 7 | F-03 (canonical), rail-neutral projection |
| `pay1c3-limits.test.ts` | 7 | G-06 |
| `pay1c3-duplicate-guard.test.ts` | 4 | B-06 |
| `pay1c4-certification.test.ts` | 6 | G-07 |
| `pay1c4-production-gate.test.ts` | 6 | G-08 |
| **Total** | **131** | — |

## E2E / staging evidence

| Spec | What it proves | Status |
|---|---|---|
| `pay1a1-deployed-lifecycle.staging.spec.ts` | Two-actor lifecycle end-to-end on Coulee Ridge staging tenant. | Accepted at PAY-1A.1 closeout. |
| `pay1a1-return-scenario.staging.spec.ts` | Return accounting via webhook. | Accepted at PAY-1A.1 closeout. |
| `pay1a2-timeout-retry.staging.spec.ts` | Ambiguous-outcome retry preserves economic identity. | Accepted at PAY-1A.2 closeout. |
| `pay1b-staging-scenarios.staging.spec.ts` | External event Scenarios A–F. | Accepted at PAY-1B closeout. |
| `pay1b1-outage-scenario.staging.spec.ts` | Provider outage (Scenario G) preserves authorized payments; recovery reintroduces one economic payment. | Accepted at PAY-1B.1 closeout. |
| `pay1c-staging-scenarios.staging.spec.ts` | PAY-1C scenarios A–G — limits refusal, duplicate guard, incident containment, recovery, canonical rail mapping, deterministic correlation, production gate. | This slice. |

## Evidence rules

1. A control row missing from the register is missing from this
   document.
2. A row here with a pass count of `0` or a failing spec is a
   control failure — it is not "documentation drift".
3. The E2E specs run against the **deployed** staging image. A
   deployment that has not been rolled out cannot be cited here.
4. This document does not vouch for controls Spectre has not
   implemented (real-money execution, real sponsor rail
   connectivity). Those are named as unknowns in
   `external-unknown-register.md`, not as controls.
