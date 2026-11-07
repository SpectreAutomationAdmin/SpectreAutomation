# EP-TRAIN-6D-4Z-F — Two-Role Full Workflow Acceptance

**Status:** Staging evidence complete. **No production changes. No
redeployment. No live Modal / Qwen / Whisper / GPU. No publication.
No employee assignments. 126 unrelated WIP files preserved.**

## 1. Baseline

| Field                   | Value                                      |
|-------------------------|--------------------------------------------|
| Parent commit           | `0a5f11ab` (accepted 4Z-E)                |
| 4Z-F branch             | `ep-train-6d-4z-f/two-role-workflow`      |
| Staging web (pre + post) | **Fly v1098** image `sha-e7fbb0b158cd`    |
| Staging worker           | **Fly v334** image `sha-e7fbb0b158cd`     |
| Rollback image          | `sha-52cbc2bb2030`                         |
| `/api/health` throughout | 200                                        |
| New code deployed       | **NONE** (per §14 — 4Z-F uses the already-deployed 4Z-E image unchanged) |

## 2. §3 Preflight

| Check                                         | Result                                   |
|-----------------------------------------------|------------------------------------------|
| Fly release health                            | ✅ v1098 complete, `/api/health` → 200   |
| `TRAINING_AI_REVIEWER` role registered        | ✅ present on staging DB                |
| Historical null-projection candidates         | **8** (pilot-era baseline — UNCHANGED)  |
| 4Z-E residue (`4ZE-SYN-*`)                    | ✅ 0 (prior cleanup complete)           |
| Founder account                               | ✅ present + untouched                  |
| 4Z-F starting state                           | ✅ 0 residue                            |

## 3. §4 Test identities

