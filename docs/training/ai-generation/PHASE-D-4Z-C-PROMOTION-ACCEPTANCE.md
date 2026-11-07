# EP-TRAIN-6D-4Z-C — AI Question Promotion Staging Acceptance

**Status:** Staging evidence complete. No production deployment. No
live Modal/Qwen/Whisper/GPU. No publication. No employee assignments.
126 unrelated WIP files preserved.

## 1. Baseline

| Field                     | Value                                  |
|---------------------------|----------------------------------------|
| Parent commit             | `d36d2b28` (accepted 4Z)              |
| 4Z-C branch               | `ep-train-6d-4z-c/promotion-acceptance`|
| Staging web (pre + post)  | Fly **v1097** image `sha-52cbc2bb2030`|
| Staging worker            | Fly **v333**  image `sha-52cbc2bb2030`|
| Rollback anchor           | Fly v1096 image `sha-e49122690011`    |
| `/api/health` throughout  | 200                                    |
| New code deployed         | **NONE** — 4Z-C is a staging-side
  acceptance using the already-deployed 4Y workspace + 4T service.    |

## 2. §3 Preflight findings

### Staging health + release

- Fly v1097 complete, image `sha-52cbc2bb2030`, `/api/health` → 200.
- 4Y/4Z code unchanged — this slice does NOT redeploy.

### Historical candidate integrity

- `TrainingQuestionAiDraft.groundingProjectionId IS NULL` count: **8**
  (the pilot-era 6D-4H baseline). **PRESERVED** — no fixture
  touched these rows.
- Residue from 4Z (fixture rows with code starting `4Z-SYN-`): **0** —
  the 4Z cleanup worked.

### 4Z audit-attribution findings

Scanned the staging `AuditLog` table for founder-attributed events in
the 4Z deployment window (2026-11-07T02:25 — 03:05 UTC):

| Event count | Finding                                                        |
|-------------|-----------------------------------------------------------------|
| **0**       | Training-AI audit events ever attributed to founder            |
| 0           | `TrainingQuestionAiReview.reviewedByUserId == founder.id` rows |
| 0           | `TrainingQuestionAiDraftPromotion.promotedByUserId == founder` |
| 0           | `TrainingQuestionAiStateTransition.byUserId == founder.id` rows|

The 28 founder-attributed AuditLog events in that window are all
unrelated mailbox-token-refresh + reauth-required cron events (ran
background during the deploy, unrelated to 4Z). The 2 remaining
events are `auth.login_success` from the Playwright founder sessions,
which are **legitimate** attribution (the founder's credentials were
in fact used to log in).

**Audit-attribution conclusion:** 4Z's fixture `TrainingQuestionAiReview`
row attributed to the founder was deleted during the 4Z cleanup
script and left **no durable audit residue**. The fixture inserted
rows directly via Prisma without calling `audit()`, and the manager-
UI Playwright did not fire the promote endpoint (the §9 assembly-
step assertion only checked that the button was visible). **No
corrective annotation is needed; nothing to correct.**

### Recommended future guardrail (not implemented here)

For the next fixture slice, we have adopted the following rule:
**fixtures that write `TrainingQuestionAiReview.reviewedByUserId`
MUST use a dedicated synthetic user (e.g. `4z-syn-reviewer-<ts>@example.test`)
instead of attributing to the founder.** This rule is already
implemented in the 4Z-C fixture script. If a founder-attributed
review row is ever detected in the future, it can be annotated
non-destructively by adding a `reviewerNote` suffix or by adding a
separate `audit()` call tagged with the correction context — the
authoritative review row is NOT rewritten.

## 3. Synthetic fixture

### Fixture script

[scripts/ep-train-6d4zc-promotion-fixture.mjs](../../../scripts/ep-train-6d4zc-promotion-fixture.mjs)

- **Dedicated synthetic reviewer user**: `4z-syn-reviewer-<ts>@example.test`
  - name: `4Z-SYN-Reviewer`
  - `role`: `CLUB_ADMIN` (legacy string column only — no
    `UserClubRole` grant, so this user carries ZERO active
    permissions in the running app)
  - `passwordHash`: unrecoverable random bcrypt — cannot log in
  - **No permanent privileged test identity. No role grant. The
    user exists solely for FK attribution on synthetic review rows.**
