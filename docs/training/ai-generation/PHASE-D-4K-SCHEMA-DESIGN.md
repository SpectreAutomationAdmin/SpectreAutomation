# EP-TRAIN-6D-4K — Immutable Transcript Evidence Schema Foundation

**Status:** Offline schema implementation. No staging or production touched. No ingest worker wired. No API route added. No UI change. No historical candidate mutated.

**Scope:** additive Prisma schema + migration SQL (SQLite dev + Postgres deployment) for three new evidence tables and three nullable columns on existing AI-review tables.

**Upstream:** EP-TRAIN-6D-4J architecture (accepted).

**Companion:** [PHASE-D-4K-ACCEPTANCE.md](PHASE-D-4K-ACCEPTANCE.md).

---

## 1. Summary

Three new tables + three nullable columns, additive-only.

| New table | Purpose |
|---|---|
| `TrainingTranscriptBuild` | One row per deterministic transcription run per tenant per source video. Carries actual transcriber engine / model / version / config SHA / produced-at (per founder directive §4). |
| `TrainingTranscriptSegment` | One row per segment of a build. Immutable text + startSec + endSec + per-segment advisory flags. CHECK-enforced timestamp + index invariants. |
| `TrainingGroundingProjection` | One row per immutable projection subset authorised for generation. Canonical passages JSON + sha256 + course-version ownership. |

| Additive nullable column | On | Purpose |
|---|---|---|
| `groundingProjectionId` | `TrainingQuestionAiDraft` | FK to the durable projection. NULL on historical rows. ON DELETE RESTRICT. |
| `modelSelectedAnswerSnapshotJson` | `TrainingQuestionAiDraft` | Frozen canonical JSON of the MODEL-selected options. NULL on historical rows. |
| `verifiedCorrectAnswerSnapshotJson` | `TrainingQuestionAiValidation` | Reviewer-asserted "correct" snapshot. Written ONLY by the future approval route (4N); NULL on every pre-approval row. |

No existing row is mutated. No table is otherwise altered. Rollback drops the three new tables + three new columns cleanly.

---

## 2. Preflight — the one surfaced correction to the 6D-4J two-table design

The 6D-4J architecture proposed TWO new tables: `TrainingTranscriptSegment` and `TrainingGroundingProjection`. During preflight (per directive §"If the two-table design cannot express these requirements without ambiguous or mutable ownership, STOP and propose the smallest corrected design before implementing"), the audit shape was evaluated against all eleven founder requirements:

| # | Requirement | 6D-4J 2-table design | Adequate? |
|---|---|---|---|
| 1 | Tenant ownership | `clubId` on both tables | ✅ |
| 2 | Course and course-version ownership | `TrainingGroundingProjection.courseVersionId` | ✅ |
| 3 | Source-video SHA-256 | On both tables | ✅ |
| 4 | **Unique transcription-run identity** | **No run row**; run metadata duplicated per segment | **❌** |
| 5 | **Actual transcriber engine, model, version** | **Duplicated per segment**; drift possible | **❌** |
| 6 | Exact segment IDs, text, timestamps | `segmentIndex`, `text`, `startSec`, `endSec` | ✅ |
| 7 | Immutable grounding projection membership | `passagesJson` + `sha256` unique | ✅ |
| 8 | Source-org + mismatch flags | `pendingReviewJson`, `sourceOrgMismatchJson`, `uncertaintyWarning` | ✅ |
| 9 | Binding to original draft content hash | Validation row carries `draftContentHash`; snapshot sits on the validation row | ✅ |
| 10 | Provenance integrity + idempotency | Projection + segment uniques OK; but run-level transcriber values can drift across segments | ⚠ |
| 11 | Cross-course-version rejection | Projection + draft both carry `courseVersionId` | ✅ |

Rows 4, 5, and 10 are the inadequacies. Founder directive §4 is explicit: "Record actual engine/model/version metadata **per run** rather than assuming one global configuration." Storing `transcriberName / transcriberVersion / transcriberModelName / transcriberModelVersion / transcriberConfigSha256 / producedAt` on every segment allows per-row drift: a bug or a tampered write path could produce segments of the same `resolvedTranscriptBuildId` that disagree on which transcriber version produced them. PostgreSQL cannot enforce "all segments of the same build share the same metadata" without a row-level trigger or a per-segment join to a canonical row.

