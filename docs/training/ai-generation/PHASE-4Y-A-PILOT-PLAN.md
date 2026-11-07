# EP-TRAIN-4Y-A — Live AI Pilot Plan

**Status:** READ-ONLY PROPOSAL (2026-11-07). Awaits founder
authorisation before any live inference.
**Scope:** directive §9. One real video, one tenant, one DRAFT
version, one transcription job, one assessment plan, one bounded
generation run, no automatic approval, no automatic promotion, no
publication, no employee assignments.
**Companion docs:**
- [PHASE-4Y-A-LIVE-AI-PREFLIGHT.md](PHASE-4Y-A-LIVE-AI-PREFLIGHT.md) — readiness audit
- [PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md) — question-quality thresholds

**STOP boundaries carried forward**: no production, no live
publication, no employee assignment, no permanent role grants,
$10 Modal workspace cap PRESERVED, 126 unrelated WIP files
preserved.

---

## 1. Pilot shape (directive §9 one-liner)

| Dimension | Value |
|-----------|-------|
| Source video | **Silver Springs Staff Orientation** — tenant `cmrvdeny7000144372ktmmg9c`, course `cmvzs3vz9000256qcu7lfysoz`, version `cmvzs3w05000456qcgfgps7gy`, video SHA `d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29`; identical to the EP-TRAIN-6C-11 source |
| Tenant | **Silver Springs** (development tenant; no production obligations) |
| Course version | **DRAFT** (preserved as DRAFT throughout pilot; no transition) |
| Transcription jobs | **1** bounded, `maxAttempts=1` |
| Assessment plans | **1** (baseline, deterministic) |
| Generation runs | **1** bounded, `maxAttempts=1`, `targetTotalQuestions = 6` |
| Modal workspace | `spectreautomation-admin` |
| Functions used | `spectre-training-transcribe` (new deployment) + `spectre-training-generate` (redeploy on Bearer contract) |
| GPU family | **A10** (matches 6C-11 baseline; no L40S upgrade for first pilot) |
| Bearer token | `MODAL_SPECTRE_SHARED_TOKEN` (32+ hex bytes, random, never logged) |
| Pilot budget cap | **G.E $100** Modal spend ceiling (expected actual: ~$0.11 per end-to-end run; $2 for 15 runs) |
| Human roles | 1 Admin operator (founder or designate) + 1 synthetic or real `TRAINING_AI_REVIEWER` + 1 `CLUB_ADMIN` (per 4Z-F) |
| Automatic approval | **NEVER** — every proposed question MUST pass through 4N human review |
| Automatic promotion | **NEVER** — every promotion is an explicit `CLUB_ADMIN` action |
| Publication | **NEVER** — DRAFT only |
| Employee assignments | **NONE** |

---

## 2. Two pilot shapes considered

### 2.1 Shape A (recommended) — reuse EP-TRAIN-6C-11 Silver Springs DRAFT

Reuses the exact Silver Springs course / version / video SHA / 7
grounding passages already established in 6C-11. The grounding
projection SHA is byte-identical to the 6C-7 baseline
(`0549c7e34b8c81129ee138a7a8c6fffab4e8d0ac061ea2c833f4d5056daaa0d6`),
so segment indices are reproducible.

Advantages:
- Zero new uploads; zero new R2 bytes.
- Rubric scoring is directly comparable to 6C-11's 74.8/100
  baseline — the pilot's own quality is measurable against prior
  art.
- Excluded segments 16, 17 already enforced throughout the
  4L / 4W / 4M pipeline.

Risk:
- The 4V transcription stage will re-produce segments (Modal
  faster-whisper → 4L ingest). Even though the grounding projection
  SHA matches the 6C-7 baseline byte-identically, a fresh
  transcription may yield a different segment index map (model
  versions drift). **The pilot plan explicitly tests this** (§5.3
  below).

### 2.2 Shape B (not recommended for first pilot) — new short video on a dedicated pilot course