- 1 DRAFT `TrainingCourseVersion` with authentic synthetic transcript
  evidence (6 segments, grounding projection with canonical passage
  shape + canonical envelope hash, COMPLETED transcription job,
  COMPLETED generation run, checkpoint at 115 s).
- 2 drafts in `APPROVED_DRAFT` state, each with validation (verified
  answer snapshot populated with correct `validationId` binding) +
  APPROVED review attributed to the synthetic reviewer (NOT the
  founder).
- Prefix `4Z-SYN-*` on every seeded row.

### Cleanup script

[scripts/ep-train-6d4zc-promotion-cleanup.mjs](../../../scripts/ep-train-6d4zc-promotion-cleanup.mjs)

Deletes the promotion sidecar BEFORE the TrainingQuestion row to
respect the `RESTRICT` FK, then removes answer options, drafts,
runs, jobs, checkpoint, segments, build, projection, version,
course, and the synthetic reviewer user. Residue check at the end.

## 4. §4 Acceptance — 12 checks

The Playwright spec at
[tests/e2e/ep-train-6d4zc-promotion-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4zc-promotion-acceptance.staging.spec.ts)
drives both the UI promote journey and the programmatic
idempotency + conflict tests.

| # | Check                                             | Outcome |
|---|---------------------------------------------------|---------|
| 1 | Approved draft eligibility                        | ✅ Both drafts in `APPROVED_DRAFT` with populated `verifiedCorrectAnswerSnapshotJson` |
| 2 | Verified correct-answer snapshot                  | ✅ Snapshot shape passes 4N reader's 6 integrity checks (hash + validationId + option index + option text + reviewer + timestamp) |
| 3 | Source-evidence integrity                         | ✅ 4M evidence reader passes projection sha256 recompute + build lookup |
| 4 | Authorized manager promotion                      | ✅ Founder (CLUB_ADMIN → carries `hr:training:write`) clicked promote; service accepted |
| 5 | Correct TrainingQuestion creation                 | ✅ 2 questions created — prompt + questionType + options + active=true match source draft |
| 6 | Correct checkpoint association                    | ✅ Escalation question has `checkpointId = cmw5tlzla000qtakdfd3oqfpf` (115 s checkpoint) |
| 7 | Correct final-assessment association              | ✅ Food-safety question has `checkpointId = null` |
| 8 | Human-verified answer propagation                 | ✅ `verifiedAnswerOptionIndex = 0` → `TrainingAnswerOption[0].isCorrect = true` on both; model-selected answer NOT used |
| 9 | Duplicate promotion idempotency                   | ✅ Replay to same destination returned 200 + `replay: true` (programmatic API call on the authenticated session) |
| 10| Conflicting destination refusal                   | ✅ Same draft to different destination returned 409 + `rejectionCode: ALREADY_PROMOTED_DIFFERENT_DESTINATION` |
| 11| Publication readiness                             | ✅ Version state remains `DRAFT`; publish panel remains available for a later authorised slice |
| 12| No publication or employee assignment             | ✅ `TrainingCompletion` count = 0; `appliesToAll = false`; `appliesToDeptIds = null`; `appliesToPositionIds = null` |

**Playwright result: 2/2 specs PASSED (52.4s).**

## 5. §5 Manager-workflow completeness assessment

### Promote step — COMPLETE via manager UI

| Capability                                     | Status |
|------------------------------------------------|--------|
| Promote button visible                         | ✅ (`ai-workspace-assemble-promote-checkpoint` + `ai-workspace-assemble-promote-final`) |
| Checkpoint selector populated                  | ✅ dropdown contains `115s · 4Z-SYN-Mid-video checkpoint` |
| Click fires authenticated POST                 | ✅ founder session cookies carried |
| Server re-verifies all 7 integrity checks      | ✅ 4T service runs evidence + verified-answer + content-hash + destination + idempotency |
| Success renders inline                         | ✅ "Promoted. CHECKPOINT" / "Promoted. FINAL_ASSESSMENT" |
| Reload shows "Already promoted · <destination>"| ✅ server-rendered state reads the promotion sidecar |