**Smallest corrected design:** lift the run-level metadata off the segment row into a dedicated `TrainingTranscriptBuild` table, keyed on `(clubId, sourceVideoSha256, resolvedTranscriptBuildId)`. Segments FK to it. Three tables total; nothing else changes.

**Why this is the minimum, not an invention:**

- Founder directive §4 mandates run-level metadata.
- The single-table design cannot enforce run-level identity invariants at the DB level — only at the service layer, which is weaker than the directive's "unique transcription-run identity" requirement #4.
- The lifted fields are EXACTLY the five fields 6D-4J §4.1 already named — no new columns are introduced beyond moving those five + `producedAt` into their rightful parent row.
- No other 6D-4J design surface changes.

This correction is surfaced visibly here per directive instruction "Do not silently introduce additional tables or change the approved architecture." If the founder rejects the correction, the implementation can be reverted to the 2-table shape on the same branch; the `migration.sql` + `schema.prisma` deltas are local to this commit.

---

## 3. Schema delta — full details

### 3.1 New model — `TrainingTranscriptBuild`

Immutable per `(clubId, sourceVideoSha256, resolvedTranscriptBuildId)`. Re-transcription (e.g. a new faster-whisper version) produces a new `resolvedTranscriptBuildId` and therefore a new row — the old row + its segments remain.

```prisma
model TrainingTranscriptBuild {
  id                           String   @id @default(cuid())

  clubId                       String
  club                         Club     @relation(fields: [clubId], references: [id])

  sourceVideoSha256            String
  resolvedTranscriptBuildId    String

  transcriberName              String   // e.g. "faster-whisper"
  transcriberVersion           String   // e.g. "1.0.3"
  transcriberModelName         String   // e.g. "large-v3"
  transcriberModelVersion      String   // stable identifier for the model artifact
  transcriberConfigSha256      String   // hash of the deterministic config JSON

  producedAt                   DateTime
  createdAt                    DateTime @default(now())

  segments                     TrainingTranscriptSegment[]

  @@unique([clubId, sourceVideoSha256, resolvedTranscriptBuildId])
  @@index([clubId, sourceVideoSha256])
  @@index([clubId, producedAt])
}
```

### 3.2 New model — `TrainingTranscriptSegment`

One row per segment. Immutable. `startSec`/`endSec` enforce `startSec >= 0 AND endSec >= startSec`; `segmentIndex` enforces `>= 0`.

```prisma
model TrainingTranscriptSegment {
  id                           String   @id @default(cuid())

  clubId                       String
  club                         Club     @relation(fields: [clubId], references: [id])

  transcriptBuildId            String
  transcriptBuild              TrainingTranscriptBuild @relation(fields: [transcriptBuildId], references: [id])

  segmentIndex                 Int

  text                         String
  startSec                     Decimal
  endSec                       Decimal

  pendingReviewJson            String   @default("[]")
  sourceOrgMismatchJson        String   @default("[]")
  uncertaintyWarning           String?

  createdAt                    DateTime @default(now())

  @@unique([clubId, transcriptBuildId, segmentIndex])
  @@index([clubId, transcriptBuildId])
}
```

With CHECK constraints in the migration SQL:
- `CHECK ("segmentIndex" >= 0)`
- `CHECK ("startSec" >= 0 AND "endSec" >= "startSec")`

### 3.3 New model — `TrainingGroundingProjection`

