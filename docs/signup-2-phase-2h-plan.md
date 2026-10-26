# SIGNUP-2 Phase 2H — Plan + Founder Decision Package (DRAFT)

**Status.** PLANNING ONLY, pending founder authorisation.  No
application code; no Prisma migration; no deployment; no tenant
provisioning; no production configuration.

**Audience.** Founder (non-technical).  Readable without source
code.  Signing this package authorises Claude to build Phase 2H
to this specification.

**Supersedes.** None (Phase 2H first draft).

**Depends on.**
- Phase 2A `TenantProvisioningJob` state machine + sentinel
  columns.
- Phase 2B attestation surface.
- Phase 2C entity-standing + authority verification.
- Phase 2D three-operator release workflow.
- Phase 2E payment-authorization + mandate + webhook dispatch.
- Phase 2F activation-decision boundary +
  `validateActivationAuthorisation` + `invalidateActivationAuthorisation`.
- Phase 2G durable provisioning + `provisioningCancelledAt`
  sentinel + atomic Tier 2 grant.

**Rollback anchor at Phase 2H deploy time (future):** Phase 2G
image `sha-5e6071507187` / Fly release v901.

---

## 0. One-line summary

Phase 2H adds **two durable states that didn't exist before** —
`SUSPENDED` and `UNDER_REVIEW` — and gives an authorised
operator a UI to transition any Phase 2A-2G tenant between
`ACTIVE`, `UNDER_REVIEW`, and `SUSPENDED` based on financial /
legal / verification evidence, with full data preservation,
separation-of-duties, and documented reinstatement controls.
Phase 2H does **NOT** touch Stripe, does **NOT** modify
existing tenants outside the explicit operator workflow, and
does **NOT** activate real tenants.

---

## 1. Scope + exclusions

### 1a Phase 2H ships

1. Two new `ClubSubscription.subscriptionStatus` values:
   `SUSPENDED` and `UNDER_REVIEW` (additive, enforced by the
   posting-guard).
2. One new `ClubSubscription.accessTier` value:
   `SUSPENDED_READ_ONLY` (already partially referenced in
   Phase 2A schema comments; now enforced).
3. **Suspension handler**: a service function that, given a
   trigger kind + evidence + an operator, flips a Club into
   SUSPENDED or UNDER_REVIEW without deleting rows.
4. **Reinstatement handler**: a service function that, given
   current financial eligibility + an authoriser + evidence,
   flips a SUSPENDED or UNDER_REVIEW Club back to ACTIVE +
   accessTier=FULL.
5. **Operator-remediation workflow** (UI + API):
   - List outstanding operator-inbox entries by category.
   - View a tenant's full posting-chain + verification history +
     reconciliation + suspension / reinstatement audit log.
   - Trigger suspension (one of six documented triggers).
   - Trigger reinstatement (requires re-verification of
     financial eligibility; see §3).
   - Retry a failed Phase 2G provisioning job
     (`recoverFromFailure` wrapper + authorisation).
   - Resolve a Phase 2C / 2D / 2F operator alert.
6. **Permissions**: three new RBAC permission keys with the
   separation-of-duties rules in §4 below.
7. **Audit**: every suspension / reinstatement / remediation
   action writes an audit row + a `TenantLifecycleTransition`
   row (new table — see §2).
8. **Posting-guard integration**: SUSPENDED / UNDER_REVIEW
   tenants cannot post GL writes, payroll, member billing,
   portal activity, or other operational actions.  Read-only
   admin surfaces + specific allowlisted remediation surfaces
   remain reachable.
9. **Background-job gating**: scheduled Spectre workers skip
   SUSPENDED / UNDER_REVIEW tenants (list in §5).
10. **Contract + Playwright staging acceptance tests**.
11. **Documentation + runbook**.

### 1b Phase 2H does NOT ship

- Live Stripe integration.
- Automatic cron for operator-tick (Phase 2G decision D6
  deferred).
- Rich operator UX polish beyond functional minima.
- The real Phase 2G importers (COA / opening-balance /
  branding / invitations / welcome email) — still deferred to
  a live-tenant-authorisation slice.
- A real `docs/legal/terms-of-service-v1.md` (still deferred
  to legal review).