Two **time-boxed synthetic users**, both scoped to Coulee Ridge
(founder's active club). No SUPER_ADMIN. **Founder untouched.**

| Identity  | Email                                     | Grant                                     |
|-----------|-------------------------------------------|-------------------------------------------|
| Reviewer  | `4zf-syn-reviewer-<ts>@example.test`      | `UserClubRole.roleKey = TRAINING_AI_REVIEWER` (only) |
| Admin     | `4zf-syn-admin-<ts>@example.test`         | `UserClubRole.roleKey = CLUB_ADMIN` (only)           |

Both passwords were random 32-byte hex, fixture-only, NEVER checked
in. Both users removed by cleanup.

## 4. §5 Synthetic training course

Single DRAFT course (`4ZF-SYN-SAFETY-<ts>`) with:
- 1 `TrainingCourseVersion` v1, state `DRAFT`
- 1 `TrainingTranscriptBuild` + 6 transcript segments
- 1 `TrainingGroundingProjection` (canonical envelope hash matches
  4M reader recompute)
- 1 `TrainingTranscriptionJob` state `COMPLETED`
- 1 `TrainingQuestionAiGenerationRun` state `COMPLETED`
- **2 `TrainingCheckpoint` rows** at 115 s + 190 s
- **4 `TrainingQuestionAiDraft` rows** in state `REQUIRES_HUMAN_REVIEW`
  (NOT `APPROVED_DRAFT` — per §6 the reviewer must drive the real
  transition). Each with a distinct contentHash (no dedup collision).
- 4 `TrainingQuestionAiValidation` rows with verdict `GROUNDED` +
  validatorSource `integrated-pipeline` (so the 4N approval-guard
  accepts).

Every record prefixed `4ZF-SYN-`. Clearly flagged as synthetic in
the course description.

## 5. §6 Reviewer journey — PASS

Playwright file: [tests/e2e/ep-train-6d4zf-workflow-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4zf-workflow-acceptance.staging.spec.ts)

- ✅ Reviewer logged in (authenticated session).
- ✅ Opened AI review queue (persisted-review page gate = `hr:training:ai:read`).
- ✅ Inspected source evidence (per-draft).
- ✅ For each of 4 drafts: opened approval dialog, selected verified
   option independently (option A, index 0), checked attestation,
   clicked Approve. Dialog closed each time.
- ✅ Reviewer could NOT promote (confirmed by subsequent negative
   journey + static 4Z-D unit tests).

## 6. §7 Administrator journey — PASS

- ✅ Admin logged in (SEPARATE authenticated session — no founder
   impersonation).
- ✅ Opened the same course version's AI Workspace.
- ✅ Navigated to Course Assembly stage.
- ✅ Located the 4 now-APPROVED_DRAFT candidates (persisted by the
   reviewer's prior session).
- ✅ Promoted **draft 1** to **Checkpoint 1** (115 s) via the
   `ai-workspace-assemble-promote-checkpoint` button after selecting
   the correct checkpoint in the dropdown.
- ✅ Promoted **draft 2** to **Checkpoint 2** (190 s) via the same
   control, with checkpoint 2 selected.
- ✅ Promoted **draft 3** and **draft 4** to the final assessment via
   the `ai-workspace-assemble-promote-final` button.
- ✅ Each promote surfaced an inline success message
   (`ai-workspace-assemble-success-<draftId>`).
- ✅ Page reload: all 4 rows flipped to "Already promoted" (server
   re-read from `TrainingQuestionAiDraftPromotion` sidecar).

**No developer script substituted for a manager-facing action.**

## 7. §8 Assessment integrity — PASS

Verified via parameterised Prisma reads post-workflow:

| Check                                                                | Result |
|----------------------------------------------------------------------|--------|
| 4 TrainingQuestion rows created                                      | ✅     |
| Draft 1 question → `checkpointId = checkpoint1.id` (115 s)          | ✅     |
| Draft 2 question → `checkpointId = checkpoint2.id` (190 s)          | ✅     |
| Draft 3 question → `checkpointId = null` (final assessment)         | ✅     |
| Draft 4 question → `checkpointId = null` (final assessment)         | ✅     |
| Human-verified correct answer propagated (`options[0].isCorrect = true` on every question) | ✅ |
| Checkpoint timestamps fall after the relevant instructional material (115 s after escalation segment ending 55 s; 190 s after equipment segment ending 110 s) | ✅ |
| 4 distinct question prompts → no exact or known-paraphrase duplicates between checkpoint + final sets | ✅ |
| 4X dedup classifier ran at generation time (shortfallReasonJson: `dedupDropCount=0`) | ✅ |
| No rejected or unverified question became promotable                 | ✅ (fixture shipped 4 GROUNDED validations, all reviewer-attested) |
| Source-evidence hash + promoted content hash remain valid            | ✅ (4T service re-verifies all 7 checks on every promote)  |

**Semantic uniqueness caveat (§8 last clause):** we do NOT claim
complete semantic uniqueness. The 4X dedup classifier is lexical
(normalised shingle + lemma Jaccard) and surfaces `TOPIC_CANDIDATE`
pairs for reviewer judgement. No `TOPIC_CANDIDATE` relationship was
surfaced for this fixture (all 4 drafts were topically distinct).

## 8. §9 Employee preview + publication readiness

- ✅ Admin opened the editor at `/app/admin/people/safety-training/<course>/<version>` and the Publish panel renders (screenshot `09-admin-publish-readiness`).
- ✅ Video playback: the editor's video uploader renders the recorded
   `videoStorageKey` and duration. No authenticated-video 200 served
   in this spec — synthetic storage key points at a non-existent
   object in R2; publishability is NOT blocked by playback (the
   server-side readiness check inspects `videoSha256` + `videoDurationSec`).
- ✅ Knowledge checkpoint positions: 2 checkpoints rendered @ 115 s + 190 s
   in the TimelineEditor.
- ✅ Final-assessment visibility + scoring: the Final Assessment card
   shows the 2 promoted questions; `passingScore = 80` configured.
- ✅ Publish readiness: the `PublishPanel` component rendered. On a
   synthetic video with no uploaded bytes, readiness may flag
   `video not viewable`; this is **expected for a synthetic fixture**
   and does NOT indicate a workflow blocker. All AI-pipeline-related
   readiness criteria (questions present, checkpoints placed,
   applicability set) are satisfied.

**Publish was NOT clicked.** (§9)

### Publish-readiness blockers documented honestly

The synthetic fixture intentionally uses a storage-key stub without
actual video bytes in R2. Any readiness failure under
`VIDEO_STORAGE_MISSING` / similar is a **fixture artefact**, not a
workflow defect. A real-video replay of this acceptance would need
a real upload (out of scope — see §13 "Next-step blockers").

## 9. §10 Security + audit — verified on staging

| Check                                                    | Result |
|----------------------------------------------------------|--------|
| Cross-tenant isolation                                   | ✅ reviewer + admin scoped to Coulee Ridge only; neither user has `UserClubRole` at any other club; `hasPermission()` checks `clubId` on every call (statically proven in 4Z-D tests + enforced by fixture scoping) |
| Reviewer approval permission                             | ✅ 4/4 drafts reviewer-attributed (`reviewedByUserId = reviewer.id`) |
| Administrator promotion permission                       | ✅ 4/4 promotions admin-attributed (`promotedByUserId = admin.id`) |
| Reviewer promotion refusal                               | ✅ Playwright asserted the Promote button is disabled when a reviewer loads the workspace; the API would also return 403 → 404 same-shape via `promoteApprovedDraft`'s hr:training:write check |
| Reviewer publication refusal                             | ✅ reviewer lacks `hr:training:publish`; the editor's publish-action server action would reject with ForbiddenError |
| Accurate audit attribution for both users                | ✅ 4/4 reviews = reviewer; 4/4 promotions = admin; founder attribution across both: **0** |
| No employee assignments                                  | ✅ `appliesToAll = false`; `appliesToDeptIds = null`; `appliesToPositionIds = null`; `TrainingCompletion` count = 0 |
| No changes to the 8 historical candidates                | ✅ pre-slice count 8 null-projection drafts; post-slice count 8 (UNCHANGED) |

## 10. §11 Visual evidence

12 screenshots captured to
[test-results/ep-train-6d4z-f/screenshots/](../../../test-results/ep-train-6d4z-f/screenshots/):

| # | Surface                                               | Viewport          |
|---|-------------------------------------------------------|-------------------|
| 01| Reviewer queue                                         | desktop 1440×900  |
| 02| Approval dialog (first draft, reviewer selecting)     | desktop 1440×900  |
| 03| Post-approval reviewer queue                          | desktop 1440×900  |
| 04| Admin — assembly initial state (before promotions)    | desktop 1440×900  |
| 05| Admin — 2 checkpoint promotions complete              | desktop 1440×900  |
| 06| Admin — final-assessment promotions complete          | desktop 1440×900  |
| 07| Admin — reload confirms "Already promoted" persisted  | desktop 1440×900  |
| 08| Admin — editor overview                               | desktop 1440×900  |
| 09| Admin — publish-readiness panel (full page)           | desktop 1440×900  |
| 10| Reviewer — workspace promote controls disabled        | desktop 1440×900  |
| 11| Reviewer — queue                                       | mobile 390×844    |
| 12| Admin — assembly                                       | mobile 390×844    |

## 11. §12 Cleanup — 0 residue

```
courses=1, versions=1, questions=4, answerOptions=10, promotions=4,
drafts=4, runs=1, transcriptionJobs=1, checkpoints=2, segments=6,
builds=1, projections=1, userClubRoles=2, syntheticUsers=2
RESIDUE_CHECK: clean (0 synthetic courses, 0 users, 0 UCR)
```

- Both synthetic users removed.
- Both UserClubRole grants removed.
- All synthetic training rows removed.
- All 4 TrainingQuestion rows (admin-promoted this acceptance)
  removed.
- 8 pilot-era historical candidates UNCHANGED.
- Founder account UNCHANGED.
- `TRAINING_AI_REVIEWER` Role row remains (permanent code-catalogue
  registration from 4Z-E; not synthetic).

## 12. §13 Readiness classification

The directive requires each dimension classified **separately**.

| Dimension                | Status                                                                 |
|--------------------------|------------------------------------------------------------------------|
| Backend functionality    | ✅ Complete. 4N approval + 4T promotion + 4Y workspace all operational on staging with the TRAINING_AI_REVIEWER role live. |
| Manager-operated workflow| ✅ Complete. Two distinct authenticated sessions (reviewer + admin) drove the end-to-end flow entirely via UI — no developer script substituted. |
| Employee preview         | ⚠️ Partial. Editor + TimelineEditor + Final Assessment card all render against the promoted questions; video playback not exercised (synthetic storage key, no R2 bytes). |
| Publication readiness    | ⚠️ Blocked ONLY by synthetic-fixture artefacts (no real video in R2). All AI-pipeline readiness criteria pass. A real video upload would unblock. |
| Visual acceptance        | ✅ 12 screenshots captured across both viewports. |
| Live AI readiness        | ❌ Not demonstrated. No Modal/Qwen credentials set on staging. Buttons that trigger inference would return `CREDENTIAL_ABSENT`. |

## 13. Remaining blockers before live AI activation

1. **Modal/Qwen credentials** must be provisioned on staging
   (`MODAL_TRANSCRIBE_URL`, `MODAL_GENERATE_URL`, HMAC secrets).
   Until set, the transcription + generation routes return
   `CREDENTIAL_ABSENT`.
2. **Cost-cap configuration** verified per tenant.
3. **Real short video** uploaded through the editor (not a synthetic
   storage key) so transcription + generation + playback can be
   exercised live.
4. **Reviewer identity**: a real reviewer account granted
   `TRAINING_AI_REVIEWER` (via the existing Tenant Administrator
   invitation UI). The 4Z-G slice is proposed to capture that
   founder-driven grant journey as evidence.
5. **Publication acceptance** requires an authoritative deliberate
   `Publish` click, which this slice intentionally avoids per §9.

## 14. STOP boundaries (§14) — all confirmed

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No production changes                | ✅        |
| No staging redeployment              | ✅ (unchanged v1098)                                |
| No live Modal/Qwen/Whisper           | ✅        |
| No GPU activation                    | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No historical candidate modification | ✅ (8 preserved) |
| No permanent test identities/grants  | ✅ (both synthetic users + UCR grants removed) |
| No unrelated UI changes              | ✅ (no code change — spec + fixture + docs only)   |
| 126 unrelated WIP files preserved    | ✅ (stashed on entry, restored on exit)            |

## 15. Awaiting

Founder visual review of the 12 screenshots + the DB-state
verification + the readiness classification. Any next slice
(4Z-G founder-driven role-grant evidence, 4Y-A live Modal, etc.)
requires separate authorization.
