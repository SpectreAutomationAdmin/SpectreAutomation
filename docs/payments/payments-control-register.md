# Spectre Payments — Control Register

**Version:** 2026-09-26 (PAY-1C/1)
**Scope:** internal Payments platform controls only. Sponsor bank,
Payments Canada, RPAA, and FINTRAC obligations are OUT OF SCOPE for
this register; those are external legal / regulatory matters to be
determined by Canadian payments counsel and captured in
`external-unknown-register.md`.

**How to read this:** every row names a specific control that
actually exists in the codebase today. Each row points to
`Implementation` (the code that enforces it) and `Evidence` (the
automated test that proves it). Empty pointers are not permitted —
if there is no implementation, the row does not belong here.

---

## A. Authorization

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| A-01 | Maker/checker separation | The user who prepared a payment run may not authorize it. | Unauthorized single-person payment. | `src/lib/payments/authorization.ts:177-181` (SoD check). | `tests/payments/pay1a3-authorization.test.ts` — SoD suite. |
| A-02 | Authorization fingerprint | Freezes the exact material state (funding account, currency, execution date, per-instruction fingerprints) at authorization time. | Silent post-authorization mutation. | `src/lib/payments/fingerprint.ts` + `authorization.ts:203`. | `pay1a3-authorization.test.ts` — fingerprint freeze. |
| A-03 | Material-change invalidation | Any material mutation of an authorized run invalidates the authorization. | Authorization drift. | `src/lib/payments/authorization.ts:invalidateAuthorization`. | `pay1a3-authorization.test.ts`. |
| A-04 | Role separation via RBAC | `payment:prepare` and `payment:authorize` are distinct permissions. | Permission bundling defeats SoD. | `src/lib/permissions.ts:126-127`. | RBAC seed tests. |

## B. Payment Integrity

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| B-01 | Immutable PaymentInstruction | Authorized instructions are never edited in place. | Silent payment mutation. | `src/lib/payments/authorization.ts` freezes fingerprint; state moves via `transitionRunState`. | `pay1a1-primitives.test.ts`. |
| B-02 | Destination snapshot | The recipient's payment destination is captured at authorization and referenced immutably. | Recipient banking mutated after authorization. | `PaymentDestinationSnapshot` (schema.prisma:14273). | `pay1a1-primitives.test.ts`. |
| B-03 | Exact amount + currency | Amount is `Decimal`; float math is refused in fingerprint canonicalisation. | Precision drift. | `src/lib/payments/fingerprint.ts:22-24` refuses numeric type. | `pay1a1-primitives.test.ts`. |
| B-04 | Economic identity | Every payment carries exactly one economic identity across retries/representations. | Second economic payment on retry. | `retrySubmit` reuses idempotencyKey `run:<runId>:inst:<instructionId>`. | `pay1a2-retry.test.ts`. |
| B-05 | Provider idempotency | `(providerType, providerInstructionId)` unique DB constraint. | Duplicate provider submission recorded. | `prisma/schema.prisma:14381`. | `pay1a4-provider-accounting.test.ts`. |
| B-06 | Duplicate-business-payment guard | Refuses authorization if the same source business object + recipient + destination + amount already has an active/settled instruction. | Accidental duplicate economic payment. | `src/lib/payments/duplicate-guard.ts` + `authorization.ts` inline guard. | `tests/payments/pay1c3-duplicate-guard.test.ts`. |

## C. Execution

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| C-01 | Connection ACTIVE validation | Submission refuses SUSPENDED / DEGRADED / REVOKED connections. | Submission through unhealthy rail. | `src/lib/payments/provider/health.ts:assertConnectionUsable`. | `pay1b1-connection-controls.test.ts`. |
| C-02 | Environment validation | Refuses PRODUCTION connections when real-money is off. | Real-money attempt on staging. | `src/lib/payments/provider/connection.ts:assertEnvironmentAllowed`. | `pay1b1-connection-controls.test.ts`. |
| C-03 | Capability validation | Required capability must be declared by the adapter. | Executing a payment kind the adapter cannot handle. | `production-gate.ts` (capability check). | `pay1c4-production-gate.test.ts`. |
| C-04 | Retry semantics | Retry reuses idempotencyKey; refuses if authorization stale. | Retry-triggered second payment. | `src/lib/payments/submission.ts:retrySubmit`. | `pay1a2-retry.test.ts`. |
| C-05 | Ambiguous-outcome handling | Provider timeout leaves the instruction in `SUBMITTING`, not `SCHEDULED`. | False "never submitted" state. | `submission.ts:167-186`. | `pay1a2-retry.test.ts`. |