- Government-ID collection.
- Phase 2I / 2J + any later phases.

### 1c Hard non-authorisations (preserved from the Phase 2H
   authorisation email)

- No real tenant activation.
- No Stripe calls (even test-only).
- No existing-tenant access change outside the operator
  workflow.
- No production deploy.
- No legal-terms activation.
- No gov-ID surface.
- No later-phase initiation.

---

## 2. State model + schema

### 2a `ClubSubscription.subscriptionStatus` state additions

Phase 2A already defined the enum shape; Phase 2H enforces the
two new values + the transitions.

| State | Meaning | Reachable from | Reachable to |
|---|---|---|---|
| `AUTHORISED` → `INITIATED` → `AWAITING_SETTLEMENT` → `SETTLED` → `ACTIVATION_READY` → `ACTIVE` | Phase 2A-2G lifecycle | — | — |
| `UNDER_REVIEW` (new) | Operator-flagged for financial / legal / verification review; access reduced to Tier 1 read-only; full operational writes blocked | `ACTIVE` or `SUSPENDED` | `ACTIVE` (reinstatement) or `SUSPENDED` (escalation) |
| `SUSPENDED` (new) | Operator-confirmed restriction after a terminal reversal event; access reduced to Tier 1 read-only; data preserved indefinitely | `ACTIVE`, `UNDER_REVIEW`, or `REVERSED` | `UNDER_REVIEW` (reinstatement review) → `ACTIVE` |
| `REVERSED` | Phase 2E webhook-driven; Phase 2H's suspension handler is the ONLY path from REVERSED → SUSPENDED | — | `SUSPENDED` only |
| `CANCELLED` | Terminal operator action; data preserved; posting-guard refuses operational writes forever | `SUSPENDED` or `UNDER_REVIEW` | — (terminal) |
| `PAYMENT_FAILED`, `MANUAL_INVOICE` | Phase 2E states, unchanged | — | — |

**Enforcement**: `subscription-state-machine.ts` is extended
with the new transitions; any attempt to flip a state outside
the enumerated map throws
`SIGNUP_2H_INVALID_TRANSITION`.

### 2b `ClubSubscription.accessTier` state addition

| Tier | Meaning | Posting-guard behaviour |
|---|---|---|
| `null` (grandfathered) | pre-SIGNUP-2 tenant | PASS (legacy) |
| `PRE_AUTH`, `STAGED` | Phase 2A/2G construction states | REFUSE operational writes |
| `FULL` | Phase 2G final grant | ALLOW operational writes |
| `SUSPENDED_READ_ONLY` (new, enforced) | Phase 2H suspension state | REFUSE operational writes; ALLOW read-only admin + specific allowlisted remediation routes |

### 2c New Prisma model

```prisma
model TenantLifecycleTransition {
  id                  String   @id @default(cuid())
  clubId              String
  club                Club     @relation(fields: [clubId], references: [id])
  previousStatus      String
  newStatus           String
  previousAccessTier  String?
  newAccessTier       String?
  trigger             String   // see §3 enumerated triggers
  triggerEvidenceJson String?  // provider event id, reversal reason, operator notes
  operatorUserId      String
  authoriserUserId    String?  // required for reinstatement (SoD)
  reasonCode          String?
  reasonNotes         String?
  effectiveAt         DateTime @default(now())
  reversedAt          DateTime?  // if this transition is itself later reversed
  reversedReason      String?
  createdAt           DateTime @default(now())

  @@index([clubId, effectiveAt])
  @@index([newStatus, effectiveAt])
  @@index([trigger, effectiveAt])
  @@index([operatorUserId, effectiveAt])
}
```

Additive-only migration; both SQLite + Postgres schemas; mirrors
Phase 2A/2F/2G pattern.

### 2d Posting-guard additions

Phase 2H extends `assertPostingAllowed` to refuse when:

- `clubSubscription.subscriptionStatus === "SUSPENDED"` OR
  `"UNDER_REVIEW"`.
- `clubSubscription.accessTier === "SUSPENDED_READ_ONLY"`.
- The route is not on the `OPERATIONAL_WRITES_ALLOWED_UNDER_REVIEW`
  allowlist (currently empty — all operational writes blocked
  by default; the allowlist exists as a seam for a future
  "limited-write" grade if authorised).

