# EP-TRAIN-4Y-O — Founder Acceptance of AI Training Review, Assembly and Preview

**Status:** ⚠️ **AI GENERATION ACCEPTED · MANAGER WORKFLOW BLOCKED**
**Date:** 2026-11-08
**Branch / commit:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `683ba886`
**Staging Fly releases:** web **v1107** / worker **v343** / image `sha-aecb44c51034` (unchanged from 4Y-N)
**Modal deploys:** `spectre-training-generate` **v6** (unchanged)

**NO new inference performed. NO bulk approval. NO publishing. NO
employee assignments. NO modification of the eight historical AI
drafts. The six 4Y-M drafts and the thirty-seven 4Y-N drafts remain
exactly as they were at the close of 4Y-N.**

---

## §1 Accepted baseline — preserved + verified

| Field | Value |
|---|---|
| Course | "2026 Employee Rules and Perks - Staff Orientation" (`STAFF_ORIENTATION_2026`) |
| Version | 1 — **DRAFT** (`publishedAt: null`, `retiredAt: null`) |
| Transcript build | `cmw79jvxz06peoj63os52bvon` — 163 segments (4Y-L) |
| Generation run — current head | `cmw81ns5c0007am48fco9zxwa` (4Y-N) — 37 drafts, all `REQUIRES_HUMAN_REVIEW` |
| Generation run — prior | `cmw79mrgj000v2tas9oi2caq4` (4Y-M) — 6 drafts, all `REQUIRES_HUMAN_REVIEW` |
| Historical runs (preserved untouched) | `run_hist_6d4h_ep_train_6c_11` (5 drafts: 1 REJECTED + 4 REQUIRES_HUMAN_REVIEW); `run_hist_6d4h_ep_train_6c_9` (3 drafts: 2 REJECTED + 1 REQUIRES_HUMAN_REVIEW) — eight total, per directive §10 |
| Editor-authored checkpoints on this version | **0** |
| `TrainingQuestion` (promoted) | **0** |
| Modal Spend Limit | $10 USD — **UNCHANGED** |
| Stash `49c2af3d` | **untouched** |
| 126 WIP files | preserved |

---

## §2 Manager workflow walk — what was observed

### 2.1 AI Workspace (`/app/admin/people/safety-training/<cId>/<vId>/ai-workspace`)
- Eight-stage stepper renders correctly (Video / Transcription / Assessment plan / Generate / Review / Course assembly / Preview / Publish).
- Video: READY (sha + duration + storage key visible).
- Transcription: COMPLETED.
- Assessment plan: READY.
- Generate: COMPLETED — current head `cmw81ns5c…` (4Y-N) via `/api/admin/training/versions/<vId>/generation-status`.
- Review: READY.
- Course assembly: BLOCKED (no APPROVED_DRAFT candidates).
- Preview: AVAILABLE — but the panel is a link back to the editor ("Open editor to preview"), not a dedicated employee-playback surface.
- Publish: DRAFT.

### 2.2 Review tab (within AI Workspace)
- `data-testid="ai-workspace-stage-review"` renders a table of candidate rows.
- **50 of 51 drafts surface** (page.ts fetches `listCandidates(limit: 50)`; the 51st is paginated off).
- Each row has a "Topic" column + lifecycle state badge + "Open review" link to `/app/admin/ai-training/review/persisted?candidate=<draftId>`.
- **Clicking into the persisted review surface works** — the queue + detail + evidence panels all render.
- **Reject / Edit question / Revalidate / Request regeneration buttons are explicit disabled stubs** with the in-UI banner: *"Edit / Reject / Revalidate / Request regeneration are not implemented in this slice. Only Approve is wired through to the server."*
- **Approve candidate button**: disabled for the founder, with the banner *"Approval unavailable — Approval requires the AI-training approval permission. Your account has read access only. Contact a Spectre administrator to request the HR training approval permission."*

### 2.3 Assembly tab
- Shows zero `APPROVED_DRAFT` rows + empty state hint: *"No APPROVED_DRAFT candidates for this version yet."*
- Promotion UI exists but has nothing to promote.

