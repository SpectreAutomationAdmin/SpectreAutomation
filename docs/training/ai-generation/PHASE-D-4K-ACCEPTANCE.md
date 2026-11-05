# EP-TRAIN-6D-4K — Acceptance

**Slice:** EP-TRAIN-6D-4K — Immutable Transcript Evidence Schema Foundation.
**Status:** Offline schema implementation DELIVERED on branch `ep-train-6d-4k/schema-foundation`. No staging or production touched. Awaiting founder acceptance.

**Upstream baseline:** `acceptance/ep-train-6d-4i` at sha `87bf7ccd47a2ed9eb3378768aca25c08bb4918d0`, Fly v1095 / `sha-5e60fa59894f`. Unchanged by this slice.

**Companion:** [PHASE-D-4K-SCHEMA-DESIGN.md](PHASE-D-4K-SCHEMA-DESIGN.md).

---

## 1. Preflight outcome — surfaced correction

The EP-TRAIN-6D-4J architecture proposed a two-table design. Preflight (per directive) found that this design cannot satisfy all eleven founder requirements without ambiguous or mutable ownership. Specifically, requirements §4 ("unique transcription-run identity") and §5 ("actual transcriber engine, model and version") would have required run-level metadata to be duplicated across every segment row, with no DB-level enforcement that segments of the same build agree on which transcriber produced them.

**Smallest corrected design implemented:** three tables instead of two. The run-level transcriber metadata (`transcriberName`, `transcriberVersion`, `transcriberModelName`, `transcriberModelVersion`, `transcriberConfigSha256`, `producedAt`) is lifted off `TrainingTranscriptSegment` into a dedicated `TrainingTranscriptBuild` row. Segments FK to the build. One additional table, directly responsive to the directive's §4 requirement to record metadata "per run". No other 6D-4J design surface is altered. If the founder rejects this correction, the migration SQL + schema delta can be reverted to the 2-table shape on the same branch.

Full detail: [PHASE-D-4K-SCHEMA-DESIGN.md §2](PHASE-D-4K-SCHEMA-DESIGN.md).

---

## 2. Founder decision reconciliation

| # | Decision | Where honoured |
|---|---|---|
| 1 | Approve two-table design in principle | Preserved as the baseline + one surfaced correction (§1 above + design doc §2). |
| 2 | Historical backfill deferred | No historical row mutated. The eight 6D-4H candidates retain `groundingProjectionId = NULL` + `modelSelectedAnswerSnapshotJson = NULL`. |
| 3 | Automatic ingest-worker wiring deferred | No ingest service shipped in 4K. Service-layer design + boundary enumerated in [SCHEMA-DESIGN.md §9](PHASE-D-4K-SCHEMA-DESIGN.md). |
| 4 | Transcription engine is faster-whisper; record ACTUAL engine/model/version per run | `TrainingTranscriptBuild` carries `transcriberName`, `transcriberVersion`, `transcriberModelName`, `transcriberModelVersion`, `transcriberConfigSha256`, `producedAt`. All text columns, open-ended — no global default assumed. |
| 5 | Retention aligned with source video + course; no automatic deletion or new retention period | FK targets use `ON DELETE RESTRICT`. No TTL column added. No maintenance job scheduled. |
| 6 | Verified-answer approval governance approved conceptually, deferred to 4N | `verifiedCorrectAnswerSnapshotJson` column added nullable; approval route NOT implemented in 4K. |
| 7 | Design the approval refusal responses, do not implement in 4K | Enumerated in [SCHEMA-DESIGN.md §9](PHASE-D-4K-SCHEMA-DESIGN.md) + preserved in the 6D-4J architecture reference. No API code shipped. |

Specific correction: the 6D-4J §7.2 table had `ARCHIVED` listed as an eligible state for displaying an authoritative "Correct" label. Per founder directive "Do not make `ARCHIVED` an automatic eligibility condition", the design doc + the column comment both now state explicitly that the **presence of a non-null `verifiedCorrectAnswerSnapshotJson` is the only eligibility signal**; state alone (ARCHIVED or otherwise) is not sufficient.

---

## 3. Deliverables