Suspension / reinstatement writes bypass posting-guard; they
use `assertSensitiveActionAllowed()` (existing non-financial
admin guard) with the new RBAC permissions in §4.

---

## 3. Suspension triggers + evidence (founder §3-A)

Six enumerated triggers; each requires specific evidence before
the suspension handler accepts the call.

| # | Trigger | Evidence required | Who may call |
|---|---|---|---|
| 1 | **PAD return** | Stripe webhook event id for the ACH return + `BillingCycle.reversedAt` set | Automatic via Phase 2E webhook dispatch (writes `UNDER_REVIEW` for operator triage); operator confirms → SUSPENDED |
| 2 | **Payment reversal** | Stripe webhook event id for the reversal + `BillingCycle.reversedAt` set | Same as #1 |
| 3 | **Refund** | Stripe webhook event id for the refund + reconciliation entry | Same as #1 |
| 4 | **Dispute (chargeback)** | Stripe webhook event id for the dispute + dispute amount + evidence due-date | Same as #1 |
| 5 | **Failed renewal** | Phase 2E renewal-cycle `subscriptionStatus = PAYMENT_FAILED` + 3-attempt dunning history | Automatic transition to `UNDER_REVIEW`; operator confirms → SUSPENDED |
| 6 | **Operator-imposed financial hold** | Operator reason-code (from a controlled vocab) + free-form notes ≥ 20 chars | Operator-only; no automatic trigger |

### 3a Automatic UNDER_REVIEW vs operator-confirmed SUSPENDED

- Triggers 1-5 flip the Club to **UNDER_REVIEW** automatically
  (webhook or dunning path).  Operational writes are blocked
  from that moment.
- Only an operator can finalise `SUSPENDED` — the escalation
  requires a human review.
- An operator can also **release** from UNDER_REVIEW back to
  ACTIVE if the review finds the trigger was in error (e.g.
  mis-attributed webhook).  This requires the SoD rule in §4.

### 3b Blocked vs allowed actions during SUSPENDED / UNDER_REVIEW

**Blocked (posting-guard refuses):**
- GL postings.
- AR charges, payments, adjustments.
- AP invoices, bills, payment runs.
- Payroll posting + statement generation.
- Member billing + statement generation.
- Member portal visibility.
- POS checks, closes, settlements.
- All operational imports.
- All scheduled worker jobs (see §5).

**Allowed:**
- Read-only admin dashboards + reports (so the operator can
  review).
- Phase 2H operator-remediation UI itself.
- Audit log reads.
- Financial reconciliation reads.
- A controlled "remediation action" surface — currently empty;
  reserved for Phase 2I.

---

## 4. Operator remediation workflow (founder §3-B)

### 4a New RBAC permission keys

Phase 2H adds **three** new permission keys to the Phase 2A
RBAC model.  Each is a platform-scoped (clubId=null)
permission that only SUPER_ADMIN carries by default; operator
roles added later can inherit specific subsets.

| Permission key | Grants | Example route |
|---|---|---|
| `platform:tenants:suspend` | Flip ACTIVE → UNDER_REVIEW or UNDER_REVIEW → SUSPENDED | `POST /api/admin/signup-ops/tenants/[clubId]/suspend` |
| `platform:tenants:reinstate` | Flip SUSPENDED → UNDER_REVIEW or UNDER_REVIEW → ACTIVE | `POST /api/admin/signup-ops/tenants/[clubId]/reinstate` |
| `platform:tenants:remediate` | Resolve operator-inbox entries, retry Phase 2G jobs, cancel jobs | `POST /api/admin/signup-ops/tenants/[clubId]/remediate` |

### 4b Separation-of-duties rule (reinstatement only)

**Reinstatement from SUSPENDED → UNDER_REVIEW is single-operator.**
**Reinstatement from UNDER_REVIEW → ACTIVE requires TWO distinct
users** — the one who triggered the state transition cannot
also authorise the activation.  Enforced by:

- `reinstateTenant(..., { operatorUserId, authoriserUserId })`
  rejects when the two ids match.
- The operator-inbox entry for the pending reinstatement
  surfaces the "awaiting authoriser" state until a different
  user signs off.
