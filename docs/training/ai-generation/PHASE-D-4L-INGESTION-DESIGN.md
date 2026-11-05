# EP-TRAIN-6D-4L — Authenticated Transcript Evidence Ingestion Services

**Status:** Offline implementation DELIVERED on branch `ep-train-6d-4l/ingestion-services` (based on 4K commit `cd743a7c`). No staging or production touched. No ingest worker wired. No API route added. No UI change. No historical candidate mutated.

**Scope:** server-side write-boundary services only. Three service functions, one new permission catalogue entry (no role grants), SQLite contract tests + disposable Postgres 16 integration evidence, and a documented integration contract for a future transcription worker.

**Companion:** [PHASE-D-4L-ACCEPTANCE.md](PHASE-D-4L-ACCEPTANCE.md).

---

## 1. Summary of deliverables

| Deliverable | Location |
|---|---|
| `persistTranscriptBuild` service | [src/lib/hr/training/transcription/ingest.ts](../../../src/lib/hr/training/transcription/ingest.ts) |
| `persistTranscriptSegments` service | same file |
| `persistGroundingProjection` service | same file |
| Barrel export | [src/lib/hr/training/transcription/index.ts](../../../src/lib/hr/training/transcription/index.ts) |
| New permission catalogue entry | [src/lib/permissions.ts](../../../src/lib/permissions.ts) (`hr:training:transcription:write`). **No role currently holds this permission.** |
| SQLite contract suite (26 tests) | [tests/ep-train-6d4l-transcription-ingest-contract.test.ts](../../../tests/ep-train-6d4l-transcription-ingest-contract.test.ts) |
| Disposable Postgres 16 integration harness (16 scenarios) | `scratchpad/ep-train-6d4l/integration-test.ts` (session-scratchpad; reproducer reproduced verbatim in §5 of this doc) |
| Captured harness output | `scratchpad/ep-train-6d4l/integration-test-output.txt` + `integration-test-result.json` (summary PASS/FAIL JSON) |
| `tests/util/db.ts` resetDb — three new table deletions added so the shared SQLite harness unwinds cleanly | required for 4L SQLite tests to coexist with other suites |

