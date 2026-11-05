# EP-TRAIN-6D-4M — Authenticated Evidence Reader & Answer Verification Presentation

**Status:** Offline implementation DELIVERED on branch `ep-train-6d-4m/evidence-reader` (based on accepted 4L commit `3d497097`). No staging or production touched. Awaiting founder acceptance.

**Scope:** replace the AI-review interface's transcript-evidence placeholders with an authenticated, tenant-scoped reader that renders authentic persisted segments; correct the answer-choice presentation so model predictions are never shown as verified facts; repair a pre-existing 4D RBAC regression test.

**Companion:** [PHASE-D-4M-ACCEPTANCE.md](PHASE-D-4M-ACCEPTANCE.md).

---

## 1. Summary of deliverables

| Deliverable | Location |
|---|---|
| Evidence reader service | [src/lib/hr/training/ai-review/evidence-reader.ts](../../../src/lib/hr/training/ai-review/evidence-reader.ts) |
| Server page wire-up | [src/app/app/admin/ai-training/review/persisted/page.tsx](../../../src/app/app/admin/ai-training/review/persisted/page.tsx) |
| Workspace UI — authentic-branch segment rendering + click-to-seek | [src/components/ai-training/PersistedReviewWorkspace.tsx](../../../src/components/ai-training/PersistedReviewWorkspace.tsx) |
| Answer-label presentation fix (neutral styling + "Model-selected · unverified" chip) | same file |
| 4D RBAC regression repair + negative controls | [tests/ep-train-6d4d-real-db-integration.test.ts](../../../tests/ep-train-6d4d-real-db-integration.test.ts) |
| Evidence-reader SQLite contract suite (13 tests) | [tests/ep-train-6d4m-evidence-reader-contract.test.ts](../../../tests/ep-train-6d4m-evidence-reader-contract.test.ts) |
| PersistedReviewWorkspace UI contract suite (8 tests) | [tests/ep-train-6d4m-workspace-ui.test.tsx](../../../tests/ep-train-6d4m-workspace-ui.test.tsx) |

No new API route. No UI redesign. No role grant. No historical candidate mutated. No new mutation path.

---

## 2. Architecture

### 2.1 Reader-service entry point

```
resolveCandidateEvidence(principal, clubId, draftId) : Promise<CandidateEvidence | null>
```

Returns one of three structural kinds + a null branch:

- `null` — the draft is not visible to this principal (cross-tenant / nonexistent). Caller maps to a 404 same-shape response.
- `kind: "authentic"` — the draft has a non-null `groundingProjectionId` FK, every integrity check passed, and cited segments are rendered authoritative.
- `kind: "historical-unavailable"` — the draft is a 6D-4H candidate (null FK, `fixture-*` placeholder). The UI renders the accepted "Historical evidence unavailable" treatment; NO segment text or timestamps are fabricated.
- `kind: "evidence-integrity-failure"` — any of the five integrity checks failed. Fail-closed.

The reader throws only `UNAUTHENTICATED` / `FORBIDDEN` via `EvidenceReaderError`. All other "evidence is not here / is broken" cases are structural branches, never exceptions.

### 2.2 Integrity checks (fail-closed)

1. **Draft belongs to clubId** — `TrainingQuestionAiDraft.findFirst({ id, clubId })`.
2. **Projection belongs to the same tenant + courseVersion** as the draft.
3. **Projection sha256 equals the draft's scalar `groundingProjectionSha256`** — `PROJECTION_HASH_MISMATCH_VS_DRAFT`.
4. **Server-recomputed canonical body sha256 equals the stored projection sha256** — `PROJECTION_HASH_MISMATCH_VS_RECOMPUTE`. The reader normalises the stored `passagesJson` to match 4L's writer-side default-filled `flags` shape before hashing (writer stores raw input, hashes normalised; reader must mirror).
5. **TranscriptBuild exists for the projection's `(clubId, sourceVideoSha256, resolvedTranscriptBuildId)`** — `BUILD_MISSING_FOR_PROJECTION`.
6. **At least one cited segment is resolvable** — if every cited index is excluded / absent / unauthorised, `CITED_SEGMENTS_UNRESOLVABLE`.

### 2.3 Per-segment resolution

For each cited `segmentIndex` on an authentic branch:

