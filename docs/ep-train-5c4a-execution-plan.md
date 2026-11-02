# EP-TRAIN-5C-4B — Proposed Execution Plan (Controlled Activation)

**Status:** PROPOSED. Not approved. Not executed.
**Precedes:** EP-TRAIN-5C-4A audit (this report).
**Baseline at authoring time:** `spectre-staging:sha-a6bf36202d71` (Fly v1074).

This document defines the preconditions, exact approved scope,
controlled-execution steps, validation checkpoints, rollback
strategy, and STOP conditions for the first EP-TRAIN-5C INITIAL
obligation backfill. It is a plan — the writer and reviewer are the
same model, so founder re-review of every §1–§13 preconditions is
mandatory before any step runs.

Companion deliverables:
- `ep-train-5c4a-readiness-report.md` — audit summary.
- `ep-train-5c4a-backfill-impact-register.csv` — per-pair detail.
- `ep-train-5c4a-resolver-comparison.md` — legacy vs new.
- `ep-train-5c4a-founder-approval-checklist.md` — decision gate.

---

## 1. Objectives

1. Issue the smallest safe cohort of INITIAL obligations to prove
   the backfill mechanics end-to-end on staging without disturbing
   any other training surface.
2. Preserve every historical TrainingCompletion / TrainingAttempt /
   TrainingProgress row — the backfill writes only to
   `TrainingObligation` and `AuditLog`.
3. Produce auditable per-row evidence (one `audit()` call per
   obligation issued) so the controller UI can later reconcile.
4. Keep the activation of the obligation-aware resolver as a
   SEPARATE step; the backfill itself is harmless to the running
   scheduling resolver because the legacy resolver does not read
   `TrainingObligation`.

---

## 2. Approved scope (narrow)

**Recommended authorized set:**
- 1 employee — `E-00003` Marc Maldiney @ Coulee Ridge Golf &
  Country Club (`clubId=cmrvdeny7000144372ktmmg9c`).
- 8 CREATE_INITIAL obligations against his 8 currently-applicable
  Coulee Ridge courses lacking a completion:
  1. `ORIENTATION_2027` — Coulee Ridge Staff Orientation
  2. `EQUIPMENT_SAFETY_2026` — Equipment Safety
  3. `FIRE_SAFETY` — Fire Safety
  4. `FOOD_SAFETY_2026` — Food Handling and Safety 2026
  5. `DEMO_FR_SAFETY` — Founder Demo – Safety & Training
  6. `KNIFE_SAFETY_2026` — Knife Safety
  7. `ROOFTOP_SAFETY_2026` — Rooftop Safety 2026
  8. `GAS_VERSUS_DIESEL` — The benefits of Gas vs Diesel

The scope **excludes**:
- Chris Turcato (founder) — preservation standing instruction.
- FounderDemo — requires founder decision (Approval Checklist §3).
- PAY1A-Test-A / PAY1A-Test-B — INCOMPLETE_ONBOARDING, requires
  classification decision (Approval Checklist §4).
- Every FIXTURE employee — SKIP_FIXTURE by rule.
- Every non-Coulee-Ridge club.

### 2.1 Why Marc first

Marc is the ONLY LEGITIMATE_ACTIVE non-founder non-demo employee
in the current staging dataset. Issuing against Marc:
- Exercises every code path (`issueInitialObligations` service,
  posting-guard, idempotency, audit, resolver outputs).
- Produces 8 observable UI effects (dashboard chips, course-page
  state pills, Required Training rail entries).
- Has zero scheduling-outcome impact (legacy already blocks him).

Expansion to a wider cohort is a follow-up slice after this
narrow slice is accepted.

---

## 3. Pre-activation preconditions (ALL must hold before step 1 runs)

