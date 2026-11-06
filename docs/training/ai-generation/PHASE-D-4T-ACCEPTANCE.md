# EP-TRAIN-6D-4T — Approved AI Question → Course-Authoring Bridge — Acceptance

Status: **OFFLINE IMPLEMENTATION COMPLETE.** All eight founder-
authorized conditions honoured. Awaiting founder review before
pushing 4T or proceeding to the next slice.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4t/promotion-bridge` (not pushed).

## 1. One-page summary

The founder authorized Option B (dedicated sidecar table) on
2026-11-06 with eight explicit conditions. 4T implements the full
contract offline:

- New sidecar `TrainingQuestionAiDraftPromotion` (SQLite + PG
  mirror). Zero changes to existing production columns outside three
  additive back-relations.
- `src/lib/hr/training/ai-review/promotion-service.ts` with 14-code
  rejection matrix + atomic $transaction + P2002-driven idempotent
  replay + two-sided defence-in-depth via re-run of the 4M evidence
  reader + 4N verified-answer reader.
- Extended `checkPublishReadiness` with condition-5 divergence
  detection (three reason codes).
- 18 vitest contract tests + 6 vitest publish-divergence tests + 6
  PG16 integration scenarios. All green.

**No staging deployment. No shared-database migration. No new role
grant. No historical candidate touched. No publication. No employee
assignments. 126 unrelated WIP files preserved.**

## 2. Founder condition compliance

| # | Condition                                                                 | How it is honoured                                                                                   | Status |
| - | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | :----: |
| 1 | Uniqueness of originating AI draft AND resulting TrainingQuestion         | `@unique([draftId])` + `@unique([questionId])` on sidecar; `@@index([clubId, draftId])` + `@@index([clubId, questionId])` | ✅ |
| 2 | Immutable approval provenance (draft hash + validation + verified-answer + reviewer + destination) | `approvedDraftContentHash` + `approvedValidationId` + `verifiedAnswerOptionIndex` + `verifiedAnswerSnapshotHash` + `approvedReviewId` + `approvedByUserId` + `destination` + `checkpointId` columns | ✅ |
| 3 | Transactional, audit-attached, idempotent retries                          | Single `$transaction` writes Question + Options + sidecar; P2002 → replay (same destination) or `ALREADY_PROMOTED_DIFFERENT_DESTINATION`; `audit()` post-commit; T13 + T14 contract + PG16 T2 prove it | ✅ |
| 4 | Tenant, course-version, checkpoint ownership verified server-side         | `draft.clubId === clubId` + `course.clubId === clubId` + `checkpoint.courseVersionId === draft.courseVersionId`; T4 + T5 + T11 contract + PG16 T3 prove it | ✅ |
| 5 | Edits or deletion of promoted question must not silently invalidate approval provenance — detect divergence + require reapproval before publication | `promotedQuestionContentHash` captured at promotion; `checkPublishReadiness` recomputes + refuses on divergence; also refuses if draft state moves out of APPROVED_DRAFT or draft contentHash changes; `tests/ep-train-6d4t-publish-divergence.test.ts` 6/6 proves it | ✅ |
| 6 | Support both checkpoint and final-assessment questions                     | `PromotionDestination = { CHECKPOINT; checkpointId } | FINAL_ASSESSMENT`; T1 + T2 contract + PG16 T1 prove it | ✅ |
| 7 | Do not promote the eight historical candidates or modify existing employee training records | Historical drafts have `groundingProjectionId = NULL` → 4M evidence reader returns `historical-unavailable` → promotion refuses with `EVIDENCE_HISTORICAL_UNAVAILABLE`; T6 contract proves it | ✅ |
| 8 | Offline implementation + PostgreSQL testing only; no staging migration, deployment, publication | Disposable PG16 on localhost:15437 (torn down); no `flyctl deploy`; no `prisma migrate deploy` to shared staging | ✅ |

## 3. Files added

| File                                                                                                            | Purpose                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `prisma/migrations/20261106_ep_train_6d_4t_ai_draft_promotion/migration.sql`                                    | SQLite migration: one new table + 4 indexes, additive only.        |
| `prisma-postgres/migrations/20261106_ep_train_6d_4t_ai_draft_promotion/migration.sql`                           | Postgres mirror: identical shape with PG-dialect FK + `IF NOT EXISTS` guards. |
| `src/lib/hr/training/ai-review/promotion-service.ts`                                                            | Full promotion service (14 rejection codes + hash helper).         |
| `tests/ep-train-6d4t-promotion-contract.test.ts`                                                                | 18 contract scenarios (SQLite).                                    |
| `tests/ep-train-6d4t-publish-divergence.test.ts`                                                                | 6 publish-gate divergence scenarios (SQLite).                      |
| `scratchpad/ep-train-6d4t/integration-test.ts`                                                                  | 6 PG16 integration scenarios (disposable).                         |
| `docs/training/ai-generation/PHASE-D-4T-PROMOTION-DESIGN.md`                                                    | Design doc (updated from preflight to implementation-complete).    |
| `docs/training/ai-generation/PHASE-D-4T-ACCEPTANCE.md`                                                          | This document.                                                     |

## 4. Files modified

| File                                                                | Change                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                              | Added `TrainingQuestionAiDraftPromotion` model + three Prisma-side back-relations (Club, TrainingQuestion, TrainingQuestionAiDraft). Zero column changes to existing entities. |
| `prisma-postgres/schema.prisma`                                     | Same mirror.                                                                                         |
| `src/lib/hr/training/courses.ts`                                    | Extended `checkPublishReadiness` to run condition-5 divergence detection on every `aiPromotion`-bearing question.                                    |
| `src/lib/hr/training/ai-review/evidence-reader.ts`                  | Accepts optional `opts.prisma` (defaults to the global import). Enables PG16 harness. Public contract unchanged for existing callers.                 |
| `src/lib/hr/training/ai-review/verified-answer-reader.ts`           | Same opts-prisma addition.                                                                           |
| `tests/util/db.ts`                                                  | `resetDb` clears `trainingQuestionAiDraftPromotion` BEFORE `TrainingQuestion` + `TrainingQuestionAiDraft` to honour the ON DELETE RESTRICT FKs. |

## 5. Rejection-code matrix (directive §5)

| Code                                        | HTTP | When fired                                                        |
| ------------------------------------------- | :--: | ----------------------------------------------------------------- |
| `DRAFT_NOT_FOUND`                           | 404  | Draft missing OR cross-tenant OR course-version mismatch         |
| `DRAFT_NOT_APPROVED`                        | 409  | Draft state ≠ APPROVED_DRAFT                                      |
| `CONTENT_HASH_MISMATCH`                     | 409  | Client's expectedDraftContentHash stale                           |
| `VALIDATION_MISMATCH`                       | 409  | Client's expectedValidationId stale                               |
| `VERIFIED_ANSWER_MISSING`                   | 409  | 4N reader returned `unverified`                                   |
| `VERIFIED_ANSWER_INTEGRITY_FAIL`            | 409  | 4N reader returned `integrity-warning` OR draft body malformed    |
| `EVIDENCE_HISTORICAL_UNAVAILABLE`           | 409  | 4M reader returned `historical-unavailable` (6D-4H candidates)    |
| `EVIDENCE_INTEGRITY_FAILURE`                | 409  | 4M reader returned `evidence-integrity-failure`                   |
| `QUESTION_TYPE_UNSUPPORTED`                 | 409  | MULTI_ANSWER (refused per 4N precedent)                           |
| `CHECKPOINT_NOT_FOUND`                      | 404  | Destination checkpoint id does not exist                           |
| `CHECKPOINT_CROSS_COURSE`                   | 409  | Destination checkpoint belongs to a different course version      |
| `COURSE_VERSION_NOT_DRAFT`                  | 409  | Target course version is PUBLISHED or RETIRED                      |
| `ALREADY_PROMOTED_SAME_DESTINATION`         | 200  | Sentinel (replay) — the service returns `replay: true`             |
| `ALREADY_PROMOTED_DIFFERENT_DESTINATION`    | 409  | Second promote attempt against the same draft with a different destination |

## 6. Test evidence

### 6.1 Offline vitest — SQLite

```
$ npx vitest run tests/ep-train-6d4t-promotion-contract.test.ts
Test Files  1 passed (1)
Tests  18 passed (18)   ← directive §10's 18 scenarios