| Deliverable | Location | Status |
|---|---|---|
| `PHASE-D-4K-SCHEMA-DESIGN.md` | [docs/training/ai-generation/PHASE-D-4K-SCHEMA-DESIGN.md](PHASE-D-4K-SCHEMA-DESIGN.md) | DELIVERED |
| `PHASE-D-4K-ACCEPTANCE.md` | this file | DELIVERED |
| SQLite migration SQL | `prisma/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` | DELIVERED |
| Postgres deployment migration SQL | `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` | DELIVERED |
| `prisma/schema.prisma` additions | 3 models + 3 nullable columns + 4 back-relation arrays | DELIVERED |
| `prisma-postgres/schema.prisma` mirror | Same | DELIVERED |
| Isolated Postgres 16 integration evidence | `scratchpad/ep-train-6d4k/postgres-negative-controls.sql` + `postgres-negative-controls-output.txt` | DELIVERED (all 11 controls PASS + 3 structural extras) |
| Minimal-baseline migration replay | `scratchpad/ep-train-6d4k/migration-replay-minimal-baseline.sql` + verified PASS | DELIVERED |
| Reference rollback script | `scratchpad/ep-train-6d4k/down-migration.sql` + verified full up→down cycle | DELIVERED |
| Explicit rollback + compatibility analysis | [SCHEMA-DESIGN.md §7](PHASE-D-4K-SCHEMA-DESIGN.md) | DELIVERED |

---

## 4. Test evidence summary

### 4.1 Prisma validation

Both schemas validated:
- `npx prisma validate` → `The schema at prisma\schema.prisma is valid`.
- `npx prisma validate --schema prisma-postgres/schema.prisma` → `The schema at prisma-postgres\schema.prisma is valid`.

### 4.2 Isolated Postgres 16

Docker image `postgres:16-alpine` (digest `sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab`). Container `spectre-6d4k-pg` on port 15432, credentials `spectre:test`, database `spectre_6d4k`. Disposable — torn down after reporting.

Three independent passes:

1. **End-to-end schema materialisation** via `prisma db push` from `prisma-postgres/schema.prisma`. Done in 20.4s. All 3 new tables + columns + FKs + indexes + CHECK constraints materialised with exact expected shapes.
2. **Migration SQL replay** on a minimal baseline (`Club + TrainingCourse + TrainingCourseVersion + TrainingQuestionAiDraft + TrainingQuestionAiValidation`). Applied `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` directly via psql, zero errors, final inventory 8 tables (3 new).
3. **Rollback cycle** via `scratchpad/ep-train-6d4k/down-migration.sql`. Returns the DB byte-identical to the minimal baseline (5 tables, zero new columns, no orphan FKs).

### 4.3 Negative-control suite — 11/11 PASS

Captured output in `scratchpad/ep-train-6d4k/postgres-negative-controls-output.txt`. Every control from the directive's list fires at the DB level where the DB can enforce it; gaps requiring service-layer enforcement are enumerated explicitly in [SCHEMA-DESIGN.md §6](PHASE-D-4K-SCHEMA-DESIGN.md) with a per-row target slice (4L / 4M / 4N).

---

## 5. Unresolved integrity gaps — documented, not silently missed

Three guarantees that the DB cannot enforce at this slice; each one is explicitly flagged with its target slice:

| Gap | Target slice | Reason |
|---|---|---|
| Row-level cross-tenant match (e.g. segment.clubId ≠ build.clubId within a single row) | 4L (ingest service) | Prisma does not support composite FKs that pin `(clubId, buildId)` as a single reference; the ingest service checks at write time. |
| Projection sha256 drift between draft's scalar hash and FK target | 4M (read service) | DB stores both independently; the read service verifies equality on every detail-page render. Mismatch surfaces as 500-class evidence-integrity failure. |
| Reviewer approval route refusals (missing `verifiedCorrectAnswerIndex`, out-of-range, text mismatch) | 4N (approval route) | DB accepts any TEXT; the API enforces shape + contents. |

These gaps are honest limitations of DB-level enforcement, not implementation defects. 4L / 4M / 4N each close exactly one.

---

## 6. Commit

Target branch: `ep-train-6d-4k/schema-foundation` (local, not pushed).

Files committed:

- `prisma/schema.prisma` (modified — AI-review additions)
- `prisma/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` (new)
- `prisma-postgres/schema.prisma` (modified — same additions in PG dialect)
- `prisma-postgres/migrations/20261105_ep_train_6d_4k_transcript_evidence/migration.sql` (new)
- `docs/training/ai-generation/PHASE-D-4K-SCHEMA-DESIGN.md` (new)
- `docs/training/ai-generation/PHASE-D-4K-ACCEPTANCE.md` (new)