```prisma
model TrainingGroundingProjection {
  id                           String   @id @default(cuid())

  clubId                       String
  club                         Club     @relation(fields: [clubId], references: [id])

  courseVersionId              String
  courseVersion                TrainingCourseVersion @relation(fields: [courseVersionId], references: [id])

  sha256                       String

  sourceVideoSha256            String
  resolvedTranscriptBuildId    String

  passagesJson                 String
  excludedPassagesJson         String   @default("[]")

  sourceOrgMismatchFlagsPresent Boolean @default(false)
  pendingReviewPresent          Boolean @default(false)

  authoredAt                   DateTime
  createdAt                    DateTime @default(now())

  drafts                       TrainingQuestionAiDraft[]

  @@unique([clubId, courseVersionId, sha256])
  @@index([clubId, courseVersionId])
  @@index([clubId, sha256])
}
```

### 3.4 Additive columns on `TrainingQuestionAiDraft`

```prisma
// FK to the durable projection. onDelete: Restrict — projections underlying
// reviewer-approved drafts cannot be silently deleted.
groundingProjectionId         String?
groundingProjection           TrainingGroundingProjection? @relation(fields: [groundingProjectionId], references: [id], onDelete: Restrict, onUpdate: Cascade)

// Frozen canonical JSON of the options as the model emitted them.
modelSelectedAnswerSnapshotJson String?
```

### 3.5 Additive column on `TrainingQuestionAiValidation`

```prisma
// Reviewer-asserted authoritative "correct" answer snapshot.
// Shape (canonical JSON):
//   { "optionIndex": number,
//     "optionText": string,
//     "verifiedByUserId": string,
//     "verifiedAt": "ISO 8601",
//     "draftContentHash": string,
//     "validationId": string }
// Written ONLY by the future approval route (4N), inside the same DB
// transaction that advances the draft to APPROVED_DRAFT. The duplicated
// draftContentHash + validationId bind the snapshot to the exact
// immutable draft + validation version.
//
// NULL on every row that is not a terminal reviewer approval.
// ARCHIVED state alone is NOT eligibility — the presence of this
// snapshot is the only signal the read service may use to render a
// "Verified correct" label.
verifiedCorrectAnswerSnapshotJson String?
```

### 3.6 Back-relation arrays added on parent models

- `Club` gains three: `trainingTranscriptBuilds`, `trainingTranscriptSegments`, `trainingGroundingProjections`.
- `TrainingCourseVersion` gains one: `trainingGroundingProjections`.

These are compile-time Prisma conveniences; no SQL impact.

---

## 4. Migration SQL

### 4.1 Files

| Path | Target | Contents |
|---|---|---|
| `prisma/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` | SQLite dev | `CREATE TABLE` × 3 + `ALTER TABLE ... ADD COLUMN` × 3 + CHECK constraints + unique indexes + FK indexes |
| `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` | PostgreSQL deployment | Same semantic contents in PG dialect (`TIMESTAMP(3)`, `NUMERIC(65,30)`, separate `ALTER TABLE ADD CONSTRAINT`, `CREATE INDEX IF NOT EXISTS`) |

### 4.2 Foreign-key behaviour

| Edge | ON DELETE | ON UPDATE | Rationale |
|---|---|---|---|
| `TrainingTranscriptBuild.clubId → Club` | RESTRICT | CASCADE | Clubs holding durable evidence cannot be silently deleted. |
| `TrainingTranscriptSegment.clubId → Club` | RESTRICT | CASCADE | Same. |
| `TrainingTranscriptSegment.transcriptBuildId → TrainingTranscriptBuild` | RESTRICT | CASCADE | A build can only be removed after its segments are explicitly handled by a founder-authorised evidence-archive flow. |
| `TrainingGroundingProjection.clubId → Club` | RESTRICT | CASCADE | Same. |
| `TrainingGroundingProjection.courseVersionId → TrainingCourseVersion` | RESTRICT | CASCADE | Course versions underlying reviewer-visible evidence cannot be silently deleted. |
| `TrainingQuestionAiDraft.groundingProjectionId → TrainingGroundingProjection` (NEW) | RESTRICT | CASCADE | Projections referenced by drafts cannot be silently deleted. |

No destructive cascades. Every delete requires explicit handling.

### 4.3 CHECK constraints

- `TrainingTranscriptSegment_segmentIndex_nonneg_chk`: `segmentIndex >= 0`.
- `TrainingTranscriptSegment_timestamps_chk`: `startSec >= 0 AND endSec >= startSec`.

