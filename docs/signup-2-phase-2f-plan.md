# SIGNUP-2 Phase 2F — Implementation Authorisation Package (DRAFT)

**Status.** PLANNING ONLY, pending founder authorisation.  No
application code; no Prisma migration; no Stripe entity; no
production configuration; no tenant provisioning; no live payment.

**Supersedes.** None (Phase 2F first draft).
**Depends on.**
- SIGNUP-2 Architecture Decision Document v3 (`sha-07db40b`),
  specifically §1b (activation-gate preconditions) + §3
  (`TenantProvisioningJob` shape).
- SIGNUP-2 Phase 2A accepted baseline `sha-c3e337e / v870`
  (`TenantProvisioningJob` schema already shipped).
- SIGNUP-2 Phase 2B accepted baseline `sha-9c717e1 / v875`
  (dormant).
- SIGNUP-2 Phase 2C accepted baseline `sha-adfe13c / v877`
  (dormant).
- SIGNUP-2 Phase 2D accepted baseline `sha-e3eed9e / v880`
  (dormant).
- SIGNUP-2 Phase 2E TECHNICALLY accepted baseline
  `sha-993e5fd / sha-993e5fd77ceb` (MOCK-BACKED).
- Stripe-integration follow-up tracker
  ([docs/signup-2-phase-2e-stripe-followup.md](signup-2-phase-2e-stripe-followup.md))
  — Phase 2F may build against the mock adapter but MUST NOT
  treat a mock-generated `ACTIVATION_READY` as equivalent to
  independently verified Stripe financial eligibility.

**Confirmed on filing this document:**
- No production state has changed.
- No new Stripe entity exists.
- No DB migration has been applied.
- No tenant provisioned.
- No existing-tenant access change.
- Phase 2B / 2C / 2D / 2E live-mode flags remain OFF.

---

## 1. Authoritative activation-gate requirements

Phase 2F is the **sole authoritative evaluator** of whether a
Phase 2E `ACTIVATION_READY` signal should produce a durable
authorisation for Phase 2G to consume.  Its job is to
INDEPENDENTLY re-verify every condition from the authoritative
current state — never trust the Phase 2E webhook-written signal
on its own.

Phase 2F requires ALL of the following to hold atomically at
authorisation time:

| # | Condition | Source of truth |
|---|---|---|
| G1 | `BillingCycle.subscriptionStatus == "ACTIVATION_READY"` | Spectre DB (Phase 2E webhook outcome) |
| G2 | `BillingCycle.reversedAt IS NULL` | Spectre DB |
| G3 | Latest Stripe `BalanceTransaction.status == "available"` AND `available_on <= now()` | Stripe (via StripeAdapter.retrieveBalanceTransaction) — re-fetched at authorisation time, NOT read from Spectre DB cache |
| G4 | No `charge.refunded` / `charge.dispute.created` event in `StripeWebhookEvent` for this cycle | Spectre DB (dedup table) |
| G5 | `SubscriptionPaymentMandate.revokedAt IS NULL` | Spectre DB |
| G6 | Phase 2D `OperatorVerificationRecord(concept=RELEASE)` exists via `BillingCycle.releasedByOperatorRecordId` | Spectre DB |
| G7 | Phase 2B `SubscriptionAuthorisationAttestation.supersededAt IS NULL` AND its `termsVersionSha256` matches the currently-approved ToS SHA-256 | Spectre DB + file-system ToS |
| G8 | The applicant's `SignupRegistration.status != "ABANDONED"` AND `verificationVerdict IN ("MANUAL_RELEASE", "PASS_AUTOMATED")` | Spectre DB |
| G9 | No existing non-cancelled `TenantProvisioningJob` for this `billingCycleId` (idempotency) | Spectre DB |

**All nine must hold atomically** inside a single
`prisma.$transaction` + a `SELECT ... FOR UPDATE` row-lock on
`BillingCycle` (Postgres).  SQLite's dev DB does not support
row-locks; local dev relies on the single-worker concurrency
guarantee + the Phase 2F feature flag staying OFF outside staging.

