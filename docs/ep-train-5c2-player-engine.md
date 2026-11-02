# EP-TRAIN-5C-2 — Obligation-Scoped Player Engine & Atomic Completion

**Status:** Deployed to staging 2026-11-02 behind a server-side
activation boundary. The new obligation-scoped progress + atomic
completion engine runs ONLY when an OUTSTANDING `TrainingObligation`
is active for the (employee × version). When no obligation is active,
the pre-5C-2 legacy path runs byte-for-byte unchanged — preserving
EP-TRAIN-4E completed-course replay exactly.

**No employee UI, dashboard, or chrome changes.** 5C-3 wires the UI;
5C-4 runs the live backfill + activates the obligation-aware
resolver. Pre-5C-4 nobody has OUTSTANDING obligations on prod → the
new engine is inert for every real employee.

---

## 1. Architecture audit

Walked the training attempt + progress + completion write paths in
[src/lib/hr/training/attempts.ts](../src/lib/hr/training/attempts.ts):

| Function | Risk pre-5C-2 | 5C-2 fix |
|---|---|---|
| `recordVideoProgress` | `trainingProgress.upsert({where: {employeeId_courseVersionId: ...}})` keyed by the legacy UNIQUE. A retake would overwrite the completed row's `secondsWatched` / `farthestSecond` / `checkpointClearedJson`. | **Switched to obligation-scoped upsert.** When an active OUTSTANDING obligation exists, upsert the row keyed by `(employeeId, courseVersionId, obligationId)`. When none, keep the legacy singleton (null obligationId). |
| `getPlayerState` | Returns `finalAssessmentUnlocked: reasons.length === 0 && completion === null`. A prior completion row BLOCKS unlock. | **Obligation-aware unlock.** When an active obligation exists, consider only the completion LINKED to that obligation (via `TrainingObligation.satisfiedByCompletionId`). The legacy per-version historical completion no longer blocks the new attempt. |
| `startAttempt` + `startCheckpointAttempt` | Create `TrainingAttempt` with `(employeeId, courseVersionId, attemptNumber)` unique. No obligation context. | **Stamp `obligationId` on new attempts** when active obligation exists. Legacy path unchanged. |
| `submitAttempt` (checkpoint) | `trainingProgress.upsert({where: {employeeId_courseVersionId: ...}})` on cleared-checkpoint persistence. Same leak risk. | **Mirrors `recordVideoProgress`.** |
| `submitAttempt` (final, passing) | Creates `TrainingCompletion` with `attemptId @unique` idempotency guard. **Does NOT link to any obligation.** Obligation stays OUTSTANDING forever. | **Atomic completion + satisfaction.** In the same `prisma.$transaction`: create completion, then call `satisfyObligationWithCompletion`. |

### Progress uniqueness

[`TrainingProgress`](../prisma/schema.prisma) previously:

```
@@unique([employeeId, courseVersionId])
```

Allowed exactly one progress row per (employee, version). A retake
would mutate the completed row — directly violating directive §5
"Previous watched coverage must not satisfy the new obligation."

**EP-TRAIN-5C-2 schema change:**
- Add nullable `obligationId: String?` + FK to `TrainingObligation`.
- Replace the strict UNIQUE with:
  - A **partial** UNIQUE `WHERE "obligationId" IS NULL` guaranteeing one legacy-singleton row per (employee, version). All existing rows satisfy this invariant trivially (they all have `obligationId = NULL` after the migration).
  - A **partial** UNIQUE `WHERE "obligationId" IS NOT NULL` guaranteeing one obligation-scoped row per `(employee, version, obligation)`.
- Prisma schema uses a plain `@@index([employeeId, courseVersionId])` + `@@index([obligationId])`; the partial uniques live in raw-SQL migrations (both engines).

All existing `TrainingProgress` rows get `obligationId = NULL` by default on migration — zero data mutation.

### Attempt + completion schema