| Condition | Result |
|---|---|
| In `EXCLUDED_SEGMENT_INDICES` (16 / 17) OR in projection's `excludedPassagesJson` | `unavailableReason: "SEGMENT_EXCLUDED_BY_AUTHORISATION"`, text + timestamps null |
| Not in the projection's `passagesJson[].sourceSegmentIds` | `unavailableReason: "SEGMENT_NOT_IN_AUTHORISED_PROJECTION"`, null |
| Authorised but no `TrainingTranscriptSegment` row exists | `unavailableReason: "SEGMENT_NOT_PERSISTED"`, null |
| Authorised + persisted | `unavailableReason: null`, text + startSec + endSec populated from the stored row |

### 2.4 Click-to-seek

The reader pre-computes `videoSeekEnabled` = `videoStorageKeyPresent AND at least one segment resolved`. The UI's authentic-branch component:

- Mounts a standard HTML5 `<video controls preload="metadata">` pointed at `/api/hr/training/versions/{versionId}/video` (the existing authenticated video proxy — no new route, no public R2 URL).
- Provides a per-segment `▶ Play` button that sets `currentTime = Number(startSec)` on the video element and calls `.play()`.
- Shows an inline `role="alert"` box if the authenticated video fails to load (tenant-access check failed at the proxy, or the upload is not in R2).
- Does NOT autoplay on mount.
- Is responsive (full-width, controls preserved on mobile).

### 2.5 Answer-choice presentation (directive §6)

Rewritten in [PersistedReviewWorkspace.tsx](../../../src/components/ai-training/PersistedReviewWorkspace.tsx):