Upload a 60-90 s synthetic safety clip (Spectre-authored, §D of
EP-TRAIN-6A-2) to a brand-new DRAFT course on Silver Springs.
Clean separation from 6C-11 grounding infrastructure.

Advantages:
- Fresh baseline; unambiguous attribution of pilot output.

Disadvantages:
- Zero prior art for comparison.
- Fresh grounding projection + fresh segment indices every run —
  more variables to bisect if something goes wrong.

**Recommendation**: Shape A for the first pilot. Shape B only
AFTER Shape A's rubric clears acceptance.

---

## 3. Exact preflight checks (zero writes)

All checks are **read-only**. Any failure STOPS the pilot before
the first Modal call.

### 3.1 Spectre-side state verification

1. **Branch tip**: `git log -1 --format='%H' ep-train-6d-4z-f/two-role-workflow`
   → `7a2d31ca` (confirmed by this preflight).
2. **Staging image**: `flyctl releases list --app spectre-staging`
   → current `v1098` image `sha-e7fbb0b158cd`.
3. **Health check**: `curl https://staging.spectreautomation.com/api/health`
   → HTTP 200 with `ok: true`.
4. **4Y workspace reachable**:
   `GET /app/admin/people/safety-training/<courseId>/<versionId>/ai-workspace`
   returns 200 for an authenticated `CLUB_ADMIN` founder session.
   The 4Y page renders the stepper, every stage label visible.

### 3.2 Source-video verification (§3.2 of preflight)

5. `TrainingCourseVersion.findUnique({ where: { id: cmvzs3w05000456qcgfgps7gy }})`
   → row exists; `course.clubId = cmrvdeny7000144372ktmmg9c`.
6. `videoSha256 = d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29`.
7. `videoDurationSec ≥ 131` (passage 18 ends at 131.40 s).
8. `resolveDocumentStorage({clubId: silverSprings}).head({storageKey})`
   → true.
9. Authenticated Range request `GET /api/hr/training/versions/.../video`
   → 206 Partial Content.

### 3.3 Fly secret presence

10. `flyctl secrets list --app spectre-staging` includes
    `MODAL_TRANSCRIBE_URL`, `MODAL_GENERATE_URL`,
    `MODAL_SPECTRE_SHARED_TOKEN` (presence check; VALUES NEVER
    PRINTED).
11. Same three secrets on `spectre-staging-worker`.

### 3.4 Modal workspace state

12. `modal workspace current` → `spectreautomation-admin`.
13. `modal app list` → shows `spectre-training-transcribe` AND
    `spectre-training-generate` as DEPLOYED.
14. `modal secret list` → shows `spectre-training-runtime-hmac`
    (or equivalent name consistent with the chosen auth scheme).
15. Workspace spend cap unchanged: $10 USD (operator reads from
    Modal Settings UI).

### 3.5 Role assignment verification

16. The designated real `TRAINING_AI_REVIEWER` user has been
    granted the role on Silver Springs via `/app/admin/settings/users`
    (operator confirms in UI; no direct DB query).
17. The pilot Admin operator holds `CLUB_ADMIN` on Silver Springs.
18. Founder account unchanged — zero permission grants, zero role
    changes.

### 3.6 No concurrent jobs on the target version

19. `TrainingTranscriptionJob` where
    `courseVersionId = cmvzs3w05000456qcgfgps7gy` AND
    `state IN ('REQUESTED','QUEUED','RUNNING')` → zero rows.
20. `TrainingQuestionGenerationRun` same version AND
    `executionStatus IN ('REQUESTED','QUEUED','RUNNING')` → zero
    rows.

### 3.7 Historical preservation

21. Marc Fire INITIAL OUTSTANDING (per 5D-3C-B memory) and all 9
    founder completions on Coulee Ridge ORIENTATION_2027 are
    UNTOUCHED. (The pilot does not operate on that course, but a
    read-only check reassures the founder.)
