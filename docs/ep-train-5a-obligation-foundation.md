# EP-TRAIN-5A — Training Obligation Foundation

**Status:** Deployed to staging 2026-11-01 as a dormant foundation.
No existing user-facing surface consults the new model yet.

**Owners:** EP-TRAIN-5B wires manager flows; EP-TRAIN-5C swaps the
applicability resolver + dashboard + player.

---

## 1. Why

The current training model (`src/lib/hr/training/applicability.ts`)
derives "is this course outstanding?" from the absence of a
`TrainingCompletion` row for the currently-published
`courseVersionId`. Three real workflows cannot be expressed in that
model:

| Need                                                | Possible today?                                   |
|-----------------------------------------------------|---------------------------------------------------|
| Grandfather Alice's v1 completion when v2 publishes | ❌ v2 is instantly outstanding for everyone       |
| Require Bob to retake v1 again (no revision)        | ❌ `@@unique([employeeId, courseVersionId])` blocks |
| Annual food-safety recertification                  | ❌ no durable obligation after the first pass     |

`TrainingObligation` becomes the authoritative answer to
"*does this employee currently owe this specific version?*", decoupled
from "*has this employee ever completed this version?*". History is
preserved; the obligation stream explains what is required *right now*.

## 2. Model

Full field definitions live in [prisma/schema.prisma](../prisma/schema.prisma)
at the `TrainingObligation` model.

### 2.1 Reasons

| Reason             | Issuer                                                               | Issued by EP-TRAIN-5A? |
|--------------------|----------------------------------------------------------------------|------------------------|
| `INITIAL`          | 5C applicability resolver when a course first becomes applicable     | No                     |
| `REVISION`         | 5B publish-with-retake flow (Options B and C)                        | No                     |
| `MANUAL_REINSTATE` | 5B "Require Retake" admin action                                     | No                     |
| `RECERTIFICATION`  | Future recurring scheduler (annual food safety, etc.)                | No                     |

EP-TRAIN-5A ships the service module **dormant**. No automated job,
API route, or UI surface creates obligations yet. 5B / 5C begin
populating the table.

### 2.2 State machine

```
                 cancelObligation()
                 ┌────────────────────→ CANCELED (terminal)
                 │
  OUTSTANDING ───┼────────────────────→ SATISFIED (terminal)
                 │ satisfyObligation…()
                 │
                 └────────────────────→ SUPERSEDED (terminal)
                   supersedeObligation()
```

Terminal statuses are frozen. A new event (another revision, another
reinstatement) issues a NEW obligation; it does NOT re-open a terminal
one.

### 2.3 Invariants

1. **At most ONE `OUTSTANDING` per `(employee, courseVersionId, reason)`**
   — enforced via the `outstandingUniqueKey` UNIQUE index. The service
   sets the key on OUTSTANDING rows and NULL on terminal ones; both
   SQLite and Postgres treat multiple NULLs as distinct in UNIQUE
   indexes, so terminal rows do not collide.

2. **One completion satisfies AT MOST one obligation**
   — enforced via `TrainingObligation.satisfiedByCompletionId @unique`.

3. **An old completion must not auto-satisfy a newly issued obligation**
   — enforced in `satisfyObligationWithCompletion` with
   `completion.completedAt >= obligation.issuedAt`.

4. **Tenant isolation** — every write accepts a `clubId` and re-validates
   it against the course's club before inserting.

Invariants 1 & 2 are checked at both the DB layer and the service
layer. 3 & 4 are enforced at the service layer only.

## 3. Backfill design (NOT YET RUN)

When 5C swaps the resolver to consult obligations, we must preserve
current behaviour exactly. The backfill (documented here, scripted
in a 5C-adjacent slice) will:

For every `(employee, course)` pair where the course is applicable
to the employee today (via all / department / position / assigned):

- **If a `TrainingCompletion` row exists** for the currently-PUBLISHED
  version → create a `SATISFIED` obligation with:
  - `reason = "INITIAL"`
  - `issuedAt = completion.completedAt` (so invariant 3 is satisfied
    for retrospective matching)
  - `satisfiedByCompletionId = completion.id`
  - `satisfiedAt = completion.completedAt`
  - `outstandingUniqueKey = null`
  - `issuedByUserId = null` (system-issued)

- **If no completion exists AND `version.required = true`** → create
  an `OUTSTANDING` obligation with:
  - `reason = "INITIAL"`
  - `issuedAt = now()` (or the retroactive timestamp used by the
    audit — final choice deferred to 5C)
  - `outstandingUniqueKey = ${employeeId}|${versionId}|INITIAL`
  - `issuedByUserId = null`

- **If no completion exists AND `version.required = false`** → no
  obligation. Optional courses are not tracked by the obligation
  stream.

The backfill is idempotent against `issueObligation`'s invariant 1,
so partial runs + retries converge.

**Rollback:** `DELETE FROM "TrainingObligation";` — the completion
history is untouched because obligations only reference completions
via `satisfiedByCompletionId` (ON DELETE SET NULL).

## 4. Future (post-5C) resolver shape

The directive mandates that `resolveEmployeeSchedulingEligibility`
switch its "outstanding" derivation to the obligation stream:

```ts
// pseudocode — final shape designed in 5C
export async function resolveOutstandingObligationsForEmployee(employeeId) {
  return prisma.trainingObligation.findMany({
    where: { employeeId, status: "OUTSTANDING" },
    orderBy: [{ dueAt: "asc" }, { issuedAt: "asc" }],
    include: { course: true, courseVersion: true },
  });
}
```

The current applicability signal (dept / position / assignment) still
drives WHO gets a new obligation at publish time. The obligation
stream owns "what does this employee still owe right now."

## 5. Permissions

Unchanged. The existing `hr:training:publish` + `hr:training:write`
permission keys guard the (future) manager actions in 5B. The
service module leaves authorization enforcement to the caller — see
the "defense in depth" note at the top of `obligations.ts`.

## 6. Why the service module is dormant in 5A

The directive explicitly requires:

> *"Do not deploy an incomplete obligation model that causes previously
> completed courses to appear outstanding unexpectedly."*

Shipping the schema + service + tests without a resolver swap and
without the backfill respects that constraint. Current behaviour is
unchanged: `resolveEmployeeSchedulingEligibility` still looks up
`TrainingCompletion` rows exactly as before, and the dashboard renders
exactly the same outstanding set it rendered yesterday.

When 5B lands:
1. New revisions / reinstatements write obligations.
2. The resolver *reads* obligations IN ADDITION TO the completion
   check (not instead of), so unaffected employees see no change.

When 5C lands:
3. The backfill runs.
4. The resolver flips to obligation-authoritative.
5. The dashboard distinguishes "Updated Training Required" (reason=REVISION)
   vs "Retake Required" (reason=MANUAL_REINSTATE) labels.

STOP boundary respected: no scheduler, no notification, no auto-expiry.
