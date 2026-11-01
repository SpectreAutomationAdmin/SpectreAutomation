# Training-video `videoStorageKey` writer audit (EP-TRAIN-4E-2A, 2026-11-01)

Every code path capable of CREATING or REPLACING a
`TrainingCourseVersion.videoStorageKey` reference, with its
classification under the shared-key lifecycle invariant.

## Invariant

> No video object may be physically deleted while any committed
> course version references it, including references created
> concurrently with cleanup.

Enforced by a Postgres transaction-scoped advisory lock keyed on
`hashtextextended(storageKey, 0)` plus a HEAD-check of the R2
object inside the locked region on every reference-establishment
path.

## Writers

### 1. `uploadTrainingVideo` ([src/lib/hr/training/video.ts](../src/lib/hr/training/video.ts))

- **Classification**: **Protected (safe)**.
- **How it writes**: `storage.put` the new bytes under a fresh
  `clubs/{clubId}/training/{courseId}/{version}/{sha256}` key, then
  inside `withPostingGuard`'s transaction:
  1. `acquireStorageKeyLock(tx, storageKey)` — serializes against
     cleanup for this exact key.
  2. `storage.head({ storageKey })` — verifies the object is still
     physically present after the lock blocks any concurrent cleanup.
  3. `tx.trainingCourseVersion.update(...)` — commits the reference.
- **Independent-ownership guarantee**: each upload generates a
  unique sha256 of the stored bytes, so the resulting storageKey
  cannot collide with any other course's. Even if it coincidentally
  did, the lock + HEAD close the race.

### 2. `remediateVideoFastStart` ([src/lib/hr/training/video.ts](../src/lib/hr/training/video.ts))

- **Classification**: **Protected (safe)**.
- **How it writes**: `storage.put` the fast-start-remuxed bytes
  under a new `clubs/{clubId}/training/{courseId}/{version}/{newSha256}`
  key, then inside `withPostingGuard`'s transaction:
  1. Acquire the advisory lock on BOTH the old key and the new key,
     in lexicographic order (deadlock-safe).
  2. `storage.head({ storageKey: newStorageKey })` — verify the new
     object exists.
  3. `tx.trainingCourseVersion.update(...)` — swap the reference
     from old → new.
- **Note**: the OLD key becomes unreferenced after this write and
  is eligible for cleanup by any subsequent course delete.

### 3. `startNewDraft` ([src/lib/hr/training/courses.ts](../src/lib/hr/training/courses.ts))

- **Classification**: **Protected (safe) — EP-TRAIN-4E-2A patched**.
- **How it writes**: Clones the source published version's
  `videoStorageKey` into a brand-new DRAFT `TrainingCourseVersion`
  row (a NEW reference to an EXISTING R2 object).  Inside the
  `prisma.$transaction`:
  1. If `source.videoStorageKey` is non-null, `acquireStorageKeyLock(tx, source.videoStorageKey)`.
  2. `storage.head({ storageKey: source.videoStorageKey })` — verify
     the R2 object still exists before cloning the reference.
     Throws `ConflictError` if gone (fail-closed; admin must
     re-upload on the new draft).
  3. `tx.trainingCourseVersion.create(...)` — commits the new
     reference.
- **Why this matters**: without the lock+head, a cleanup running
  against the source course could delete the R2 object between
  `startNewDraft`'s read of `source.videoStorageKey` and the
  INSERT of the new draft row, leaving the draft referencing a
  missing object.

### 4. `provisionIsolatedFixture` ([tests/e2e/_lib/ep-train-3-fixture.ts](../tests/e2e/_lib/ep-train-3-fixture.ts))

- **Classification**: **Legacy / test-only — documented restriction**.
- **How it writes**: Direct Prisma writes against a hard-coded
  reusable key (`REUSED_VIDEO_KEY`) that points at the shared B31
  R2 object.  Bypasses `uploadTrainingVideo` and does NOT acquire
  the advisory lock.
- **Restriction**: this harness is used only by the staging E2E
  test suite.  The B31 R2 object is permanently protected by
  B31_STAGING_ACCEPTANCE's own `videoStorageKey` reference, so even
  a concurrent cleanup from a fixture delete observes B31's
  reference and skips the R2 delete.  The one scenario the harness
  cannot defend against — a direct admin DELETE of B31's R2 object
  from outside Spectre — is out of scope for Spectre's lifecycle
  guarantees.

### 5. One-shot scripts (`scripts/ep-train-3-slice3-provision.mjs`, `scripts/ep-train-3-slice3b-remediate-wso.mjs`, `scripts/hr-2c-b31-staging-fixture.mjs`, `scripts/ep-train-3-review-fixture.mjs`)

- **Classification**: **Legacy / offline-only — documented restriction**.
- **How they wrote**: One-time pre-production seed scripts, applied
  manually by an operator through `flyctl ssh`.  Not called by
  running services.  Each write established a reference, but no
  concurrent cleanup existed at the time of application.
- **Restriction**: must not be re-run on a live production tenant.

### 6. Repair / inventory scripts (`scripts/ep-train-4e-null-duration-inventory.mjs`, `scripts/ep-train-4e-repair-null-duration.mjs`)

- **Classification**: **Not a `videoStorageKey` writer**.
- **What they do**: inventory is read-only; the repair writes ONLY
  `videoDurationSec` (never `videoStorageKey`, `videoSha256`, or
  `videoSizeBytes`).  Does not establish a new reference.

## Reads (not writers)

For completeness, the following read `videoStorageKey` but do not
write it:

- `src/lib/hr/training/attempts.ts` — reads for the player state.
- `src/lib/hr/training/employee-read.ts` — reads for the employee
  course view.
- `src/lib/hr/training/video-stream.ts` — reads to stream bytes.
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx` — reads for the admin editor.
- `src/lib/hr/training/applicability.ts` — reads for applicability
  resolution.

None of these mutate the field.

## Operator reconciliation

An operator can list orphaned R2 cleanup failures and preserved-shared-reference events via `AuditLog`:

```
SELECT * FROM "AuditLog"
WHERE "action" IN (
  'hr.training.video.r2-deleted',
  'hr.training.video.r2-delete-failed',
  'hr.training.video.cleanup-skipped',
  'hr.training.video.cleanup-tx-failed'
)
ORDER BY "createdAt" DESC;
```

These rows are the source of truth for identifying orphaned R2
bytes (keys with `r2-delete-failed` audits and no later
`r2-deleted`) that an operator can reconcile manually with
confidence.