| # | Precondition | Verification method |
|---|---|---|
| P1 | Staging image matches the accepted baseline or an authorised successor | `flyctl status --app spectre-staging` → image sha; compared against this plan's baseline. |
| P2 | `/api/health` returns 200 | `curl -o /dev/null -w "%{http_code}" https://staging.spectreautomation.com/api/health` |
| P3 | Founder preservation untouched | SSH snapshot: `{completions:9, attempts:30, progress:9}` for E-00002 |
| P4 | Zero existing OUTSTANDING obligations in scope | SSH query: `trainingObligation.count({ where: { status: "OUTSTANDING", employeeId: "<Marc's id>" } }) === 0` |
| P5 | Register still shows 8 CREATE_INITIAL for Marc + 0 REVIEW_REQUIRED mutations | Regenerate `scripts/ep-train-5c4a-impact-register.mjs`, diff summary.actions vs this plan. |
| P6 | DB backup snapshot captured | Fly Postgres snapshot via `flyctl pg snapshot create` or equivalent. **Snapshot id recorded in the deploy ticket.** |
| P7 | Rollback anchor documented | Image sha + Fly release + snapshot id. |
| P8 | Idempotency key format fixed | Service's INITIAL-issuance key format: `init:${applicabilityWindowBucket}` — bucket format MUST be deterministic (ok) and must NOT include `Date.now()` or similar (confirmed). |
| P9 | No scheduling-eligibility code path reads TrainingObligation yet | Grep confirms: scheduling resolver is unchanged in `src/lib/hr/scheduling-eligibility.ts`. |
| P10 | Audit action name reserved | `hr.training.obligation.issue.initial.backfill` with per-row entityId pointing at the obligation. |

If any precondition fails: **STOP. Do not proceed. File the failure
in the deploy ticket. Do not attempt remediation inside the backfill
step.**

---

## 4. Controlled execution

### 4.1 Service entry point

A new service function (to be authored in 5C-4B's implementation
PR, not this plan) under `src/lib/hr/training/obligations.ts`:

```ts
export async function issueInitialObligationsForEmployee(
  principal: Principal,
  args: { employeeId: string; clubId: string; dryRun: boolean }
): Promise<IssueInitialResult>
```

Properties:
- Permission gate: `hr:training:publish` on the active club.
- Tenant isolation: refuses if `principal.activeClubId !== args.clubId`.
- Applicability resolution: calls `resolveApplicableCourses`
  (identical to the register).
- For each applicable (employee, courseVersion) pair with no
  qualifying completion AND no OUTSTANDING obligation:
  - Compute `issuanceKey = "init:" + applicabilityWindowBucket`
    where the bucket is the current `(employeeId, courseVersionId)`
    first-applicable moment (defaults to the employee's `createdAt`
    if no explicit bucket is available).
  - Upsert via `prisma.trainingObligation.create` guarded by the
    composite `(clubId, employeeId, courseVersionId, reason,
    issuanceKey)` UNIQUE.
  - Write `audit({ action: "hr.training.obligation.issue.initial.backfill",
    entityType: "TrainingObligation", entityId: obligation.id, clubId,
    before: null, after: { reason, courseVersionId, issuanceKey } })`.
- Transactional at the service level: each (employee, courseVersion)
  pair is written in its own small transaction. The outer backfill
  caller aggregates per-employee progress.
- `dryRun: true` performs every read + every validation but SKIPS
  the create + audit. Returns the counts the real run would produce.

### 4.2 Call sequence

1. Confirm P1–P10 again inside the execution window.
2. `issueInitialObligationsForEmployee(founderPrincipal, { employeeId: Marc, clubId, dryRun: true })` — verify the DRY_RUN returns `{ created: 8, skipped: 0 }`.
3. Snapshot: `obligationCount = 0`; `audit count` for action key.
4. `issueInitialObligationsForEmployee(founderPrincipal, { employeeId: Marc, clubId, dryRun: false })`.
5. Snapshot: `obligationCount === 8` (OUTSTANDING, reason=INITIAL,
   employeeId=Marc, courseVersionId ∈ expected set, issuanceKey all
   distinct).
6. Audit snapshot: 8 rows with the designated action; verify each
   `after.courseVersionId` matches a row.