$ npx vitest run tests/ep-train-6d4t-publish-divergence.test.ts
Test Files  1 passed (1)
Tests  6 passed (6)     ← founder condition #5 verification
```

Contract coverage mapping (directive §10):

- Valid checkpoint promotion — T1 ✅
- Valid final-assessment promotion — T2 ✅
- Human-verified answer differs from model prediction — T3 ✅
- Cross-tenant refusal — T4 ✅
- Cross-course refusal — T5 ✅
- Historical candidate refusal — T6 ✅
- Rejected candidate refusal — T7 ✅
- Missing verified answer — T8 ✅
- Stale approval / hash — T9 + T10 ✅
- Invalid checkpoint — T11 ✅
- Published course-version refusal — T12 ✅
- Duplicate promotion replay — T13 ✅
- Conflicting destination replay — T14 ✅
- MULTI_ANSWER refusal — T15 ✅
- Unauthenticated / STAFF refusal — T16 + T17 ✅
- Divergence hash helper purity — T18 ✅

Publish-gate divergence (new 6-test file):

- Pristine promoted question: publish gate reports no divergence ✅
- Edited prompt: publish refuses ✅
- Edited option: publish refuses ✅
- Draft state ≠ APPROVED_DRAFT: publish refuses ✅
- Draft contentHash changed: publish refuses ✅
- Manually-authored questions: divergence check does NOT fire (regression safety) ✅

### 6.2 Disposable PostgreSQL 16

Container: `postgres:16-alpine` on `localhost:15437`, torn down with
`docker stop` + `--rm` after the harness exited.

```
EP-TRAIN-6D-4T — PG16 integration harness
  PASS  T1 happy-path FINAL_ASSESSMENT promotion writes question + options + sidecar
  PASS  T2 concurrent identical promotions — exactly one creator, duplicates become replay
  PASS  T3 cross-tenant refusal → 404
  PASS  T4 published course-version refusal → COURSE_VERSION_NOT_DRAFT
  PASS  T5 conflicting destination refusal
  PASS  T6 publish-gate divergence detection: edited prompt refuses publish