- Audit records both ids on `TenantLifecycleTransition`.

Phase 2H baseline requires both ids to be SUPER_ADMIN; future
grades may introduce an operator role with the two permissions
split for cleaner SoD.

### 4c Audit + evidence retention

- Every suspension writes a `TenantLifecycleTransition` row.
- Every reinstatement writes a `TenantLifecycleTransition` row
  with `authoriserUserId` populated.
- Every operator action also writes an `audit()` row with
  tails-only metadata.
- `triggerEvidenceJson` stores provider event ids + reversal
  reasons + operator reason-code; the raw provider payload is
  NOT duplicated here (already lives in `StripeWebhookEvent`).
- Retention: `TenantLifecycleTransition` rows are **never
  deleted** by application code.  A separate retention policy
  outside Phase 2H's scope governs long-term archival.

### 4d Safe retry behaviour

- Phase 2G `recoverFromFailure` is wrapped by Phase 2H's
  remediation route.
- Retry writes a `TenantLifecycleTransition` with trigger
  `RETRY_PROVISIONING_FAILURE`.
- Retry does NOT bypass the Phase 2G mock-isolation gate; a
  job that was mock-backed stays mock-backed; retry on a
  live-stripe job stays live-stripe.
- The posting-guard remains enforced throughout the retry.

---

## 5. Concurrency + safety (founder §3-D)

### 5a Serialisation against operational writes

- Every operational write path reads
  `ClubSubscription.subscriptionStatus` + `accessTier` as part
  of its posting-guard call.
- The posting-guard uses a `select for update` row-lock on
  `ClubSubscription` under Postgres for the duration of the
  check.
- A suspension handler takes the same row-lock before
  flipping state; concurrent operational writes see the new
  state and refuse.

### 5b Serialisation against background jobs

Scheduled Spectre workers that must be gated:

- Monthly reporting generator.
- Statement runs.
- AR aging + collections.
- AP payment-run scheduler.
- Payroll statement generation.
- Email digests + member notifications.
- POS end-of-day close.
- Reconciliation worker.
- Phase 2G provisioning-tick (operator-triggered; also
  refuses).
- Phase 2E webhook dispatcher (continues processing but writes
  to `BillingCycle` only; never flips `ClubSubscription` on a
  SUSPENDED tenant beyond the automatic UNDER_REVIEW escalation
  itself).

Each worker reads `ClubSubscription.subscriptionStatus` at job
claim + skips the tenant if `SUSPENDED` or `UNDER_REVIEW`.  A
single shared helper
(`isTenantOperationallyActive(subscription): boolean`) centralises
the check so a future state addition cannot silently bypass a
worker.

### 5c Serialisation against access-tier UI flips

- `accessTier` is updated inside the same transaction as
  `subscriptionStatus`.
- A write to one without the other is **not permitted** by the
  Phase 2H service — a convenience setter unifies both.

### 5d UI-only hiding is NOT acceptable

**Phase 2H's suspension explicitly rejects a "hide the UI
controls" approach.**  The server-side posting-guard is the
authoritative enforcement; the UI merely visualises the state.
Any new UI must call the posting-guard before offering an
action, and the posting-guard refuses regardless of UI state.

Compliance test: `tests/signup-2-phase-2h-posting-guard-coverage.test.ts`
asserts that every operational write route calls
`assertPostingAllowed` and that `assertPostingAllowed` reads
`subscriptionStatus` + `accessTier` from the current
`ClubSubscription`.

---

## 6. Reinstatement controls (founder §3-C)

### 6a Eligibility re-checks (ALL required)

A reinstatement from UNDER_REVIEW → ACTIVE is refused unless:

1. **Current financial eligibility.**  The most-recent
   `BillingCycle` for this Club has `subscriptionStatus =
   "ACTIVE"` AND `reversedAt = NULL`.  A stale old
   authorisation is not sufficient — Phase 2E must have a
   current cycle in good standing.
2. **Phase 2F authorisation still valid.**  If the Club has
   a `TenantProvisioningJob`, calling
   `validateActivationAuthorisation(jobId)` must return
   `ok: true`.  (For reinstatement of an existing live
   tenant that predates Phase 2A, this check is skipped.)
