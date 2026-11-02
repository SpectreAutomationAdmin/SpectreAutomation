# EP-TRAIN-5B — Administrative Revision & Reinstatement

**Status:** Deployed to staging 2026-11-01. Builds on EP-TRAIN-5A-1's
obligation foundation. **Employee-facing enforcement is still inactive**
(resolver + dashboard swap belong to EP-TRAIN-5C) — this slice adds
only the two administrative workflows: *Revise Training* with a
three-option publish confirmation, and *Require Retake* without a
content change.

---

## 1. Scope

EP-TRAIN-5B delivers:

| Capability | Where |
|---|---|
| **Revise Training** button | Course detail page (same button as "Start new draft" when a published version exists; label changes to "Revise training") |
| **Three-option publish confirmation** | Version editor page's Publish panel — opens the new `PublishRevisionDialog` when the DRAFT is a revision (i.e. a prior PUBLISHED version exists); v1 publishes continue through the existing simple `PublishPanel`. |
| **Require Retake** button + modal | Course detail page, visible when a published version exists. |
| Server-side issuance identity | `randomUUID()` generated once per confirmed action; threaded as `${eventId}:${employeeId}` into the obligation's `issuanceKey` (EP-TRAIN-5A-1 contract). |
| Audit trail | `hr.training.revision.publish` and `hr.training.manual-reinstate.issue` audit actions carrying `eventId`, policy, affected ids, due date, reason. |

EP-TRAIN-5B does NOT touch:

- Employee Portal dashboard or course page (that is 5C's resolver swap)
- Recurring recertification scheduler (future, out of 5B scope)
- Automatic reassignment, notifications, email

## 2. Workflow A — Revise Training with Publication Policy

### 2.1 Trigger

On the admin course detail page:

- When a `PUBLISHED` version exists, the "Start new draft" button is relabeled "Revise training" (same server action, same `startNewDraft` service — the semantics are literally "start a draft off the latest version").
- The manager edits the draft in the existing version editor (video / description / checkpoints / questions / applicability).
- When ready, the Publish panel on the version editor:
  - For **v1 publishes** (no prior PUBLISHED): renders the existing simple `PublishPanel` with the one-click "Publish this version" button — unchanged.
  - For **revisions** (prior PUBLISHED exists): renders the new `PublishRevisionDialog` component. The manager clicks "Publish this version" → modal opens with three options.

### 2.2 Three options

| Option | What happens |
|---|---|
| **A — Require all applicable employees to complete the revised version** | Issue a REVISION obligation for every applicable employee (via all / dept / position / assigned). Historical completions preserved. Current staging count surfaced in the dialog. |
| **B — Require only employees who have not previously completed the course** | Resolve applicable employees → filter out those with a `TrainingCompletion` row against the prior PUBLISHED version id → issue REVISION obligations only to the remainder. Shows "N of M" count in the dialog so the manager sees how many are grandfathered. |
| **C — Require selected employees** | Manager checks specific people from the applicable roster. Server-side guard rejects any id that does not belong to this club (`issues: [{path: "selectedEmployeeIds"}]`). |

The dialog also displays a per-option summary panel with the live
"N employee(s) will receive a new requirement" count before the manager
clicks "Publish version".

### 2.3 Order of operations (post EP-TRAIN-5A-1)

```
┌───────────────────────────────────────────────────────────────┐
│ publishDraftWithPolicy({ principal, versionId, policy, ... }) │
├───────────────────────────────────────────────────────────────┤
│  1. loadDraft + assertTenantOwned + requirePermission         │
│  2. Resolve `priorPublished` (for revision detection)         │
│  3. Resolve target employee set per policy                    │
│     (fails here on cross-tenant SELECTED — publish NOT run)   │
│  4. publishDraft() — retires prior + flips currentVersionId   │
│  5. eventId = randomUUID()                                    │
│  6. For each target employee:                                 │
│       issueObligation({ reason: "REVISION",                   │
│                         issuanceKey: `rev:${eventId}:${emp}` })│
│     (per-employee failures collected, not fatal)              │
│  7. audit("hr.training.revision.publish", { eventId, ... })   │
└───────────────────────────────────────────────────────────────┘
```

**v1 publishes** (no prior PUBLISHED) pass through step 4 without
step 6 running — audit records "v1 publish — no REVISION obligations
issued" and returns 0 affected employees. (5C will seed INITIAL
obligations instead, if the backfill is still pending.)