**Each failing condition is logged + routed to the operator
inbox with the specific reason.**  Phase 2F does NOT silently
hold the job for a later re-check (that is the sweeper's job);
every refusal is operator-visible.

---

## 2. Interaction with the Phase 2E `ACTIVATION_READY` signal

- Phase 2E's webhook dispatcher writes `BillingCycle.subscriptionStatus = "ACTIVATION_READY"` when `charge.succeeded` arrives AND the `BalanceTransaction` lookup already reports available.  **This is the trigger, not the authorisation.**
- Phase 2F's **sweeper** (background worker, Phase-2I-adjacent but shipped in Phase 2F for autonomy) runs every N minutes and picks up `BillingCycle` rows where:
  - `subscriptionStatus == "ACTIVATION_READY"`.
  - No `TenantProvisioningJob` exists.
  - The cycle has NOT been seen in the last K minutes (debounce).
- For each candidate, the sweeper calls `authoriseActivation(cycleId)`.
- The sweeper is idempotent, concurrent-safe (one row at a time + `TenantProvisioningJob` unique on `billingCycleId`), and crash-safe (nothing is lost if the worker dies mid-row — the next tick picks it up).
- Phase 2F does NOT re-write `subscriptionStatus` on the webhook path.  Phase 2E's state machine remains untouched.
- The webhook dispatcher continues to be able to revoke `ACTIVATION_READY` on a late reversal webhook; Phase 2F's own re-check (G2 + G4) catches the race.

---

## 3. Independent verification of payment settlement and funds availability

Per founder §3, Phase 2F must INDEPENDENTLY verify every
settlement condition.  Phase 2F's `authoriseActivation` does NOT
trust:

- `BillingCycle.subscriptionStatus` alone (that's a staleness
  risk).
- `BillingCycle.stripeBalanceTransactionId` existence alone (an
  older cached id may no longer be the current one).
- Prior `StripeWebhookEvent` rows alone (webhook delivery may be
  behind reality — Phase 2I's reconciliation worker catches
  drift at the hour cadence; Phase 2F catches it at the
  authorisation moment).

Phase 2F DOES:

- Call `stripeAdapter.retrieveBalanceTransaction(cycle.stripeBalanceTransactionId)` LIVE at authorisation time.
- Verify `status == "available"` AND `availableAt <= now()`.
- Re-fetch any dispute / refund signal from Stripe directly
  (via `stripe.charges.retrieve(chargeId).refunded` and
  `stripe.disputes.list({charge: chargeId})`) and treat ANY
  signal as a refusal.
- Record the fetched `BalanceTransaction` id + status + fetched-at
  timestamp in the `TenantProvisioningJob` provenance for Phase
  2G to see.

Live-adapter note: with Phase 2E's mock adapter, these re-fetches
return deterministic mock outcomes.  Phase 2F's state machine +
atomic transition + operator alerting can be exercised + tested
on the mock, but FINAL READINESS for real-tenant activation
requires the live-adapter procurement items 1.1–1.8 from the
Phase 2E Stripe follow-up tracker to land first.

---

## 4. Dispute, refund, and return checks

G4 above + the live-adapter dispute/refund fetch.  Phase 2F
treats ANY of the following as an authorisation refusal:

- Any `charge.refunded` event id in `StripeWebhookEvent` for the
  cycle's charge id.
- Any `charge.dispute.created` event id in `StripeWebhookEvent`.
- A live Stripe `charges.retrieve` that reports
  `refunded: true`, `amount_refunded > 0`, OR
  `dispute: {status: "needs_response" | "warning_needs_response"
  | "warning_under_review" | "won" | "lost"}`.
- A live Stripe `disputes.list({charge: chargeId})` that returns
  any row.

Refusal path:
- Write `OperatorInboxEntry(severity=IMMEDIATE, category=REVERSAL)`
  with the exact reason + the Stripe object id references.
- Audit event.
- Return without creating a `TenantProvisioningJob`.
- The sweeper does NOT retry the same cycle until an operator
  explicitly re-cleans the state (either by overriding or by a
  new mandate collection).

---

## 5. Commercial authorization + approved legal-document dependencies

G6 + G7 + G8 above.

- G6 confirms the Phase 2D three-operator release chain still
  points at this cycle (via `BillingCycle.releasedByOperatorRecordId`).
- G7 confirms the Phase 2B attestation hasn't been superseded AND
  the ToS SHA-256 the signatory accepted still matches the
  currently-approved ToS (defends against a ToS change
  invalidating earlier consents).
- G8 confirms the applicant's registration hasn't been operator-
  rejected since the webhook arrived.

If a ToS SHA-256 mismatch is detected: refusal is routed to the
operator inbox with category `TOS_MISMATCH` (new sub-category);
operator must either revoke-and-re-attest or confirm the signatory's
consent is still valid under the new ToS version.

---

## 6. Atomic and idempotent activation decisions

- Entire `authoriseActivation` runs inside one
  `prisma.$transaction`.
- `BillingCycle` row is `SELECT ... FOR UPDATE` locked at the
  start (Postgres).
- `TenantProvisioningJob` creation uses `upsert` on
  `billingCycleId` so a second concurrent call sees the existing
  job + returns `{ noop: true, jobId: existing.id }`.
- The uniqueness constraint on `TenantProvisioningJob.billingCycleId`
  is the hard concurrency gate.
- Audit emission is outside the transaction (per the Phase 2A
  pattern — audit failures must not block the authorisation).

---

## 7. Prevention of stale or replayed readiness signals

- G3's LIVE re-fetch of `BalanceTransaction` is the primary
  defence against stale state.  A mock-replay with a stale
  signal fails at G3.
- The sweeper's "debounce K minutes" window prevents a race where
  a webhook flips the signal, Phase 2F fires, the signal is
  revoked, and the sweeper re-picks the same cycle before the
  state has settled.
- The `TenantProvisioningJob.billingCycleId @unique` constraint
  prevents duplicate job creation.
- The sweeper claims a row by writing `TenantProvisioningJob`
  BEFORE any Phase 2G worker touches it; a crash between claim
  and job completion leaves the job in `state=CREATED` which
  Phase 2G's own `authoriseActivation` re-check (defense in depth)
  will catch.

---

## 8. Handling of financial reversals during activation

Three phases of the reversal window:

1. **Before Phase 2F fires** (webhook → ACTIVATION_READY, no job
   yet): Phase 2E's reversal path flips `reversedAt +
   subscriptionStatus = REVERSED/DISPUTE_OPEN`.  Phase 2F
   sweeper's G1 check will fail; no job is created.

2. **Between Phase 2F fire and Phase 2G claim**: `TenantProvisioningJob.state == CREATED`.  A reversal webhook arrives.  Phase 2F's own
   reversal-handler (new in Phase 2F): on the sweeper's next tick,
   it checks for `TenantProvisioningJob(state=CREATED, cycle.reversedAt NOT NULL)` and cancels the job with `cancelledAt + cancelReason = "financial_reversal_pre_claim"`.

3. **During Phase 2G provisioning** (job claimed, mid-step): Phase
   2G's per-step re-check (per v3 §3b) will see the reversal and
   call Phase 2F's `cancelProvisioningJob(jobId)` helper, which
   atomically transitions `state → CANCELLED` + writes the
   operator inbox entry + preserves per-step provenance for a
   future retry.

In all three cases, no tenant is granted operational access.
The cancellation record is immutable + audited.

---

## 9. Safe handoff to Phase 2G durable provisioning

Phase 2F creates `TenantProvisioningJob` with:

| Field | Value at Phase 2F creation |
|---|---|
| `id` | cuid |
| `billingCycleId` | unique; from the cycle |
| `signupRegistrationId` | from `BillingCycle.clubId` (temporary synthetic value = registration id in Phase 2E; Phase 2G's writer will rewrite `clubId` after Club shell creation) |
| `state` | `"CREATED"` |
| `attempts` | 0 |
| `nextAttemptAt` | now (immediately claimable by Phase 2G) |
| `startedAt` | null (Phase 2G stamps on claim) |
| all step-level columns | null |

Phase 2G worker then:
1. Re-authenticates with Phase 2F's `authoriseActivation` gate (defense in depth — rejects a stale job if a reversal arrived).
2. Claims the job (`state → USER_CREATED` after the User write), one step at a time per v3 §3.
3. On the final `WELCOME_EMAIL_SENT → COMPLETED` transition, atomically flips `ClubSubscription.subscriptionStatus → ACTIVE` + `accessTier → FULL`.

Phase 2F exports a stable TypeScript contract for Phase 2G:

```ts
export interface Phase2FReleaseAuthorisation {
  jobId: string;
  billingCycleId: string;
  signupRegistrationId: string;
  verifiedAt: Date;
  balanceTransactionId: string;
  balanceAvailableAt: Date;
  authorisationEvidence: {
    standingOperatorRecordId: string;
    authorityOperatorRecordId: string;
    releaseOperatorRecordId: string;
    attestationId: string;
    mandateId: string;
    termsVersionSha256: string;
  };
}
```

Phase 2G reads this via `getActivationAuthorisation(jobId)` — a
Phase 2F read-only service.

---

## 10. Failure recovery and operator alerts

Phase 2F failure outcomes (ordered by severity):

| Failure | Operator alert | Recovery |
|---|---|---|
| G1 (status not ACTIVATION_READY) — most common, benign | None (sweeper skipped) | Automatic re-check on next tick |
| G2 (reversedAt set) | ROUTINE / PAYMENT_FLOW | Phase 2H operator reviews reversal |
| G3 (balance not available) | ROUTINE / PAYMENT_FLOW | Automatic re-check on next tick (Phase 2I reconciliation also catches) |
| G4 (dispute / refund event present) | IMMEDIATE / REVERSAL | Phase 2H operator must resolve |
| G5 (mandate revoked) | IMMEDIATE / PAYMENT_FAILURE | New mandate required |
| G6 (missing release record) — defensive, should never fire if Phase 2D was correct | IMMEDIATE / VERIFICATION_HOLD | Operator investigation |
| G7 (ToS mismatch) | IMMEDIATE / TOS_MISMATCH | Legal review; signatory re-attestation |
| G8 (registration ABANDONED) | ROUTINE / VERIFICATION_HOLD | Benign if operator rejected after webhook arrived |
| G9 (job already exists) | None (noop return) | Phase 2G picks up the existing job |
| Live adapter error (Stripe fetch timeout / 500) | ROUTINE / PAYMENT_FLOW (transient); IMMEDIATE on repeat | Phase 2I reconciliation worker catches persistent failures |

The sweeper has a max-attempt budget per cycle to prevent an
infinite loop (default: 10 attempts over 1 hour).  Beyond that:
`OperatorInboxEntry(severity=IMMEDIATE, category=ACTIVATION_STUCK)`
with the full gate-check history.

---

## 11. Audit evidence and reconciliation requirements

Every `authoriseActivation` call writes:
- One `audit()` row with action
  `signup.activation.authorised` (on success) or
  `signup.activation.refused` (on failure, with the specific gate
  that failed).
- One `PaymentReconciliationEntry` with
  `entryType = "ACTIVATION_AUTHORISED"` (on success).  Links the
  job id, cycle id, and all authorisation-evidence ids.
- The `TenantProvisioningJob` row itself is the immutable
  authorisation record consumed by Phase 2G.

Phase 2I's reconciliation worker sweeps `TenantProvisioningJob`
rows that have been in `state=CREATED` for more than one hour
and raises an operator alert (not Phase 2F's responsibility; the
Phase 2I spec lives separately).

---

## 12. Existing-tenant compatibility

- Zero `Club.create` writes.
- Zero `User.create` writes.
- Zero `UserClubRole.create` writes.
- Zero `accessTier` writes anywhere (Phase 2G writes
  `accessTier = FULL` only at the final step).
- Legacy tenants (`accessTier IS NULL`) continue to grandfather
  through the Phase 2B seams.
- The additive Phase 2F migration (none expected — Phase 2A's
  `TenantProvisioningJob` schema already carries every field
  Phase 2F writes) does not touch any existing-column shape.
- Phase 2F does not introduce any new Prisma model.

Grep-sweep contract tests (same pattern as Phase 2D's §12 +
Phase 2E's §12) assert these invariants.

---

## 13. Contract and staging acceptance tests

### 13a Contract tests (vitest; target ≥ 80 passing assertions)

1. `tests/signup-2-phase-2f-schema-reuse.test.ts` — confirms
   Phase 2F uses only Phase 2A's `TenantProvisioningJob` columns
   (no new schema).
2. `tests/signup-2-phase-2f-gate-matrix.test.ts` — the nine-gate
   matrix tested with every combinatorial failure branch.
3. `tests/signup-2-phase-2f-atomicity.test.ts` — $transaction
   wrap; row-lock pattern; upsert idempotency on billingCycleId;
   concurrent-fire returns one job id.
4. `tests/signup-2-phase-2f-sweeper.test.ts` — picks up
   ACTIVATION_READY candidates; debounce window; max-attempt
   budget; stuck-job alert.
5. `tests/signup-2-phase-2f-reversal.test.ts` — reversal
   mid-stream cancels the CREATED job + routes to the operator
   inbox.
6. `tests/signup-2-phase-2f-authorisation-contract.test.ts` —
   `getActivationAuthorisation(jobId)` returns the shape Phase 2G
   expects.
7. `tests/signup-2-phase-2f-no-provisioning-side-effects.test.ts`
   — grep sweep: no `prisma.club.create`, no
   `prisma.user.create`, no `prisma.userClubRole.create`, no
   `accessTier\s*:` write, no Stripe SDK import, no gov-ID
   surface.

### 13b Playwright staging acceptance

`tests/e2e/signup-2-phase-2f-activation-acceptance.staging.spec.ts`
(fixture-driven; mock adapter):

- **A.** Happy path: fixture seeds a BillingCycle with
  `subscriptionStatus = ACTIVATION_READY` + a Phase 2D RELEASE
  record + a Phase 2B attestation + an unrevoked mandate.  Sweeper
  tick creates a `TenantProvisioningJob(state=CREATED)`.  Phase
  2F's `getActivationAuthorisation(jobId)` returns the handoff
  shape.
- **B.** Reversal pre-fire: fixture seeds the cycle, then flips
  `reversedAt` BEFORE the sweeper tick.  Sweeper creates NO job
  + writes IMMEDIATE operator alert.
- **C.** Reversal post-fire, pre-claim: job created, then
  `reversedAt` flipped.  Phase 2F's reversal-handler cancels the
  job.
- **D.** ToS mismatch: fixture seeds the attestation with a
  stale ToS SHA-256.  Sweeper refuses + writes IMMEDIATE
  TOS_MISMATCH alert.
- **E.** Fail-closed flag: `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE`
  unset → sweeper's `authoriseActivation` throws
  `ForbiddenError`; no job created.

### 13c Full regression

- SIGNUP-1 + 1F + 2A + 2B + 2C + 2D + 2E + 2F suites green.
- Posting-guard-adjacent suites green.
- Placeholder scan clean.

---

## 14. DRH-1 deployment and rollback

Standard DRH-1 pattern:
1. Commit on `staging-deploy/web1b1-framer-fidelity`.
2. GitHub Actions runs the usual build + the newly-added
   post-deploy image-tag reliability gate (Phase 2D follow-up).
3. Fly release to `spectre-staging` (no production target).
4. Health probe + webhook signature-reject smoke.
5. Playwright acceptance against the deployed image.

Rollback anchor: **Phase 2E baseline** (image `sha-993e5fd77ceb`).

Phase 2F ships with the feature flag OFF.  Controlled staging
activation (if authorised post-acceptance) follows the Phase 2D
pattern: flip ON → run full Playwright → flip OFF → document the
transition.

---

## 15. Outstanding founder decisions

Material to code surface:

1. **Sweeper cadence**: Phase 2F proposes 5 minutes.  Confirm
   or specify (longer = slower activation; shorter = higher
   staging load).
2. **Debounce window**: Phase 2F proposes 2 minutes between
   consecutive attempts on the same cycle.  Confirm or specify.
3. **Max-attempt budget**: Phase 2F proposes 10 attempts over
   1 hour before raising the STUCK alert.  Confirm or specify.
4. **ToS SHA-256 re-check behaviour**: Phase 2F proposes
   immediate refusal + TOS_MISMATCH alert.  Alternative:
   automatic signatory re-attestation request.  Recommended:
   immediate refusal — automatic re-attestation is a legal risk
   until founder authorises it.
5. **Live-Stripe adapter dependency**: Phase 2F IMPLEMENTATION
   can proceed against the mock, BUT Phase 2F ACCEPTANCE against
   a real tenant requires items 1.1–1.8 of the Stripe follow-up
   tracker.  Confirm: Phase 2F can land mock-backed AND Phase
   2F's live-mode flag flip requires a separate per-change
   authorisation.

Configuration + copy:
6. Feature-flag name: `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE`
   proposed.
7. Operator-inbox category label `TOS_MISMATCH` proposed.
8. Operator-inbox category label `ACTIVATION_STUCK` proposed.

Decisions 1–5 are material.  6–8 are configuration + copy.

---

## 16. What this document is + is not

**IS:**
- The Phase 2F planning document, awaiting founder authorisation.
- A reconciliation of v3 architecture §1b (activation gate), §3
  (TenantProvisioningJob shape), §4 (reconciliation ledger), with
  the Phase 2F boundary that stops short of Phase 2G.
- A specification complete enough that implementation is a
  direct translation.

**IS NOT:**
- Authorisation to implement.
- A code change.
- A deployment.
- A Stripe API call (test or live).
- A Phase 2G or later initiation.
- A commitment to any specific sweeper cadence until decision 1
  lands.

**Awaiting founder authorisation of Phase 2F per Section 13.**