**The promote step of the manager-workflow is COMPLETE.** A
CLUB_ADMIN manager can promote an approved AI draft into a
publishable `TrainingQuestion` entirely through the deployed
workspace UI, with no developer script or manual API invocation.

### End-to-end pipeline — INCOMPLETE for the founder's role

The full pipeline (upload → transcribe → plan → generate → review
→ approve → promote → publish) has one step the founder's current
role CANNOT execute via UI:

| Step             | Permission required               | Founder (CLUB_ADMIN) carries it? |
|------------------|-----------------------------------|----------------------------------|
| Upload video     | `hr:training:write`               | ✅                                |
| Transcribe       | `hr:training:write`               | ✅ (but gated on Modal creds)     |
| Review plan      | `hr:training:read`                | ✅                                |
| Generate         | `hr:training:write`               | ✅ (but gated on Modal creds)     |
| Review candidate | `hr:training:ai:read`             | ✅                                |
| **Approve candidate** | **`hr:training:ai:approve`** | **❌ CLUB_ADMIN does NOT carry this** |
| Promote          | `hr:training:write`               | ✅                                |
| Publish          | `hr:training:publish`             | ✅                                |

**The approve step is a gap.** In this acceptance the APPROVED_DRAFT
state was pre-seeded by the fixture (attributed to the synthetic
reviewer). Driving the END-to-end pipeline live via UI is BLOCKED by
the missing `hr:training:ai:approve` grant on CLUB_ADMIN. This gap
is not in-scope for 4Z-C to fix — a role-grant change is a §9 STOP
item. **Recommended next slice: 4Z-D would assess whether the
approve grant belongs on CLUB_ADMIN or on a new reviewer role, and
how the founder authorises that role.**

### Fixture use is developer-only

Seeding synthetic approved drafts via `scripts/ep-train-6d4zc-promotion-fixture.mjs`
is a developer action. A real manager does not run fixture scripts.
Pre-seeding was necessary ONLY because the approve step cannot be
driven from the founder's current role (see above). Once the approve
grant is wired for the manager role, no fixture pre-seed will be
needed.

## 6. §6 Security + audit confirmation

| Check                                                | Result |
|------------------------------------------------------|--------|
| Dedicated synthetic reviewer identity                | ✅ `4z-syn-reviewer-<ts>@example.test` — fixture-only, cannot log in |
| Do not impersonate the founder                       | ✅ All `TrainingQuestionAiReview.reviewedByUserId` + `TrainingQuestionAiDraftPromotion.approvedByUserId` rows attribute to the synthetic reviewer |
| Do not grant permanent broad permissions             | ✅ No `UserClubRole` created; synthetic user carries 0 active permissions |
| Preserve authoritative approval + promotion audit    | ✅ Promotion rows written via the real 4T service (authoritative); `promotedByUserId = founder` (legitimate — founder clicked promote); `approvedByUserId = synthetic reviewer` (legitimate — synthetic reviewer approved the fixture draft) |
| No synthetic training content visible to employees    | ✅ Version stays DRAFT, no publication, no assignment, 0 TrainingCompletion rows |

## 7. §7 Evidence + screenshots

### Successful promote evidence

16 lines of verification output captured via parameterised Prisma
reads against staging (no `$queryRawUnsafe` with string
interpolation, no user enumeration):

- Escalation draft → promotion row with `destination: CHECKPOINT`,
  `checkpointId: cmw5tlzla000qtakdfd3oqfpf`, `verifiedAnswerOptionIndex: 0`,
  `promotedByUserId: cmrvdenz700034437agp7gqs5` (founder — legitimate),
  `approvedByUserId: cmw5tlzbn0000takd7y8i5shm` (synthetic reviewer).
- Food-safety draft → promotion row with `destination: FINAL_ASSESSMENT`,
  `checkpointId: null`, `verifiedAnswerOptionIndex: 0`, same
  promoted/approved attribution split.
- TrainingQuestion rows for both:
  - Escalation: 3 options, `options[0].isCorrect = true`
    (matches verifiedAnswerOptionIndex).
  - Food-safety: 2 options, `options[0].isCorrect = true` (same).
- Version state: `DRAFT`. Assignment flags: all false/null.
  TrainingCompletion count: 0.

### Screenshots

