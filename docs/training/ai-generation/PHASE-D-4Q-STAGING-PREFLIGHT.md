# EP-TRAIN-6D-4Q — Staging Integration Preflight

Status: READ-ONLY preflight. No deployment executed. No migration
applied to shared staging. No role grant issued. No test identity
created.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4q/staging-preflight` (documentation only, not pushed).

## 1. Source inventory

### 1.1 Accepted branches on origin

| Slice | Branch                                               | Commit     | State on origin |
| ----- | ---------------------------------------------------- | ---------- | --------------- |
| 4B    | (merged / included in ancestry)                      | —          | applied to staging |
| 4K    | `ep-train-6d-4k/...` ancestry                        | `cd743a7c` | not applied to staging |
| 4L    | `ep-train-6d-4l/...` ancestry                        | `3d497097` | offline-only    |
| 4M    | `ep-train-6d-4m/evidence-reader`                     | `875b68fe` | offline-only    |
| 4N    | `ep-train-6d-4n/human-verification-approval`         | `dcc26122` | pushed, offline-only |
| 4P    | `ep-train-6d-4p/interactive-reviewer-ux`             | `b2180d53` | pushed, offline-only |

4Q is this preflight's documentation branch; it changes no code.

### 1.2 Current staging anchor (rollback target)

| Item          | Value                                               |
| ------------- | --------------------------------------------------- |
| App           | `spectre-staging` (Fly, org `spectre-automation`, region `iad`) |
| Current version | **v1095**                                         |
| Image         | **`registry.fly.io/spectre-staging:sha-5e60fa59894f`** |
| Released at   | 2026-11-05T ~07:05Z (10h47m ago at query time)      |

Rollback command (reversible APP ONLY — does NOT reverse a migration):
```bash
flyctl deploy --app spectre-staging --image registry.fly.io/spectre-staging:sha-5e60fa59894f --strategy immediate
```

### 1.3 Staging DB migration state (queried read-only 2026-11-06)

Query executed via `flyctl ssh console` running
`prisma.$queryRawUnsafe` against the production Prisma client.
Scripts were uploaded to `/app/`, executed, and deleted at the end
of the inspection.

| Migration name                                           | finished_at                 | steps |
| -------------------------------------------------------- | --------------------------- | ----- |
| `20261104_ep_train_6d_4b_ai_review_persistence`          | 2026-11-04T21:21:20.880Z    | 1     |

**Not yet applied**: `20261105_ep_train_6d_4k_transcript_evidence`.

Tables present on staging today (AI-review set):

- `TrainingQuestionAiDraft`
- `TrainingQuestionAiGenerationRun`
- `TrainingQuestionAiOperationKey`
- `TrainingQuestionAiReview`
- `TrainingQuestionAiStateTransition`
- `TrainingQuestionAiValidation`

Tables **missing** on staging (introduced by 4K):

- `TrainingTranscriptBuild`
- `TrainingTranscriptSegment`
- `TrainingGroundingProjection`

Columns **missing** on staging (introduced by 4K additively):

- `TrainingQuestionAiDraft.groundingProjectionId`
- `TrainingQuestionAiDraft.modelSelectedAnswerSnapshotJson`
- `TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson`

### 1.4 Historical candidates on staging

| Measurement                                              | Count |
| -------------------------------------------------------- | ----- |
| Total `TrainingQuestionAiDraft` rows                     | 8     |
| Coulee Ridge drafts (`clubId = cmrvdeny7000144372ktmmg9c`) | 8     |
| In state `REQUIRES_HUMAN_REVIEW`                         | 5     |
| In state `REJECTED`                                      | 3     |

**Preservation requirement.** When 4K applies, the three new nullable
columns default to `NULL` on every existing row. Every one of these
8 historical drafts will therefore retain `groundingProjectionId =
NULL`, which the 4M evidence reader classifies as
`historical-unavailable` — and the 4P eligibility service classifies
as `HISTORICAL_EVIDENCE_UNAVAILABLE`. Approval remains refused for
these rows. No backfill is performed.

## 2. Migration preflight

### 2.1 Destructive-SQL scan

Both migration files were scanned (comment lines excluded):

- `prisma-postgres/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql` — **zero DROP / TRUNCATE / ALTER…DROP.**
- `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` — **zero DROP / TRUNCATE / ALTER…DROP.**

Both migrations are fully additive. Rollback requires explicit
`DROP TABLE` + `ALTER TABLE … DROP COLUMN` executed by hand (or via
a reverse migration committed later); Prisma does not generate down-
migrations.

### 2.2 Disposable PG16 rehearsal

A disposable `postgres:16-alpine` container on `localhost:15436` was
loaded with a baseline schema (via `prisma db push`), stripped of
the 4B + 4K artefacts to simulate a pre-4B production snapshot,
seeded with a representative `Club + TrainingCourse +
TrainingCourseVersion` row, and the migrations were applied in
order.

Harness: `scratchpad/ep-train-6d4q/migration-rehearsal.mjs`.

Result: **7/7 PASS**

```
PASS  T1 both migration files contain no DROP/TRUNCATE/ALTER…DROP (comment lines excluded)
PASS  T2 apply 4B migration — all 6 tables created
PASS  T3 apply 4K migration — all 3 tables + 3 columns present
PASS  T4 raw-SQL replay fails on FK (preflight finding — do NOT replay 4K by hand)
PASS  T5 pre-existing Club / Course / Version rows preserved byte-identical
PASS  T6 4K rollback does not affect 4B tables (reversible layering)
PASS  T7 4K re-apply after rollback succeeds
```

### 2.3 Idempotency finding (T4) — important for the release

The 4K migration's FK declarations (`ALTER TABLE … ADD CONSTRAINT …
FOREIGN KEY …`) have no `IF NOT EXISTS` form in PostgreSQL. A
**raw-SQL replay by hand** therefore fails with
`constraint "…_fkey" for relation "…" already exists`.

`prisma migrate deploy` (the actual release-command path) is NOT
affected — it consults `_prisma_migrations` and SKIPS any migration
whose row records a completed apply. Takeaway:

- `flyctl deploy` → `prisma migrate deploy` is safe to re-run after a
  partial release.
- Hand-running `psql -f prisma-postgres/migrations/…/migration.sql`
  on staging is NOT safe for the 4K migration, and MUST NOT be done.

### 2.4 Rollback strategy

Rolling back the Fly image alone does NOT reverse the 4K migration.
The old image reading from the 4K-extended schema will still function
because:

- The 3 new tables are not read by the pre-4K application.
- The 3 new nullable columns are not projected by any pre-4K Prisma
  client call.

**Therefore a Fly image rollback leaves staging in a safe state — the
new schema is backward-compatible with the old application code.**
There is no database restore requirement for a rollback; the forward
migration is additive, and reversing the migration is OPTIONAL.

If a full DB-level rollback is ever required for a forensic reason, a
point-in-time restore via Neon is the safe path (not raw SQL). This is
outside the normal rollback procedure.

## 3. Authorization preflight

### 3.1 Required permissions

An authenticated reviewer must hold ALL of:

| Permission                       | Why                                                                 | Enforced by                           |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `hr:training:ai:read`            | View persisted review workspace / queue / detail / evidence meta   | `read-service.ts`, `page.tsx`         |
| `hr:training:ai:approve`         | Submit the authoritative approval transaction                       | `approval-service.ts`, `approve/route.ts` |
| `hr:training:read`               | Play the uploaded source MP4 via `/api/hr/training/versions/[id]/video` | `video/route.ts:51`              |

### 3.2 Current role grants (confirmed read-only)

| Role          | ai:read | ai:approve | training:read |
| ------------- | :-----: | :--------: | :-----------: |
| SUPER_ADMIN   | ✅       | ✅          | ✅             |
| CLUB_ADMIN    | ✅       | ❌          | ✅             |
| CONTROLLER    | ❌       | ❌          | ❌             |
| GENERAL_MANAGER | ❌     | ❌          | ✅             |
| STAFF         | ❌       | ❌          | ❌             |

CLUB_ADMIN does **NOT** carry `hr:training:ai:approve`. The 4N
approval route therefore refuses every CLUB_ADMIN POST with
403→404 (same-shape per directive §4). A real staging reviewer with
CLUB_ADMIN role cannot approve.

### 3.3 Narrowest test identity — three options

Ranked by narrowness-of-grant:

| Option | Identity                                        | ai:approve scope          | Teardown                              | Narrowness |
| ------ | ----------------------------------------------- | ------------------------- | ------------------------------------- | ---------- |
| **A**  | Insert a `UserClubRole` row for a synthetic user with `{clubId: "cmrvdeny7000144372ktmmg9c", roleKey: "SUPER_ADMIN"}` | **Scoped to Coulee Ridge only**  | Delete the row + delete the User row | ★★★ (narrowest, re-uses existing RBAC catalogue) |
| B      | Use the existing Fly admin account's global SUPER_ADMIN membership  | **Global (every club)**   | None — pre-existing production identity | ★ (widest) |
| C      | Add a new permission bundle to CLUB_ADMIN       | All CLUB_ADMINs across all clubs | Removal requires another RBAC change | ★★ (production-grade change, overkill) |

**Recommendation: Option A.** No RBAC catalogue change. No new role.
A single DB row + a single Prisma user record. Scope is strictly
Coulee Ridge; audit rows record the synthetic userId; cross-tenant
behaviour is unchanged.

### 3.4 Option A — identity provisioning procedure (DRY-RUN DOCUMENT; DO NOT EXECUTE YET)

Creation:

```js
// scratchpad/ep-train-6d4q/create-test-identity.mjs — DOCUMENTED, NOT RUN.
import { PrismaClient } from "@prisma/client";
import { hash } from "bcrypt";
const pg = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const email = "4q-reviewer@spectre-test.local";
const password = await hash(crypto.randomUUID(), 10);
const user = await pg.user.create({
  data: {
    email,
    name: "4Q Synthetic Reviewer",
    status: "ACTIVE",
    passwordHash: password,
    role: "SUPER_ADMIN", // legacy column; the membership below is authoritative for RBAC
  },
});
await pg.userClubRole.create({
  data: {
    userId: user.id,
    clubId: COULEE,
    roleKey: "SUPER_ADMIN",
  },
});
console.log({ userId: user.id, email });
```

Teardown (idempotent):

```js
// scratchpad/ep-train-6d4q/teardown-test-identity.mjs — DOCUMENTED, NOT RUN.
import { PrismaClient } from "@prisma/client";
const pg = new PrismaClient();
await pg.userClubRole.deleteMany({ where: { user: { email: "4q-reviewer@spectre-test.local" } } });
await pg.user.deleteMany({ where: { email: "4q-reviewer@spectre-test.local" } });
```

Audit attribution: every `TrainingQuestionAiReview`,
`TrainingQuestionAiStateTransition`, and `audit()` row produced
during the acceptance test carries this synthetic user's `id` as
`reviewedByUserId` / `userId`. Those audit rows are preserved after
teardown — only the login capability is removed.

Teardown does NOT delete the authored approval rows — those belong
to the acceptance evidence. The synthetic fixture draft (§4) is
torn down separately.

### 3.5 Why NOT a brand-new RBAC role

Shipping a `TRAINING_AI_REVIEWER` role is a production RBAC change
that touches `src/lib/permissions.ts` and requires founder
authorisation per CLAUDE.md. The directive §5 prefers "a disposable,
tenant-scoped test identity with only the minimum required
permissions" — Option A satisfies that without any permission
catalogue change.

## 4. Authentic-evidence synthetic fixture (specification, not implementation)

### 4.1 Goal

Provision ONE synthetic, deliberately-constructed training-question
candidate that:

- Owns a real `TrainingCourseVersion` with an uploaded MP4 (byte-
  identical to a short synthetic video, e.g. a 10-second H.264 file).
- Has a real `TrainingTranscriptBuild` with faster-whisper metadata.
- Has 3–4 real `TrainingTranscriptSegment` rows with persisted text
  + timestamps (constructed by hand from the script, not Whisper-
  generated).
- Has a real `TrainingGroundingProjection` with the server-
  recomputed canonical SHA-256 wired to the segments above.
- Has a real `TrainingQuestionAiGenerationRun` + `TrainingQuestionAiDraft`
  + `TrainingQuestionAiValidation` where:
  - `state = REQUIRES_HUMAN_REVIEW`
  - `questionType = SINGLE_CHOICE`
  - 3 options with the wrong `isCorrect = true` on the "model-picked"
    option
  - 1 of the other options is the **actually-correct** answer per
    the segment text (the human reviewer discovers this)
  - `latestValidation.verdict = GROUNDED` or
    `REQUIRES_HUMAN_VERIFICATION`, zero hard errors
  - `draft.contentHash` and `projection.sha256` wired through 4L's
    canonical hasher
- Exercises 4L's `persistTranscriptBuild`,
  `persistTranscriptSegments`, and `persistGroundingProjection`
  services (not direct `pg.create` writes).
- Exercises 4M's `resolveCandidateEvidence` end-to-end (authentic
  branch, not historical-unavailable).
- Lets 4P's dialog open + submit a successful approval.
- Lets 4N's verified-answer snapshot write + 4M's integrity-check
  emerald chip render on the next page read.

### 4.2 Fixture components (nine rows across six tables)

| # | Table                         | Role                                                      |
| - | ----------------------------- | --------------------------------------------------------- |
| 1 | `Club`                        | Existing Coulee Ridge row (`cmrvdeny7000144372ktmmg9c`) — NOT created. |
| 2 | `TrainingCourse`              | New: `code = "4Q-SYNTH"`, `category = "ORIENTATION"`.     |
| 3 | `TrainingCourseVersion`       | New: `version = 1`, `state = "DRAFT"`, `videoSha256 = <sha of uploaded MP4>`. |
| 4 | R2 object                     | A short 10-second synthetic MP4 (e.g. `assets/4q-fixture.mp4`). |
| 5 | `TrainingTranscriptBuild`     | `transcriberName = "spectre-synthetic-4q"` (**deliberately NOT faster-whisper** so the UI's transcription-source line reads "spectre-synthetic-4q — not a Whisper run"). |
| 6 | `TrainingTranscriptSegment` × 3 | Three segments with real text + timestamps, hand-authored. |
| 7 | `TrainingGroundingProjection` | Canonical body built by `canonicalProjectionBody`; server-recomputed sha256. |
| 8 | `TrainingQuestionAiGenerationRun` | A sentinel generation row bookkeeping the synthesis.   |
| 9 | `TrainingQuestionAiDraft` + `TrainingQuestionAiValidation` | The reviewable candidate. |

### 4.3 Not-AI disclaimer

The fixture does **NOT** invoke Qwen or Whisper. The transcript
metadata uses `transcriberName = "spectre-synthetic-4q"` so no
operator can mistake this fixture for proof of AI-generation
quality. The fixture exercises the 4L–4P pipelines; it does **NOT**
validate the AI content generators themselves.

### 4.4 Teardown (idempotent)

```js
// scratchpad/ep-train-6d4q/teardown-fixture.mjs — DOCUMENTED, NOT RUN.
import { PrismaClient } from "@prisma/client";
const pg = new PrismaClient();
const COURSE_ID = "crs_4q_synth";
// Order: child rows first (FK constraint ON DELETE RESTRICT).
await pg.trainingQuestionAiOperationKey.deleteMany({ where: { draft: { courseId: COURSE_ID } } });
await pg.trainingQuestionAiStateTransition.deleteMany({ where: { draft: { courseId: COURSE_ID } } });
await pg.trainingQuestionAiReview.deleteMany({ where: { draft: { courseId: COURSE_ID } } });
await pg.trainingQuestionAiValidation.deleteMany({ where: { draft: { courseId: COURSE_ID } } });
await pg.trainingQuestionAiDraft.deleteMany({ where: { courseId: COURSE_ID } });
await pg.trainingQuestionAiGenerationRun.deleteMany({ where: { courseId: COURSE_ID } });
await pg.trainingGroundingProjection.deleteMany({ where: { courseVersion: { courseId: COURSE_ID } } });
await pg.trainingTranscriptSegment.deleteMany({ where: { build: { /* no courseVersion FK — filter by clubId + sha */ } } });
await pg.trainingTranscriptBuild.deleteMany({ where: { sourceVideoSha256: "<fixture-video-sha>" } });
await pg.trainingCourseVersion.deleteMany({ where: { courseId: COURSE_ID } });
await pg.trainingCourse.deleteMany({ where: { id: COURSE_ID } });
// R2: delete the fixture MP4 object.
```

### 4.5 Audit-retention policy

After teardown:

- The synthetic `TrainingQuestionAiReview` + `…StateTransition`
  rows produced during the acceptance test are **deleted** (they
  reference a draftId that no longer exists; keeping them would be
  misleading). The `audit()` event rows in the global `AuditLog`
  remain — they preserve the "4Q-acceptance happened" fact without
  dangling references.
- The synthetic identity (§3.4) is torn down separately AFTER the
  fixture teardown completes.

### 4.6 The 8 historical candidates are NOT modified

The teardown explicitly filters on `courseId = "crs_4q_synth"`.
Every one of the 8 pre-4K historical candidates (§1.4) belongs to a
different `TrainingCourse` and is therefore untouched. A post-
teardown read-only check against `TrainingQuestionAiDraft` must
report exactly 8 rows (the pre-release count) for Coulee Ridge.

## 5. Video authorization preflight

The 4M dialog streams the source MP4 via
`/api/hr/training/versions/[id]/video` (see
[src/app/api/hr/training/versions/[id]/video/route.ts](../../src/app/api/hr/training/versions/[id]/video/route.ts)).

The GET path enforces, in order:

1. `callerCanReadVersion(versionId)` — tenant-scope the version to the
   caller's club via `course.clubId`.
2. **Admin path**: a signed-in Principal with
   `hr:training:read` on that club (SUPER_ADMIN carries this
   globally; CLUB_ADMIN has it at line [permissions.ts:477](../../src/lib/permissions.ts#L477)).
3. **Employee-portal path**: a portal principal in the same club AND
   the version is applicable AND published AND not retired.

**Finding.** The 4Q synthetic identity (Option A, SUPER_ADMIN-on-
Coulee-Ridge) satisfies the admin path:
`rolesAtClub("cmrvdeny7000144372ktmmg9c") === ["SUPER_ADMIN"]` →
`hasPermission("hr:training:read")` → `true`.

**No additional grants required.** The reviewer plays the video via
the same session cookie used for the approval POST; the existing
authenticated endpoint streams bytes with HTTP Range support (so
click-to-seek works in Safari + Chrome).

**No public R2 URL is exposed.** The dialog renders `<video
src="/api/hr/training/versions/{id}/video">`; the browser's fetch
inherits the session cookie; the server verifies permission on each
request.

## 6. Idempotency + retry preflight

### 6.1 UUID lifecycle (from `ApprovalDialog.tsx`)

| Event                                          | Key behaviour                                         |
| ---------------------------------------------- | ----------------------------------------------------- |
| Dialog closed → opened                         | `setIdempotencyKey(crypto.randomUUID())` — fresh UUID. |
| User clicks Approve, gets a 500 or timeout     | Same key preserved — a retry sends the SAME POST body. 4N's `_prisma_migrations`-equivalent (TrainingQuestionAiOperationKey unique index) returns the cached success. |
| User clicks Approve, gets a 409 IDEMPOTENCY_CONFLICT | UI shows "Regenerate the key or refresh." Pressing ↻ regenerate mints a new UUID. |
| User materially changes the selected answer    | They should press ↻ regenerate before resubmitting (otherwise the server's 4N reader will refuse because the payload fingerprint no longer matches the cached one). |
| User clicks Approve, gets 200                  | `onApproved()` fires → parent calls `router.refresh()` → next render reads the authoritative verified-answer snapshot. |

Tested offline in `tests/ep-train-6d4p-approval-dialog.test.tsx`:

- `retry after a network failure reuses the same idempotency key` ✅
- `regenerating the idempotency key produces a new key on the next submit` ✅
- `rapid double-click submits once (duplicate submit prevented)` ✅

### 6.2 Server-side reconciliation

If the browser uncertain-outcome state ever disagrees with the
server (e.g. a long-running connection drop during 4N's transaction),
the reviewer can reload the persisted review page — the server
re-reads via `resolveVerifiedAnswer`, which is authoritative:

- If 4N committed: emerald "Verified correct" renders, Approve
  button disables with reason `ALREADY_VERIFIED`.
- If 4N rolled back: Approve button remains enabled, reviewer
  retries with the same UUID (replay returns 200 + `replay: true`)
  OR a fresh UUID (new attempt).

### 6.3 Unresolved 4Q-era gap

**Observation** (not a blocker): the dialog's "regenerate idempotency
key" button is intentionally visible but un-prominent; a reviewer
who clicks Approve on a stale payload fingerprint may be surprised
by the 409 IDEMPOTENCY_CONFLICT. For the first acceptance pass we
accept this; a follow-up slice could auto-regenerate the key when
the answer selection changes. Documented, not implemented.

## 7. Dependencies between the slices

To get a reviewer approving a candidate end-to-end on staging, the
following must land together:

- 4K migration — adds the 3 tables + 3 columns.
- 4L code — reads/writes the 3 new tables via the ingest services.
- 4M code — reads evidence via the new schema.
- 4N code — writes the verified-answer snapshot into the new
  `verifiedCorrectAnswerSnapshotJson` column + calls
  `/api/admin/ai-training/drafts/[id]/approve`.
- 4P code — eligibility gate + dialog + wired into the page.

**Deployment order inside a single release:** Fly's `release_command`
runs `prisma migrate deploy` BEFORE the new app serves traffic, so
the schema is in place before the new image reads it. Rollback-safety
is additive: the old image continued to read from a schema that just
grew three nullable columns.

## 8. STOP boundaries honoured (per directive §11)

| Boundary                                 | Status         |
| ---------------------------------------- | -------------- |
| No staging deployment                    | HONOURED       |
| No shared database migration             | HONOURED — rehearsal was on disposable PG16 only |
| No new role grants                       | HONOURED       |
| No test-account creation                 | HONOURED — Option A documented, not executed |
| No historical candidate backfill         | HONOURED       |
| No Modal/Qwen inference                  | HONOURED       |
| No transcription-worker activation       | HONOURED       |
| No live approval or publication          | HONOURED       |
| No global UI redesign                    | HONOURED       |
| Preserve the 126 unrelated WIP files     | HONOURED — stashed at entry, to be restored at exit |

## 9. Outputs

- This file.
- [PHASE-D-4Q-RELEASE-PLAN.md](PHASE-D-4Q-RELEASE-PLAN.md) — the
  DRH-1 16-step procedure.
- [PHASE-D-4Q-ACCEPTANCE.md](PHASE-D-4Q-ACCEPTANCE.md) — summary +
  GO/NO-GO.