7. Rerun step 4 — expected result: `{ created: 0, skipped: 8 }` (the
   composite UNIQUE rejects the duplicate).
8. Snapshot: `obligationCount === 8` (unchanged).

### 4.3 Failure handling

If step 4 fails after writing some rows (partial commit):
- The service wraps each pair in its own small transaction, so a
  partial run leaves 0..N obligations in a consistent state.
- `audit` is written INSIDE the same transaction, so there is no
  obligation-without-audit row.
- Rerun step 4 — the composite UNIQUE idempotently skips rows
  already written.
- If rerun step 4 fails on the SAME pair twice: **STOP, roll back
  via step 10, file an incident.**

### 4.4 No partial-success silence

The service returns `IssueInitialResult = { created, skipped, failed }`.
`failed > 0` → the outer runner stops after that employee and
reports a BLOCKED checkpoint.

---

## 5. Validation checkpoints (post-execution)

Within 10 minutes of step 4 completion:

| Check | Expected | Method |
|---|---|---|
| V1 | Marc has 8 OUTSTANDING INITIAL obligations | SSH prisma count |
| V2 | Marc's dashboard renders 8 obligation chips | authenticated Playwright on `/employee/safety-training` as Marc (fixture / staging login) |
| V3 | Marc's course pages (per obligation) show "Initial Training Required" state pill (or the configured copy) | authenticated Playwright per courseVersionId |
| V4 | Chris's dashboard unchanged | authenticated Playwright on `/employee/safety-training` as Chris |
| V5 | FounderDemo's dashboard unchanged | authenticated Playwright or SSH snapshot |
| V6 | Admin workflows (Require Retake, Publish Revision, etc.) unchanged | authenticated Playwright as founder admin |
| V7 | Legacy scheduling-eligibility resolver output unchanged for ALL employees | SSH script compares before/after |
| V8 | Zero mutation to completions / attempts / progress | SSH snapshot diff |
| V9 | Audit trail: 8 rows for `hr.training.obligation.issue.initial.backfill` with Marc's entityId | SSH prisma query |
| V10 | Founder preservation: `{9, 30, 9, 0}` | SSH snapshot |

Any FAIL → stop, roll back via §10, file incident.

---

## 6. Resolver cutover (SEPARATE SLICE)

The 5C-4B activation plan **does NOT** change which resolver the
scheduling path reads. The obligation-aware resolver remains
dormant. A separate slice (likely EP-TRAIN-5C-4C) will:
1. Add an explicit feature flag `SPECTRE_TRAINING_COMPLIANCE_RESOLVER`.
2. Wire the admin UI to flip the flag inside a staging-only window.
3. Compare legacy vs new resolver outputs server-side for the
   current cohort during the window; verify zero reversals.
4. Flip the flag OFF after the window closes.
5. Record the per-tenant resolver outputs for the founder.

The 5C-4B backfill does NOT depend on the resolver cutover; the
backfill produces data the new resolver would read if activated.

---

## 7. Rollback strategy

Rollback does NOT delete completions, attempts, progress, courses,
or employees. It reverses only the obligations the backfill
created.

### 7.1 Reversible obligation cancellation (preferred)

Operator action: for each obligation created by the backfill:
- `update({ status: "CANCELED", ... })` with a `cancellationReason`
  describing the rollback event and the deploy ticket id.
- Preserves the audit trail: the obligation row stays, the
  `satisfiedByCompletionId` is null, the status is CANCELED.
- Legacy resolver is unaffected; new resolver (if ever activated)
  classifies CANCELED as non-blocking.

Operator script: `scripts/ep-train-5c4b-cancel-backfill.mjs`
(authored in 5C-4B, not this plan). Dry-run safe; refuses to run
without an explicit `rollback-reason` env variable and the matching
deploy ticket id.

### 7.2 Fly image rollback

If the backfill itself cannot be rolled back (which should not
happen because the service writes are reversible via §7.1), the
rollback anchor is:
- Image: `spectre-staging:sha-1c10508065b3` (Fly v1074).
- Snapshot: Fly Postgres snapshot captured in P6.
- Procedure: `flyctl releases rollback -r 1074 --app spectre-staging`.