- Preamble above the options: *"The options below are the model's prediction. Until a human reviewer approves this candidate, no answer here is a verified fact."*
- Every option renders with `bg-stone-50 border-stone-200` — **no emerald styling at all**, in any lifecycle state (`REJECTED`, `REQUIRES_HUMAN_REVIEW`, `GENERATED`, `APPROVED_DRAFT`, `ARCHIVED`).
- The model-selected option (any option with `isCorrect: true` in `draftJson`) carries a muted "Model-selected · unverified" chip (`text-stone-500`), not an emerald "Correct" label.
- `aria-checked` is now `false` (not the model's `isCorrect` boolean) to avoid misreporting the prediction as a verified fact to assistive tech.

Per directive §6: *"A non-null `verifiedCorrectAnswerSnapshotJson` is necessary but NOT sufficient for authoritative correctness presentation. Authoritative verification additionally requires a valid human review decision, exact immutable draft/hash binding and applicable server-side eligibility checks. Until 4N implements and tests that governance chain, do not introduce any new pathway that renders a newly stored answer snapshot as verified."*

4M complies by **never** reading `verifiedCorrectAnswerSnapshotJson` anywhere in the server or client code. The column is reserved for 4N's writer path, and 4M does not introduce a reader that could render it.

### 2.6 Workspace layout (directive §8)

Three-column layout preserved verbatim:
- Left aside — `aria-label="Review queue"`.
- Center main — `aria-label="Question detail"`.
- Right aside — `aria-label="Source evidence"`.

Within the right panel, priority order matches the directive's §8.1 list:
1. Source material (course + version + video summary).
2. Authenticated player (when `videoSeekEnabled`).
3. Cited transcript passages with per-segment timestamps.
4. Timestamp navigation (`▶ Play` buttons).
5. Evidence-integrity status (banner + per-segment unavailable reasons).
6. Validation errors + advisories (unchanged from 4I).
7. Collapsible technical provenance (hashes + IDs, unchanged from 4I).

### 2.7 Historical-unavailable copy

- Amber "Historical evidence unavailable" chip in the panel header.
- Explicit copy: *"This candidate was imported from the EP-TRAIN-6C pilot. The authoritative per-segment transcript text and timestamps were not durably persisted for the pilot runs, so Spectre cannot display them here without fabricating them. Reviewers must consult the original source video directly and must not treat the segment numbers below as self-verifying."*
- Cited segment numbers are rendered as bare chips (`seg 5`, `seg 8`) without text / timestamps.
- Silver Springs source-organisation distinction is preserved via the existing `SOURCE_ORG_MISMATCH` validator flag path (independent of 4M).

---

## 3. 4D RBAC regression correction (directive §7)

The accepted 4G policy grants CLUB_ADMIN `hr:training:ai:read`. The pre-existing 4D test asserted *"without hr:training:ai:read, listCandidates throws FORBIDDEN"* using a CLUB_ADMIN fixture — the assumption was stale once 4G landed.

Repair in [tests/ep-train-6d4d-real-db-integration.test.ts](../../../tests/ep-train-6d4d-real-db-integration.test.ts):

- The failing test now uses STAFF (a role which does NOT hold `hr:training:ai:read`) and still asserts FORBIDDEN.
- A positive-control test asserts CLUB_ADMIN's read SUCCEEDS (per 4G policy).
- A negative-control test asserts CLUB_ADMIN's read grant does NOT confer any of the seven consequential AI-review permissions NOR `hr:training:transcription:write`:
  - `hr:training:transcription:write` (4L ingestion)
  - `hr:training:ai:generate`
  - `hr:training:ai:edit`
  - `hr:training:ai:revalidate`
  - `hr:training:ai:approve` (4N)
  - `hr:training:ai:remediate-rejected`
  - `hr:training:ai:archive`

(Note: `hr:training:assign` and `hr:training:publish` are legitimate CLUB_ADMIN grants for non-AI training admin and are intentionally NOT in the refused list — they predate the AI workflow.)

4D now passes 6/6.

---

## 4. Test evidence

### 4.1 Evidence reader — SQLite contract suite: 13/13 PASS

[tests/ep-train-6d4m-evidence-reader-contract.test.ts](../../../tests/ep-train-6d4m-evidence-reader-contract.test.ts). Covered:

- **Authorisation** — UNAUTHENTICATED (null principal), FORBIDDEN (STAFF), null on cross-tenant draft, null on nonexistent draft.
- **Historical-unavailable branch** — `kind === "historical-unavailable"` with correct `reason`, `groundingProjectionFingerprint`, `citedSegmentIndices`; structural proof that the type has no `citedSegments` field so fabrication is impossible.
- **Authentic branch** — full segment resolution with authoritative text + timestamps; `SEGMENT_NOT_IN_AUTHORISED_PROJECTION` for out-of-projection citations; `SEGMENT_EXCLUDED_BY_AUTHORISATION` for indices 16/17; `EXCLUDED_SEGMENT_INDICES` constant correctness; `videoSeekEnabled` toggle on storage-key presence + segment resolution.
- **Evidence-integrity-failure branch** — `PROJECTION_HASH_MISMATCH_VS_DRAFT` + `CITED_SEGMENTS_UNRESOLVABLE`; safe-message does NOT include raw SHA.

### 4.2 Workspace UI — jsdom contract suite: 8/8 PASS

[tests/ep-train-6d4m-workspace-ui.test.tsx](../../../tests/ep-train-6d4m-workspace-ui.test.tsx). Covered:

- **No emerald "Correct" styling** on any option in any lifecycle state (DOM subtree scan).
- **"Model-selected · unverified" chip** renders on the model-selected option.
- **Authentic segments render text + timestamps**; segment zero + segment one visible with 0.00s / 2.50s stamps.
- **`<video>` element mounts** with `src="/api/hr/training/versions/{id}/video"`; `autoplay` NOT set; `▶ Play` button visible.
- **Historical banner renders** with `seg 5` / `seg 8` chips + the "Historical evidence unavailable" copy; NO fabricated transcript text; zero `<video>` elements mount.
- **Integrity-failure banner renders** safe diagnostic + error code; no segment text; safe message itself contains no raw SHA.
- **Zero enabled mutation buttons** (approve / reject / edit / revalidate / regenerate / publish / assign are either absent or `disabled`).
- **Three-column layout preserved** (`aria-label` probes for Queue + Detail + Evidence).

### 4.3 Targeted regression — 114/114 PASS

```
tests/ep-train-6d4b-ai-review-governance.test.ts
tests/ep-train-6d4d-read-service-contract.test.ts
tests/ep-train-6d4d-real-db-integration.test.ts     ← 4D regression REPAIRED (was 3P/1F)
tests/ep-train-6d4l-transcription-ingest-contract.test.ts
tests/ep-train-6d4m-evidence-reader-contract.test.ts (NEW)
tests/training-ai-generation-grounding.test.ts
```

All 114 pass. The one 4K-era pre-existing failure is now a pass under 4M's repair.

### 4.4 Prisma + typecheck

- `npx prisma validate` → both schemas valid (unchanged by 4M).
- `npx tsc --noEmit` → zero 4M-attributable errors. The three pre-existing errors in unrelated services (`signup-2m4-cancellation-service.ts`, Playwright `test.describe` typing on four e2e files, one HR e2e test) remain unchanged.

### 4.5 Nav audit — not applicable

`npm run nav:audit` applies to new user-facing routes. 4M adds no new route — the existing `/app/admin/ai-training/review/persisted` is the only reader surface and is already listed in the 4D audit allow-list.

### 4.6 Live screenshots — deferred

Directive §8 asks for Playwright screenshots at 1440 × 900 + 390 × 844 "using real authorized evidence where feasible". Live capture requires:

1. A running dev server (would mutate the shared dev DB).
2. Seeded authentic evidence (transcript build + segments + projection + draft with non-null FK) in that DB.
3. A real CLUB_ADMIN login via `/login`.
4. Playwright directed at the server's authenticated session.

Items (1) + (2) conflict with the directive's §11 "Preserve the 126 unrelated WIP files" instruction — the shared dev DB holds state related to the framer-fidelity WIP and other in-progress work. Item (3) requires founder-provided credentials this slice is not authorised to use.

4M therefore defers live-evidence screenshot capture to a separately-authorised slice (likely bundled with the first live 4L ingestion worker run on staging). The UI assertions above are the programmatic equivalent for layout + content verification without the dev-DB risk.

Per directive: *"Do not substitute fixture evidence while claiming live evidence acceptance."* This document does not claim live evidence acceptance; it claims **programmatic assertion coverage + deferred live capture** and documents both honestly.

---

## 5. Unresolved dependencies for 4N

The next slice (4N — approval-route governance) must:

1. Implement a POST route `/api/admin/ai-training/drafts/[id]/review:APPROVE` that:
   - requires `hr:training:ai:approve` on the draft's `clubId`;
   - requires a `verifiedCorrectAnswerIndex: number` field in the request body (400 on omit, out-of-range, or text-mismatch with a canonical draft option);
   - refuses when the latest validation's `verdict === "REJECTED"`;
   - refuses when `draftContentHash` on the inbound request disagrees with the draft's current `contentHash`;
   - inside a single DB transaction, writes `TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson` (shape per 4K schema design §3.5) + advances the draft to `APPROVED_DRAFT` + appends a `TrainingQuestionAiStateTransition` row + emits `training.ai.question.verified-correct.recorded` via `audit()`.
2. Add a reader path for the snapshot ONLY after this governance chain exists — 4M deliberately does not read `verifiedCorrectAnswerSnapshotJson` anywhere, so introducing the read path AFTER the writer is the cleanest way to avoid a half-cooked "snapshot exists, but treated as unverified" state.
3. Extend the 4M answer-choice presentation: when the draft is `APPROVED_DRAFT` / `ARCHIVED` AND the driving validation carries a non-null `verifiedCorrectAnswerSnapshotJson`, render the single option whose text matches the snapshot with emerald styling + "Verified correct · {approver display name}". Every OTHER state + every option that doesn't match the snapshot stays stone-neutral.

Nothing else in 4M blocks 4N. 4N requires a separate authorised slice.

---

## 6. Files touched by this slice

| Path | Change |
|---|---|
| `src/lib/hr/training/ai-review/evidence-reader.ts` | NEW — tenant-scoped evidence reader service |
| `src/app/app/admin/ai-training/review/persisted/page.tsx` | modified — calls `resolveCandidateEvidence`, passes payload to workspace |
| `src/components/ai-training/PersistedReviewWorkspace.tsx` | modified — added `evidence` prop, branched `EvidencePanel`, added `AuthenticCitedSegments` + `HistoricalCitedSegments` components, replaced emerald answer styling with neutral "Model-selected · unverified" chip, added `useRef` import |
| `tests/ep-train-6d4d-real-db-integration.test.ts` | modified — repaired 4D RBAC regression (STAFF instead of CLUB_ADMIN for the FORBIDDEN fixture) + added positive + negative-control tests |
| `tests/ep-train-6d4m-evidence-reader-contract.test.ts` | NEW — 13 SQLite contract tests |
| `tests/ep-train-6d4m-workspace-ui.test.tsx` | NEW — 8 jsdom UI assertions |
| `docs/training/ai-generation/PHASE-D-4M-EVIDENCE-READER-DESIGN.md` | NEW — this file |
| `docs/training/ai-generation/PHASE-D-4M-ACCEPTANCE.md` | NEW — companion acceptance doc |

Nothing else. No API route. No RBAC grant. No schema change. No migration. No worker. No deployment.

---

## 7. STOP boundaries — all honoured

- No staging or production migration.
- No DRH-1 deployment.
- No Modal/Qwen inference.
- No worker activation.
- No historical candidate backfill or mutation.
- No review mutation or approval route (4N territory; design §5 enumerates the contract, no code).
- No publication or employee assignments.
- No additional role grants.
- 126 unrelated WIP files on `staging-deploy/web1b1-framer-fidelity` preserved via `git stash push -u`.
