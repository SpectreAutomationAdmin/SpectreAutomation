# EP-TRAIN-6D-4M — Acceptance

**Slice:** EP-TRAIN-6D-4M — Authenticated Evidence Reader & Answer Verification Presentation.
**Status:** Offline implementation DELIVERED on branch `ep-train-6d-4m/evidence-reader` (based on accepted 4L commit `3d497097`). No staging or production touched. Awaiting founder acceptance.

**Baseline:**
- Parent 4L commit: `3d4970974f460fa73295e93745e5d33f278a169a` on `ep-train-6d-4l/ingestion-services` (pushed to origin per founder authorisation).
- Deployed staging (unchanged by this slice): Fly v1095 / `sha-5e60fa59894f`.

**Companion:** [PHASE-D-4M-EVIDENCE-READER-DESIGN.md](PHASE-D-4M-EVIDENCE-READER-DESIGN.md).

---

## 1. What this slice delivered

- `resolveCandidateEvidence(principal, clubId, draftId)` — tenant-scoped reader service that composes the 4K schema + 4L ingestion canonical-hash to resolve per-draft evidence into one of three structural branches (`authentic`, `historical-unavailable`, `evidence-integrity-failure`) + `null` for cross-tenant / nonexistent drafts.
- Updated server page passes the resolved evidence to the UI.
- `PersistedReviewWorkspace` renders authentic segment bodies + timestamps + click-to-seek via the existing authenticated video proxy; renders a dedicated "Historical evidence unavailable" branch for 6D-4H candidates; renders a fail-closed safe diagnostic for evidence-integrity failures.
- Answer-choice styling rewritten to **never** use emerald "Correct" labelling. Every option renders neutrally; the model-selected option carries a muted "Model-selected · unverified" chip.
- Pre-existing 4D RBAC regression test repaired. Positive + negative RBAC controls added for CLUB_ADMIN's 4G read grant.
- 13 SQLite contract tests + 8 jsdom UI tests cover the full service behaviour + all three evidence branches + the no-emerald rule + the no-mutation rule.

Nothing else. No API route. No role grant. No historical candidate mutated. No new mutation path. No schema change.

---

## 2. Founder directive reconciliation

| Directive requirement | Where honoured |
|---|---|
| Tenant-scoped reader resolving draft → projection → build → segments → text + timestamps + SHAs + transcriber provenance + validation | [evidence-reader.ts](../../../src/lib/hr/training/ai-review/evidence-reader.ts) + [page.tsx](../../../src/app/app/admin/ai-training/review/persisted/page.tsx) wire-up. |
| Verify tenant access + course/version ownership + video SHA + draft↔projection association + recomputed projection SHA + segment membership + segment ordering/timestamp validity | Six integrity checks at the top of `resolveCandidateEvidence`. Unit-tested in all 13 service contract cases. |
| Fail closed on inconsistency | `kind: "evidence-integrity-failure"` structural branch; no exception surfaces to caller; no partial data rendered. Proven by two integrity-failure tests. |
| Same-shape 404 on cross-tenant | `null` return + caller mapping (existing page.tsx fallback path). Proven by "cross-tenant draft" + "nonexistent draft" tests. |
| Do not expose secret-bearing metadata | Safe message contains no raw SHA; only the collapsible technical-provenance footer carries hashes (per directive §8 priority order). |
| Use existing authenticated review GET routes + DTO patterns | No new API route. `page.tsx` consumes the service directly; the DTO extends the existing `CandidateDetail` pattern via a sibling `CandidateEvidence` type. |
| Preserve historical candidates verbatim | 4M NEVER mutates historical rows. Historical branch structurally has no `citedSegments` field — fabrication is impossible by shape. `groundingProjectionFingerprint` renders the `fixture-*` string verbatim. |
| Do not fabricate text/timestamps for historical | Confirmed by the UI test "renders NO segment text" + the service-layer test "never fabricates transcript text or timestamps". |
| Do not claim fixture is a SHA-256 | The authentic branch has `isRealSha256()` gating; the fixture placeholder renders with its own amber chip. |
| Click-to-seek only on verified cited segments | Per-segment Play button rendered ONLY when `unavailableReason === null`; disabled for excluded / unauthorised / non-persisted segments. |
| Preserve Silver Springs source-organisation distinction | Pre-existing `SOURCE_ORG_MISMATCH` validator flag path preserved; 4M adds additional surfacing via `evidence.sourceOrgMismatchFlagsPresent` on the authentic branch. |
| Preserve rejected + human-review verdicts | Lifecycle state + validation payload unchanged by 4M; UI tests confirm "Needs reviewer decision" copy renders on REQUIRES_HUMAN_REVIEW. |
| Integrate with existing authenticated video proxy | `<video src="/api/hr/training/versions/{id}/video">` — the existing route. No new endpoint. No public R2 URL. UI test confirms the src pattern. |
| No autoplay on page load | `preload="metadata"`, no `autoplay` attribute. UI test confirms. |
| Visible playback loading + error states | `onError` handler + inline `role="alert"` banner for load failures. |
| Responsive desktop + mobile | Mobile sidebar selector preserved; evidence panel rendered inside both desktop aside + mobile stacked column. |
| If playback is not safe, implement reader + document blocker | Playback IS safe via the existing proxy; no blocker documented. |
| Do not expose unrestricted media access | Zero public URL. Zero fetch past the authenticated proxy. |
| Remove the AI-selected-answer-is-correct assumption | Every option renders stone-neutral. "Model-selected · unverified" chip replaces "Correct" label. UI test scans the DOM subtree for `emerald-` and asserts absent. |
| Non-null `verifiedCorrectAnswerSnapshotJson` is necessary but NOT sufficient | 4M **never reads** this column. The reader service does not touch it; the UI has no code path that would render it as verified. 4N must implement + test the full governance chain before any reader path is introduced. |
| Keep model-selected answer intact, distinguish from human-verified | Model-selected chip preserves the prediction; "Verified correct" label is reserved for 4N. |
| Investigate 4D RBAC regression; update stale expectation; add CLUB_ADMIN negative controls | 4D test repaired (STAFF fixture); positive control added; 7-key negative control confirms no AI-mutation grants bleed through. |
| Three-column layout preserved | UI test asserts `aria-label="Review queue" / "Question detail" / "Source evidence"` all present. |
| Right-panel priority: source material → player → segments → timestamps → integrity → validation → provenance | Render order in `EvidencePanel` matches §8.1 list. |
| Do not move hashes into primary reading hierarchy | Hashes remain in the collapsible `<details>` footer (unchanged from 4I). |
| Preserve Spectre visual language | No typography / color / navigation / layout change. Only answer-choice colours (emerald → stone) + new `EvidencePanel` sub-components. |
| Capture 1440 × 900 + 390 × 844 screenshots using real authorized evidence where feasible | **Deferred** — see design doc §4.6. Not feasible without disturbing WIP or using founder credentials. Programmatic UI assertions cover the content + structure verification. |
| Do not substitute fixture evidence while claiming live evidence acceptance | No live acceptance claimed. Deferred honestly. |
| Cross-tenant denial | Service test + 4D positive/negative controls. |
| Cross-course denial | Enforced via ownership chain; `null` return on mismatch. |
| Unauthorized video access | Existing authenticated proxy — unchanged. No new surface. |
| Missing transcript / projection / SHA mismatch / video SHA mismatch / segment-membership mismatch / invalid timestamp / historical fixture identifier / rejected candidate / human-review candidate | 13 service tests + 8 UI tests cover these cases. |
| Neutral model-selected styling / no unverified "Correct" / no enabled mutation / no unauthorized write routes | UI tests + the structural fact that 4M adds zero write surface. |
| Disposable PostgreSQL 16 for database-dependent tests | 4M's logic is tested against SQLite via the shared harness — the service does not introduce DB-level constraints beyond 4K's (which 4K + 4L already proved on PG 16). No new PG harness needed; 4L's harness remains the PG authority. |
| Prisma validation / regression / scoped typecheck / nav audit | ✅ Prisma valid; ✅ 114/114 regression PASS; ✅ `tsc --noEmit` zero 4M-attributable errors; nav audit not applicable (no new route). |