## D. External Events

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| D-01 | Event verification | Financial mutation only on `verificationStatus = VERIFIED` events. | Unverified/forged event mutates state. | `src/lib/payments/external-events.ts:154`. | `pay1b3-external-events.test.ts`. |
| D-02 | Replay protection | `(provider, providerEventId)` unique. | Duplicate settlement JE from replayed event. | `prisma/schema.prisma:14517`. | `pay1b3-external-events.test.ts`. |
| D-03 | Out-of-order handling | Later ACCEPTED after SETTLED is ignored. | Regression to earlier status. | `external-events.ts:202-208`. | `pay1b3-external-events.test.ts`. |
| D-04 | Unknown-status handling | Provider status outside the normalized set fails closed. | Silent acceptance of unknown outcomes. | `external-events.ts:159`. | `pay1b3-external-events.test.ts`. |

## E. Accounting

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| E-01 | Settlement-only cash recognition | Cash JE only on SETTLED, never on ACCEPTED/SUBMITTED. | Recognizing cash before it moves. | `src/lib/payments/accounting.ts`. | `pay1a4-provider-accounting.test.ts`. |
| E-02 | Return accounting | Return produces an inverse JE on the same instruction. | Silent balance mismatch on return. | `accounting.ts:recordInstructionReturn`. | `pay1a4-provider-accounting.test.ts`. |
| E-03 | Duplicate journal prevention | Settling an already-settled instruction refuses. | Double-count settlement. | `accounting.ts` guards. | `pay1a4-provider-accounting.test.ts`. |
| E-04 | Mismatch fail-closed | Amount mismatch / currency mismatch on external event refuse financial mutation. | Incorrect settlement JE. | `external-events.ts:191-199`. | `pay1b3-external-events.test.ts`. |

## F. Security

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| F-01 | KMS secret references only | `PaymentDestinationSnapshot` + `PaymentProviderConnectionVersion` store opaque KMS references; plaintext never touches the DB. | Secret exposure via DB dump. | Schema + `provider/connection.ts`. | Read-through of the schema; no plaintext field exists. |
| F-02 | Tenant isolation | Every payment table carries `clubId`; queries scope through it; cross-tenant events are rejected. | Cross-tenant data leak. | Schema + `external-events.ts:186`. | `pay1a1-cross-tenant.test.ts`. |
| F-03 | Credential redaction | Rail canonical representation carries only masked identifiers; never secret refs. | Leak of KMS pointers to logs/UI. | `src/lib/payments/rail/canonical.ts:assertNoBankSecretsInCanonical`. | `pay1c2-rail-mapping.test.ts`. |
| F-04 | Environment separation | SIMULATOR / SANDBOX / PRODUCTION enum; PRODUCTION construction structurally refused when real-money is off. | Prod-shape row appearing on staging. | `connection.ts:83-91`. | `pay1b1-connection-controls.test.ts`. |

## G. Operations

| controlId | control | objective | risk addressed | implementation | evidence |
|---|---|---|---|---|---|
| G-01 | Provider health circuit-breaker | 5 consecutive failures flip a connection to DEGRADED; single OK restores ACTIVE. | Continued submissions against a failing rail. | `src/lib/payments/provider/health.ts`. | `pay1b4-exceptions-health.test.ts`, `pay1b1-outage-scenario.staging.spec.ts`. |
| G-02 | Connection suspension | Manual `setConnectionStatus(SUSPENDED)` refuses new submissions. | Emergency operator response. | `provider/connection.ts:setConnectionStatus`. | `pay1b1-connection-controls.test.ts`. |
| G-03 | Kill switches | `PAYMENTS_ENABLED` and `PAYMENTS_REAL_MONEY_ENABLED` at the process level. | Emergency global halt. | `src/lib/payments/kill-switch.ts`. | `pay1a1-primitives.test.ts`. |
| G-04 | Operational exception surfacing | Every payment-boundary anomaly rides Work Intake, distinct workDomain. | Silent failures. | `src/lib/payments/operational-exceptions.ts`. | `pay1b4-exceptions-health.test.ts`. |
| G-05 | Payment incident record | Wider events (outage, forge attempts, reconciliation discrepancies) get a first-class `PaymentIncident` for reconstruction. | Post-hoc opacity. | `src/lib/payments/incidents.ts`. | `pay1c1-incident.test.ts`. |
| G-06 | Fail-closed limits | Configured limits evaluated before external submission; breach refuses submission and raises Work Intake. | Uncapped payment. | `src/lib/payments/limits.ts`. | `pay1c3-limits.test.ts`. |
| G-07 | Provider adapter certification | Adapter's `readiness` distinct from a connection's `status`; PRODUCTION_APPROVED required before real-money submission. | Untested adapter reaches production. | `src/lib/payments/certification.ts`. | `pay1c4-certification.test.ts`. |
| G-08 | Central production gate | Every prerequisite composed at submission time; refuses if any is missing. | Single-flag production enablement. | `src/lib/payments/production-gate.ts`. | `pay1c4-production-gate.test.ts`. |

---

**Change control:** additions require both an implementation pointer
and a passing test. Rows without evidence must be removed, not
retained as aspirations.
