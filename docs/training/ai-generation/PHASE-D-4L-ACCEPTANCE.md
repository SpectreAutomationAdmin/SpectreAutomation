# EP-TRAIN-6D-4L — Acceptance

**Slice:** EP-TRAIN-6D-4L — Authenticated Transcript Evidence Ingestion Services.
**Status:** Offline implementation DELIVERED on branch `ep-train-6d-4l/ingestion-services` (based on accepted 4K commit `cd743a7c`). No staging or production touched. Awaiting founder acceptance.

**Baseline:**
- Parent 4K commit: `cd743a7cf8e38065e2f5f4e4271491c659d87e6a` on `ep-train-6d-4k/schema-foundation` (pushed to origin per founder authorisation).
- Deployed staging (unchanged by this slice): Fly v1095 / `sha-5e60fa59894f`.

**Companion:** [PHASE-D-4L-INGESTION-DESIGN.md](PHASE-D-4L-INGESTION-DESIGN.md).

---

## 1. What this slice delivered

Three write-boundary service functions + supporting infrastructure:

- `persistTranscriptBuild(principal, clubId, input)` — idempotent upsert of a transcription-run row.
- `persistTranscriptSegments(principal, clubId, buildId, input)` — bulk immutable segment insert with per-segment drift detection.
- `persistGroundingProjection(principal, clubId, input)` — idempotent projection upsert with server-side canonical sha256 recompute + segment-membership validation.

Plus:

- New permission `hr:training:transcription:write` added to the catalogue. **No role holds it.**
- 26 SQLite contract tests covering input validation + service shape + idempotency + audit emission — 26/26 PASS.
- 16 real-Postgres-16 integration scenarios covering CHECK constraints, SERIALIZABLE isolation, P2002 concurrent-write retry, transaction atomicity, cross-tenant 404 shape — 16/16 PASS.
- Reset-order update to `tests/util/db.ts` so the shared SQLite harness unwinds cleanly with the three new 4K tables.
- `runWithUniqueRetry` utility — handles P2002 unique-violation races between concurrent identical writers and converges to `created: false` on the losing side.

Nothing else. No API route. No UI code. No worker. No inference. No role grant. No audit backfill. No historical candidate mutated.

---

## 2. Founder directive reconciliation