**Fly image rollback does NOT remove the obligation rows** — they
were written to Postgres, not the image. The §7.1 cancel path is
the canonical rollback mechanism.

### 7.3 Destructive rollback (never used by default)

A `prisma.trainingObligation.deleteMany({ where: {backfill marker}})`
would physically delete the rows. This destroys the audit trail
and MUST NOT be used except as a tenant-isolated recovery of a
badly-mis-tenanted backfill (which the service's tenant guard
should make impossible). Requires separate founder authorization.

---

## 8. Timing + visibility

- Backfill wall-clock: estimated < 30 seconds for Marc's 8 pairs.
- Full validation (V1–V10): 5–10 minutes.
- Rollback (if required): < 60 seconds via §7.1.
- Window: a controlled window AFTER founder authorization, with no
  concurrent EP-TRAIN-* work.

---

## 9. Observability + audit

- Each obligation issuance writes `audit()` with `action =
  "hr.training.obligation.issue.initial.backfill"`.
- The backfill script writes a run-level audit row with action
  `hr.training.backfill.initial.run` containing the aggregate
  summary (`{clubId, employeeId, created, skipped, failed}`).
- Post-run: snapshot the audit log to `test-results/`
  (gitignored) and reference the run id in the acceptance report.

---

## 10. STOP conditions

The 5C-4B execution must STOP (not proceed, not retry) if:

- Any P1–P10 precondition fails.
- Any V1–V10 validation fails.
- A new PUBLISHED course version has been written between register
  regeneration and backfill execution.
- The target employee or any applicable course has been modified
  during the execution window.
- The founder-preservation snapshot (Chris's `{9,30,9,0}`) changes
  mid-run.
- Any FIXTURE row (per §4 classification rules) ends up in the
  authorized-execution scope.

---

## 11. Explicit non-goals (what 5C-4B does NOT do)

- Issue obligations against the founder.
- Issue obligations against the FounderDemo employee (unless
  Approval Checklist §3 authorizes it in a separate slice).
- Reclassify or delete PAY1A-Test-A / PAY1A-Test-B.
- Clean up any FIXTURE row.
- Activate the obligation-aware resolver as the scheduling gate.
- Change scheduling-eligibility enforcement.
- Modify any Employee Portal UI.
- Produce or modify RECERTIFICATION obligations.
- Deploy to production.
- Expand to any club other than Coulee Ridge.

---

## 12. Expected acceptance evidence

A 5C-4B acceptance report under `docs/ep-train-5c4b-*.md` must
include:

- Pre-run snapshot (counts + rollback anchor).
- DRY_RUN output.
- Backfill output (`{ created: 8, skipped: 0, failed: 0 }`).
- Post-run snapshot (counts, obligation ids, audit rows).
- Playwright authenticated acceptance for V2 (Marc's dashboard).
- Chris's dashboard unchanged screenshot.
- Idempotency re-run proof (`{ created: 0, skipped: 8 }`).
- Rollback script dry-run output (not executed unless rollback is
  needed).
- Founder sign-off recorded.

---

## 13. Decision gate (pre-5C-4B)

Founder must approve, in writing, before 5C-4B begins:
- Scope: **Marc only** (per §2 recommended narrow scope).
- Policy for FounderDemo: skip for 5C-4B, revisit later.
- Policy for PAY1A-Test-A / PAY1A-Test-B: skip for 5C-4B, revisit
  later.
- Policy for Chris Turcato (founder): skip for 5C-4B, do not
  issue obligations.
- Rollback method: CANCELED-status rollback (per §7.1) is the
  default; destructive deletion requires separate authorization.
- Scheduling enforcement: unchanged by 5C-4B.
- Timing: founder-chosen window; not implicitly triggered by
  authorization of this plan.

See `ep-train-5c4a-founder-approval-checklist.md` for the full
decision list.