22. Silver Springs course version — count of `TrainingQuestion`
    rows BEFORE the pilot captured. Pilot MUST NOT reduce that
    count.

**If any check 1-22 fails, STOP and report. No Modal call.**

---

## 4. Execution sequence

**Operator identities (per 4Z-F pattern):**

- **Admin operator** — `CLUB_ADMIN` on Silver Springs; drives the
  AI-workspace clicks + promotion.
- **Reviewer** — `TRAINING_AI_REVIEWER` on Silver Springs;
  independent session; drives the 4N approval dialog.
- **Founder** — observer only; no clicks, no attribution.

All actions MUST be clicked via the 4Y workspace UI. No developer
script replaces any manager-facing action.

### 4.1 Phase A — Transcription (one bounded job)

| Step | Who | Action | Expected |
|------|-----|--------|----------|
| A.1 | Admin | Open `.../ai-workspace`, confirm Stage 1 badge "no transcript". | — |
| A.2 | Admin | Click **Request transcription** → POST `/api/admin/training/versions/.../transcribe` with `maxAttempts=1`. | 200 `{jobId, state: 'QUEUED', idempotent: false}` |
| A.3 | — | Poll `.../transcription-status` every 5 s. | `state`: `QUEUED → RUNNING → COMPLETED` |
| A.4 | Worker | Claims job, calls Modal `/transcribe` with signed R2 URL. | Modal returns `audioSha256`, segments, `elapsedMs`. |
| A.5 | Worker | Verifies `audioSha256 === videoSha256`. | Match (else SHA_MISMATCH TERMINAL) |
| A.6 | Worker | 4L ingest writes `TrainingTranscriptBuild` + segments + `TrainingGroundingProjection`. Segments 16/17 excluded from grounding citations (but persisted as segments). | Build row created; grounding projection SHA computed. |
| A.7 | Admin | 4Y renders Stage 1 "complete"; Stage 2 unlocks. | Transcript panel shows ≥ 20 segments. |

**Abort conditions (TERMINAL):** `SHA_MISMATCH` | `MODAL_HMAC_INVALID`
| `MODAL_BODY_INVALID` | `INGEST_FAILED`. In all cases: Admin
captures evidence, halts, and reports in the acceptance doc §4.

### 4.2 Phase B — Assessment plan

| Step | Who | Action | Expected |
|------|-----|--------|----------|
| B.1 | Admin | 4Y auto-computes a baseline plan from the just-ingested transcript. | Plan preview: learningObjectiveCount ≥ 2, checkpointCount ≥ 2, finalAssessmentCount ≥ 4. |
| B.2 | Admin | Inspect proposed boundaries in the Stage 3 panel. Reject if any boundary falls inside an excluded segment (16, 17) or produces a checkpoint < 15 s or > 90 % through the video. | Plan accepted. |

### 4.3 Phase C — Generation (one bounded run)

