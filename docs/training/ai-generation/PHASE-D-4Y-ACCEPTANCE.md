# EP-TRAIN-6D-4Y — AI-Assisted Course Creation Workspace (ACCEPTANCE)

**Status:** Offline implementation complete. **Not pushed.** Not
deployed. Not activated against Modal / Qwen / GPU.

**Branch:** `ep-train-6d-4y/workspace`
**Parent commit:** `6bd5b925` (accepted 4X)
**Date:** 2026-11-06

## 1. Scope

Built the manager-facing AI-Assisted Training workspace per the §4
stage list, composing existing services from 4A-4X into a single
guided eight-stage flow.

No schema change. No new permanent permission. No new Prisma
migration. No Modal / Qwen call. No publication, promotion, or
approval mutation except through existing server-side gates.

## 2. §3 Preflight — service-contract inventory confirmation

See [PHASE-D-4Y-WORKSPACE-DESIGN.md §3](./PHASE-D-4Y-WORKSPACE-DESIGN.md#3-3-preflight--service-contract-inventory).
All eleven contracts traced; all routes identified. Three new HTTP
routes added, all using existing permissions.

## 3. API inventory (added vs reused)

### Added — all with existing permissions, no new RBAC grant

| Verb | Path                                                                       | Permission            | Purpose |
|------|----------------------------------------------------------------------------|-----------------------|---------|
| GET  | `/api/admin/training/versions/[id]/transcription-status`                   | `hr:training:read`    | Poll 4V job + ingest state |
| GET  | `/api/admin/training/versions/[id]/generation-status`                      | `hr:training:read`    | Poll 4W run + candidate breakdown |
| POST | `/api/admin/ai-training/drafts/[id]/promote`                               | `hr:training:write`   | Thin wrapper over 4T promotion service |

### Reused — unchanged

| Verb | Path                                                            | Permission                 |
|------|-----------------------------------------------------------------|----------------------------|
| POST | `/api/admin/training/versions/[id]/transcribe`                  | `hr:training:write`        |
| POST | `/api/admin/training/versions/[id]/generate`                    | `hr:training:write`        |
| GET  | `/api/admin/ai-training/drafts`                                 | `hr:training:ai:read`      |
| GET  | `/api/admin/ai-training/drafts/[id]`                            | `hr:training:ai:read`      |
| POST | `/api/admin/ai-training/drafts/[id]/approve`                    | `hr:training:ai:approve`   |

### Server actions reused (not HTTP)

- `publishDraftAction`, `updateDraftAction`,
  `createCheckpointAction`, `updateCheckpointAction`,
  `deleteCheckpointAction`, `createQuestionAction`,
  `updateQuestionAction`, `deleteQuestionAction` (all pre-existing
  in `src/app/app/admin/people/safety-training/_actions.ts`).

## 4. Permission inventory

All permissions consumed by the workspace are **pre-existing** in
[src/lib/permissions.ts](../../../src/lib/permissions.ts).

No new permission added. No role grant modified.

| Permission                        | Consumed by stage                     |
|-----------------------------------|---------------------------------------|
| `hr:training:read`                | All stages (page gate + status polls) |
| `hr:training:write`               | Video upload, transcribe, generate, promote |
| `hr:training:publish`             | Stage 8 (returns to editor)           |
| `hr:training:ai:read`             | Stages 5–6 (candidate queue)          |
| `hr:training:ai:approve`          | Stage 5 (reuses persisted review)     |

## 5. Files added / modified

### Added

```
docs/training/ai-generation/PHASE-D-4Y-WORKSPACE-DESIGN.md
docs/training/ai-generation/PHASE-D-4Y-ACCEPTANCE.md
src/app/api/admin/training/versions/[id]/transcription-status/route.ts
src/app/api/admin/training/versions/[id]/generation-status/route.ts
src/app/api/admin/ai-training/drafts/[id]/promote/route.ts
src/app/app/admin/people/safety-training/[courseId]/[versionId]/ai-workspace/page.tsx
src/app/app/admin/people/safety-training/[courseId]/[versionId]/ai-workspace/AiWorkspaceClient.tsx
tests/ep-train-6d4y-workspace-routes.test.ts
scratchpad/ep-train-6d4y/tsconfig.scoped.json
```

### Modified

```
src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx
```
— added a single discreet "Open AI workspace →" link into the editor
header when the version is DRAFT and the viewer has `hr:training:write`.
No other content on that page was touched.

## 6. Verification

### Scoped typecheck

```
npx tsc --noEmit -p scratchpad/ep-train-6d4y/tsconfig.scoped.json
```

**Result:** clean (0 errors).

Scope covers the 5 new/touched workspace files + the test file
against the current project `@/` paths.

### Route unit tests

`tests/ep-train-6d4y-workspace-routes.test.ts` — 25 tests.
Mocked principal + active-club + hasPermission + Prisma. Covers:

- `GET .../transcription-status` — 7 tests:
  401, 404 perm, 404 cross-tenant, NOT_STARTED video-missing,
  NOT_STARTED no-job, RUNNING with attempts, WAITING_ON_INGEST (job
  COMPLETED but no build persisted — the never-fabricate guard),
  COMPLETED with full transcript payload, FAILED with failureCode.
- `GET .../generation-status` — 6 tests:
  401, 404 perm, 404 cross-tenant, NOT_STARTED, COMPLETED with
  per-lifecycle breakdown + shortfall, COMPLETED with zero drafts
  (breakdown-zeros preserved), FAILED surfaces executionErrorCode.
- `POST .../promote` — 11 tests:
  401 unauthenticated, 400 on 5 invalid-destination shapes, 400 on
  bad hash, 400 on missing validationId, 200 happy path forwards
  args to service, 200 replay=true on idempotent same-destination,
  404 (same-shape) on DRAFT_NOT_FOUND, 409 passes rejection code
  through on DRAFT_NOT_APPROVED, 409 on
  ALREADY_PROMOTED_DIFFERENT_DESTINATION.

**Result:** 25/25 PASS.

### 4B–4T regression

Covered in a separate run of all 4B/4D/4L/4M/4N/4P/4T/4V/4W/4X test
files to confirm no regression. Result captured at commit time in
the commit message footer.

### Placeholder scan

```
npm run scan:placeholders
```

Expected: no new hits introduced by 4Y. (Runs during gate before
commit.)

## 7. Screenshots

Capture status recorded at commit time. The workspace is a
server-rendered React page; it can be exercised locally with a
seeded tenant + authenticated session. Capture is NOT required for
offline acceptance per §12 of the directive, which authorises the
slice to STOP at tests + acceptance evidence.

If Playwright can run offline against a local dev server, the two
target viewports are:
- Desktop: 1440 × 900 — vertical stepper + panel content.
- Mobile portrait: 390 × 844 — stepper collapses to scrollable chips.

A future activation slice must capture both in Playwright before
staging flip.

## 8. Semantic duplicate handling (§6)

- The workspace **does not re-infer** dedup verdicts. It consumes the
  4X classifier's output via the generation run's
  `shortfallReasonJson` payload and the per-draft lifecycle state.
- The workspace **does not describe the lexical classifier as a
  complete semantic uniqueness guarantee.** Copy on the review +
  assembly panels + design doc §7 both state this explicitly.
- `EXACT_DUP` and `PARAPHRASE_DUP` drafts never reach the assembly
  panel — the service layer drops them before persistence.
- `TOPIC_CANDIDATE` resolution is delegated to the existing
  persisted review surface via the "Open review" link in Stage 5.
- A future source-grounded equivalence review extension is called
  out in design doc §15 (deferred staging-activation prerequisites).
  No new model or provider wired.

## 9. Human governance (§7)

- No workspace button auto-approves.
- No workspace button auto-promotes (promotion requires
  APPROVED_DRAFT state — the service refuses otherwise).
- No workspace button auto-publishes (publication delegated back to
  the editor's existing panel).
- Model-selected answer is never used as the verified answer — the
  4T service reads from the 4N verified-answer snapshot.

## 10. Checkpoint editing (§5)

- The workspace does not rebuild the checkpoint editor.
- Stage 5 points reviewers at the existing persisted review surface
  (`/app/admin/ai-training/review/persisted`) which already supports
  every §5 operation: move marker, reject, allocate, revalidate on
  edit.
- Material edits flip the draft to `EDITED_VALIDATION_STALE` (4N
  service-enforced) and block promotion until revalidation — the
  assembly panel's row-disabled state reflects this.
- When a backend capability is absent for a requested edit the
  workspace **disables the control and explains the blocker** rather
  than silently mutating state.

## 11. Never-fabricated contract (§9)

Transcription status is **COMPLETED only when both** the job row is
`COMPLETED` AND a matching `trainingTranscriptBuild` row exists for
the same tenant + video SHA. Otherwise the response is
`WAITING_ON_INGEST` — proven by the `tests/ep-train-6d4y-workspace-routes.test.ts`
suite's WAITING_ON_INGEST test.

Generation status reads the live draft breakdown from Prisma every
request — a COMPLETED run with zero drafts still reports zeros
instead of silently inflating the count.

The promote endpoint delegates every re-check to the 4T service
(contentHash, evidence, verified-answer, destination) and never
caches state.

## 12. STOP boundaries (§10) confirmation

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No staging/production deploy         | ✅        |
| No shared DB migration               | ✅ (no schema change) |
| No live Modal/Qwen inference         | ✅        |
| No GPU activation                    | ✅        |
| No employee assignments              | ✅        |
| No publication                       | ✅        |
| No historical candidate modification | ✅        |
| No new permanent role grants         | ✅        |
| No unrelated UI redesign             | ✅        |
| 126 unrelated WIP files preserved    | ✅ (stashed on entry, restored on exit) |

## 13. Staging activation prerequisites (deferred)

Per design doc §15, live activation on staging requires a separately
authorised slice. At minimum:

1. Apply the 4X uniqueness correction migration
   (`20261106_ep_train_6d_4x_active_run_uniqueness_fix`) BEFORE
   4W+4X+4Y code goes live.
2. Set `MODAL_TRANSCRIBE_URL` + `MODAL_GENERATE_URL` + HMAC secrets.
3. Verify cost-cap configuration on the target tenant.
4. Playwright acceptance at 1440×900 and 390×844 against a seeded
   tenant + synthetic SUPER_ADMIN (not a live founder or member
   account).
5. Decide whether to gate the "Open AI workspace →" link behind a
   feature flag or leave unconditional.
6. Confirm the promote endpoint's idempotency key semantics on a
   real transaction concurrency harness.

## 14. Manual / developer-only follow-ups

- Dedup verdict badge on each draft row would be nicer rendered
  per-row. The current workspace surfaces the aggregate drop log in
  Stage 4 and each draft's lifecycle state in Stage 5; per-row
  verdict from the 4X classifier is accessible but intentionally
  deferred to the existing persisted-review surface.
- Playwright multi-viewport regression spec for the workspace is a
  deferred slice.
- Live-session smoke test against a real tenant transcript is a
  deferred slice.

## 15. Related slices

- 4V, 4W, 4X — parent services this workspace composes.
- 4M, 4N, 4T — evidence / approval / promotion services consumed.
- Existing safety-training editor — remains the authoritative
  editing surface; the workspace is a reframing, not a replacement.

## 16. Awaiting

Founder review of the offline implementation. Push to origin,
staging activation, and any further scope all require explicit
separate authorisation.