### 2.4 Idempotency within a single confirmed publish

Each per-employee `issuanceKey` is composed as
`rev:${eventId}:${employeeId}`. A retry of the same server action
within the same confirmed publish uses the same `eventId` and
therefore idempotently returns the same obligations. A second
separate manager-confirmed publish allocates a new `eventId` →
new obligations per EP-TRAIN-5A-1 semantics.

A single-request duplicate in `selectedEmployeeIds` (e.g. same id
twice) deduplicates via `Array.from(new Set(...))` upstream of the
issue loop — proven by `§6.7 — RETRY of the same publishDraftWithPolicy
call does not duplicate`.

## 3. Workflow B — Require Retake (no content change)

### 3.1 Trigger

On the admin course detail page, a **Require Retake** button sits in
the top-right action row (next to "Revise training" and "Retire
course") and is visible when the course has a currently published
version.

### 3.2 Three-step dialog

1. **Pick** — enter mandatory reason + optional due date; select
   employees from the applicability roster via a filterable list.
2. **Review** — click "Review"; server returns a per-employee
   preview with latest completion (version + date + score) AND any
   OUTSTANDING obligations currently in place. The manager sees the
   full conflict picture before confirming.
3. **Confirm & Issue** — one server-side `eventId` for the whole
   submission → `rtk:${eventId}:${employeeId}` per obligation.

### 3.3 Conflict handling (per directive §3)

The review step surfaces for each employee:

- Their latest completion (if any) — version number, date, score
- Every OUTSTANDING obligation currently in place for this course
- An explanatory note: *"This will add an additional requirement;
  existing ones remain in place and are satisfied in the order
  issued."*

This mirrors the EP-TRAIN-5A-1 FIFO policy: new MANUAL_REINSTATE
obligations coexist with any prior OUTSTANDING; satisfied in
`issuedAt ASC` order (`pickObligationToSatisfy` helper). The service
does NOT auto-cancel or auto-supersede prior obligations.

### 3.4 Idempotency

Same mechanism as revision publish: single `eventId` + per-employee
`issuanceKey` → UI double-click is a no-op; a second manager-
confirmed action (new `eventId`) correctly produces coexisting
obligations.

Dedup within a single call: `Array.from(new Set(employeeIds))` → a
request with duplicate ids writes one obligation per unique
employee.

## 4. Validation + authorization

All server-side:

| Guard | Enforced by |
|---|---|
| `hr:training:publish` permission at the active club | `requirePermission` in both `publishDraftWithPolicy` and `issueManualReinstatement` |
| Tenant isolation on the course | `assertTenantOwned` — throws before any write |
| SELECTED employee ids must belong to the club | Explicit `prisma.employee.findMany({where: {id: in requested, clubId}})` check, with the diff logged in a `ValidationError` |
| Mandatory reason on MANUAL_REINSTATE | Service layer trims + length check |
| Due date is a valid date | Server action parses + checks `Number.isNaN` |
| Course must have a published version to require retake | `issueManualReinstatement` throws `ValidationError` otherwise |

Non-admin principals (e.g. `STAFF`) are blocked by `requirePermission`
before any mutation.

## 5. Audit

Two new audit actions:

| Action | Entity | Meta |
|---|---|---|
| `hr.training.revision.publish` | `TrainingCourseVersion` (the newly published version) | `eventId`, `policy`, `versionNumber`, `priorPublishedVersionId`, `affectedCount`, `obligationCount`, `skippedCount` |
| `hr.training.manual-reinstate.issue` | `TrainingCourse` | `eventId`, `courseVersionId`, `employeeCount`, `reason`, `dueAt` (ISO) |

Both wrap the pre-existing `hr.training.version.publish` audit from
`publishDraft` so the publish and the obligation issuance are linked
by `eventId` for a Controller-friendly reporting join.

## 6. Historical data preservation

- No `TrainingCompletion`, `TrainingAttempt`, or `TrainingProgress`
  row is deleted, modified, or marked failed by either workflow.
  Proven by `§6.11` contract test (row counts + explicit
  `completedAt` + `score` comparison before/after).
- Historical rows remain queryable by the employee + manager views
  exactly as they did before 5B.
- The obligation is purely additive — it says "they currently owe
  this specific version"; the completion history stays its own
  independent evidence stream.

## 7. UI design discipline

Both dialogs follow the existing Spectre administrative design
system: `btn btn-primary` / `btn btn-secondary` buttons, standard
`table-base` for the review table, standard `rounded-md` + stone
palette for the modal shell. No `issuanceKey`, no `OUTSTANDING`,
no `TrainingCourseVersion` identifiers are ever shown to the user —
copy uses "requirement", "retake required", "version N", "N
employee(s) will receive a new requirement".

Reason-ladder visibility:

- "REVISION" obligation → UI label **"Updated training required"**
- "MANUAL_REINSTATE" obligation → UI label **"Retake required"**

## 8. Tests (12 directive scenarios → 20 contract tests)

`tests/hr/training/revisions.test.ts` — 20 of 20 PASS locally:

| Directive § | Coverage |
|---|---|
| 6.1 | DRAFT creation preserves PUBLISHED row |
| 6.2 | All three policies (ALL / NON_COMPLETERS / SELECTED), empty SELECTED rejection, v1 publish behavior |
| 6.3 | Retake of unchanged version writes a MANUAL_REINSTATE obligation |
| 6.4 | Selected-only obligation issuance |
| 6.5 | Empty / whitespace reason rejection |
| 6.6 | Optional due date persists |
| 6.7 | Within-call duplicate id deduplication (both workflows) |
| 6.8 | Preview surfaces conflicts; two independent reinstatements coexist |
| 6.9 | Supersession rule (covered in `obligations.test.ts`); 5B does NOT auto-supersede |
| 6.10 | Cross-tenant + cross-tenant-SELECTED + unauthorized-principal refusal |
| 6.11 | Zero completion / attempt / progress mutations |
| 6.12 | `resolveEmployeeSchedulingEligibility` still ignores obligations (no employee-facing regression) |

Plus the 21 EP-TRAIN-5A-1 obligation contract tests remain PASS
(invariants unchanged).

## 9. Rollback

Neither workflow mutates any historical row. Rolling back is purely
an obligation-table action:
- Revision rollback: `DELETE FROM "TrainingObligation" WHERE reason = 'REVISION' AND "clubId" = ? AND "courseVersionId" = ?;`
- Manual-reinstate rollback: `DELETE FROM "TrainingObligation" WHERE reason = 'MANUAL_REINSTATE' AND "clubId" = ? AND id IN (?);`

Both are safe because 5C has not landed — nothing employee-facing
reads these rows yet.

## 10. Not implemented in 5B (next slices)

- Employee Portal consumption of obligations → **5C**
- Dashboard de-duplication for same-reason overlaps → **5C**
- Auto-supersession when a REVISION replaces an INITIAL → **5C or an explicit 5B+ follow-up**
- Recurring recertification scheduling → future
- INITIAL backfill run → gated on 5C's resolver readiness

## 11. STOP boundary

- No employee-facing changes shipped.
- No INITIAL backfill run.
- No notifications, emails, or automatic reassignment.
- No production deployment.