Zero-length segments (endSec == startSec) are allowed as an edge case.

### 4.4 Idempotency behaviour

- `CREATE TABLE IF NOT EXISTS` on every new table.
- `CREATE INDEX IF NOT EXISTS` on every new index.
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on every new column.
- `ALTER TABLE … ADD CONSTRAINT` is NOT wrapped in `IF NOT EXISTS` — PostgreSQL does not support `IF NOT EXISTS` on `ADD CONSTRAINT`. Re-applying the migration raises a known error on the constraint statements. This matches the existing 6D-4B convention: Prisma's `_prisma_migrations` tracking (not SQL-internal idempotency) is the source of truth for whether a migration has already applied. Verified across the project's other 133 migrations.

---

## 5. Isolated Postgres 16 integration evidence

### 5.1 Harness

- Docker image: `postgres:16-alpine` (`sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab`).
- Container: `spectre-6d4k-pg`, disposable, port 15432, credentials `spectre:test`, database `spectre_6d4k`.
- Workflow: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` before each pass.

### 5.2 Pass 1 — `prisma db push` end-to-end

Every table + index + constraint from `prisma-postgres/schema.prisma` materialised in a single Prisma-managed run. Confirmation:

- All 3 new tables exist with correct columns, types, defaults, NOT NULL flags, and PK/unique constraints.
- `TrainingQuestionAiDraft.groundingProjectionId` exists, nullable, FK to `TrainingGroundingProjection(id)` with `ON DELETE RESTRICT ON UPDATE CASCADE`.
- `TrainingQuestionAiDraft.modelSelectedAnswerSnapshotJson` exists, nullable.
- `TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson` exists, nullable.

### 5.3 Pass 2 — `migration.sql` on a minimal baseline

Fresh schema → minimal `Club + TrainingCourse + TrainingCourseVersion + TrainingQuestionAiDraft + TrainingQuestionAiValidation` baseline → apply `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` directly via psql. Zero errors.

Final table inventory: `Club, TrainingCourse, TrainingCourseVersion, TrainingGroundingProjection, TrainingQuestionAiDraft, TrainingQuestionAiValidation, TrainingTranscriptBuild, TrainingTranscriptSegment` (8 tables, 3 new).

### 5.4 Pass 3 — Negative control suite

11 controls (per directive §"Required negative controls") + 3 structural checks. Results:

| # | Control | Result | Enforcement |
|---|---|---|---|
| 1 | Cross-tenant FK references rejected | **PASS** | DB (FK to non-existent Club rejected); row-level cross-tenant mismatch (segment.clubId ≠ build.clubId) deferred to 4L service layer. |
| 2 | Cross-course-version evidence binding rejected | **PASS** | DB (FK to non-existent `TrainingCourseVersion` rejected); tenant/version mismatch deferred to 4L. |
| 3 | Duplicate segment identities rejected | **PASS** | Unique `(clubId, transcriptBuildId, segmentIndex)` fires. |
| 4 | Duplicate grounding projections handled idempotently | **PASS** | Unique `(clubId, courseVersionId, sha256)` fires; same sha256 on a different course version permitted (legitimate). |
| 5 | Invalid timestamps rejected | **PASS** | CHECK constraints fire for `startSec < 0`, `endSec < startSec`, `segmentIndex < 0`. Zero-length segment accepted. |
| 6 | Missing source-video binding rejected | **PASS** | NOT NULL on `TrainingTranscriptBuild.sourceVideoSha256` + `TrainingTranscriptSegment.transcriptBuildId`. |
| 7 | Immutable evidence cannot be silently overwritten | **PASS (PK level)** | PK duplicates refused; service-layer rewrite prevention deferred to 4L (ingest uses `createMany skipDuplicates`). |
| 8 | Existing AI-review records remain compatible | **PASS** | Historical draft with `groundingProjectionId = NULL` + `modelSelectedAnswerSnapshotJson = NULL` persists; new draft with FK + snapshot populated persists. |
| 9 | Migration applies cleanly to isolated DB | **PASS** | Pass 2. |
| 10 | Transaction failures leave no partial records | **PASS** | Rollback of a multi-row INSERT leaves segment count pre/post identical. |
| 11 | No credential or sensitive provenance leakage | **PASS** | Zero columns matching `password/token/secret/cred/api[_-]?key/private[_-]?key/authorization` across the three new tables. |

Plus structural extras:

| Check | Result |
|---|---|
| `ON DELETE RESTRICT` on `draft.groundingProjectionId` prevents projection delete while referenced | **PASS** |
| `verifiedCorrectAnswerSnapshotJson` accepts canonical JSON string via UPDATE | **PASS** |

Full SQL + output: `scratchpad/ep-train-6d4k/postgres-negative-controls.sql` + `postgres-negative-controls-output.txt`.

### 5.5 Pass 4 — Rollback

`scratchpad/ep-train-6d4k/down-migration.sql` is a reference rollback script (Prisma migrate does not drive automated down-migrations; this is for manual use if needed). Verified: baseline + 4K up → down produces the exact minimal baseline (5 tables, zero new columns on the two existing tables, no orphaned FK). Clean.

---

## 6. DB-level vs service-layer enforcement — honest line

Not every negative control the directive enumerates can be DB-enforced:

| Guarantee | Enforcement location |
|---|---|
| Cross-tenant mismatch within ONE row (e.g. segment.clubId ≠ build.clubId) | **Service layer (4L)**. The DB checks clubId points at a real Club and transcriptBuildId points at a real Build, but not that they share a clubId. 4L's ingest service refuses the write before it reaches the DB. |
| Cross-course-version mismatch within ONE row (e.g. projection.clubId ≠ `TrainingCourseVersion.course.clubId`) | **Service layer (4L)**. Same reasoning. |
| Service-layer `UPDATE` rewriting an existing segment's text | **Service layer (4L)**. The DB only prevents PK + unique-constraint reuse. 4L's ingest uses `createMany skipDuplicates`; the write path never issues `UPDATE` on these tables. |
| Projection sha256 drift between draft's scalar hash + FK target's `sha256` | **Service layer (4L / 4M)**. DB holds both independently; the read service verifies equality on every detail-page render and surfaces a 500-class evidence-integrity failure on mismatch. |
| Reviewer approval refusals (missing `verifiedCorrectAnswerIndex`, index out-of-range, text mismatch) | **API layer (4N)**. DB accepts any TEXT value for `verifiedCorrectAnswerSnapshotJson`; the approval route enforces shape + contents. |

This separation is documented so a future reviewer knows exactly which guarantees land in 4K vs later slices.

---

## 7. Compatibility + rollback analysis

### 7.1 Forward compatibility

- Historical EP-TRAIN-6D-4H drafts: byte-identical. `groundingProjectionId = NULL`, `modelSelectedAnswerSnapshotJson = NULL`, `verifiedCorrectAnswerSnapshotJson = NULL` on every linked validation. The read service (not changed in 4K) continues to render them exactly as it does today.
- Existing AI-review services (`src/lib/hr/training/ai-review/*`): untouched by 4K. No compile-time or runtime change.
- Existing API routes under `src/app/api/admin/ai-training/**`: untouched. The new columns are not returned in any current DTO.
- Existing UI (`PersistedReviewWorkspace.tsx`): untouched. New columns are not read.

### 7.2 Backward rollback

- The additive migration is strictly reversible via `scratchpad/ep-train-6d4k/down-migration.sql`. Verified in Pass 4.
- Rollback precondition: no evidence rows in the three new tables (operator check `SELECT COUNT(*) FROM "TrainingGroundingProjection"` etc. before running the down script). If evidence rows exist, archive them before rollback — the operator decision belongs to the founder, not the engineer.

### 7.3 Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Projection sha256 drift between draft's scalar hash + FK target | Low | Service-layer integrity check at read time (4M). Mismatch surfaces as a 500-class error, never as rendered evidence. |
| Transcriber metadata drift across segments of the same build | **Eliminated by the three-table shape**. Drift is impossible by construction (one row per build). | — |
| Historical candidate accidentally rendered with click-to-seek | Low | 4M read service will branch on `groundingProjectionId IS NULL`; UI shows "Imported from a historical pilot" treatment. No change needed in 4K. |
| Operator deletes a projection while a draft still references it | Low | `ON DELETE RESTRICT` refuses the delete at the DB layer. |

---

## 8. Files touched by this slice

| Path | Change |
|---|---|
| `prisma/schema.prisma` | +3 models at EOF, +3 nullable columns on existing AI-review tables, +4 back-relation arrays on Club + TrainingCourseVersion |
| `prisma-postgres/schema.prisma` | Mirror of the above |
| `prisma/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` | NEW — SQLite additive migration |
| `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` | NEW — PG additive migration |
| `docs/training/ai-generation/PHASE-D-4K-SCHEMA-DESIGN.md` | NEW — this file |
| `docs/training/ai-generation/PHASE-D-4K-ACCEPTANCE.md` | NEW — companion acceptance doc |
| `scratchpad/ep-train-6d4k/postgres-negative-controls.sql` | NEW — integration-test harness |
| `scratchpad/ep-train-6d4k/postgres-negative-controls-output.txt` | NEW — captured psql output (PASS evidence) |
| `scratchpad/ep-train-6d4k/migration-replay-minimal-baseline.sql` | NEW — minimal baseline for replay test |
| `scratchpad/ep-train-6d4k/down-migration.sql` | NEW — reference rollback script |

Nothing else changed. No service-layer code. No API route. No UI code. No RBAC grant. No role seed. No documentation outside the 4K folder. The 126 unrelated WIP files on `staging-deploy/web1b1-framer-fidelity` are preserved (stashed, not touched).

---

## 9. Proposed 4L implementation boundary

The next slice is the ingest WRITE PATH. Scope boundary:

- `src/lib/hr/training/transcription/ingest.ts` — new service file.
  - `persistTranscriptBuild(principal, clubId, input)` — upsert into `TrainingTranscriptBuild` by `(clubId, sourceVideoSha256, resolvedTranscriptBuildId)`.
  - `persistTranscriptSegments(principal, clubId, buildId, input)` — bulk insert into `TrainingTranscriptSegment` via `createMany skipDuplicates`; tamper check compares `text` of any pre-existing matching row and refuses on drift (hard 500).
  - `persistGroundingProjection(principal, clubId, input)` — upsert into `TrainingGroundingProjection` by `(clubId, courseVersionId, sha256)`; computes `sha256` from canonical `passagesJson` server-side; refuses if the client-supplied hash disagrees.
- Permission: new `hr:training:transcription:write` grant, SUPER_ADMIN + CLUB_ADMIN only (NOT broader). Grant added in 4L, NOT this slice.
- Audit: every write calls `audit()` with action `training.transcript.build.ingested` / `.segment.ingested` / `.projection.ingested`.
- Service-layer tenant-isolation guards for the gaps enumerated in §6.
- NO worker wiring, NO Modal/Qwen inference, NO UI change, NO new API route (service functions are called by a future authorised worker; worker-wiring is a separate slice after 4L).

Scope NOT in 4L:

- Reader surface (segment-body rendering on the manager review page) — that's 4M.
- Approval-route `verifiedCorrectAnswerIndex` enforcement — that's 4N.
- Historical backfill of the eight 6D-4H candidates from scratchpad data — that's 4O (deferred, separately authorised per founder decision #2).

---

## 10. STOP boundaries re-stated

- No DB migration applied to staging or production.
- No API route added.
- No UI change shipped.
- No Modal/Qwen inference run.
- No historical candidate mutated. The eight 6D-4H candidates remain exactly as they are today.
- No approval, editing, rejection, or publication performed.
- No new RBAC permission grant. The existing `hr:training:ai:read` grant is unchanged.
- No DRH-1 deployment triggered.
- 126 unrelated WIP files on `staging-deploy/web1b1-framer-fidelity` preserved via `git stash`.