| Step | Who | Action | Expected |
|------|-----|--------|----------|
| C.1 | Admin | Click **Start generation** → POST `/api/admin/training/versions/.../generate` with `targetTotalQuestions = 6`, `maxAttempts = 1`. | 200 `{runId, state: 'QUEUED'}` |
| C.2 | — | Poll `.../generation-status` every 5 s. | `state`: `QUEUED → RUNNING → COMPLETED` |
| C.3 | Worker | Claims run, iterates each group (checkpoints × 2 + final × 10 ≈ 12 Modal calls), each call Bearer-authed, each response HMAC-verified. | ≥ 6 proposals surface (some rejected lexically, that's OK). |
| C.4 | Worker | For each proposal, runs `evaluateAgainstPriors` lexical dedup. Surviving proposals persist as `TrainingQuestionAiDraft` rows (state `REQUIRES_HUMAN_REVIEW`) with `validatorSource = "integrated-pipeline"`. | At least 1 proposal per checkpoint + 4 for final survives dedup. |
| C.5 | Admin | 4Y renders Stage 4 "complete"; drafts visible in the Review Queue. | ≥ 6 drafts total. |

**Abort conditions (TERMINAL):** `CREDENTIAL_ABSENT` |
`MODAL_HMAC_INVALID` | daily cost cap tripped (`DEFAULT_DAILY_USD_MICROS`
exceeded on the rolling 24 h) | any single Modal call exceeds
60 s (operator-imposed soft cap on first-pilot behaviour).

### 4.4 Phase D — 4N human review

| Step | Who | Action | Expected |
|------|-----|--------|----------|
| D.1 | Reviewer | Log in as the designated real `TRAINING_AI_REVIEWER` in a SEPARATE browser session (never the Admin operator's session). | — |
| D.2 | Reviewer | Open each draft via the Review Queue. | Dialog opens. |
| D.3 | Reviewer | For each draft: inspect grounding passages + source-segment citations + distractors; verify the correct-answer radio selection matches the source material; tick the attestation checkbox; click **Approve** OR click **Reject** with reason. | `reviewedByUserId` recorded + draft transitions to `APPROVED_DRAFT` or `REJECTED`. |
| D.4 | Reviewer | After each approval, close the dialog and verify the draft row's "Approved" badge in the queue. | Badge visible. |

**Attribution invariant**: every `reviewedByUserId` MUST equal the
real reviewer's `User.id`. Zero founder attributions in the
`TrainingQuestionAiReview` table rows created by this pilot.

### 4.5 Phase E — 4T promotion

| Step | Who | Action | Expected |
|------|-----|--------|----------|
| E.1 | Admin (CLUB_ADMIN) | In the Course Assembly UI, for each APPROVED_DRAFT: choose destination (specific checkpoint OR Final Assessment); click **Promote**. | 4T promotion service runs 7 re-checks → `TrainingQuestion` row + options inserted; `TrainingQuestionAiDraftPromotion` sidecar recorded with `promotedByUserId = adminId`, `approvedByUserId = reviewerId`. |
| E.2 | Admin | Reload the version editor. | Promoted questions visible; "Already promoted" state persists. |
| E.3 | Admin | Open the publish-readiness panel. **Do NOT click Publish.** | Publish-readiness card renders, lists the new questions as pending. |

**Promotion attribution invariants**:
- `promotedByUserId = Admin operator id`
- `approvedByUserId = Reviewer id`
- No row with `promotedByUserId = Reviewer id`
- No row with `approvedByUserId = Admin operator id` (unless Admin is also reviewer, which is prohibited by 4Z-F pattern)
- Zero founder attributions in either column.

### 4.6 Phase F — Rubric scoring (parallel to 4N/4T)

The real reviewer scores each surviving candidate against the 6
rubric criteria (see
[PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md)
§7). Average score + per-criterion average captured for the
acceptance report. No code; manual review + scratchpad JSON.

### 4.7 Phase G — Preview

| Step | Who | Action | Expected |
|------|-----|--------|----------|
| G.1 | Admin | Open the employee-preview surface (admin-impersonate-employee is NOT required; admin can preview via the existing authoring preview on `TrainingCourseVersion`). | Promoted questions render inline. |
| G.2 | Admin | Verify checkpoint questions fire at correct timestamps on video playback. | Checkpoints align with boundaries. |

No assignment, no obligation issuance, no employee seat used.

---

## 5. Monitoring

### 5.1 Live monitoring surfaces

| Surface | What to watch | Trigger to halt |
|---------|---------------|-----------------|
| Modal dashboard container page | Active containers for `spectre-training-*` | > 2 concurrent containers OR container running > 2 min |
| Modal dashboard cost page | Running total for the pilot | Approaching 50 % of G.E $100 cap |
| Fly `spectre-staging-worker` logs | `queue.handler.training_*` entries | Any ERROR / FATAL log |
| Fly `spectre-staging` logs | 503 responses from `/api/admin/training/versions/.../transcribe` or `/generate` | Any 500 or unexpected shape |
| `TrainingTranscriptionJob` + `TrainingQuestionGenerationRun` tables | Row states + `failureCode` + `failureMessage` | Any FAILED row without expected `failureCode` |
| Audit log | `hr.training.transcription.*` + `hr.training.generation.*` + `hr.training.ai.review.*` + `hr.training.ai.promotion.*` | Any missing audit for a state change |

### 5.2 Operator discipline

- All logs tailed in **operator-only terminals**. No log output
  is shared; every secret is redacted at source (Spectre code
  guarantees no token logging — verify by scanning logs for
  substrings of the token tail is PROHIBITED; trust the code).
- Terminal captures saved to the session scratchpad
  (`C:\Users\cturcato\AppData\Local\Temp\claude\…\scratchpad\ep-train-4y-a\`).
  Never committed.

### 5.3 Integrity gates during the run

| Gate | Check | When |
|------|-------|------|
| SHA parity | `audioSha256` from Modal = `videoSha256` from DB | At A.5 |
| Grounding projection parity | New projection SHA vs 6C-7 baseline `0549c7e…0d6` | After A.6 — **flag** divergence, do NOT abort (model drift is allowed) |
| Segment 16/17 exclusion | 0 grounding citations against segment 16 or 17 | After A.6 |
| Prompt canonicalisation | ASCII-only in all pilot-authorisation / prompt scope fields (per 6C-11 §4.2 em-dash lesson) | Before C.1 |
| Daily cost cap | `claimNextGenerationRun` must accept the first run | At C.1 |
| Attribution | `reviewedByUserId ≠ founderId`; `promotedByUserId ≠ reviewerId`; `promotedByUserId ≠ founderId` | After D.4 and E.1 per row |
| Zero DB mutations outside expected rows | Version `updatedAt` unchanged; no new `TrainingCompletion` row; no obligation change | End-of-pilot |

---

## 6. Rollback

### 6.1 Reversible by design

- All writes are DB inserts into tables (`TrainingTranscriptionJob`,
  `TrainingTranscriptBuild`, `TrainingTranscriptSegment`,
  `TrainingGroundingProjection`, `TrainingCheckpointProposal`,
  `TrainingQuestionGenerationRun`, `TrainingQuestionAiDraft`,
  `TrainingQuestionAiValidation`, `TrainingQuestionAiReview`,
  `TrainingQuestion`, `TrainingQuestionOption`,
  `TrainingQuestionAiDraftPromotion`).
- Zero updates to existing data (`TrainingCourseVersion.state`
  remains DRAFT; `TrainingCompletion`s untouched; obligations
  untouched).

### 6.2 Rollback procedure if the pilot is aborted

1. **Halt immediately**: operator presses "Cancel" on any RUNNING
   job via the 4Y workspace; the service marks the job CANCELLED,
   the worker drops late Modal responses.
2. **Stop Modal apps**: `modal app stop spectre-training-generate`
   + `modal app stop spectre-training-transcribe`. Confirm zero
   active containers via `modal container list`.
3. **Unset Fly secrets** (optional, per G.F if no further work
   authorised): `flyctl secrets unset MODAL_TRANSCRIBE_URL
   MODAL_GENERATE_URL MODAL_SPECTRE_SHARED_TOKEN --app
   spectre-staging --app spectre-staging-worker`.
4. **Audit record**: operator writes `scratchpad/ep-train-4y-a/pilot-aborted.json`
   with phase, step, failureCode, rollback actions taken.
5. **No app redeploy required** (no application code changed).

### 6.3 Keeping the artefacts for forensics

Even on abort, keep:
- The `TrainingTranscriptionJob` row (state CANCELLED | FAILED).
- Any `TrainingTranscriptBuild` + segments produced.
- Any `TrainingQuestionGenerationRun` row.
- Any `TrainingQuestionAiDraft` rows (state REQUIRES_HUMAN_REVIEW).
- Audit log entries.

Clean up only at explicit founder authorisation (Phase H §7).

---

## 7. Cleanup (Phase H)

On a successful pilot OR after forensic review of an aborted run:

| Step | Action | Who |
|------|--------|-----|
| H.1 | Delete the pilot drafts + validations + reviews + promotions via a parameterised Prisma script (executed by the pilot operator on staging DB, bounded `WHERE clubId = silverSprings AND versionId = cmvzs3w05000456qcgfgps7gy AND createdAt > <pilot_start>`). No cross-tenant reach. | Admin operator |
| H.2 | Delete the `TrainingQuestion` rows promoted during the pilot (via same parameterised script). The sidecar `TrainingQuestionAiDraftPromotion` MUST be deleted BEFORE the `TrainingQuestion` row (RESTRICT FK). | Admin operator |
| H.3 | Delete the `TrainingQuestionGenerationRun` + `TrainingCheckpointProposal` rows. | Admin operator |
| H.4 | Delete the `TrainingGroundingProjection` + `TrainingTranscriptSegment` + `TrainingTranscriptBuild` rows for the pilot build. | Admin operator |
| H.5 | Delete the `TrainingTranscriptionJob` row. | Admin operator |
| H.6 | `modal app stop spectre-training-generate` and `spectre-training-transcribe`. `modal app list` reports zero deployed rows. | Operator |
| H.7 | `modal container list` returns zero active containers. | Operator |
| H.8 | Rotate the Modal workspace secret (`spectre-training-runtime-hmac` or the equivalent for the chosen auth scheme). `modal secret create --force`. | Operator |
| H.9 | **(Optional)** `flyctl secrets unset MODAL_* --app spectre-staging --app spectre-staging-worker`. Only if no further authorised work scheduled. | Operator |
| H.10 | Residue verification SQL (parameterised): 0 rows in each of the 10 pilot-touched tables for the pilot window. | Operator |
| H.11 | Historical preservation verification: Marc Fire INITIAL OUTSTANDING + 9 Chris Coulee Ridge completions UNCHANGED. | Operator |
| H.12 | Modal dashboard: pilot spend < $5 USD (if far off, flag as a defect). | Operator |

### 7.1 Zero GPU running at the end

Per directive §5 "How to verify zero running GPU containers
afterward": operator runs `modal container list` and attaches the
stdout (0 rows) to the acceptance doc §12.

---

## 8. Explicit go/no-go gates at each phase

| Phase | Gate | GO condition | NO-GO consequence |
|-------|------|--------------|---------------------|
| A — Transcription | Preflight checks 1-22 all pass | yes | STOP; report BLOCKED |
| A — Transcription complete | Build row written; SHA parity OK; 0 citations on segments 16/17 | yes | Do not proceed to Phase B |
| B — Plan accepted | Plan has ≥ 2 checkpoints + 4 final; no boundary in 16/17; no checkpoint < 15 s or > 90 % | yes | Do not proceed to Phase C |
| C — Generation complete | ≥ 6 surviving drafts; daily cost cap not tripped; no `CREDENTIAL_ABSENT` | yes | Do not proceed to Phase D |
| D — Review | Every draft has an explicit reviewer action (approve / reject); attribution verified | yes | Do not proceed to Phase E |
| E — Promotion | Every APPROVED_DRAFT either promoted or explicitly skipped; attribution verified | yes | Do not proceed to Phase F |
| F — Rubric | Average rubric ≥ **70 / 100** OR a documented regression vs 6C-11's 74.8 baseline with founder-reviewed explanation | yes | Continue to Phase G but flag |
| G — Preview | Promoted questions render in the authoring preview; checkpoints fire at correct timestamps | yes | STOP; investigate before cleanup |
| H — Cleanup | All 12 cleanup verifications pass; historical preservation intact | yes | STOP cleanup; founder review required |

---

## 9. Pilot timeline (expected wall-clock)

| Phase | Expected duration |
|-------|-------------------|
| Preflight checks 1-22 | 15 min |
| A Transcription (bounded 1 job) | 2 min wall-clock (Modal ~30 s + ingest ~90 s) |
| B Plan review | 10 min |
| C Generation (bounded 1 run, ~12 Modal calls) | 5 min wall-clock (cold boot + 12 warm calls) |
| D Review (6 drafts × ~5 min per draft) | 30 min |
| E Promotion | 10 min |
| F Rubric scoring | 60 min (per 6C-11 "35-50 min reviewer time" extrapolated) |
| G Preview | 15 min |
| H Cleanup | 30 min |
| **Total** | **~3 h** |

---

## 10. Interactions with current staging state

### 10.1 What the pilot touches on Silver Springs

- Inserts into 10 pilot-named tables (listed in §6.3 + §7).
- No updates to `TrainingCourseVersion` (`state` remains DRAFT;
  `updatedAt` unchanged).
- No changes to Silver Springs's existing `TrainingQuestion` row
  count on other versions.
- No cross-tenant reach.

### 10.2 What the pilot does NOT touch

- Coulee Ridge tenant (ORIENTATION_2027 v4 + 9 Chris completions
  + Marc Fire INITIAL OUTSTANDING).
- Any other Silver Springs training course / version.
- `TrainingCompletion` rows on any tenant.
- `TrainingObligation` rows on any tenant.
- `User` / `UserClubRole` / `Session` rows.
- `AuditLog` rows unrelated to the pilot.
- 126 unrelated WIP files on
  `staging-deploy/web1b1-framer-fidelity` (branch not merged, tree
  not touched).

### 10.3 Concurrent-work isolation

If any other staging work is active during the pilot window
(e.g. another operator's checkpoint on a different course), the
pilot does not block it — the pilot's DB writes are all behind
tenant-scoped `clubId = silverSprings` + versionId gates. The
Modal workspace cap ($10) is the single shared ceiling; operator
monitors continuously.

---

## 11. STOP boundaries re-confirmed

| STOP | Honoured by this plan? |
|------|-------------------------|
| No publication | YES — `publicationProhibited: true` enforced via DRAFT state + no Publish click |
| No employee assignment | YES — no `TrainingObligation` write path in any pilot phase |
| No permanent role grants in shared envs | YES — reviewer role granted for the pilot window only, revoked at H.9 or next cleanup |
| No historical-candidate modification | YES — Silver Springs course version state not changed; Coulee Ridge not touched at all |
| No Modal spend-limit change | YES — $10 cap preserved |
| No automatic retries without authorisation | YES — `maxAttempts=1` on first runs |
| Preserve 126 WIP files | YES — pilot does not touch the staging-deploy/web1b1 branch |

---

## 12. Final-response shape for the acceptance doc

When the pilot runs, the acceptance deliverable must include:

1. **Preflight evidence** — the 22 checks (yes/no + evidence pointer).
2. **Phase-by-phase evidence** — step numbers, actual timestamps,
   job ids, draft ids, question ids, screenshot paths.
3. **Attribution table** — every row of
   `TrainingQuestionAiReview` + `TrainingQuestionAiDraftPromotion`
   touched by the pilot, with `reviewedByUserId` /
   `promotedByUserId` / `approvedByUserId` verified ≠ founderId.
4. **Rubric table** — per-candidate 6-criteria scores +
   editorial disposition (matching 6C-11's §6 shape).
5. **Modal cost evidence** — screenshot of the workspace cost
   page; total < $5 USD.
6. **Zero-GPU verification** — `modal container list` + `modal app list`
   outputs.
7. **Cleanup verification** — residue SQL results (0 rows in each
   of the 10 tables).
8. **Historical preservation** — Marc + 9 Chris completions
   unchanged.
9. **Known failure modes observed** — compared to 6C-11's TRUE_FALSE
   over-preference, attribution confusion, invented interpretation,
   verbose stems, thin-passage drift.
10. **Decision**: READY FOR FOUNDER REVIEW / BLOCKED / NEEDS
    REWORK.

**End of pilot plan.**