| Directive requirement | Where honoured |
|---|---|
| Three services (`persistTranscriptBuild`, `persistTranscriptSegments`, `persistGroundingProjection`) | [ingest.ts](../../../src/lib/hr/training/transcription/ingest.ts) |
| Existing service architecture + Prisma transaction conventions | `$transaction` + `runWithUniqueRetry` + typed errors via `AppError` subclasses; audit outside the tx per CLAUDE.md non-blocking-audit pattern. |
| Provenance binding: tenant, course, course-version, source-video SHA, stable transcription-run identity, canonical content hash, creation/authorization metadata | Every service verifies the full chain in-transaction; `canonicalise` + `sha256Hex` reused from the 6D-4B helper; `producedAt` + transcriber metadata on the build row. |
| Do not trust client-supplied hashes without recomputation | `persistGroundingProjection` recomputes server-side; refuses on disagreement. `clientSuppliedSha256` is optional and advisory. |
| Do not use a model explanation as authoritative transcript evidence | 4L services never read `draftJson.explanation`. Documented in [ingest.ts](../../../src/lib/hr/training/transcription/ingest.ts) comment block + design doc §4. |
| Tenant isolation inside transactional write boundary | Ownership chain check (version → course → club) runs INSIDE the tx. Verified by SQLite test "rejects cross-tenant courseVersion" + PG harness T1. |
| Reject mismatched references | SQLite tests (NOT_FOUND / VALIDATION / CONFLICT) + PG harness T1–T3, T7, T16. |
| Composite database constraints where feasible without an unauthorised schema change | 4K's unique indexes + CHECK constraints — no 4L schema change. 4K's composite unique keys enforce the identity invariants. |
| All failures leave zero partial records | Verified by SQLite tests + PG harness T11 (mid-batch tamper leaves zero new rows). |
| Immutability + idempotency guarantees — identical retries no-op; conflicting retries fail; immutable evidence never overwritten; concurrent requests tested against actual PostgreSQL | Real-PG harness T5 (build idempotency + drift), T6 (segment idempotency + drift), T9 (projection idempotency), T10 (concurrent-write collapse via P2002 retry). |
| Segment timestamps finite, non-negative, correctly ordered | Pre-validation + DB-level CHECK constraints (T4). |
| Duplicate / contradictory segment indices rejected | SQLite test + PG harness T6. |
| Grounding projections reference only segments on their authorised build | Service validates presence of every cited segmentIndex on the target build (PG harness T7). |
| Canonical ordering deterministic | `canonicalise` from content-hash.ts; "extra" harness test proves server sha256 matches a reconstructed canonical value. |
| Trust classification preserved | §4 of design doc + harness T13 (segments 16/17 refused) + T14 (4L never writes verified-answer snapshot). |
| Do not promote the eight historical candidates to trusted evidence | 4L services never touch `TrainingQuestionAiDraft` / `TrainingQuestionAiValidation`. Historical row count stays at zero in both test surfaces. |
| Segments 16/17 excluded from eligible grounding | `EXCLUDED_SEGMENT_INDICES` hard-coded; `persistGroundingProjection` refuses any passage citing them. |
| Add `hr:training:transcription:write` to permission catalogue; do NOT grant to CLUB_ADMIN / SUPER_ADMIN / any role | Added to `src/lib/permissions.ts` line 310. Checked: no `"hr:training:transcription:write"` appears inside any `ROLE_PERMISSIONS[X]` entry. |
| Design for a future narrowly authorized ingestion identity | Documented in design doc §7 (worker integration contract) + permission comment block. |
| Do not introduce a new externally accessible endpoint | No API route added. Services are called in-process only; a future worker slice adds the entry point. |
| Audit record for consequential evidence writes | `audit()` call per successful service create. SQLite test + PG harness T15 confirm the audit record is written for creates + the audit sidecar failure never rolls back the primary row. |
| Where audit + state mutation must be atomic, use the same DB transaction | 4L's primary mutation IS the single evidence row — audit is post-commit and non-blocking per CLAUDE.md pattern. The 6D-4B `writeStateTransition` transactional-audit pattern applies to DRAFT lifecycle, not pre-draft evidence; those two surfaces have different atomicity requirements. Documented in service header block. |
| Do not rely solely on the existing non-throwing audit helper for transactional guarantees | The primary guarantee (immutable evidence row) is in-transaction. `audit()` is a supplementary, post-commit, non-blocking emission — exactly the CLAUDE.md pattern. |
| Never log credentials, DB connection strings, raw tokens, secret-bearing metadata | No secret columns on the new tables; audit meta payload only carries hashes + identifiers + counts. No `getRequestContext()` header forwarding changes. |
| Do NOT populate `verifiedCorrectAnswerSnapshotJson` | PG harness T14 + SQLite test verify this column stays NULL across every 4L code path. |
| Do not infer human verification from the presence of a snapshot field | Services never WRITE to this column; design doc §4N preamble documents the required 4N contract. |
| Document that 4N must require qualified reviewer, exact immutable draft/hash binding, server-side eligibility checks | Design doc §9 (4M dependencies) + §4K's docs still point at the 4N contract (preserved verbatim). |
| Disposable PostgreSQL 16 for integration tests | `scratchpad/ep-train-6d4l/integration-test.ts` runs against disposable `postgres:16-alpine` on port 15433. |
| 14 directive-enumerated scenarios | All 14 covered in the PG harness (T1–T14), plus two structural extras (T15 audit sidecar isolation, T16 cross-build projection). |
| Distinguish tests performed with mocks from tests executed against real PostgreSQL | Explicitly split: SQLite contract suite (service shape, input validation, idempotent return shapes) vs real-PG harness (CHECK, SERIALIZABLE, P2002 concurrency, deployment path). Design doc §5.3. |
| Prisma validation, targeted regression tests, scoped typechecking, nav audit | ✅ `prisma validate` both schemas; ✅ 69/69 existing AI-review tests pass against the 4K-regenerated client (one pre-existing FORBIDDEN test fails on 4K baseline — pre-existing, not caused by 4L, documented in design doc §5.4); ✅ `tsc --noEmit` zero 4L-attributable errors; nav audit not applicable (no new navigable UI). |

---

## 3. Test evidence

### 3.1 SQLite contract — 26/26 PASS