All three services are strictly WRITE-boundary code. None of them queries for reader surfaces (that's 4M); none of them write to `TrainingQuestionAiDraft`, `TrainingQuestionAiValidation`, or any pre-4K AI-review table.

---

## 2. Architecture

### 2.1 Service entry points

```
persistTranscriptBuild(principal, clubId, input)      → { build, created }
persistTranscriptSegments(principal, clubId, buildId,
                          { expectedResolvedTranscriptBuildId,
                            segments[] })             → { created, idempotentSkipped,
                                                          segmentIndices[] }
persistGroundingProjection(principal, clubId, input)  → { projection, created, sha256 }
```

Every function:

1. **Validates input synchronously** before any DB round-trip (pre-transaction gate).
2. **Opens a Prisma `$transaction`** and performs the entire ownership chain + idempotency check + write INSIDE the tx.
3. **Runs the transaction inside `runWithUniqueRetry`** — a one-shot retry on Prisma's `P2002` unique-violation code so that concurrent identical writers converge on `created: false` rather than one of them raising.
4. **Emits a post-commit `audit()` record** when `created === true`. The audit sidecar is deliberately OUTSIDE the transaction: an audit failure never rolls back the primary evidence row (CLAUDE.md pattern, preserved).

### 2.2 The three-table write surface

Composed on the 4K tables (unchanged):

- `TrainingTranscriptBuild` — one row per deterministic transcription run (keyed on `(clubId, sourceVideoSha256, resolvedTranscriptBuildId)`).
- `TrainingTranscriptSegment` — one row per segment of a build; CHECK constraints enforce `segmentIndex >= 0` and `startSec >= 0 AND endSec >= startSec`.
- `TrainingGroundingProjection` — one row per immutable projection subset authorised for generation (keyed on `(clubId, courseVersionId, sha256)`).

### 2.3 Ownership chain

Every service performs the full chain in-transaction:

```
TrainingCourseVersion → course.clubId == input.clubId      (tenant match)
                     → videoSha256 == input.sourceVideoSha256 (video match)
TrainingTranscriptBuild        → clubId + sourceVideoSha256 + resolvedTranscriptBuildId
                                 (unique, idempotent)
TrainingTranscriptSegment      → clubId + transcriptBuildId + segmentIndex
                                 (unique, drift-detected on content mismatch)
TrainingGroundingProjection    → clubId + courseVersionId + sha256
                                 (unique, idempotent on identical body)
```

Service-layer checks go beyond DB uniqueness:

- `expectedResolvedTranscriptBuildId` (on `persistTranscriptSegments`) must equal the build's stored `resolvedTranscriptBuildId` — defence-in-depth against a stale buildId passed from a caller whose cache is out of date.
- `clientSuppliedSha256` (on `persistGroundingProjection`, optional) is recomputed server-side from the canonical projection body; disagreement raises `ConflictError`. The server's recomputed value is the authoritative identity.
- Projection passages that cite segment indices in `EXCLUDED_SEGMENT_INDICES` (16 and 17 — per the EP-TRAIN-6C pilot authorisation + founder directive) are refused unconditionally.
- Projection passages that cite segment indices which do not exist on the transcript build are refused.

### 2.4 Canonical hashing

The canonical JSON + SHA-256 helpers are reused from [src/lib/hr/training/ai-review/content-hash.ts](../../../src/lib/hr/training/ai-review/content-hash.ts) — the same helpers used by the 6D-4B draft-content-hash path + the Modal server-side canonicaliser. This guarantees `TrainingGroundingProjection.sha256` matches the SHA-256 a Modal generator would compute from the same body.

### 2.5 Concurrent-write retry

```
runWithUniqueRetry(fn):
  try fn()
  on P2002 → try fn() again      # losing side's second attempt sees the winner
  on repeat P2002 → propagate    # genuine corruption, not a legitimate race
```

Proven in the real-Postgres harness (§5, T10): three parallel identical writers converge to exactly one row with `created: true`, with the losing sides returning `created: false` via the retry's second-attempt `findUnique`.

---

## 3. Permission + authorisation

New permission: **`hr:training:transcription:write`**.

Added to the catalogue ONLY. **No role currently holds this permission.** The permission reserves a target for a future narrowly-authorised ingestion identity (e.g. a signed-worker service principal), to be wired in a separately-authorised slice.

- Not granted to CLUB_ADMIN.
- Not granted to SUPER_ADMIN by name.
- No employee / manager / CONTROLLER / payroll grants.

`requirePermission` is called at the top of every service AND re-checked inside the transaction (defence-in-depth against a principal-mutation race between validation and write).

**Who can call these services today?** Only a SUPER_ADMIN, because SUPER_ADMIN auto-passes every permission check via the `isSuperAdmin()` shortcut in `rbac.ts`. All other roles raise `ForbiddenError` (HTTP 403). A `null` principal raises `UnauthenticatedError` (HTTP 401).

This matches the directive's instruction: *"Design for a future narrowly authorized ingestion identity. Do not introduce a new externally accessible endpoint."*

---

## 4. Trust classification

Preserved from 4J / 4K, verified by both test surfaces:

| Class | Signal | 4L behaviour |
|---|---|---|
| **Authoritative transcript evidence** | New rows written by 4L; FK back to a real `TrainingCourseVersion.videoSha256`; canonical SHA-256 recomputed server-side | Written by `persistTranscriptBuild` + `persistTranscriptSegments` + `persistGroundingProjection` with all ownership + integrity checks. |
| **Historical pilot evidence** | Eight 6D-4H candidates with `groundingProjectionSha256 LIKE 'fixture-%'` AND `groundingProjectionId IS NULL` | **4L does NOT touch**. The three services never write to `TrainingQuestionAiDraft` or `TrainingQuestionAiValidation`. Historical drafts retain their original treatment. |
| **Fixture placeholders** | Projection sha starts with `fixture-` | **4L refuses** — `assertHexSha256` rejects anything other than a 64-char lowercase hex string at input validation. |
| **Unverified model explanations** | `draftJson.explanation` string | **4L never consumes this field**. The `explanation` is a model self-report on the Lite draft; 4L's services take transcript text / projection passages from caller-supplied inputs that must originate from the deterministic transcription + projection prep pipelines, not from a generator's self-explanation. |
| **Unverified segment indices (16, 17)** | Hard-coded in `EXCLUDED_SEGMENT_INDICES` | **4L refuses** — any projection that cites 16 or 17 raises `ValidationError` before reaching the DB. |

---

## 5. Test evidence

### 5.1 SQLite contract suite — 26/26 PASS

`tests/ep-train-6d4l-transcription-ingest-contract.test.ts` — runs against the shared SQLite template DB via `tests/util/db.ts`.

Three describe blocks, one per service. Covered:

**persistTranscriptBuild (10 tests):**
- UNAUTHENTICATED on null principal
- FORBIDDEN on principal without the permission
- VALIDATION on bad hex / bad id-shape / invalid Date
- NOT_FOUND on cross-tenant courseVersion
- VALIDATION on video-SHA mismatch
- Successful create + `created: true`
- Idempotent retry (same identity) → `created: false`, same row id
- CONFLICT on drift (same identity, different transcriber version)
- AuditLog row written on `created: true`, with non-sensitive metadata only
- No AuditLog row on idempotent retry

**persistTranscriptSegments (9 tests):**
- VALIDATION on empty batch
- VALIDATION on intra-batch duplicate `segmentIndex`
- VALIDATION on `endSec < startSec`
- VALIDATION on negative `startSec`
- NOT_FOUND on cross-tenant buildId
- CONFLICT on `expectedResolvedTranscriptBuildId` disagreement
- Successful bulk create with correct return shape
- Cross-call idempotent retry (`created: 0`, `idempotentSkipped: 3`)
- CONFLICT on drift (same index, different text) — zero mutation

**persistGroundingProjection (7 tests):**
- VALIDATION on excluded segment 16 + 17 citations
- VALIDATION on passages citing out-of-build segments
- CONFLICT on `clientSuppliedSha256` disagreement
- VALIDATION when the build row doesn't exist yet
- Successful create + server-computed SHA-256
- Idempotent retry
- 4L never writes `TrainingQuestionAiValidation` rows (verified-correct snapshot is NEVER populated by 4L)

### 5.2 Disposable Postgres 16 harness — 16/16 PASS

Container: `postgres:16-alpine` (digest `sha256:0cefaabd...`), `localhost:15433`, disposable.

Full harness source at `scratchpad/ep-train-6d4l/integration-test.ts`. Reproducer, verbatim summary:

```
  PASS  T1  tenant ownership — rejects cross-tenant courseVersion
  PASS  T2  course/version ownership — rejects nonexistent courseVersion
  PASS  T3  video SHA mismatch — rejects when input video sha differs
  PASS  T4  segment CHECK constraints — raw insert with endSec<startSec rejected by DB
  PASS  T5  duplicate build identity — idempotent on identical; ConflictError on drift
  PASS  T6  duplicate segment identity — intra-batch dup rejected; cross-call idempotent; drift ConflictError
  PASS  T7  projection membership — passages citing out-of-build segments rejected
  PASS  T8  hash tampering — clientSuppliedSha256 ≠ server recompute raises ConflictError
  PASS  T9  idempotent projection retries — identical body → created=false
  PASS  T10 concurrent writes — simultaneous identical persistTranscriptBuild collapse to 1 row
  PASS  T11 transaction rollback — mid-batch tamper leaves zero new rows
  PASS  T12 unauthorised ingestion — principal without permission is 403; null principal is 401
  PASS  T13 historical fixture isolation — segment indices 16/17 refused from projections
  PASS  T14 verified-answer snapshot — 4L never writes TrainingQuestionAiValidation rows
  PASS  T15 audit sidecar isolation — audit failure must NOT roll back the primary evidence row
  PASS  T16 cross-build projection — rejects when build is not yet ingested

SUMMARY  pass=16 fail=0 total=16
```

Notable differences between the two harnesses, honestly surfaced:

- **CHECK constraints (T4) only exist under `prisma migrate deploy`, not `prisma db push`.** The harness explicitly applies the CHECK constraints via raw SQL post-push to mirror the production deployment reality. Documented in `scratchpad/ep-train-6d4l/integration-test.ts :: resetSchema()`.
- **Audit sidecar (T15) runs against the default SQLite-bound Prisma client**, which rejects PG URLs. The sidecar swallows the error via `audit()`'s own try/catch (by design). T15 asserts the primary evidence row persists regardless — the audit sidecar failure is a harness artifact, not a service defect. The SQLite contract suite's T9 (`writes an AuditLog row on created=true`) covers the positive audit-emission path.

### 5.3 Distinguish mocks from real Postgres

Per directive:

- **Mocks / SQLite-backed:** `tests/ep-train-6d4l-transcription-ingest-contract.test.ts`. Runs via the shared vitest harness with the project's SQLite template DB. Covers service-level business logic that does NOT depend on PostgreSQL-specific semantics.
- **Real PostgreSQL 16:** `scratchpad/ep-train-6d4l/integration-test.ts`. Runs against an isolated Postgres 16 container. Covers CHECK-constraint firing, SERIALIZABLE transaction isolation, P2002 concurrent-write retry, and the deployment-path CHECK application.

### 5.4 Pre-existing regression outside 4L scope

`tests/ep-train-6d4d-real-db-integration.test.ts :: "without hr:training:ai:read, listCandidates throws FORBIDDEN"` fails on the 4K baseline (verified independently). The failure is a consequence of EP-TRAIN-6D-4G's CLUB_ADMIN grant for `hr:training:ai:read` — the test's setup "principal does not hold the permission" no longer holds for a CLUB_ADMIN. This is a pre-existing defect on the acceptance line and is NOT caused by 4L. Per CLAUDE.md Testing Strategy, 4L does not fix it; the regression is reported here so the next slice (or a dedicated fix) can address it with proper authorisation.

### 5.5 Prisma validation + typecheck

- `npx prisma validate` → both `prisma/schema.prisma` and `prisma-postgres/schema.prisma` valid.
- `npx prisma generate` → client regenerated successfully; new models + columns present (2283 references to `TrainingTranscriptBuild` in generated types).
- `npx tsc --noEmit` → zero 4L-attributable errors. Pre-existing errors in unrelated services unchanged.

---

## 6. Explicit unresolved dependencies for 4M

The next slice (4M — reader surface) must close the following gaps, which 4L deliberately does not touch:

1. **Projection sha256 reconciliation at read time.** 4L computes the sha256 server-side on write; 4M must assert `TrainingQuestionAiDraft.groundingProjectionSha256 === TrainingGroundingProjection.sha256` on every detail-page render for drafts that carry a non-null `groundingProjectionId`. A mismatch is a 500-class evidence-integrity failure, surfaced to the reviewer with a safe copy string (never raw hash values on-screen outside the collapsible technical-provenance footer).
2. **Cited-segment resolution.** 4M calls `TrainingTranscriptSegment.findMany` for each draft's `sourceSegmentIds`, scoped by `(clubId, sourceVideoSha256, resolvedTranscriptBuildId)` + the segment's membership in the projection's `passagesJson`. Segments that are excluded by authorisation (16/17) or absent from the projection are rendered with the dedicated "unavailable" callouts enumerated in 4J §8.3 — not fabricated.
3. **Historical-candidate differentiation.** 4M's read DTO branches on `groundingProjectionId IS NULL`: null means "historical pilot evidence" (the eight 6D-4H candidates); non-null means the full 4L-ingested evidence chain. The reader UI's amber "Imported from a historical pilot" treatment is preserved for null-FK rows.
4. **Click-to-seek video player.** The existing video proxy route takes `?startSec=…&endSec=…` query parameters; 4M wires the UI side. No new API route.
5. **Answer-label correction** (founder finding 2026-11-05, documented in 4J §7). Emerald + "Correct" ONLY on `APPROVED_DRAFT` / `ARCHIVED` with a non-null `verifiedCorrectAnswerSnapshotJson` (which 4L deliberately never populates — that lands in 4N).

---

## 7. Proposed integration contract for a future transcription worker

### 7.1 Worker scope

A future "transcription worker" slice will:

- Poll a signed Modal job output (OUT-OF-REPO; signed per Spectre's pilot authorisation pattern).
- Call `persistTranscriptBuild` to record the transcription-run metadata.
- Call `persistTranscriptSegments` with the segment array (the worker is the SOLE legitimate caller that holds segment text + startSec + endSec from faster-whisper).
- Call `persistGroundingProjection` once the Modal job emits an authorised projection subset.

The worker runs as a dedicated **service principal** — NOT an interactive user. No HR role grants are touched to grant it the permission; instead, the worker's principal holds `hr:training:transcription:write` DIRECTLY via a new role (e.g. `TRANSCRIPTION_WORKER`) with only this one permission. Role addition is a future slice's scope, not 4L.

### 7.2 Contract the worker must respect

1. **Submit the three writes in topological order**: build → segments → projection. The projection service refuses when the build or any cited segment is missing.
2. **Treat all three services as idempotent**. A worker restart MUST retry the exact same payloads; the services return `created: false` on a retry and do not mutate the stored row.
3. **Do not pass model-emitted explanation text**. The Lite draft's `explanation` field is a model self-report; it is NOT authoritative transcript evidence. The worker's inputs to `persistTranscriptSegments` MUST originate from the deterministic transcription output's segment array, not from a generator's narrative.
4. **Compute the projection's canonical sha256 client-side as a preflight**; pass it as `clientSuppliedSha256`. The service recomputes server-side and raises `ConflictError` on disagreement. This surfaces worker-side canonicalisation bugs loudly and immediately.
5. **Never attempt to write to `TrainingQuestionAiDraft` or `TrainingQuestionAiValidation`**. That's 4M (read) and 4N (approval) territory. The worker's write surface is strictly the three 4L services.
6. **Scrub credentials from inputs before calling**. The worker passes `transcriberConfigSha256` (a hash) — never the raw config JSON, never the signed-authorisation token, never Modal credentials. The service's audit() meta payload never contains credential-bearing fields.

### 7.3 Error handling the worker must perform

| 4L raises | Worker action |
|---|---|
| `UNAUTHENTICATED` / `FORBIDDEN` | STOP. Permission mis-configuration. Operator action required. |
| `VALIDATION` | STOP. Worker-side bug — the deterministic pipeline shouldn't produce invalid input. Alert + preserve the failing payload. |
| `NOT_FOUND` on courseVersion | Retry ONCE with a 5-minute backoff (course version may be mid-creation). On second NOT_FOUND, STOP. |
| `CONFLICT` on build drift | STOP. Two different workers believe the same `resolvedTranscriptBuildId` has different metadata. Alert. |
| `CONFLICT` on segment drift | STOP. Same reason. |
| `CONFLICT` on hash tamper | STOP. Worker canonicalisation differs from server's. Fix the worker. |
| Any other error | Retry with bounded backoff. |

### 7.4 Observability the worker must emit

Per 4L audit emissions:

- `training.transcript.build.ingested` — emitted per successful build create.
- `training.transcript.segment.ingested` — emitted per successful segment batch create.
- `training.grounding.projection.ingested` — emitted per successful projection create.

A worker-side retry that results in `created: false` does NOT emit an audit row (by design — idempotent no-ops don't need a trail). The worker SHOULD emit its own `training.transcript.worker.cycle.completed` event with the three services' `created` / `idempotentSkipped` counts aggregated.

### 7.5 What the worker MAY NOT do without a new authorised slice

- Activate Modal / Qwen inference. 4L has no inference path.
- Deliver generated drafts to employees.
- Publish training.
- Grant its own permissions.
- Modify historical 6D-4H candidates.

---

## 8. Files touched by this slice

| Path | Change |
|---|---|
| `src/lib/hr/training/transcription/ingest.ts` | NEW — three service functions + validation + canonical helpers + P2002 retry |
| `src/lib/hr/training/transcription/index.ts` | NEW — barrel exports |
| `src/lib/permissions.ts` | modified — added `hr:training:transcription:write` to catalogue; NO role grants |
| `tests/ep-train-6d4l-transcription-ingest-contract.test.ts` | NEW — 26 SQLite contract tests |
| `tests/util/db.ts` | modified — added three new table deletions to `resetDb()` order |
| `docs/training/ai-generation/PHASE-D-4L-INGESTION-DESIGN.md` | NEW — this file |
| `docs/training/ai-generation/PHASE-D-4L-ACCEPTANCE.md` | NEW — companion acceptance doc |

Files intentionally NOT committed (scratchpad convention, gitignored):

- `scratchpad/ep-train-6d4l/integration-test.ts` — real-PG harness; its sixteen scenarios are enumerated verbatim in §5.2 of this doc so the reproducer is reconstructable.
- `scratchpad/ep-train-6d4l/integration-test-output.txt` + `integration-test-result.json` — captured PASS evidence; results summarised in §5.2.
- `scratchpad/ep-train-6d4l/schema.prisma` + `scratchpad/ep-train-6d4l-pg-client/` — a PG-flavoured Prisma schema + generated client used only to let the real-PG harness exercise the service code (which otherwise imports the SQLite-bound default client).

Nothing else changed. No service touched outside the new `transcription/` module. No API route. No UI code. No role seed. No RBAC grant. No documentation outside the 4L folder. The 126 unrelated WIP files on `staging-deploy/web1b1-framer-fidelity` are preserved (stashed, not touched).

---

## 9. STOP boundaries — all honoured

- No staging or production migration.
- No API routes.
- No UI changes.
- No Modal/Qwen inference.
- No worker activation.
- No historical candidate modification.
- No approval, editing, rejection, or publication.
- No new role grants (`hr:training:transcription:write` added to catalogue only).
- No DRH-1 deployment.
- 126 unrelated WIP files preserved via stash+pop cycle.