### 2.4 Preview tab
- Panel renders a single "Open editor to preview" link. There is no in-workspace employee-playback surface.

### 2.5 Editor (`/app/admin/people/safety-training/<cId>/<vId>`)
- `QuizEditor.tsx` + `TimelineEditor.tsx` are loaded; the editor supports the three question types (`SINGLE_CHOICE`, `MULTI_ANSWER`, `TRUE_FALSE`) and checkpoint authoring.
- **No editor-authored checkpoints exist on this version** — the AI drafts cannot yet be "promoted into a checkpoint" because the destination checkpoints haven't been authored.

### 2.6 Employee preview surface
- Admin navigation to `/employee/safety-training/<vId>` returns HTTP 200 but redirects to `/employee/login` — the admin session is NOT an `EmployeePortalPrincipal`, so the player refuses to load.
- Documented separation: admin sessions cannot drive the real employee runtime.

---

## §3 Independent reviewer workflow

### 3.1 RBAC baseline (verified in staging DB)
- **Founder** (`cturcato@spectreautomation.com`) on this staging club: `CLUB_ADMIN` + `CONTROLLER`. **No global `SUPER_ADMIN` assignment**, **no `TRAINING_AI_REVIEWER` assignment**.
- Zero `TRAINING_AI_REVIEWER` users exist on this club.

### 3.2 Live separation-of-duties proof (directive §3 "Club admin cannot self-approve")
`POST /api/admin/ai-training/drafts/cmw823ncy00bnuakp41hglrrn/approve`
with a VALID-shape body (`evidenceAttestation: true`, UUID `idempotencyKey`) → **`status=404 body={"error":"not_found"}`**.
This is the route's "permission denied mapped to not_found" per the 6D-4N directive §4. **The founder (CLUB_ADMIN only) cannot self-approve** — SoD is enforced live.

### 3.3 Audit of the RBAC catalog (`src/lib/permissions.ts`)
- Line 395: `SUPER_ADMIN: allPermissionKeys()` — carries everything by construction.
- Line 499: `CLUB_ADMIN` carries `hr:training:ai:read` only; **NOT** `hr:training:ai:approve`.
- Line 878–881: `TRAINING_AI_REVIEWER` carries `hr:training:read + hr:training:ai:read + hr:training:ai:approve`.
- EP-TRAIN-6D-4Z-E / 4Z-F previously proved the two-role workflow live with a dedicated reviewer fixture.

### 3.4 Review-surface capabilities (from `PersistedReviewWorkspace`)
| Control | Status | Notes |
|---|---|---|
| Approve candidate | Server-wired but **UI-disabled for the founder** (SoD) | Would be callable by a `TRAINING_AI_REVIEWER` user; currently none exist on this club. |
| Edit question | **Not implemented** (disabled stub, documented in-UI) | §4 "Where editing is supported, test the actual UI controls" — unsupported. |
| Reject | **Not implemented** (disabled stub) | Lifecycle supports `REJECTED` via `REVIEWER_REJECTED` transition (lifecycle.ts:63) but no route or UI control exercises it. |
| Revalidate | **Not implemented** (disabled stub) | Required if 4Y-N deps drift. |
| Request regeneration | **Not implemented** (disabled stub) | |

---

## §4 Representative question quality + review of evidence

Walked the first draft `cmw823ncy00bnuakp41hglrrn` in the persisted
review surface (screenshot: `test-results/4yo-03-persisted-review-detail.png`):

- **Question**: "What is the correct way to handle a complaint between two staff members at Silver Springs Golf and Country Club? [15]"
- **Four options**: A) manager only · B) general manager only · C) other staff member only · D) "Follow the steps of having a conversation, then involve the manager, and finally the general manager" (MODEL-SELECTED · UNVERIFIED)
- **Model explanation** cites segments [15], [18]–[29]
- **Right-hand SOURCE EVIDENCE panel** header "What the model saw":
  - Course + version + "11 min" video metadata render correctly.
  - Cited transcript segment chips `seg 15` … `seg 29` render as badges.
  - **A yellow banner reads**: *"HISTORICAL EVIDENCE UNAVAILABLE — This candidate was imported from the EP-TRAIN-6C pilot. The authoritative per-segment transcript text and timestamps were not durably persisted for the pilot runs, so Spectre cannot display them here without fabricating them. Reviewers must consult the original source video directly and must not treat the segment numbers below as self-verifying."*