3. **No active disputes.**  No `StripeWebhookEvent` with
   `eventType = "charge.dispute.*"` and no `processedAt`
   can be open for this Club.
4. **Current legal attestation.**  The most-recent
   `SubscriptionAuthorisationAttestation` for the Club has
   `supersededAt = NULL` AND its `termsVersionSha256`
   matches the current approved ToS.
5. **Operator reason-code + notes.**  The authoriser
   writes a controlled-vocab reason code + ≥ 20-char notes.

Any failure writes a `TenantLifecycleTransition` with
`newStatus = "UNDER_REVIEW"` and `reasonCode =
"REINSTATEMENT_REFUSED_<CODE>"`, keeping an audit trail of
the attempt.

### 6b No automatic reinstatement

Phase 2H never flips UNDER_REVIEW → ACTIVE automatically.
Even if a reversal is withdrawn, the operator must explicitly
act.  A Phase 2E webhook that WOULD trip the eligibility
back to green does NOT auto-reinstate; it merely enables the
operator's reinstatement path.

### 6c No "resurrection" of CANCELLED tenants

CANCELLED is terminal.  Phase 2H never flips CANCELLED back
to any other state.  A cancelled tenant that wants to resume
must sign up as a new club.

---

## 7. Staging acceptance (founder §3-E)

### 7a Contract tests (vitest; target ≥ 90 assertions)

1. **Schema contract** — new `TenantLifecycleTransition`
   model + indexes; additive-only migration (both schemas).
2. **State-machine contract** — enumerated transitions;
   invalid-transition throws; terminal states unreachable
   except via SoD-authorised path.
3. **Suspension handler contract** — six triggers; evidence
   validation; audit + lifecycle-transition rows written;
   row-lock serialisation.
4. **Reinstatement handler contract** — five eligibility
   checks; SoD enforcement (same-user refusal); automatic
   state revert on refusal.
5. **Posting-guard coverage** — every operational write route
   calls `assertPostingAllowed`; posting-guard reads
   subscriptionStatus + accessTier.
6. **Background-job gating** — every scheduled worker uses
   the shared `isTenantOperationallyActive` helper.
7. **RBAC contract** — three new permission keys; SoD rule;
   SUPER_ADMIN-only by default.
8. **Audit contract** — every state transition emits an
   `audit()` row + a `TenantLifecycleTransition` row; no
   state transition happens without both.
9. **No-destructive-cancellation contract** — Phase 2H never
   deletes Club / User / UserClubRole / ClubSubscription /
   BillingCycle / audit / lifecycle rows.
10. **Non-authorisation contract** — Phase 2H introduces no
    live-Stripe calls, no gov-ID surface, no production
    endpoints.

### 7b Playwright staging acceptance

`tests/e2e/signup-2-phase-2h-suspension-acceptance.staging.spec.ts`:

- **A.** Automatic PAD-return suspension: seed an ACTIVE
  tenant via Phase 2G fixture; replay a Stripe reversal
  webhook; verify Club flips to UNDER_REVIEW; operational
  write to a GL account is refused by posting-guard.
- **B.** Operator confirms suspension: operator calls the
  suspend route from UNDER_REVIEW → SUSPENDED; verify
  accessTier = SUSPENDED_READ_ONLY; verify operator-inbox
  entry resolved.
- **C.** Separation-of-duties on reinstatement: operator A
  attempts to both suspend + reinstate → the reinstatement
  refuses with `SIGNUP_2H_SOD_VIOLATION`; operator B
  authorises the reinstatement → ACTIVE.
- **D.** Stale authorisation refused: suspend a tenant whose
  Phase 2F authorisation has expired; attempt reinstatement
  → refused with `SIGNUP_2H_REINSTATEMENT_STALE_AUTH`.
- **E.** No destructive cancellation: suspend + cancel a
  tenant; verify every Club / User / ClubSubscription /
  BillingCycle row persists with the sentinel columns
  populated.
- **F.** Idempotency: calling suspend on an already-SUSPENDED
  tenant is a no-op (returns the existing lifecycle-transition
  row); no duplicate audit; no duplicate lifecycle row.
- **G.** Existing-tenant compatibility: a pre-SIGNUP-2
  tenant (`subscriptionStatus = null, accessTier = null`)
  cannot be suspended via Phase 2H (requires existing
  SIGNUP-2 state); the operator must first run a Phase 2I
  "legacy-tenant adoption" workflow (future scope).