SUMMARY  pass=6 fail=0 total=6
```

### 6.3 Full 4-series regression

```
$ npx vitest run tests/ep-train-6d4b-*.test.* tests/ep-train-6d4d-*.test.* tests/ep-train-6d4l-*.test.* tests/ep-train-6d4m-*.test.* tests/ep-train-6d4n-*.test.* tests/ep-train-6d4p-*.test.* tests/ep-train-6d4t-*.test.*
Test Files  14 passed (14)
Tests  203 passed (203)
```

Zero regression in the accepted 4B / 4D / 4L / 4M / 4N / 4P suites.

### 6.4 Schema validation + migration safety

```
$ npx prisma validate --schema prisma/schema.prisma
The schema at prisma\schema.prisma is valid 🚀

$ npx prisma validate --schema prisma-postgres/schema.prisma
The schema at prisma-postgres\schema.prisma is valid 🚀
```

Migration SQL scanned: zero `DROP` / `TRUNCATE` / `ALTER…DROP` in
either dialect. Fully additive. Rollback = `DROP TABLE
TrainingQuestionAiDraftPromotion` (plus removing the three Prisma
back-relations) — no existing data touched.

### 6.5 Nav audit + placeholder scan

```
$ npm run nav:audit
URL-only (orphans):   0

$ npm run scan:placeholders
(no 4T-authored placeholders)
```

## 7. STOP compliance (directive §12)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No staging or production deployment      | HONOURED |
| No shared database migration             | HONOURED — disposable PG16 only; container torn down |
| No Modal/Qwen inference                  | HONOURED |
| No transcription worker activation       | HONOURED |
| No historical candidate modification     | HONOURED |
| No course publication                    | HONOURED |
| No employee assignments                  | HONOURED |
| No unrelated UI changes                  | HONOURED — no admin UI button added in this slice |
| No permanent role grants                 | HONOURED — uses existing `hr:training:write` |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry                |

## 8. Residual notes + explicit follow-ons (directive §11)

### 8.1 Admin UI promotion action — INTENTIONALLY NOT IN 4T

The promotion service is implemented + tested; no admin UI button
was added to the persisted review workspace in this slice. The
founder's 8 conditions did not require a UI surface, and the
directive §12 says "No unrelated UI changes." A follow-on slice
(4T-UI) can add a destination-picker modal that calls the service
once the service is accepted.

### 8.2 Loss of explanation text

The AI draft carries an `explanation` field; `TrainingQuestion` has
no column for it. The service drops it on promotion. Explanation
remains on the `TrainingQuestionAiDraft` row for audit. A separate
slice can add `TrainingQuestion.explanation: String?` if the founder
wants employee-facing rationales.

### 8.3 MULTI_ANSWER refused

Per 4N precedent, MULTI_ANSWER remains refused at promotion time
(code `QUESTION_TYPE_UNSUPPORTED`). Extending the contract requires
a separate slice that lifts the restriction at both 4N approval AND
4T promotion layers simultaneously.

### 8.4 Transcription + automatic placement + semantic dedup

Per the 4S audit, this slice (4T) closes the "parallel universes"
gap. It does NOT:

- Add automatic checkpoint placement (gap G2.1 — recommended slice 4X).
- Add semantic deduplication (gap G2.3 — recommended slice 4X).
- Wire transcription (gap G1.1-G1.3 — recommended slice 4V).
- Wire AI generation (gap G1.4 — recommended slice 4W).

The 4T service's `promotedQuestionContentHash` + the sidecar schema
leave room for the 4X dedup registry to be added later without
re-writing the promotion contract.

### 8.5 Rollback mechanism for a promoted question

If an admin needs to "un-promote" a question (e.g. the authoring
view edited it heavily and they want to restart from the AI draft),
today's options are:

- `prisma.trainingQuestion.delete` — refused by FK (ON DELETE
  RESTRICT on the sidecar).
- Manually: delete sidecar first, then the question. No service
  method exists.

A `revertPromotion(principal, questionId)` follow-on would clean up
both rows + audit the reversion. Out of scope for 4T.

### 8.6 Known harness artifact: audit() SQLite error in PG16 harness

The PG16 harness logs an `audit()` error at end-of-transaction
because the default `audit()` call uses the SQLite-bound
`@prisma/client` import. The error is swallowed by `audit()`'s
try/catch per the CLAUDE.md non-blocking-audit pattern — the
promotion transaction itself commits cleanly. In production, both
the service's prisma AND `audit()`'s prisma resolve to the same
in-process client, so no error occurs.

## 9. Awaiting founder review

Next steps require explicit founder authorization:

- **(A)** Approve 4T + authorise pushing to origin.
- **(B)** Approve 4T + authorise the next slice (4T-UI admin button,
  OR 4V transcription, OR 4W AI generator, OR 4X automatic
  placement + dedup).
- **(C)** Request changes to the 4T implementation before pushing.

Until the founder picks A, B, or C, 4T remains committed on branch
`ep-train-6d-4t/promotion-bridge` with no push.