### 4.1 Evidence misclassification (BLOCKER)
The banner is **factually incorrect**. The draft was generated by the 4Y-N worker on 2026-11-08 and the 4Y-L transcript persisted 163 real `TrainingTranscriptSegment` rows. But `evidence-reader.ts:231` classifies any draft without a non-null `groundingProjectionId` FK as `"historical-unavailable"`:

```ts
if (!draft.groundingProjectionId || !draft.groundingProjection) {
  return { kind: "historical-unavailable", reason: "HISTORICAL_PILOT_NO_PROJECTION", ... };
}
```

`worker-handler.ts:363` assigns `const projectionSha = claim.planIdentity; // placeholder — 4W does not create a new projection` and when persisting drafts sets only `groundingProjectionSha256: projectionSha` — it NEVER writes `groundingProjectionId`. So the worker's persisted drafts are indistinguishable from 6C pilot historical fixtures as far as the evidence reader is concerned.

**Consequence**: the reviewer sees "evidence unavailable" and is told to consult the source video. Even if the server-side SoD gate let the founder approve, the eligibility check would ALSO push `HISTORICAL_EVIDENCE_UNAVAILABLE` and the draft would be ineligible.

### 4.2 Validation-row absence (BLOCKER)
Direct DB check: 4Y-N run has **0 `TrainingQuestionAiValidation` rows** across all 37 drafts (vs 5 for historical `run_hist_6d4h_ep_train_6c_11`). `reviewer-eligibility.ts:108` requires `latestValidation`; its absence pushes `VALIDATION_ROW_MISSING`. No code path in `src/lib/hr/training/` writes `TrainingQuestionAiValidation.create(...)` — `approval-service.ts` only *updates* an existing row's `verifiedCorrectAnswerSnapshotJson`.

**Combined with §4.1, this means no 4Y-N draft (and no 4Y-M draft) is approvable through the UI or through the server. The review → approve → promote chain is physically unreachable until a worker emits both artefacts.**

### 4.3 Question-quality spot-check
Independent of the review-surface gaps, the first draft reads as a plausible training question. The model's answer D matches the policy described in the 4Y-N transcript segments 15–29. The cited segment set is coherent. This matches the 4Y-N acceptance finding that the content is factually grounded.

Minor residue noted in 4Y-N acceptance is still present: a few questions include the suffix "according to the transcript segment N" as a stylistic artifact; content is correct. No further invented facts observed.

---

## §5 Course assembly

- Assembly panel renders the heading + description + the empty-state hint.
- Zero `APPROVED_DRAFT` rows → nothing promotable.
- Zero editor-authored checkpoints on this version → even with approved drafts, CHECKPOINT-destined promotions would need a checkpoint-first authoring pass in the TimelineEditor.
- `TrainingQuestionAiDraftPromotion` count: **0**. No drafts have been promoted to `TrainingQuestion`.
- **Course remains DRAFT** (`publishedAt: null`). Publish gate intact.

**No promotions executed in this slice. Nothing to assemble.**

---

## §6 Employee preview

- No dedicated "preview as employee" surface exists in the admin AI Workspace. The Preview panel only offers a link back to the editor.
- The real employee runtime (`src/app/employee/(authed)/safety-training/[versionId]`) is gated on `getEmployeePortalPrincipal`. The admin session is NOT an `EmployeePortalPrincipal`, so navigation to `/employee/safety-training/<vId>` returned HTTP 200 but redirected to `/employee/login`.
- **Admin cannot drive the employee preview with their own session.** A disposable employee fixture (impersonation / preview-as-employee flow) is not wired.

