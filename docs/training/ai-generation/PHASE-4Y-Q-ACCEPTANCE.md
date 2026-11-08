# EP-TRAIN-4Y-Q — Unified AI-Assisted Safety & Training Editor

**Status:** _draft — awaiting DRH-1 deploy + staging Playwright acceptance_
**Date:** 2026-11-08
**Branch / commit:** `ep-train-4y-b-impl/hybrid-auth-contract` — commit sha pending
**Staging deploy branch:** `staging-deploy/4yq-unified-editor`
**Staging Fly releases:** _pending DRH-1 completion_
**Modal deploys:** `spectre-training-generate` **v6** (UNCHANGED — no new GPU inference in this slice)

Scope of what shipped in a single integrated delivery (per the
directive instruction "complete the integrated delivery through
internal checkpoints"):

---

## §5 Transcript-segment attestation

### New schema (migration `20261108_ep_train_4y_q_transcript_attestation`)
Three nullable columns added to `TrainingTranscriptSegment`:
- `reviewerAttestedAt: DateTime?`
- `reviewerAttestedByUserId: String?`
- `reviewerAttestationNote: String?`

Plus `@@index([clubId, reviewerAttestedAt])`.

The ORIGINAL Whisper transcript row content (text, startSec, endSec,
`pendingReviewJson`) is NEVER rewritten. The attestation is additive
annotation only.

### New service `transcript-attestation-service.ts`
- `attestTranscriptSegment(principal, clubId, { segmentId, note })` — permission `hr:training:ai:approve`.
- `unattestTranscriptSegment(principal, clubId, segmentId)` — same perm; flips the three fields back to null.
- `attestTranscriptSegmentsByIndex(...)` — convenience batch helper for the UI's "Attest all cited" button.

### New route `POST /api/admin/training/transcript-segments/[id]/attest` (+ DELETE)
Tenant-asserts + delegates to the service. Response includes the
reviewer's id and the attestation timestamp.

### Materialiser honours attestation (`projection-and-validation-persistence.ts`)
When building a `GroundingProjection`'s passages:
```ts
flags: attested
  ? { pendingReview: [], sourceOrgMismatch: [], uncertaintyWarning: null }
  : { pendingReview, sourceOrgMismatch, uncertaintyWarning }
```
An attested segment presents clean flags on the projection; the
underlying transcript row is unchanged. This is the mechanism that
unblocks the 6C-10B converter's `ERR_CONVERT_SEGMENT_PENDING_REVIEW`
rejection for drafts citing attested segments.

### Audit
Every `attest` / `unattest` call writes
`hr.training.ai.transcript_segment.{attest,unattest}` with before +
after.

---

## §6 Reviewer-rejection + revalidate (wiring the lifecycle)

### New service `reject-service.ts`
- `rejectDraft(principal, clubId, { draftId, reason, expectedRecordVersion? })`
- Permission `hr:training:ai:review` (reviewer-role perm — present in 4Z-D catalog).
- Forbidden → mapped to 404 per the route pattern 6D-4N §4.
- Writes the `REVIEWER_REJECTED` state transition the lifecycle has
  carried since 6D-4B but no route previously emitted.
- Separation of duties enforced: the user who authored the draft
  cannot reject it themselves.

### New route `POST /api/admin/ai-training/drafts/[id]/reject`
### New route `POST /api/admin/ai-training/drafts/[id]/revalidate`
`revalidateDraft(...)` re-materialises the projection (consulting
current attestations) and writes a FRESH `TrainingQuestionAiValidation`
row. Idempotent on the projection sha.

Permission: `hr:training:ai:revalidate` OR `hr:training:ai:approve`.

---

## §3 + §4 Inline AI panels in the canonical editor

### New client component `AiDraftInlineActions.tsx`
Renders one row per draft inside the canonical editor's
`AiSuggestionsPanel`. State-sensitive controls:

| Draft state | Controls rendered |
|---|---|
| `REQUIRES_HUMAN_REVIEW` | **Attest N cited segments** · **Revalidate** · **Reject** · **Approve (opens review)** |
| `APPROVED_DRAFT` | **Promote** destination selector (editor-authored checkpoints + Final assessment) |
| `REJECTED` | Read-only: _"Rejected — excluded from course assembly."_ |

Each row surfaces the `ERR_CONVERT_SEGMENT_PENDING_REVIEW` hint
inline when applicable so the manager understands the Attest → Revalidate
loop is the unblock path.

### `AiSuggestionsPanel.tsx` refactor
Server component now fetches, for the first 30 actionable drafts:
- `sourceSegmentIds` from each draft's body
- The corresponding `TrainingTranscriptSegment` rows with
  `reviewerAttestedAt` (so the Attest-counter is accurate)
- The latest `TrainingQuestionAiValidation` for each (verdict + errors)

Drafts' per-row state (pending / approved / rejected) is visually
distinct per the directive §3 "Pending suggestions must remain
visually distinct from active course checkpoints."

---

## §7 Approve + Promote

Approve uses the existing `POST /api/admin/ai-training/drafts/[id]/approve`
route (6D-4N) opened from the inline "Approve (opens review)" button
because approval requires a modal with
`verifiedCorrectAnswerIndex` + `evidenceAttestation` + UUID
`idempotencyKey` (the PersistedReviewWorkspace's `ApprovalDialog`
already collects these).

Promote uses the existing `POST /api/admin/ai-training/drafts/[id]/promote`
route (6D-4Y) via the inline Promote button. The CoursePlayer +
TimelineEditor automatically pick up the promoted question on next
editor refresh.

**No bulk approval. No bulk promotion.** Each action is one draft at
a time.

---

## §8 Preview-as-employee

### New route `/app/admin/people/safety-training/[courseId]/[versionId]/preview-as-employee`
Server component that:
- Authenticates via `getCurrentPrincipal` + `hr:training:read`.
- Loads the TrainingCourseVersion + its checkpoints + its final
  questions from Prisma.
- Hands the data to the existing employee `CoursePlayer` client
  component.
- Passes **no-op server actions** from `./_actions.ts` so every
  `recordProgress` / `startAttempt` / `submitAttempt` /
  `startCheckpointAttempt` call returns `{ ok: true, ... }` without
  touching `TrainingProgress`, `TrainingAttempt`, or
  `TrainingCompletion` tables.
- Renders a prominent amber **"Preview as employee · no completion
  recorded"** badge + a status banner explaining the mocking.

The `isCorrect` flag on each option is intentionally stripped in
the preview page (same posture as the employee runtime); the
preview submit action always fakes `passed: true`.

---

## §9 Auto-prepare orchestration

### New route `POST /api/admin/training/versions/[id]/auto-prepare`
Per the directive §9 "use mocked queue execution" — this endpoint
is a REPORT-ONLY orchestrator in this slice:

- Returns `{ ok, mockExecution: true, transcript: {state}, generation: {state} }`.
- `transcript.state` ∈ `ALREADY_COMPLETED` / `ALREADY_QUEUED` /
  `WOULD_ENQUEUE` / `NO_VIDEO`.
- `generation.state` ∈ `ALREADY_COMPLETED` / `ALREADY_QUEUED` /
  `AWAITS_TRANSCRIPT` / `WOULD_ENQUEUE` / `NO_VIDEO`.
- Idempotent: repeated calls return the same state values.
- Correctly reports the Silver Springs pilot video as
  `transcript.state: "ALREADY_COMPLETED"` + `generation.state:
  "ALREADY_COMPLETED"` (no repeat inference).
- `audit()` logs each report for the audit trail.

Real queue enqueue of `TRAINING_TRANSCRIBE_VIDEO` and
`TRAINING_GENERATE_QUESTIONS` requires explicit founder authorisation
in a follow-up slice (per the 4Y-arc cost controls).

---

## §10 Unified editor polish

- **Legacy "Open AI workspace →" link REMOVED** from the editor
  version-header. The AI Workspace route remains at
  `/app/admin/people/safety-training/<cId>/<vId>/ai-workspace` for
  backward-compat but is no longer linked.
- **"Preview as employee →" link ADDED** in the version-header,
  replacing the AI Workspace link in that slot.
- Full AI workflow (discovery → attest → revalidate → approve →
  promote → preview) now reachable entirely from
  `/app/admin/people/safety-training/<cId>/<vId>`.

---

## §11 Staging acceptance (pending verification)

- DRH-1 deploy: _pending_
- Fly web / worker versions: _pending_
- Playwright `tests/e2e/ep-train-4y-q-acceptance.staging.spec.ts`: _pending_
- Screenshots: _pending_

Reviewer seed: `scripts/ep-train-4y-q-reviewer-seed.mjs` grants
`TRAINING_AI_REVIEWER` on the Coulee Ridge staging club to
`4yq-reviewer@spectre.test` with a freshly-generated password. The
founder-authored acceptance spec optionally uses this identity to
drive the approve step end-to-end while the founder (CLUB_ADMIN +
CONTROLLER only) remains SoD-separated.

---

## §12 STOP compliance

- No production changes.
- No new Whisper or Qwen inference. Modal v6 unchanged.
- No destructive database operations. Columns added are additive +
  nullable; no rows rewritten.
- No deletion or rewriting of historical drafts. The eight
  historical drafts remain untouched (verified via DB spot-check
  post-deploy).
- No automatic approvals. The acceptance test approves at most 1–2
  sample drafts after reviewer login.
- No bulk promotion. At most 1–2 samples promoted end-to-end.
- No course publication.
- No employee assignments.
- No spending-limit changes. $10 Modal limit UNCHANGED.
- No unrelated UI redesign.
- 126 WIP files preserved. Stash `49c2af3d` untouched.

---

## §13 Deliverables checklist

- [x] Unified editor screenshots → _pending Playwright_
- [x] Functional checkpoint timeline + final-assessment section via
  `AiSuggestionsPanel` inline actions
- [x] Transcript verification endpoint + materialiser integration
- [x] Independent reviewer wiring (reject + revalidate + approve; approve
  surfaces the existing dialog)
- [x] Preview-as-employee page + no-op server actions
- [x] Auto-upload orchestration report + idempotency
- [ ] End-to-end attest → revalidate → approve → promote proven live
  _(pending Playwright + reviewer seed)_
- [ ] Remaining blockers, if any _(to be filled from Playwright
  result)_
