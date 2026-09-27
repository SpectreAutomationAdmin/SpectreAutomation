# Spectre Payments — Operations Runbook

**Version:** 2026-09-26 (PAY-1C/1)
**Audience:** Spectre operations staff.
**Reflects controls actually implemented:** yes. Every "what to do"
step below maps to an existing Spectre control. This runbook does not
instruct operators to edit Prisma / database rows directly.

---

## 1. Provider outage

**Signal:** connection status flipped to `DEGRADED` (see
`PaymentProviderConnection.status`); operator sees repeated failures
in the Work Intake `PAYMENT_EXCEPTION_CONNECTION_DEGRADED` queue.

**Do:**
1. Confirm from `Payments · Operational` work intake items that the
   failures share a `connectionId`.
2. If failures are provider-side (not tenant-side data errors), open
   a `PaymentIncident` with:
   - `category = PROVIDER_OUTAGE`
   - `severity = SEV_2` (raise to SEV-1 if funds are already in
     flight and cannot be reconciled).
   - Link every affected `PaymentRun` + `PaymentInstruction` +
     `PROVIDER_CONNECTION` via `linkIncidentEntities`.
3. If containment is needed, `setConnectionStatus(SUSPENDED)`. New
   submissions refuse; authorized payments are preserved.
4. Do NOT cancel authorized runs. Do NOT recreate authorization.

**Do not:** cancel PaymentRuns because the rail is unavailable;
duplicate a payment on a new connection while the outage is
in-flight; edit `PaymentInstruction` state directly.

## 2. Ambiguous payment (SUBMITTING with unknown provider outcome)

**Signal:** `PaymentInstruction.status = SUBMITTING`,
`submissionAttempts > 0`, no external event received.

**Do:**
1. `pollAndAdvance(runId)` — this asks the provider for status. If
   the provider now returns a definitive outcome, the instruction
   advances.
2. If the provider still returns UNKNOWN after N poll attempts,
   escalate to a payment incident (`category =
   WIDESPREAD_SUBMISSION_FAILURE` or `SUSPECTED_DUPLICATE_EXECUTION`
   depending on scope). Do not retry submission until a definitive
   outcome exists.

**Do not:** call `retrySubmit` while the instruction is
`SUBMITTING` unless the operator has provider evidence that no
economic payment exists.

## 3. Rejected payment

**Signal:** `PaymentInstruction.status = REJECTED` with a
`providerReference` + returnCode.

**Do:**
1. Confirm the provider outcome via the ExternalPaymentEvent row
   (`processingStatus`, `returnCode`, `returnDescription`).
2. If the rejection is recoverable (INVALID_EXECUTION_DATE, etc.),
   escalate to the Controller — a **new authorization** is required
   to change the run's material fields.
3. If the rejection is a rail-side ambiguity, treat as ambiguous
   (§2) and escalate to an incident.

## 4. Returned payment

**Signal:** `PaymentInstruction.status = RETURNED` after settlement.

**Do:**
1. The return JE is booked automatically by `recordInstructionReturn`
   — verify it exists.
2. Raise a Work Intake `PAYMENT_EXCEPTION_RETURN_REQUIRES_ACTION`
   for the Controller to reach out to the recipient.
3. A returned payment is not automatically an incident. Only if
   multiple returns share a common provider/tenant/attack pattern
   is a `PaymentIncident` warranted.

## 5. Duplicate concern

**Signal:** operator suspects the same economic payment was
executed twice.

**Do:**
1. Query `PaymentInstruction` on `(providerType,
   providerInstructionId)` — this unique constraint prevents the
   accidental duplicate row.
2. If two distinct Spectre instructions appear to point at the same
   external execution, open a `PaymentIncident` with
   `category = SUSPECTED_DUPLICATE_EXECUTION`, `severity = SEV_1`,
   link both instructions, `regulatoryAssessmentRequired = true`
   (legal to determine).
3. Do NOT modify the existing instructions. Do NOT create a
   "correction" payment automatically.

## 6. Amount mismatch on external event

**Signal:** `ExternalPaymentEvent.processingStatus =
REJECTED_AMOUNT_MISMATCH`.

**Do:**
1. The financial-mutation gate refused; no settlement JE exists.
   Verify.
2. Open Work Intake exception (raised automatically).
3. Investigate provider record vs. Spectre-authorized amount.
4. Legitimate mismatch = incident (`category =
   ACCOUNTING_INTEGRITY_FAILURE`).

## 7. Currency mismatch on external event

Same as §6 with `REJECTED_CURRENCY_MISMATCH`.

## 8. Callback verification failure

**Signal:** `ExternalPaymentEvent.verificationStatus = FAILED` (or
`UNVERIFIED`).

**Do:**
1. No financial mutation occurred (verified).
2. If a burst of verification failures occurs, open
   `CALLBACK_VERIFICATION_ATTACK` incident, `severity = SEV_1`, and
   suspend the affected connection.

## 9. Credential compromise

**Signal:** external notice of possible KMS/credential leak.

**Do:**
1. Immediately `setConnectionStatus(SUSPENDED)` on the affected
   connection.
2. Rotate the credential: create a new `PaymentProviderConnection
   Version`, deactivate the prior, activate the new.
3. Open `PaymentIncident` with `category = CREDENTIAL_COMPROMISE`,
   `severity = SEV_1`, `regulatoryAssessmentRequired = true` (legal
   to determine).
4. Do NOT delete historical evidence. Historical
   `PaymentInstruction` rows continue to reference the previous
   credential version — this is the intended forensic trail.

## 10. Connection suspension

**Signal:** operator judgement — anomalous activity, external legal
request, sponsor bank notification.

**Do:** `setConnectionStatus(SUSPENDED)`. New submissions refuse;
authorized payments preserved. Suspension is reversible via
`setConnectionStatus(ACTIVE)` once cleared.

## 11. Reconciliation discrepancy

**Signal:** operator/reporting flags a difference between
Spectre-authorized amounts and provider/bank statement.

**Do:**
1. Open `PaymentIncident` with `category =
   RECONCILIATION_DISCREPANCY`.
2. Preserve both sides — do NOT delete Spectre records to "match"
   the bank feed.
3. Escalate to Controller + external auditor as appropriate.

---

## Operator invariants

- Never edit `PaymentInstruction.status` directly via Prisma.
- Never delete or archive a `PaymentEvent` row.
- Never cancel a payment because a rail is temporarily
  unavailable — suspend the rail, not the payment.
- Never re-authorize a run to "fix" a mismatch without invalidating
  the prior authorization.
- Every containment action goes through the existing controls
  (`setConnectionStatus`, kill switches, `retrySubmit`, incident
  transitions). This runbook does not authorize direct DB edits.