```
 Test Files  1 passed (1)
      Tests  26 passed (26)
   Start at  11:08:10
   Duration  185.79s
```

### 3.2 Disposable Postgres 16 — 16/16 PASS

```
SUMMARY  pass=16 fail=0 total=16
```

Full PASS/FAIL table in [PHASE-D-4L-INGESTION-DESIGN.md §5.2](PHASE-D-4L-INGESTION-DESIGN.md).

### 3.3 Targeted regression — AI-review suites

```
 tests/ep-train-6d4b-ai-review-governance.test.ts   → 69 passed
 tests/ep-train-6d4d-read-service-contract.test.ts
 tests/training-ai-generation-grounding.test.ts
 tests/ep-train-6d4d-real-db-integration.test.ts    → 3 passed + 1 pre-existing failure
```

The one failing test (`tests/ep-train-6d4d-real-db-integration.test.ts :: "without hr:training:ai:read, listCandidates throws FORBIDDEN"`) is a pre-existing regression on the 4K baseline, caused by EP-TRAIN-6D-4G's CLUB_ADMIN grant for `hr:training:ai:read`. Independently verified on the 4K parent commit. Not caused by 4L; not fixed by 4L per Targeted Validation discipline.

### 3.4 Prisma validate + typecheck

```
The schema at prisma\schema.prisma is valid 🚀
The schema at prisma-postgres\schema.prisma is valid 🚀
tsc --noEmit                   → zero 4L-attributable errors
```

---

## 4. Unresolved integrity gaps — deferred to later slices

| Gap | Target slice |
|---|---|
| Projection sha256 reconciliation at read time (`draft.groundingProjectionSha256 === projection.sha256`) | 4M (read service) |
| Cited-segment resolution for the manager review UI | 4M |
| Click-to-seek video player | 4M |
| Answer-label correction (emerald "Correct" rule) | 4M |
| Approval-route `verifiedCorrectAnswerIndex` enforcement + writes to `verifiedCorrectAnswerSnapshotJson` | 4N |
| Worker that calls these services + its role + its signed-Modal integration | separate authorised worker slice |
| Historical backfill of the eight 6D-4H candidates from scratchpad data | 4O (deferred, separately authorised) |

Each gap is honestly surfaced; none is a 4L defect.

---

## 5. Commit

Target branch: `ep-train-6d-4l/ingestion-services` (local). Based on `ep-train-6d-4k/schema-foundation` (parent SHA `cd743a7c`).

Files committed:

- `src/lib/hr/training/transcription/ingest.ts` (new)
- `src/lib/hr/training/transcription/index.ts` (new)
- `src/lib/permissions.ts` (modified — permission catalogue entry)
- `tests/ep-train-6d4l-transcription-ingest-contract.test.ts` (new)
- `tests/util/db.ts` (modified — resetDb deletion order)
- `docs/training/ai-generation/PHASE-D-4L-INGESTION-DESIGN.md` (new)
- `docs/training/ai-generation/PHASE-D-4L-ACCEPTANCE.md` (new)

Files intentionally NOT committed (scratchpad convention, gitignored):

- `scratchpad/ep-train-6d4l/integration-test.ts` — real-PG harness; sixteen scenarios enumerated verbatim in [PHASE-D-4L-INGESTION-DESIGN.md §5.2](PHASE-D-4L-INGESTION-DESIGN.md).
- `scratchpad/ep-train-6d4l/integration-test-output.txt` + `integration-test-result.json` — captured PASS evidence.
- `scratchpad/ep-train-6d4l/schema.prisma` + `scratchpad/ep-train-6d4l-pg-client/` — PG-flavoured Prisma schema + generated client used only to exercise the service code against a PG database.

**No push to origin.** 4L is local-only until founder acceptance.

---

## 6. STOP boundaries re-stated (and honoured)

- ✅ No staging or production migration.
- ✅ No API routes.
- ✅ No UI changes.
- ✅ No Modal/Qwen inference.
- ✅ No worker activation.
- ✅ No historical candidate modification.
- ✅ No approval, editing, rejection, or publication.
- ✅ No new role grants (permission catalogue only).
- ✅ No DRH-1 deployment.
- ✅ 126 unrelated WIP files preserved via `git stash push -u` on `staging-deploy/web1b1-framer-fidelity`; stash pop after 4L commit lands cleanly.

STOPPED.
