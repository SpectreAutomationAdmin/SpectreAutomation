# Spectre Payments — Incident Response

**Version:** 2026-09-26 (PAY-1C/1)
**Applies to:** Payment INCIDENTS (see distinction below). Ordinary
operational exceptions follow `payment-operations-runbook.md`.

## What is a payment incident?

An **operational exception** is a single-payment condition that
needs human review — a return, an amount mismatch on one event, a
single verification failure. It rides Work Intake and is resolved
by one operator.

A **payment incident** is a wider event — a provider outage
affecting many payments, a suspected duplicate execution, a pattern
of callback-verification failures, a credential compromise, a
reconciliation discrepancy. It requires containment, reconstruction,
and (where applicable) regulatory assessment by humans.

Rule of thumb: one returned payment is not an incident. Ten
returned payments in an hour with a common cause is.

---

## Lifecycle

```
DETECTED  →  TRIAGED  →  CONTAINED  →  INVESTIGATING  →  RECOVERED  →  RESOLVED
```

Timestamps are recorded on every transition (`triagedAt`,
`containedAt`, etc.) and the timeline JSON is append-only.

## Categories

| Category | Typical trigger | Default severity |
|---|---|---|
| `PROVIDER_OUTAGE` | Connection flipped DEGRADED; many payments affected. | SEV-2 |
| `WIDESPREAD_SUBMISSION_FAILURE` | Bulk submission failure across a tenant/rail. | SEV-2 |
| `SUSPECTED_DUPLICATE_EXECUTION` | Two Spectre instructions appear to reference the same rail execution. | SEV-1 |
| `UNAUTHORIZED_ATTEMPT` | Submission attempted by an actor without SoD-clean authorization chain. | SEV-1 |
| `CREDENTIAL_COMPROMISE` | Possible KMS / connection credential leak. | SEV-1 |
| `CALLBACK_VERIFICATION_ATTACK` | Burst of `verificationStatus = FAILED` events. | SEV-1 |
| `RECONCILIATION_DISCREPANCY` | Bank feed vs. Spectre authorized amounts do not match. | SEV-2 |
| `ACCOUNTING_INTEGRITY_FAILURE` | Amount / currency mismatch on VERIFIED event. | SEV-1 |
| `CROSS_TENANT_EVENT` | External event resolves to instruction on a different tenant. | SEV-1 |
| `DATA_INTEGRITY_EVENT` | PaymentInstruction / PaymentAuthorization state impossible under normal transitions. | SEV-1 |
| `SETTLEMENT_ANOMALY` | Settlement received without corresponding submission chain. | SEV-1 |

## Severity

- **SEV-1** — money potentially moved incorrectly, ability to
  determine outcome compromised, security event, or a whole tenant
  is blocked.
- **SEV-2** — many payments affected, but no incorrect money
  movement suspected.
- **SEV-3** — smaller scale, contained impact.
- **SEV-4** — informational; incident record for reconstruction only.

Severity is a Spectre operational label. `regulatoryAssessmentRequired`
is a separate boolean set by operators for legal / counsel triage.
Spectre never sets a legal reporting obligation automatically.

## Detect

- **Automated** — provider health circuit-breaker flip; verification
  failure burst; reconciliation module exception.
- **Operator** — flagged manually via Work Intake / operations
  console.
- **Callback verification** — signature validation failed with a
  pattern implying attack.
- **Reconciliation** — three-way match cannot be produced (once
  bank-feed reconciliation exists post-PAY-1D).

## Triage

Open the incident via `openIncident(...)`. Link every affected
`PaymentRun`, `PaymentInstruction`, `PROVIDER_CONNECTION`,
`ExternalPaymentEvent`, and `WORK_INTAKE_ITEM` via
`linkIncidentEntities`.

## Contain

Containment goes through **existing controls**:

- `setConnectionStatus(SUSPENDED)` — a provider or tenant-specific
  rail.
- Global `PAYMENTS_ENABLED = false` (kill switch) — only in a
  platform-wide event; requires founder authorization.
- `PAYMENTS_REAL_MONEY_ENABLED = false` — for real-money contexts
  post-PAY-1D. Staging remains locked to false; a production event
  requires founder authorization.

Containment MUST NOT:
- delete a `PaymentInstruction` / `PaymentRun`;
- cancel a payment for which the outcome is UNKNOWN;
- reverse payroll to "undo" a payment;
- create speculative accounting.

## Investigate

Reconstruct via the linked entities' `PaymentEvent` stream +
`ExternalPaymentEvent` rows + incident timeline. Both are immutable
and append-only.

## Recover

- Provider outage: wait for health recovery, then resume submissions
  (existing `pollAndAdvance` handles ambiguous-outcome resolution).
- Duplicate concern: work with the sponsor / rail counterparty to
  reverse the unwanted execution; open a **new authorized** payment
  if a corrective transfer is needed. NEVER modify the original
  instruction.
- Credential compromise: rotate credentials via new
  `PaymentProviderConnectionVersion`.

## Resolve

Transition the incident to `RESOLVED`. Timeline note MUST describe
what closed the incident (e.g. "sponsor confirmed reversal executed
2026-11-02"). `regulatoryAssessmentRequired` flag remains on the row
regardless — resolution is Spectre-operational; legal reporting is
tracked separately.

## Regulatory assessment

Spectre records `regulatoryAssessmentRequired` as an operator
signal. It does NOT:
- notify the Bank of Canada;
- notify FINTRAC;
- notify Payments Canada;
- notify a sponsor bank;
- notify affected members / employees;
- publish externally.

Those notifications are the responsibility of Canadian payments
counsel + the Spectre founder acting on legal advice. Spectre
Operations records the assessment flag so legal has a starting
list.

## Evidence preservation

- `PaymentInstruction`, `PaymentRun`, `PaymentAuthorization`,
  `PaymentEvent`, `ExternalPaymentEvent`, `PaymentIncident`,
  `PaymentIncidentLink` are all append-only in normal operation.
- `capabilities.__health` history on `PaymentProviderConnection`
  preserves failure counters.
- `AuditLog` rows are never deleted.
- Rotation of credentials creates a NEW `PaymentProviderConnection
  Version` — historical rows continue to reference the prior
  version's `credentialSecretRef`.

## Simulated incidents (§16 of PAY-1C brief)

Synthetic incident simulations exercised in staging:

- **Incident A** — Provider outage affecting multiple authorized
  payments. Covered by `pay1b1-outage-scenario.staging.spec.ts` and
  extended in `pay1c-staging-scenarios.staging.spec.ts` Scenario C.
- **Incident B** — Repeated forged callback attempts. Covered by
  `pay1b-staging-scenarios.staging.spec.ts` (unverified) + PAY-1C
  incident record acceptance.
- **Incident C** — Suspected duplicate provider execution. Covered
  by PAY-1C Scenario B (duplicate-business-payment guard).
- **Incident D** — Cross-tenant provider-event attempt. Covered by
  `pay1b3-external-events.test.ts` (tenant mismatch fails closed) +
  incident linkage in PAY-1C Scenario C.
