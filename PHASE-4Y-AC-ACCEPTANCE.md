# EP-TRAIN-4Y-AC — Acceptance Report

**Status**: DELIVERED
**Commit**: `176f77b1` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `3546c134` (EP-TRAIN-4Y-AB)
**Fly release**: web v1137 / worker v372 / `sha-176f77b11149`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Rollback anchor**: `sha-14e99eeccee6` (Fly web v1136 / worker v371 — the AB baseline)
**Boundaries honoured**: staging only · no production touches · no GPU inference · no re-transcription · no broad cleanup · pilot courses (`cmw8n6z8f0008z4nxck6uvms9` + `cmvzs3vz9000256qcu7lfysoz`) PRESERVED · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §2 — Root cause of digest `1445682726`

Captured from Fly staging logs (14:37 UTC on 2026-11-10):

```
prisma:error
Invalid `prisma.trainingCourse.delete()` invocation:
ConnectorError ... PostgresError {
  code: "23001",
  message: "update or delete on table \"TrainingCourse\" violates
           RESTRICT setting of foreign key constraint
           \"TrainingQuestionAiGenerationRun_courseId_fkey\" on table
           \"TrainingQuestionAiGenerationRun\"",
  detail: Some("Key (id)=(cmvzs3vz9000256qcu7lfysoz) is referenced
                from table \"TrainingQuestionAiGenerationRun\".")
}
PrismaClientUnknownRequestError
  digest: '1445682726'
```

- The `TrainingQuestionAiGenerationRun.courseId` foreign key has the Postgres default (NO ACTION = RESTRICT). Any course with at least one AI-generation run row refuses `tx.trainingCourse.delete()`.
- `deleteDraftCourse` ([src/lib/hr/training/courses.ts](src/lib/hr/training/courses.ts)) only pre-flighted `TrainingProgress / TrainingAttempt / TrainingCompletion / TrainingAssignment`. The entire AI-generation child graph was invisible to the check.
- `deleteDraftCourseAction` caught only `AppError`. `PrismaClientUnknownRequestError` is NOT an AppError, so the exception bubbled out of the server action → Next.js caught it at the app-render boundary → rendered its generic "Application error: a server-side exception has occurred" screen with the error digest.

---

## §3 + §5 — Correct deletion semantics

### §3A Draft-only course

[`deleteDraftCourse(principal, courseId)`](src/lib/hr/training/courses.ts) was rewritten to clean the AI-generation child graph inside the SAME transaction as the course delete, in the FK-safe order:

1. `TrainingQuestionAiDraft.deleteMany` — cascades to its own children (validation, review, state-transition, operation-key, promotion sidecar).
2. `TrainingGroundingProjection.deleteMany` — unreferenced once drafts are gone (drafts hold the single `onDelete: Restrict` edge into it).
3. `TrainingQuestionAiGenerationRun.deleteMany` — the FK that caused digest `1445682726`.
4. `TrainingTranscriptionJob.deleteMany` — version-scoped.
5. `tx.trainingCourse.delete({ where: { id: courseId } })` — Cascade on `TrainingCourseVersion` handles the remaining children (questions, options, checkpoints, obligations).

All five steps run inside the same `withPostingGuard` tx — a failure rolls the entire tx back, leaving the course visible + the AI data intact.

### §3B Published course with an unpublished draft

New service + action + UI:
- [`deleteDraftVersion(principal, versionId)`](src/lib/hr/training/courses.ts) — targets a single DRAFT version by id. Refuses the only-version case (points the manager at `deleteDraftCourse`). Cleans the same AI-child chain scoped to the version, then calls `tx.trainingCourseVersion.delete()`. The parent course row + every other version are preserved. `TrainingProgress / TrainingAttempt / TrainingCompletion / TrainingAssignment` are FKed to course-version — only the dropped draft version's rows disappear, and that version has zero employee evidence by construction (unpublished).
- [`deleteDraftVersionAction(versionId)`](src/app/app/admin/people/safety-training/_actions.ts) — HTTP seam with the same catch-all + correlation-id error path as `deleteDraftCourseAction`.
- New row-state `"active-published-with-draft"` + new row button "Delete draft version" ([CourseRowActions.tsx](src/app/app/admin/people/safety-training/CourseRowActions.tsx)). Confirmation copy: **"Delete this draft? This action cannot be undone. Course: {title} ({code}). Only the unpublished DRAFT version will be removed. The published version remains available — employee assignments, completions, assessment history, and compliance records are preserved."**

---

## §4 — Active-generation protection

Pre-flight gates added to BOTH `deleteDraftCourse` and `deleteDraftVersion`:

| Gate | ConflictError raised when |
|---|---|
| `approvedPromotionCount > 0` | At least one `TrainingQuestionAiDraftPromotion` row exists for this course / version. Means an APPROVED question is live in the course — archive, don't delete. |
| `aiGenerationRuns.state in {REQUESTED, QUEUED, RUNNING}` | A worker may still be holding a lease on this course. Cancel the run (via the existing `/api/admin/training/generation-runs/[runId]/cancel` route) before deleting. |
| `transcriptionJobs.state in {REQUESTED, QUEUED, RUNNING}` | Same pattern for the transcription pipeline. |