- `TrainingAttempt`: add nullable `obligationId: String?` + FK. Keep existing `@@unique([employeeId, courseVersionId, attemptNumber])` (unchanged — attempt numbers are per-version-serial and don't need obligation scoping on the unique).
- `TrainingCompletion`: no schema change. The forward link already exists via `TrainingObligation.satisfiedByCompletionId @unique` (EP-TRAIN-5A). Service layer handles the write-side atomicity.

## 2. New service module: `training-session.ts`

[src/lib/hr/training/training-session.ts](../src/lib/hr/training/training-session.ts) is the single orchestrator for obligation-scoped sessions:

| Export | Purpose |
|---|---|
| `resolveActiveObligationForSession(employeeId, courseVersionId)` | Returns the oldest eligible OUTSTANDING obligation on the (employee × version). Null when none. **FIFO per EP-TRAIN-5A-1 §4.** Secondary ordering by `id ASC` for deterministic resolution when `issuedAt` ties. |
| `upsertObligationScopedProgress(args)` | Manual find-first-then-update-or-create keyed by `(employeeId, courseVersionId, obligationId)`. Writes to the legacy singleton when `obligationId === null`. |
| `completeAndSatisfyAtomic(args)` | `prisma.$transaction`: creates `TrainingCompletion` + calls `satisfyObligationWithCompletion`. Idempotency key: `attemptId` (already `@unique` on TrainingCompletion). |

All helpers are tenant-scoped (every write asserts `clubId` matches the employee's clubId + the course's clubId before writing).

## 3. Replay compatibility (directive §10)

The new engine activates ONLY when `resolveActiveObligationForSession` returns a non-null obligation. For a completed course with NO OUTSTANDING obligation, every call path identical to pre-5C-2:
- `recordVideoProgress` writes the legacy singleton row.
- `getPlayerState` uses the pre-5C-2 derivation (`completion` from `findFirst(... order by completedAt desc)`).
- Replay starts at 0:00; no checkpoints trigger; no attempts created; no completion rows written — exactly the EP-TRAIN-4E behavior.

Pre-5C-4 nobody has OUTSTANDING obligations in production, so the new engine is inert on prod. On staging the new engine is exercised via fixture obligations.

## 4. Atomic completion + obligation satisfaction (directive §8)

New code path inside `submitAttempt` (final, passing):

```ts
const activeObligation = await resolveActiveObligationForSession(
  actor.employeeId, attempt.courseVersion.id,
);

const result = await prisma.$transaction(async (tx) => {
  // Idempotency guard — if the same attempt already has a completion
  // row (double-submit retry), return it; do not create or satisfy
  // again.
  const existing = await tx.trainingCompletion.findUnique({
    where: { attemptId: attempt.id },
  });
  if (existing) {
    // The attempt's completion already exists; if that completion
    // SATISFIED an obligation on a prior successful call, nothing
    // more to do (TrainingObligation.satisfiedByCompletionId @unique
    // + the ValidationError in satisfyObligationWithCompletion will
    // naturally reject a replay).
    return { completionId: existing.id, satisfiedObligationId: null };
  }
  const completion = await tx.trainingCompletion.create({
    data: {
      clubId: actor.clubId, employeeId: actor.employeeId,
      courseId: attempt.courseVersion.course.id,
      courseVersionId: attempt.courseVersion.id,
      attemptId: attempt.id, score,
    },
  });
  if (activeObligation) {
    await satisfyObligationWithCompletion({
      obligationId: activeObligation.id,
      completionId: completion.id,
      tx,
    });
    return { completionId: completion.id, satisfiedObligationId: activeObligation.id };
  }
  return { completionId: completion.id, satisfiedObligationId: null };
});
```

If any step throws, the whole tx rolls back — no orphaned completion.

A duplicate submission of the same attempt returns the existing completion unchanged (per the `attemptId @unique` guard). The obligation only transitions OUTSTANDING → SATISFIED exactly once (per the `TrainingObligation.satisfiedByCompletionId @unique` guard).

## 5. Deterministic FIFO when `issuedAt` ties

Directive §9 — "Ensure deterministic ordering when issuance timestamps are identical, using a stable secondary key." Implementation:

```ts
orderBy: [{ issuedAt: "asc" }, { id: "asc" }]
```

`id` is a cuid — monotonic time-sorted but deterministic. Two obligations issued in the same millisecond resolve stably across requests.

## 6. Multiple OUTSTANDING (Keep Both)

Directive §9 — a Keep Both pair produces two OUTSTANDING rows. The player session resolves the oldest. On successful completion:
- Transaction creates completion + satisfies oldest obligation.
- Second obligation remains OUTSTANDING.
- Employee refreshes → new call to `resolveActiveObligationForSession` picks the second.
- A fresh progress row for that second obligation starts at 0 (new `(employeeId, courseVersionId, obligationId=second)` upsert).

The second completion must be a NEW `TrainingAttempt` (new `attemptNumber`), because the first attempt's `attemptId` is already consumed by the first completion.

## 7. Cross-tenant + authorization (directive §9 security)

- `resolveActiveObligationForSession` scopes every query by `clubId` from the employee record.
- `upsertObligationScopedProgress` asserts the obligation's `clubId + employeeId + courseVersionId` match the caller's args before writing.
- `completeAndSatisfyAtomic` runs under `prisma.$transaction` with the attempt's authenticated principal — a browser cannot smuggle an arbitrary `obligationId`; the server resolves the active one from the authenticated session.

## 8. Historical preservation (directive §4 + §11.J)

- **Zero existing data mutated** by the migration (new column is nullable; defaults to NULL).
- **Zero completion / attempt / progress row deleted or modified.**
- Chris Turcato's `9 TrainingCompletion + 30 TrainingAttempt + 9 TrainingProgress` rows remain byte-for-byte identical.
- The partial UNIQUE on `WHERE obligationId IS NULL` is trivially satisfied by every existing row.

## 9. Scope protection (directive §12)

Not touched by this slice:
- Employee dashboard layout.
- Employee training history UI.
- Required Training rail design.
- Video-player visual styling.
- Employee Portal chrome or branding.
- Administrative revision and reinstatement workflows.
- Other Spectre modules.

The new engine lives entirely in the service + API layer. Pre-5C-3 the UI never surfaces the obligation state to the employee.

## 10. STOP boundary

Per directive §13: *"STOP after EP-TRAIN-5C-2. Do not proceed to employee UX activation or live backfill without founder approval."*

5C-3 wires the dashboard + course page + player UI to consult the obligation-aware resolver.
5C-4 runs the live backfill + flips the active resolver on.