Files intentionally NOT committed (project convention — `scratchpad/` is gitignored and stays session-local):

- `scratchpad/ep-train-6d4k/postgres-negative-controls.sql` — integration-test harness; verbatim contents reproduced in [PHASE-D-4K-SCHEMA-DESIGN.md §5.4](PHASE-D-4K-SCHEMA-DESIGN.md) so the reproducer can be rebuilt from the design doc.
- `scratchpad/ep-train-6d4k/postgres-negative-controls-output.txt` — captured psql PASS output; results summarised in §4.3 of this document.
- `scratchpad/ep-train-6d4k/migration-replay-minimal-baseline.sql` — minimal baseline SQL for the replay test.
- `scratchpad/ep-train-6d4k/down-migration.sql` — reference manual rollback script.

Commit SHA will be captured in the final report accompanying this document.

**No push to origin.** 4K is local-only until founder acceptance.

---

## 7. STOP boundaries re-stated (and honoured)

Per directive:

- ✅ No staging or production database migration. The migration.sql exists on disk; it has NOT been executed against a Neon or Fly database.
- ✅ No API route added.
- ✅ No UI change shipped.
- ✅ No Modal/Qwen inference or transcription performed.
- ✅ No historical candidate mutated. The eight 6D-4H candidates on staging are byte-identical.
- ✅ No approval, editing, rejection, or publication performed.
- ✅ No new RBAC permission grant. `hr:training:ai:read` unchanged; no `hr:training:transcription:write` grant exists yet (reserved for 4L).
- ✅ No DRH-1 deployment triggered.
- ✅ 126 unrelated working-tree files preserved via `git stash push -u` on `staging-deploy/web1b1-framer-fidelity`; will be popped back onto that branch after the 4K commit is complete.

---

## 8. Proposed 4L implementation boundary — for founder review

Per directive §"Report … the proposed 4L implementation boundary":

**Scope of 4L (write-path only, no UI):**

- `src/lib/hr/training/transcription/ingest.ts` — new service module with three functions:
  - `persistTranscriptBuild(principal, clubId, input)` — upsert by the three-part key; refuse to mutate an existing row.
  - `persistTranscriptSegments(principal, clubId, buildId, input)` — `createMany skipDuplicates`; drift-detection comparing text for any pre-existing matching row; hard 500 on text disagreement.
  - `persistGroundingProjection(principal, clubId, input)` — upsert by `(clubId, courseVersionId, sha256)`; server-side recomputation of the canonical sha256 from `passagesJson`; refuses if client-supplied hash disagrees.
- `src/lib/permissions.ts` — add `hr:training:transcription:write` permission, granted ONLY to SUPER_ADMIN + CLUB_ADMIN. No other role gets it.
- `src/lib/audit.ts` emissions — new action strings: `training.transcript.build.ingested`, `training.transcript.segment.ingested`, `training.grounding.projection.ingested`.
- Contract tests covering the three functions, including:
  - Tenant-scoped reads/writes; cross-tenant refusal.
  - Idempotency on re-ingest.
  - Tamper detection (text drift) → hard 500.
  - Projection sha256 server-recompute vs client-supplied hash mismatch.

**NOT in 4L:**

- The worker that CALLS these services (pulls from a signed Modal job output). That's a separate worker-wiring slice.
- Reader surface (segment-body rendering on the manager review page). That's 4M.
- Approval-route `verifiedCorrectAnswerIndex` enforcement. That's 4N.
- Historical backfill of the eight 6D-4H candidates from scratchpad data. That's 4O (deferred; separately authorised; not scheduled).

4L requires separate founder authorisation. Do not initiate.

---

## 9. Next action

Awaiting founder acceptance of:
1. The three-table correction surfaced in §1 above (vs the 6D-4J two-table architecture).
2. The committed schema + migration + evidence on the local `ep-train-6d-4k/schema-foundation` branch.
3. The proposed 4L implementation boundary in §8 above.

On acceptance:
- Push `ep-train-6d-4k/schema-foundation` to origin (NOT merged into main or staging-deploy).
- Hold schedule for 4L. No DRH-1 deploy. No staging migrate.

On rejection:
- Revert the three-table shape to the original 6D-4J two-table shape by moving transcriber metadata back onto `TrainingTranscriptSegment` + dropping `TrainingTranscriptBuild`. Same branch, additive commits.

STOPPED.