- **H.** UI vs API parity: a suspended tenant's /app admin
  pages render the "SUSPENDED" banner AND the posting-guard
  refuses the same operations via API when a session
  attempts them.

Every fixture row carries slug prefix `signup-2h-fixture-*` +
`stagingDataMode = "SYNTHETIC_DEMO"`.  Teardown via
`test.afterAll` guaranteed.

### 7c DRH-1 deployment

Standard staging-only pattern.  Controlled flag window
required: `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE=1` for the
acceptance run; unset afterward.  No other flags needed.
Zero worker-image change.

---

## 8. Dependencies

### 8a Hard dependencies (gate implementation)

1. **Legal review** of the three suspension UI-copy strings
   (banner, in-app notice, email-notice-text).  Phase 2H
   ships minimum copy; a design slice can polish later.
2. **Posting-guard regression surface**.  Phase 2H adds a
   new check to the posting-guard.  Every existing posting
   path must still function for ACTIVE tenants.  Full
   `npm run quality` + full regression required before
   merge.
3. **StripeWebhookEvent back-reference**.  Phase 2E's
   webhook rows must be reachable from the suspension
   trigger (currently are — just records the dependency).

### 8b Soft dependencies

- A proper SIGNUP-2 Phase 2I "legacy-tenant adoption"
  workflow for pre-SIGNUP-2 Clubs; Phase 2H refuses to
  suspend them without it.
- A Phase 2H operator-UX design pass; shipping with
  functional minima.
- A documented operator runbook for the suspension /
  reinstatement workflow (ships alongside Phase 2H in
  `docs/runbooks/signup-2-phase-2h-operator-remediation.md`).

---

## 9. Deployment + flag strategy

- Single feature flag `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE`,
  fail-closed.
- OFF on production until a separate authorisation.
- No testOnly env var — Phase 2H works on real DB state (no
  mock Stripe path), so the acceptance uses synthetic
  fixtures rather than mock-isolation.
- DRH-1 to `spectre-staging` only.  No production.
- Rollback anchor: Phase 2G image `sha-5e6071507187` + Fly
  v901.

---

## 10. Reconciliation to Phase 2G production launch blockers

Phase 2G acceptance §12.7 listed nine blockers.  Phase 2H
addresses two of them directly + leaves seven untouched:

| # | Phase 2G blocker | Phase 2H impact |
|---|---|---|
| 1 | Steps 4-7 real importers | **Untouched** — a separate "real importers" slice. |
| 2 | Step 8 real welcome-email delivery | **Untouched** — same slice as #1. |
| 3 | Post-COMPLETED suspension handler | **ADDRESSED by §3 + §4 above.** Phase 2H ships this. |
| 4 | Live Stripe integration | **Untouched** — Phase 2E Stripe follow-up items 1.1-1.8. |
| 5 | User reuse by Microsoft identity | **Untouched** — separate schema slice. |
| 6 | Automatic Fly-worker cron | **Untouched** — Phase 2G decision D6. |
| 7 | Rich operator remediation UI | **PARTIALLY ADDRESSED** — Phase 2H ships functional minima (list, view, suspend, reinstate, retry, resolve); UX polish deferred. |
| 8 | Real legally-reviewed ToS v1 | **Untouched** — legal review. |
| 9 | Placeholder-scan allowlist cleanup | **Untouched** — pre-existing. |

After Phase 2H accepts, the remaining blockers reduce from 9
to **7** (items 3 + 7 addressed).

---

## 11. Testing + deployment plan (consolidated)

| Phase | What runs | Expected result |
|---|---|---|
| Local | `npm run typecheck` + Phase 2H contract tests | clean + ≥ 90 passing |
| Local | Full SIGNUP-2 regression (`tests/signup-2*.test.ts`) | 840+ passing (unchanged + Phase 2H additions) |
| Local | Full posting-guard regression | all operational writes still succeed on ACTIVE tenants |
| DRH-1 | Build + push + deploy to spectre-staging | success + post-deploy image-tag reliability gate |
| Staging | Controlled flag window ON: `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE=1` | `/api/health` 200 |
| Staging | Phase 2H Playwright acceptance | all 8 scenarios + RBAC-separation pass |
| Staging | Flag OFF via `flyctl secrets unset` | `/api/health` 200 post-restart |
| Acceptance | Write `docs/signup-2-phase-2h-acceptance.md` | matches the Phase 2F / 2G shape |