[test-results/ep-train-6d4z-c/screenshots/](../../../test-results/ep-train-6d4z-c/screenshots/)

| # | Surface                                                | File                                                  |
|---|--------------------------------------------------------|-------------------------------------------------------|
| 01| Pre-promote (both rows visible with promote buttons)   | `01-pre-promote--desktop-1440x900.png`                |
| 02| Post-promote inline success message                    | `02-post-promote--desktop-1440x900.png`               |
| 03| Reload — "Already promoted · <destination>"            | `03-reload-already-promoted--desktop-1440x900.png`    |

### Idempotent replay evidence

Programmatic POST to `/api/admin/ai-training/drafts/{escalationId}/promote`
with same `{destination: {kind: CHECKPOINT, checkpointId}}` body
returned **HTTP 200** + `{ok: true, replay: true, destinationKind: "CHECKPOINT"}`.

### Conflicting-destination refusal evidence

Same draft, different destination (`FINAL_ASSESSMENT`) returned **HTTP 409**
+ `{error: "promotion_rejected", rejectionCode: "ALREADY_PROMOTED_DIFFERENT_DESTINATION"}`.

### Unauthorized promotion refusal

Covered by the mocked 4Y route tests (`tests/ep-train-6d4y-workspace-routes.test.ts`):
- 401 unauthenticated
- 400 invalid destination (5 shapes)
- 404 same-shape when draft is cross-tenant / missing
- 409 when draft is not APPROVED_DRAFT
- 409 CONTENT_HASH_MISMATCH / VERIFIED_ANSWER_MISSING / etc.

No new live-session negative-auth test introduced on staging (would
require creating + tearing down another fixture user with lower
permissions — out of scope for 4Z-C's promote-success objective).

### Fixture cleanup

[scripts/ep-train-6d4zc-promotion-cleanup.mjs](../../../scripts/ep-train-6d4zc-promotion-cleanup.mjs)
ran post-acceptance:

```
courses=1, versions=1, questions=2, answerOptions=2,
promotions=2, drafts=2, runs=1, transcriptionJobs=1,
checkpoints=1, segments=6, builds=1, projections=1,
syntheticReviewers=1
RESIDUE_CHECK: clean (0 synthetic courses, 0 synthetic reviewers)
```

### Historical-candidate preservation

Pre-slice: 8 null-projection pilot candidates. Post-slice: 8
null-projection pilot candidates. **UNCHANGED.**

## 8. STOP boundaries (§9) — confirmed

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No production changes                | ✅        |
| No live Modal/Qwen inference         | ✅        |
| No GPU activation                    | ✅        |
| No historical candidate modification | ✅ (8 preserved) |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No unauthorized role grants          | ✅ (synthetic user has 0 UserClubRole grants) |
| No unrelated UI redesign             | ✅ (no code change deployed) |
| 126 unrelated WIP files preserved    | ✅ (stashed on entry, restored on exit) |

## 9. Recommended next UI integration

The promote step works end-to-end via UI today. The **full
pipeline** requires closing one gap:

**4Z-D — Approve permission grant assessment (recommended next)**

Scope:
- Determine whether `hr:training:ai:approve` should be added to
  `CLUB_ADMIN`, or whether a new dedicated "Training Reviewer" role
  should be created with the AI-approval set
  (`hr:training:ai:review`, `hr:training:ai:approve`, `hr:training:ai:edit`,
  `hr:training:ai:revalidate`).
- Decide which Spectre users at a club are expected to drive the
  full AI pipeline end-to-end.
- Draft the permission.ts delta.
- If a new role is proposed, draft the RBAC migration (if any) and
  the UI changes needed for a founder to grant that role to another
  user.

4Z-D requires founder authorisation (it IS a permission change
which is a §9 STOP item). Not initiated here.

Minor UI polish deferred (not blockers):
- After a successful promote, the in-page "Promote to …" buttons
  still look clickable until page reload. Could flip to "Already
  promoted" inline from the client-side state update rather than
  waiting for a reload.
- Transcription + generation stage badges render "…" on initial
  render before the first poll completes. Could render the
  server-prefilled badge initially.

## 10. Awaiting

Founder review of the 3 screenshots + this document. Any further
implementation (4Z-D, live Modal activation, publication
acceptance) requires separate authorisation.