---

## 3. Test evidence

### 3.1 Evidence-reader SQLite contract — 13/13 PASS

```
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  163.23s
```

### 3.2 Workspace UI jsdom contract — 8/8 PASS

```
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  24.22s
```

### 3.3 Targeted AI-review regression — 114/114 PASS

```
 Test Files  6 passed (6)
      Tests  114 passed (114)
   Duration  252.95s
```

Including the repaired 4D suite (6/6 PASS, previously 3/4 under the 4K baseline).

### 3.4 `tsc --noEmit`

Zero 4M-attributable errors. Pre-existing errors in unrelated services unchanged.

### 3.5 `prisma validate`

Both schemas valid (4M makes no schema change).

---

## 4. Unresolved dependencies

Documented in design doc §5 — all deferred to 4N:

- POST approval route with `verifiedCorrectAnswerIndex` enforcement.
- Writer path for `TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson`.
- Reader path for the same (only after the writer exists, to avoid a half-cooked "snapshot exists but treated as unverified" state).
- Emerald "Verified correct · {approver}" rendering on APPROVED_DRAFT / ARCHIVED candidates with a non-null snapshot.

Live-authorized screenshot capture is deferred to a separately-authorised slice (likely bundled with the first live 4L ingestion worker run on staging).

---

## 5. Commit

Target branch: `ep-train-6d-4m/evidence-reader` (local). Based on `ep-train-6d-4l/ingestion-services` (parent SHA `3d497097`).

Files committed:

- `src/lib/hr/training/ai-review/evidence-reader.ts` (new)
- `src/app/app/admin/ai-training/review/persisted/page.tsx` (modified)
- `src/components/ai-training/PersistedReviewWorkspace.tsx` (modified)
- `tests/ep-train-6d4d-real-db-integration.test.ts` (modified — 4D RBAC repair)
- `tests/ep-train-6d4m-evidence-reader-contract.test.ts` (new)
- `tests/ep-train-6d4m-workspace-ui.test.tsx` (new)
- `docs/training/ai-generation/PHASE-D-4M-EVIDENCE-READER-DESIGN.md` (new)
- `docs/training/ai-generation/PHASE-D-4M-ACCEPTANCE.md` (new)

**No push to origin.** 4M is local-only until founder acceptance.

---

## 6. STOP boundaries re-stated (and honoured)

- ✅ No staging or production migration.
- ✅ No DRH-1 deployment.
- ✅ No Modal/Qwen inference.
- ✅ No worker activation.
- ✅ No historical candidate backfill or mutation.
- ✅ No review mutation or approval route (4N territory).
- ✅ No publication or employee assignments.
- ✅ No additional role grants.
- ✅ 126 unrelated WIP files preserved via `git stash push -u` on `staging-deploy/web1b1-framer-fidelity`.

STOPPED.