---

## 12. Outstanding founder decisions

| # | Decision | Options | Recommended default | Blocks START? | Blocks PRODUCTION? |
|---|---|---|---|---|---|
| D1 | Automatic UNDER_REVIEW on webhook triggers 1-5? | (a) Automatic.  (b) Operator-only. | **(a)** — automation + human-in-the-loop pairs well; a reversal shouldn't wait for operator availability | No | No |
| D2 | Final SUSPENDED requires operator confirmation? | (a) Yes (SoD not required for suspend).  (b) Yes + require two operators. | **(a)** — single-operator SUSPEND; SoD is specifically about reinstatement | No | No |
| D3 | Separation-of-duties required for reinstatement UNDER_REVIEW → ACTIVE? | (a) Yes, two distinct SUPER_ADMINs.  (b) Single operator. | **(a)** — matches founder §4 directive | No | **Yes** if (b) picked (security review needed) |
| D4 | SUSPENDED_READ_ONLY: what's actually readable? | (a) Everything previously readable.  (b) Only admin dashboards; member portal returns a dedicated banner. | **(b)** — members shouldn't see historical data on a suspended account | No | No |
| D5 | Resumption after SUSPENDED → UNDER_REVIEW: can skip back to ACTIVE immediately, or require a cooling-off period? | (a) Immediate (operator judgment).  (b) 24-hour cooling-off minimum. | **(a)** — operator judgment is faster for correctable mistakes; audit trail covers accountability | No | No |
| D6 | Operator-inbox category naming for Phase 2H | 7 new categories (same shape as Phase 2G's 7): `AUTO_SUSPENSION_PENDING`, `OPERATOR_CONFIRM_SUSPEND`, `REINSTATEMENT_PENDING`, `REINSTATEMENT_AUTHORISER_PENDING`, `TENANT_UNDER_REVIEW`, `TENANT_SUSPENDED`, `TENANT_REINSTATED` | Confirm or trim | No | No |
| D7 | `TenantLifecycleTransition` column name + scope | Current proposal: single transition table, no separate "RejectedReinstatement" table.  Alternative: separate attempt table. | **current proposal** — simpler + covers both via `reasonCode` | No | No |
| D8 | New permission keys to add | `platform:tenants:suspend` + `:reinstate` + `:remediate` | Confirm | No | No |
| D9 | Reason-code controlled vocab | ~ 15 codes covering the 6 triggers + 3 common operator rationales + a `OTHER` escape hatch | List drafted; confirm | No | No |
| D10 | Legacy-tenant handling (pre-SIGNUP-2 Clubs where `subscriptionStatus = null`) | (a) Phase 2H refuses to suspend them.  (b) Phase 2H auto-promotes them to `ACTIVE` before suspending.  (c) A separate Phase 2I adoption workflow is required first. | **(c)** — explicit adoption keeps data model honest | No | **Yes** if (b) — mass-promotion of grandfathered clubs needs separate sign-off |
| D11 | Scheduled background workers to gate | 10 listed in §5b | Confirm or add | No | No |
| D12 | Minimum UI copy | Three strings: banner, in-app notice, member-portal notice | Draft strings in `docs/signup-2-phase-2h-ui-copy-draft.md` (to be added at implementation time); legal review optional for a staging-only flag-gated feature | No | **Yes** — production launch needs legal sign-off on the three strings |

**Decisions blocking implementation START: NONE.**

**Decisions gating PRODUCTION ACTIVATION: D3 (if (b) chosen),
D10 (if (b) chosen), D12 (legal copy).**

---

## 13. What signing this package authorises

Replying **"Phase 2H AUTHORISED to implement per plan"** (or an
equivalent explicit phrase) + specifying a value for each of
D1-D12 (or "accept recommended default") would authorise:

1. Building the Phase 2H service (suspension + reinstatement
   + remediation).
2. Shipping the `TenantLifecycleTransition` schema + migration.
3. Extending the posting-guard with suspension awareness.
4. Shipping the three new RBAC permission keys + SoD rule.
5. Shipping the three new HTTP routes.
6. Shipping the ≥ 90 contract-test suite + 8-scenario
   Playwright acceptance.
7. Deploying to `spectre-staging` via DRH-1.
8. Running the acceptance under a controlled flag window.
9. Flipping flags OFF after acceptance + delivering
   `docs/signup-2-phase-2h-acceptance.md`.

**NOT authorised by signing this package:**
- Production deploy.
- Real Stripe webhook processing.
- Modifying existing-tenant access outside the explicit
  operator workflow.
- Legacy-tenant mass-promotion (D10 = (b)).
- Legal copy activation on production surfaces.
- Phase 2I / 2J / later-phase start.

---

## 14. What declining or deferring costs

- Phase 2G orchestration remains CONDITIONALLY ACCEPTED AND
  CLOSED but production launch stays blocked: a real tenant
  reaching Tier 2 has no safe reversal path.
- The nine Phase 2G launch blockers stay at nine; none of
  items 3 or 7 is resolved.
- No data, no existing tenant, no existing user is affected
  by declining.
- The Phase 2H plan + decision package remain valid
  indefinitely; a later authorisation picks up here.

---

## 15. Minimum operator runbook (preview for the implementation
   slice)