Features that the underlying `CoursePlayer.tsx` DOES support (code-audited):
- Checkpoint interrupt at `atSecond` with `requiredToProceed` + `maxRetries`.
- `secondsWatched` accumulates only on real playback (seeks don't count).
- Server-side grading only (no `isCorrect` crossing to the client).
- Pass/fail UX with Retake respecting the per-attempt policy.

**None of the above was exercised live in this slice** — doing so requires either an employee login or an admin impersonation mechanism that currently doesn't exist.

---

## §7 Question-type coverage

| Type | Editor | Employee runtime | 4Y-N drafts |
|---|---|---|---|
| `SINGLE_CHOICE` | ✓ | ✓ | 37 of 37 |
| `MULTI_ANSWER` | ✓ | ✓ | 0 |
| `TRUE_FALSE` | ✓ | ✓ | 0 |

- `QuizEditor.tsx` renders all three types with the correct controls (radio / checkbox / forced-True-False).
- `CoursePlayer.tsx` grades all three types.
- Reviewer-eligibility (`reviewer-eligibility.ts:51`) only lists SINGLE_CHOICE + TRUE_FALSE as `APPROVABLE_QUESTION_TYPES` — **MULTI_ANSWER is explicitly refused by the approval contract** (comment: "until a separate slice extends the contract to carry a multi-index selection"). Documented gap for future founder-authorised work.
- 4Y-N generation output is entirely SINGLE_CHOICE (deterministic Qwen preference); 4Y-N acceptance already documented this as a prompt-tuning follow-up.

---

## §8 Visual + UX acceptance

Screenshots (full-page) captured at 1600 × 1100 desktop and 390 × 844 mobile:
- `test-results/4yo-01-ai-workspace-landing.png`
- `test-results/4yo-02-ai-workspace-review-tab.png`
- `test-results/4yo-03-persisted-review-detail.png`
- `test-results/4yo-04-persisted-review-detail-scrolled.png`
- `test-results/4yo-05-ai-workspace-assemble-tab.png`
- `test-results/4yo-06-ai-workspace-preview-tab.png`
- `test-results/4yo-07-editor-landing.png`
- `test-results/4yo-08-editor-middle.png`
- `test-results/4yo-09-editor-bottom.png`
- `test-results/4yo-10-employee-player-admin-attempt.png`
- `test-results/4yo-11-ai-workspace-mobile.png`
- `test-results/4yo-12-ai-workspace-mobile-review.png`

### Observed
- Premium editorial typography on the AI Workspace heading + stepper — matches Spectre accepted design language.
- Stepper state badges (READY / COMPLETED / BLOCKED / AVAILABLE / DRAFT) are legible and semantically distinct.
- Review queue uses truncated topic titles + "NEEDS REVIEW" + "Pending validation" badges — scannable.
- Persisted review detail renders a clean three-column layout: queue / question + options / source-evidence sidebar.
- Workflow footer summary ("Generated → Validation → Manager review → Approved draft. An approved draft remains an unpublished draft. Publication requires a separate authorised step.") is a nice executive affordance.
- Mobile: the stepper collapses legibly. The queue column drops below the detail. No horizontal scroll.

### UX gaps worth flagging
- The disabled-button tooltip `title="Not implemented in this slice."` on the Approve button is MISLEADING when the real reason is "you lack permission" — the surrounding banner explains it, but the hover affordance confuses the user. Tooltip should route to the eligibility explanation.
- The "HISTORICAL EVIDENCE UNAVAILABLE" banner is confidently wrong for 4Y-M/4Y-N drafts (§4.1). It tells the reviewer to watch the video, when in reality the transcript text IS available in `TrainingTranscriptSegment`.
- No "where am I?" breadcrumb inside the persisted-review surface — the sidebar's current context is "Ai Training → Review → Persisted", which is correct but low-affordance for a first-time reviewer.

---

## §9 Deliverables + classification

| Axis | Status |
|---|---|
| AI generation | **ACCEPTED** (per 4Y-N; 37 drafts grounded + verbatim-quoted, zero dedup drops) |
| Human review | **BLOCKED** — two concrete gaps: (1) worker doesn't write `TrainingQuestionAiValidation` rows → eligibility `VALIDATION_ROW_MISSING`; (2) worker doesn't link `groundingProjectionId` → evidence-reader false-classifies as `historical-unavailable`. Reject / Edit / Revalidate / Request regeneration are explicit disabled UI stubs. SoD *enforcement* is functional. |
| Course assembly | **BLOCKED (downstream of review)** — 0 APPROVED_DRAFT rows. Also requires editor-authored checkpoints to exist on the version (currently 0). |
| Employee preview | **BLOCKED (no admin-side preview-as-employee)** — the preview panel only links to the editor. The real employee runtime requires an `EmployeePortalPrincipal`; admin sessions are refused. |
| Founder-testable | **PARTIAL** — the founder can log in, open the AI Workspace, read the drafts' questions + options + model-selected answers + segment citations + source-evidence sidebar. The founder CANNOT drive approval, cannot promote, cannot preview as an employee without a separate reviewer fixture + validation-row + grounding-projection pipeline. |

### Exact blockers to founder acceptance

1. **Worker must write a `TrainingTranscriptAiValidation` row for every draft it persists.** Approval-service only UPDATES an existing row; the generation pipeline must now be the one to create it. Expected shape per `approval-service.ts:594` audit path.
2. **Worker must bind drafts to a `TrainingGroundingProjection` row via `groundingProjectionId`.** `worker-handler.ts:363` currently sets the `groundingProjectionSha256` scalar to a placeholder; the FK is left NULL. The `TrainingGroundingProjection` model exists in schema but the worker never creates one.
3. **Reviewer fixture**: zero `TRAINING_AI_REVIEWER` users on this club. A disposable reviewer identity is needed for end-to-end approval demos. (4Z-E / 4Z-F previously did this synthetically; the fixtures have since been cleaned up.)
4. **TimelineEditor checkpoint authoring**: this version has zero editor-authored checkpoints. Even after approval, CHECKPOINT-destined promotions require pre-authored checkpoints to target.
5. **Preview-as-employee mechanism**: no admin-side flow that boots the employee runtime with a disposable preview principal. The current PreviewPanel is a static link back to the editor.

### Direct staging URL (founder-testable)

`https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/ai-workspace`

Shows: the AI Workspace with the 37 4Y-N drafts visible in the
Review queue, the "Approval unavailable" SoD banner on every draft
for the founder, and the empty Assembly panel. Each draft's question
text, model-selected answer, and cited transcript segments render
correctly even though the evidence sidebar is falsely labelled
"historical."

---

## §10 Mandatory STOP compliance

- ✓ No new Whisper or Qwen inference
- ✓ No production changes
- ✓ No new tenants or videos
- ✓ No bulk approval of drafts (zero approvals performed)
- ✓ No automatic promotion
- ✓ No course publication
- ✓ No employee assignments
- ✓ No modification of the eight historical AI drafts (confirmed via DB read — 1+2=3 REJECTED + 4+1=5 REQUIRES_HUMAN_REVIEW preserved verbatim)
- ✓ No deletion or rewriting of the accepted transcript
- ✓ No Modal spending-limit changes
- ✓ No unrelated UI redesign (zero source file changes outside the test / doc additions)
- ✓ 126 WIP files preserved
- ✓ Stash `49c2af3d` untouched

---

## §11 Four-axis summary

| Axis | Status | Note |
|---|---|---|
| AI generation | **ACCEPTED** | 4Y-N delivery intact |
| Human review | **BLOCKED** | 2 code-level gaps + 1 fixture gap (§9 blockers 1, 2, 3) |
| Course assembly | **BLOCKED (downstream)** | unlocks after review + 1 editor fixture gap (§9 blocker 4) |
| Employee preview | **BLOCKED** | preview-as-employee mechanism missing (§9 blocker 5) |
| Founder-testable | **PARTIAL** | can read drafts; cannot drive approval/promote/preview end-to-end |