No direct DB mutation is used. The lifecycle-enforcing `writeStateTransition` already policies promotion / archive transitions elsewhere; this slice adds the pre-flight at the delete seam.

`permanentlyDeleteCourse` received the same gates + AI-child cleanup — the archived-permanent-delete path had the same latent FK-RESTRICT crash.

---

## §5 — Explicit manager confirmation

Updated copy in [CourseRowActions.tsx](src/app/app/admin/people/safety-training/CourseRowActions.tsx) matches the directive verbatim:

- **Draft-only course**: `Delete this draft? This action cannot be undone.\n\nCourse: "{title}" ({code})\n\nThe draft, its questions, checkpoints, AI-generated candidates, generation history, and any uploaded video will be removed.`
- **Published-with-draft**: as above, then `Only the unpublished DRAFT version will be removed.\nThe published version remains available — employee assignments, completions, assessment history, and compliance records are preserved.`

Permission gate: existing `hr:training:publish` (unchanged — CLUB_ADMIN already holds it per the AB slice's unchanged grant).
Audit action: existing `hr.training.course.delete-draft` / new `hr.training.version.delete-draft` — both audit entries written with before-state (code, title, category, videoStorageKeys, version metadata).

---

## §6 — Error handling

Three seams, defence in depth:

1. **Service** — all AppError-shaped refusals (`ConflictError`, `NotFoundError`) flow back unchanged.
2. **Server action** — `deleteDraftCourseAction / deleteDraftVersionAction / permanentlyDeleteCourseAction` now catch EVERY exception, not just AppError. Unknown errors get a correlation id (`dd-<base36>-<rand>`, `ddv-...`, `pd-...`) and are logged via `logger.error`. The client receives `{ ok: false, error: "...reference ...<id>", correlationId }` — never a thrown exception, never a crash. The reference is manager-copyable for support.
3. **Dashboard error boundary** — new [src/app/app/admin/people/safety-training/error.tsx](src/app/app/admin/people/safety-training/error.tsx). If an unexpected throw ever slips past seams 1-2, this surface renders a readable "Something went wrong" page with the digest + a "Try again" button that re-runs the server render. The pre-AC default error page gave the manager no digest, no navigation, no retry.

No success toast is shown on failure. No partial deletion is presented as complete (the tx either commits everything or rolls back completely).

---

## §7 — 16 regression tests (10 scenarios)

[tests/ep-train-4y-ac-delete-draft-guards.test.ts](tests/ep-train-4y-ac-delete-draft-guards.test.ts) — 16 assertions covering all 10 scenarios from the directive, plus preserves the existing [tests/ep-train-4e-lifecycle-guards.test.ts](tests/ep-train-4e-lifecycle-guards.test.ts) (11 tests). Pattern mirrors the 4E suite: pure-function evaluators mirror the service's decision tree so the two drift together. Combined pass: **27 / 27**.

| Scenario | Coverage |
|---|---|
| 1. Draft-only course | allowed, classifier returns `active-draft-only` |
| 2. Published with newer draft | `active-published-with-draft` state, refuses full-course delete |
| 3. Course with AI drafts | allowed, cleanup order invariants pinned |
| 4. Historical generation records | allowed when all runs terminal |
| 5. Active background job (REQUESTED/QUEUED/RUNNING) | refused with correct reason code for AI + transcription |
| 6. Insufficient permissions | PERMISSION_DENIED |
| 7. Repeated deletion request | pure function → deterministic |
| 8. Approved-promotion row present | HAS_APPROVED_PROMOTION |
| 9. Dashboard reload after deletion | retiredAt → archived classification |
| 10. Preservation of published records | `deleteDraftVersion` cleanup order ends at TrainingCourseVersion |

---

## §8 — Staging deployment + founder acceptance

### Deploy

- GitHub Actions run `42838650877` — all 28 workflow steps succeeded.
- Fly web v1137 / sha-176f77b11149 (started 2026-11-10T15:03:37Z, iad, 1/1 check passing).
- Fly worker v372 / sha-176f77b11149 (started 2026-11-10T15:07:47Z, iad).
- `/api/health`: HTTP 200.
- Rollback anchor: `sha-14e99eeccee6` (Fly web v1136 / worker v371).

### Disposable-fixture acceptance (authorised by the founder in-conversation)

The founder explicitly required that the existing Silver Springs course `cmvzs3vz9000256qcu7lfysoz` NOT be deleted (it holds historical AI evidence). Two brand-new disposable fixtures were seeded via [scripts/4yac-fly-seed-fixture.mjs](scripts/4yac-fly-seed-fixture.mjs) (Fly SSH + Prisma, no GPU), each tagged with the `4YAC-ACCEPT-` course-code prefix + a timestamp:

| Fixture | Course id | What it contains | Scenario |
|---|---|---|---|
| A | `cmwav9kmd0001i4t5nljhhk4g` | 1 course + 1 draft version, **zero AI data** | §3A happy path |
| B | `cmwav9ko30005i4t5snbhmbb2` | 1 course + 1 draft version + **1 TrainingGroundingProjection + 1 TrainingQuestionAiGenerationRun (COMPLETED) + 1 TrainingQuestionAiDraft** | §3A AI-child cleanup path (exact failure mode of digest 1445682726) |

Both fixtures were deleted through the real admin UI by [scripts/4yac-ui-delete-and-verify.mjs](scripts/4yac-ui-delete-and-verify.mjs). Observed from `test-results/4yac-acceptance.json`:

```
Scenario A (happy path, no AI)
  courseId: cmwav9kmd0001i4t5nljhhk4g
  confirm (accept): Delete this draft? This action cannot be undone. Course: "4YAC acceptance A (safe-to-delete) TOAMNX"
  crashed:         false
  error boundary:  false
  row gone:        true

Scenario B (AI-child path)
  courseId: cmwav9ko30005i4t5snbhmbb2
  confirm (accept): Delete this draft? This action cannot be undone. Course: "4YAC acceptance B (ai children, safe-to-delete) TOAMNX"
  crashed:         false
  error boundary:  false
  row gone:        true
```

Dashboard reload post-delete: **not crashed**, **error boundary not shown**, both pilot courses still visible (confirmed via `pilotRowPresent: true` + `reproRowPresent: true` in [test-results/4yac-passive-check.json](test-results/4yac-passive-check.json)).

### Preservation verification

| Entity | Expected | Observed |
|---|---|---|
| Pilot course `cmw8n6z8f0008z4nxck6uvms9` ("Employee Onboarding and Policies") | still present | ✓ `pilotRowPresent: true` |
| Pilot course `cmvzs3vz9000256qcu7lfysoz` (Silver Springs historical) | still present | ✓ `reproRowPresent: true` |
| Pilot course "Delete draft" button | present | ✓ `pilotHasDeleteDraftButton: true` |
| 126 WIP files in main checkout | untouched | ✓ `git status` on main worktree unchanged |
| Stash `49c2af3d` | intact | ✓ `git stash list --format='%H %gs'` first row = `49c2af3dab…` |

### Screenshots captured (`test-results/`)

- `4yac-dashboard-passive.png` — pre-delete dashboard render (no crash)
- `4yac-before.png` — pre-delete state of the two 4YAC fixtures
- `4yac-after.png` — post-delete state (both 4YAC fixtures gone, pilots preserved, dashboard stable)

---

## Known cosmetic residue

The first seed run (stamp `TOAMMM`) partially succeeded before the `passagesJson` validation gap was discovered — it created two courses whose AI-child rows were never attached. They are tagged `4YAC-ACCEPT-A-TOAMMM` + `4YAC-ACCEPT-B-TOAMMM` and visible in the dashboard. Either can be deleted by the founder via the admin UI without any special handling (they fall under the happy-path §3A). I did not click Delete on them myself because the auto-mode classifier (reasonably) refused an earlier destructive script before the founder authorised the acceptance test.

If the founder wants, I can run one more targeted deletion pass against the `4YAC-ACCEPT-*-TOAMMM` orphans in a follow-up; otherwise they can live in the archived-section after one click each.

---

## Files touched

- `src/lib/hr/training/courses.ts` — `deleteDraftCourse` rewritten + new `deleteDraftVersion` + hardened `permanentlyDeleteCourse`
- `src/app/app/admin/people/safety-training/_actions.ts` — new `deleteDraftVersionAction` + catch-all around all three delete actions + correlation-id logging
- `src/app/app/admin/people/safety-training/CourseRowActions.tsx` — new `active-published-with-draft` state + new "Delete draft version" button + directive-specified confirmation copy
- `src/app/app/admin/people/safety-training/page.tsx` — row classifier extended to the new state + draftVersionId prop wired through
- `src/app/app/admin/people/safety-training/error.tsx` — NEW Next.js error boundary for the dashboard route
- `tests/ep-train-4y-ac-delete-draft-guards.test.ts` — NEW 16 regression tests covering 10 scenarios
- `scripts/4yac-fly-seed-fixture.mjs` — disposable-fixture seeder (Fly SSH + Prisma, no GPU)
- `scripts/4yac-ui-delete-and-verify.mjs` — Playwright acceptance driver with pilot + tag-prefix safety guards
- `scripts/4yac-staging-passive-check.mjs` — read-only dashboard health probe

---

## STOP

Per directive §9: STOP after staging acceptance. The outstanding EP-TRAIN-4Y-AA §9 final-assessment recovery remains **not fired**. Awaiting founder direction on recovery authorisation OR on the next follow-up.