The implementation slice will ship a dedicated
`docs/runbooks/signup-2-phase-2h-operator-remediation.md`.
Preview of the shape:

1. **Trigger spotted** (via operator inbox or webhook dispatch
   alert).
2. **Review**: open the tenant's lifecycle page; confirm the
   trigger evidence; read the reconciliation history + audit
   log.
3. **Decide**: suspend / reinstate / retry / escalate.
4. **If suspending**: supply reason code + notes; the system
   writes the lifecycle transition + flips subscriptionStatus +
   accessTier; posting-guard enforcement activates immediately.
5. **If reinstating**: five eligibility checks run; second
   authoriser must sign off; the system flips subscriptionStatus +
   accessTier back to ACTIVE + FULL.
6. **If retrying a provisioning failure**: the Phase 2G
   `recoverFromFailure` helper runs; retry respects
   mock-isolation + revalidation.
7. **Audit**: every action lands in the lifecycle transition
   log + the standard audit log.

---

## 16. Change surface summary

| Layer | Change |
|---|---|
| Schema | 1 new model (`TenantLifecycleTransition`), 0 column drops, 0 rename.  Additive. |
| Service | 1 new service module (`signup-2h-tenant-lifecycle-service.ts`), ~ 600-800 lines. |
| Posting-guard | 1 extended check (reads subscriptionStatus + accessTier). |
| State machine | 2 new states + enumerated transitions. |
| Routes | 3 new POST routes (`suspend`, `reinstate`, `remediate`) + 1 new GET route (tenant lifecycle timeline). |
| RBAC | 3 new permission keys, SUPER_ADMIN-only by default. |
| Audit | Writes to `TenantLifecycleTransition` + existing `AuditLog`. |
| Workers | 10 workers gated via shared `isTenantOperationallyActive`. |
| Fixture harness | Extended with `phase2h-seed` / `phase2h-teardown` / `phase2h-inspect` / `phase2h-trigger-reversal`. |
| Contract tests | 10 suites, ≥ 90 assertions. |
| Playwright | 1 new staging-only spec, 8 scenarios + RBAC. |
| Documentation | This plan + the final acceptance doc + the operator runbook. |
| Deployment | DRH-1 to spectre-staging only; single new flag `SPECTRE_SIGNUP_2H_SUSPENSION_LIVE`. |

---

## 17. What this document is + is not

**IS:**
- The Phase 2H plan, awaiting founder authorisation.
- A reconciliation of the Phase 2G acceptance's blockers 3 + 7.
- A specification complete enough that implementation is a
  direct translation.
- The founder decision package for Phase 2H.

**IS NOT:**
- Authorisation to implement.
- A code change.
- A deployment.
- A Phase 2H-or-later implementation initiation.
- A commitment to any specific operator-UX design beyond the
  functional minima.

**Awaiting founder authorisation of Phase 2H per §13.**
