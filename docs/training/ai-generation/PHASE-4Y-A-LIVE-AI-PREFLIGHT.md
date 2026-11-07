# EP-TRAIN-4Y-A — Live AI Activation Preflight

**Status:** READ-ONLY readiness audit (2026-11-07).
**Scope:** §3 — §8 of the EP-TRAIN-4Y-A directive.
**Companion docs:**
- [PHASE-4Y-A-PILOT-PLAN.md](PHASE-4Y-A-PILOT-PLAN.md)
- [PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md)

**Baseline:** `ep-train-6d-4z-f/two-role-workflow` @ `7a2d31ca`;
staging Fly web `v1098` + worker `v334`, image `sha-e7fbb0b158cd`.
4Z-F was pushed to `origin` as part of this preflight (§1).

**Prior-live-pilot baseline:** EP-TRAIN-6C-11 (`a865fe4e` on branch
`ep-train-6c-11/wider-coverage-pilot`) — five Modal A10 generations
executed 2026-11-04 on the Silver Springs Staff Orientation
development tenant; then stopped. The 6C-11 workspace + evidence are
the authoritative prior art for this preflight.

**STOP compliance (§11):** no Modal invocation, no GPU, no Fly
secret writes, no deploy, no DB migration, no historical mod, no
publication, no assignments, no role grants, no Modal spend-limit
change. 126 unrelated WIP files on `staging-deploy/web1b1-framer-fidelity`
preserved — this preflight's docs live on a **separate** branch
(`ep-train-4y-a/preflight`) forked from 4Z-F in an isolated git
worktree.

---

## 0. DECISION — CONDITIONAL GO

**Spectre-side pipeline**: the 4V → 4L → 4W → 4X → 4N → 4T → 4Y
integrated stack is **implemented, contract-tested, and deployed**
on staging v1098. Every manager-facing control currently returns
`CREDENTIAL_ABSENT` because the three Fly secrets are unset.

**Modal workspace**: provisioned (`spectreautomation-admin`), has
been exercised once before (EP-TRAIN-6C-11, 5 A10 generations,
$0.029 metered, workspace cap intact at 0.29 %), **currently
empty** — the `spectre-training-generate` app was stopped at 6C-11
cleanup; `spectre-training-transcribe` was never deployed.

**Critical integration gap**: the 6C-11 Modal function used
`Modal-Key` + `Modal-Secret` proxy auth + a per-call
`PilotAuthorizationV1` HMAC envelope. The EP-TRAIN-6D-4V/4W
`modal-client.ts` uses `Authorization: Bearer` + response-HMAC.
**These are incompatible.** The Modal Python side must be
redeployed to honour the Bearer contract before the 4Z-F app
pipeline can succeed end-to-end — or the Spectre-side clients must
be adapted to the 6C-11 contract. Either way is a separate
authorised slice with code changes and a new Modal deploy; neither
is in scope for 4Y-A.

**Six EP-TRAIN-6A-2 founder approvals (G.A–G.F) remain
outstanding.** No GPU, Docker image, Modal deploy, Spectre code
change, or Fly secret write starts before all six are explicitly
answered.

### Gating ladder

```
┌─────────────────────────────────────────────────────────────────┐
│ CONDITIONAL GO (today)                                           │
│   Spectre-side pipeline ready; Modal-side empty; G.A–G.F open;   │
│   auth-scheme bridge required before first integrated call.      │
└────────────────┬────────────────────────────────────────────────┘
                 ↓   (decision only, no code change)
┌─────────────────────────────────────────────────────────────────┐
│  G.A–G.F signed off  +  auth-scheme choice  +  tenant confirmed  │
└────────────────┬────────────────────────────────────────────────┘
                 ↓   (separate authorised slice)
┌─────────────────────────────────────────────────────────────────┐
│ Modal workspace preparation                                      │
│   + Redeploy generate function on Bearer contract (OR adapt      │
│     Spectre clients)                                             │
│   + Deploy transcribe function (new; never shipped)              │
│   + Mount model-cache volumes                                    │
│   + Set 3 Fly secrets on BOTH web and worker apps                │
└────────────────┬────────────────────────────────────────────────┘
                 ↓   (this doc + pilot-plan doc)
┌─────────────────────────────────────────────────────────────────┐
│ EP-TRAIN-4Y-A LIVE PILOT (gated by the pilot-plan §9 scenarios)  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Branch + deploy topology

| Branch | Tip | Status |
|--------|-----|--------|
| `main` | — | No AI-Training code |
| `staging-deploy/web1b1-framer-fidelity` | `de8653f5` (EP-TRAIN-6A-2) | Carries EP-TRAIN-6A-2 feasibility audit only |
| `ep-train-6c-11/wider-coverage-pilot` | `a865fe4e` | **Workstation-driven live pilot** (2026-11-04); 5 real Modal A10 generations + rubric scoring |
| `ep-train-6c-10b/hardened-validator-integration` | `accbb0c` | Validator used by 6C-11 pipeline |
| `ep-train-6d-4v/transcription-orchestration` | `3361ed1e` | 4V slice (offline impl) |
| `ep-train-6d-4w/question-generation` | `850c9bc6` | 4W slice (offline impl) |
| `ep-train-6d-4x/placement-and-dedup` | `6bd5b925` | 4X slice (offline impl) |
| `ep-train-6d-4y/workspace` | `52cbc2bb` | 4Y slice (offline impl) |
| `ep-train-6d-4z-c/promotion-acceptance` | `f08dbd6c` | 4Z-C staging acceptance |
| `ep-train-6d-4z-d/reviewer-auth` | `e7fbb0b1` | 4Z-D offline + deployed image sha |
| `ep-train-6d-4z-e/reviewer-staging` | `0a5f11ab` | 4Z-E reviewer-role staging acceptance |
| **`ep-train-6d-4z-f/two-role-workflow`** | **`7a2d31ca`** | **Baseline for this preflight; pushed to origin.** |
| `ep-train-4y-a/preflight` | *(new; this doc)* | Where the three preflight deliverables land |

Fly staging web `v1098` + worker `v334` were deployed from the
`e7fbb0b1` image (`sha-e7fbb0b158cd`). 4Z-E, 4Z-F reused that image.

**Implication for live activation**: the 4V–4Z-F branch chain is a
*feature chain* not merged to any shared baseline. The 6C-11 pilot
ran on a different branch (`ep-train-6c-11/wider-coverage-pilot`)
using a workstation-driven script path (`scripts/spectre-sec-1/invoke-modal-runner.ps1`
→ `scratchpad/ep-train-6b/gen/generate-lite-run.mjs`), bypassing the
Spectre app queue and the 4V/4W clients entirely. **The first
app-driven Modal call on staging will be the EP-TRAIN-4Y-A pilot.**

---

## 2. §3 — Pipeline contract inventory

Each stage cites `file:line` on the `ep-train-6d-4z-f/two-role-workflow`
branch unless otherwise noted.

### 2.1 Video upload → R2 storage — LIVE-READY: YES

- Entry: POST `src/app/api/hr/training/versions/[id]/video/route.ts`
  → `uploadTrainingVideo` at `src/lib/hr/training/video.ts:43-220`.
- Streaming: `src/lib/hr/training/video-stream.ts:99-131` (R2 Range
  streaming via `resolveR2Client()` + `GetObjectCommand`).
- SHA-256 computed at upload (`video.ts:118`); embedded in
  `storageKey` and persisted (`video.ts:190`). Not re-verified on
  playback (metadata-only).
- Shared-R2 lifecycle invariant enforced via Postgres advisory lock
  (`acquireStorageKeyLock`) + `storage.head({storageKey})` inside
  the write tx. Three protected writers (`uploadTrainingVideo`,
  `remediateVideoFastStart`, `startNewDraft`). Full taxonomy in
  [docs/training-video-storage-writers.md](../../training-video-storage-writers.md).
- Tenant scoping: `callerCanReadVersion` resolves
  `version.course.clubId` + gates by admin permission OR
  applicability for employees (`route.ts:40-63`).
- Audit: `hr.training.video.upload` (`video.ts:200-219`).
- **Not emitted**: `uploadTrainingVideo` does NOT currently enqueue
  `TRAINING_TRANSCRIBE_VIDEO`. The transcription trigger is
  explicit (admin button on the AI-workspace page). This is
  intentional per the 4V design (operator-driven, not auto-trigger).

### 2.2 4V transcription orchestration — LIVE-READY: YES (blocked by Modal)

- Lifecycle table `TrainingTranscriptionJob` (migration
  `prisma-postgres/migrations/20261106_ep_train_6d_4v_transcription_job/`)
  with states `REQUESTED → QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED`.
  Unique `[clubId, courseVersionId, sourceVideoSha256, state]`
  enforces one-live-job-per-video.
- Service: `src/lib/hr/training/transcription/job-service.ts`.
- API: POST `src/app/api/admin/training/versions/[id]/transcribe/route.ts`
  — permission `hr:training:write`; route returns `503` when Modal
  env absent.
- Status endpoint: `.../transcription-status/route.ts`.
- Worker handler: `src/lib/hr/training/transcription/worker-handler.ts`
  — the sole caller of `callModalTranscribe`.
- Queue registration: `src/lib/queue/handlers.ts:504`.
- Bounded retries: `maxAttempts=2` (initial + one retry).
- Lease safety: every mutation gated by
  `(state='RUNNING' AND leaseToken=expected)`.
- Audit: lifecycle actions through the job service.

### 2.3 Modal faster-whisper (Spectre-side client) — LIVE-READY: YES (blocked)

File: `src/lib/hr/training/transcription/modal-client.ts`.

| Dimension | Value |
|-----------|-------|
| URL env var | `MODAL_TRANSCRIBE_URL` |
| Token env var | `MODAL_SPECTRE_SHARED_TOKEN` |
| Auth header | `Authorization: Bearer <token>` |
| Response integrity | HMAC-SHA-256 of body via `X-Spectre-Signature` (base64) + `timingSafeEqual` |
| Timeout | 10 min via `AbortController` |
| Fail-closed codes | `CREDENTIAL_ABSENT`, `MODAL_HTTP_ERROR`, `MODAL_TIMEOUT`, `MODAL_HMAC_INVALID`, `MODAL_BODY_INVALID` |
| Schema lock | `transcribe-v1` |
| SHA gate | Modal returns `audioSha256`; downstream `SHA_MISMATCH` fail if ≠ stored `videoSha256` |
| Cost estimate | `estimateTranscribeCostMicros(elapsedMsTotal)` = `elapsedMs / 3,600,000 × $1.95 × 1e6` |
| Credential logging | Never (verified by read) |

### 2.4 4L transcript ingestion — LIVE-READY: YES

- `src/lib/hr/training/transcription/ingest.ts`:
  - `persistTranscriptBuild` — writes `TrainingTranscriptBuild`.
  - `persistTranscriptSegments` — monotonic index + SHA checks.
  - `persistGroundingProjection` — writes 4M input.
- **Segment 16/17 exclusion** —
  `EXCLUDED_SEGMENT_INDICES = Object.freeze(new Set([16, 17]))`
  (`ingest.ts:76`); enforced across `generation/assessment-plan.ts:20`,
  `ai-review/evidence-reader.ts:68`, `generation/worker-handler.ts:35`.
  Grounding citations against those indices raise
  `"segment ${sid} is excluded by pilot authorisation"`.
- Permission: `hr:training:transcription:write` (worker-system
  principal only — no human role holds it).

### 2.5 4W generation orchestration — LIVE-READY: YES (blocked)

- Lifecycle table `TrainingQuestionGenerationRun`:
  `REQUESTED → QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED`.
- Service: `src/lib/hr/training/generation/generation-service.ts`.
- Assessment plan: `generation/assessment-plan.ts`
  (`validateAssessmentPlan`, `buildBaselineAssessmentPlan`).
- Topic-aware placement: `generation/placement.ts`.
- API: POST `.../generate/route.ts`.
- Status: GET `.../generation-status/route.ts`.
- Worker handler: `generation/worker-handler.ts`.
- **Per-tenant daily cost cap**: per memory
  `project_ep_train_6d_4w_offline_impl.md`, `DEFAULT_DAILY_USD_MICROS = 10 × 1e6`
  — enforced in `claimNextGenerationRun` via rolling-24 h sum.

### 2.6 Modal Qwen (Spectre-side client) — LIVE-READY: YES (blocked)

File: `src/lib/hr/training/generation/modal-client.ts`.

Symmetric to 2.3 with:
- URL env var: `MODAL_GENERATE_URL` (shares token with transcribe).
- `schemaVersion = "training-proposals-v1"`.
- Grammar-constrained decoding on the Modal side (LM Format
  Enforcer — confirmed by 6C-11 backend-proof).
- Proposal shape validators + `sourceSegmentIds[]` existence
  enforced downstream in dedup + evidence reader.

### 2.7 4X checkpoint placement + duplicate screening — LIVE-READY: YES (LEXICAL ONLY)

- Placement: `generation/placement.ts` — topic-aware boundaries +
  checkpoint-after-instructional-content rule.
- Dedup: `generation/dedup.ts` —
  `evaluateAgainstPriors(candidate, priors[])` returns `ACCEPT |
  REJECT_LEXICAL_NEAR_DUPLICATE | REJECT_LEXICAL_EXACT_DUPLICATE |
  TOPIC_CANDIDATE`.
- **Honest limitation**: 4X is **lexical**. Semantic equivalence is
  NOT proven by 4X alone. 6C-11's 5-candidate rubric confirms this:
  all 5 produced `REQUIRES_HUMAN_VERIFICATION` because of advisory
  flags, not lexical duplication — the semantic review stayed human.

### 2.8 4Y manager workspace — LIVE-READY: YES

- Entry: `.../ai-workspace/page.tsx` + `AiWorkspaceClient.tsx`.
- 8-stage stepper + 5 s poll cadence on
  QUEUED/REQUESTED/RUNNING states.
- Permission: `hr:training:write`.
- Composition: pure functions of props + poll payload.
- Attribution: manager actions carry the active principal id (4Z-F
  acceptance verified `reviewer / admin / founder` attribution
  correctness).

### 2.9 4N approval service — LIVE-READY: YES

- `src/lib/hr/training/ai-review/*` — `approval-service.ts`,
  `approval-guard.ts:194`
  (`VALIDATION_SOURCE_INVALID` unless `validatorSource === "integrated-pipeline"`),
  `lifecycle.ts`, `reviewer-eligibility.ts`, `verified-answer-reader.ts`,
  `evidence-reader.ts`, `content-hash.ts`, `transactional-audit.ts`.
- Snapshot: `verifiedCorrectAnswerSnapshotJson = { optionIndex,
  optionText, verifiedByUserId, verifiedAt, draftContentHash,
  validationId }`.
- Permission: `hr:training:ai:approve` (held by `TRAINING_AI_REVIEWER`
  + `CLUB_ADMIN`).

### 2.10 4T promotion service — LIVE-READY: YES

- `ai-review/promotion-service.ts` — 7 defensive re-checks.
- Attribution: `promotedByUserId` (promoter) + `approvedByUserId`
  (reviewer); RESTRICT FK to resulting `TrainingQuestion`.

### 2.11 Employee preview — LIVE-READY: YES

- `src/app/employee/(authed)/safety-training/[versionId]/page.tsx`
  + `CoursePlayer.tsx` consume the authenticated video proxy with
  Range streaming. Picks up promoted questions on the next load.

### 2.12 Queue registry — LIVE-READY: YES

- `src/lib/queue/handlers.ts:504` — `TRAINING_TRANSCRIBE_VIDEO`.
- `src/lib/queue/handlers.ts:527` — `TRAINING_GENERATE_QUESTIONS`.
- Worker binary `bin/worker.ts` dispatches both.

### 2.13 Audit action catalogue (non-exhaustive)

- `hr.training.video.*` (upload / remediate / r2-deleted / r2-delete-failed / cleanup-skipped / cleanup-tx-failed)
- `hr.training.transcription.*`
- `hr.training.generation.*`
- `hr.training.ai.review.*`
- `hr.training.ai.promotion.*`

Worker rows attribute to `system:training-transcription:<clubId>` —
a worker-system principal, not a signable user.

---

## 3. §4 — Source video audit

### 3.1 Two distinct Staff Orientation videos — reconciliation

Repo and memory describe TWO different training-video fixtures.
The directive's instruction to "preserve its original Silver
Springs Golf & Country Club identity" refers to the first.

| Attribute | Silver Springs Staff Orientation (pilot source) | Coulee Ridge ORIENTATION_2027 (unrelated) |
|-----------|-----------------------------------------------|----------------------------------------------|
| Tenant | Silver Springs (`cmrvdeny7000144372ktmmg9c`) | Coulee Ridge |
| Course id | `cmvzs3vz9000256qcu7lfysoz` | `cmvvgznyf000gz9nu3nbqm09q` |
| Current version id | `cmvzs3w05000456qcgfgps7gy` | `cmvzjrk8c000ac8zqw0ui8os5` (v4) |
| Version state | (DRAFT, used for pilot) | PUBLISHED |
| Video SHA-256 | `d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29` | ends in `…bc79` |
| Duration | ≥ 131 s (passage 18 ends at 131.40 s) | 51 s |
| Resolved transcript build | `d138a72b1c3eee7329629f5759e528ca8dbeee5000a71a698f512e78191a2237` | (post-transcription — pilot would produce it) |
| Grounding projection SHA | `0549c7e34b8c81129ee138a7a8c6fffab4e8d0ac061ea2c833f4d5056daaa0d6` (6C-7 baseline, byte-identical) | n/a |
| Prior Modal use | **5 A10 generations on 2026-11-04** (EP-TRAIN-6C-11) | Never |
| Employee obligation universe | None (development tenant, no production assignments) | 9 founder completions + Marc Fire INITIAL OUTSTANDING + Marc v2 SUPERSEDED |
| Excluded segments | 16, 17 (preserved throughout 6C-7..6C-11) | n/a |

**Resolution**: proceed with the **Silver Springs** Staff Orientation
as the pilot source — this matches the directive AND reuses the
EP-TRAIN-6C-11 grounding infrastructure byte-identically. The
Coulee Ridge ORIENTATION_2027 is OUT OF SCOPE for the 4Y-A pilot;
it carries production obligation semantics that must not be
disturbed.

(My initial preflight draft incorrectly flagged a Silver-Springs /
Coulee-Ridge inversion. That earlier concern is withdrawn — Silver
Springs is correct.)

### 3.2 Pilot video identity verification (preflight gate)

Before the first Modal call, the pilot operator MUST verify
(read-only, no writes):

1. `TrainingCourseVersion` matches `cmvzs3w05000456qcgfgps7gy` on
   Silver Springs tenant.
2. `videoSha256 = d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29`.
3. `resolveDocumentStorage({clubId: silverSprings}).head({storageKey})`
   returns true.
4. Authenticated video proxy returns 206 for a Range request from
   a founder session.
5. Grounding projection SHA matches
   `0549c7e34b8c81129ee138a7a8c6fffab4e8d0ac061ea2c833f4d5056daaa0d6`.

All five checks are read-only. The authentication is founder
session (not synthetic test user).

### 3.3 Historical segment 16/17 exclusions

`EXCLUDED_SEGMENT_INDICES = new Set([16, 17])` is enforced in 4L
ingest, 4W assessment-plan, 4M evidence-reader. A fresh
transcription of the same bytes produces the same segment index
map; 16 and 17 are excluded from grounding citations. No code
change required to preserve.

### 3.4 Working on DRAFT, not PUBLISHED

The Silver Springs pilot course version is DRAFT (per 6C-11 §9
"Course DRAFT state | unchanged"). 4V refuses non-DRAFT versions
(`version_not_draft` 409); 4W does the same. The pilot can safely
transcribe + generate on this existing DRAFT without disturbing
any PUBLISHED workflow or any Coulee Ridge obligation universe.

### 3.5 R2 helper API

- Entry: `resolveDocumentStorage({ clubId })` in `src/lib/documents/storage.ts:46`.
- Methods: `put | get | delete | head` (:56-68).
- Range streaming: `resolveR2Client()` + `GetObjectCommand` in
  `src/lib/hr/training/video-stream.ts:99-131`.

### 3.6 SHA-256 verification flow

- Compute on upload: `video.ts:118` → `sha256 = createHash("sha256").update(bytes).digest("hex")`.
- Persist: `video.ts:190` (`videoSha256`).
- Compute on remux: `video.ts:287`.
- **Playback does NOT recompute**: `video-stream.ts:80..163`
  reads but does not verify. SHA is metadata, not a playback gate.
- Modal path: 4V worker will pass the stored SHA to Modal, which
  returns `audioSha256` after download; `SHA_MISMATCH` terminal
  failure if they differ.

---

## 4. §5 — Modal readiness

### 4.1 Workspace + apps state

| Item | State | Evidence |
|------|-------|----------|
| Modal workspace | **EXISTS**: `spectreautomation-admin` | EP-TRAIN-6C-11 §2 |
| Account-level spend limit | **$10 USD** (0.29 % consumed) | EP-TRAIN-6C-11 §8 |
| `spectre-training-generate` app | **Stopped** (deployed once 2026-11-04, then `modal app stop --yes`) | EP-TRAIN-6C-11 §4.4, §9 |
| `spectre-training-generate` historic URL | `https://spectreautomation-admin--spectre-training-generate-gener-a9d84d.us-east.modal.run` (deterministic hash, reproducible on redeploy) | 6C-11 §4.1 |
| `spectre-training-transcribe` app | **NEVER deployed** | 6C-11 §9 "`transcribe deployed: False`" |
| Model-cache volumes | **NOT MOUNTED** | 6C-11 — generate used in-container weights (A10) |
| GPU containers active right now | **0** | 6C-11 cleanup verified |
| Shared bearer token issued | **NO** | — |
| Fly secrets set | **NONE of MODAL_TRANSCRIBE_URL / MODAL_GENERATE_URL / MODAL_SPECTRE_SHARED_TOKEN** | Buttons on staging return `CREDENTIAL_ABSENT` |

**No Python Modal function source is checked into this repo** on
any branch — the actual `@app.function()` body + GPU + model
declarations live in a separate (operator-maintained) tree used
with `modal deploy`. That separate tree was exercised by 6C-11 but
is not visible to this preflight; any audit of GPU type / timeouts
/ concurrency / `modal.Secret.from_name(...)` names must read that
tree.

### 4.2 Authentication contracts — the integration gap

There are TWO auth contracts in play. **They are not
compatible.**

**Contract A — EP-TRAIN-6C-11 live pilot (what Modal actually accepts today):**

| Dimension | Value | Source |
|-----------|-------|--------|
| Proxy auth | `Modal-Key: wk-…` + `Modal-Secret: ws-…` headers | `scratchpad/ep-train-6b/gen/generate-lite-run.mjs:15-68` |
| Pilot authorisation | `PilotAuthorizationV1` JSON signed with HMAC-SHA-256 over canonical JSON; fingerprint secret `ep-train-6c-1-pilot-fingerprint-secret-v1` | 6C-11 §3 |
| Authorisation TTL | 1 hour | 6C-11 §3 |
| Question cap per auth | `maxRequestedQuestions: 1` | 6C-11 §3 |
| Request-body signing | HMAC-SHA-256 custom `x-spectre-sig-*` headers | `generate-lite-run.mjs:56-66` |
| Modal secret (server-side HMAC key) | `spectre-training-runtime-hmac` (rotated per session via `modal secret create --force`) | 6C-11 §4.1 |
| Canonicalisation | ASCII-scope boundary (em-dash in scope caused `PILOT_AUTH_FINGERPRINT_MISMATCH`) | 6C-11 §4.2 "pre-inference 403" |
| Workstation credential storage | DPAPI generic creds via SPECTRE-SEC-1 `SpectreModalCredentials.psm1:250-266` | SPECTRE-SEC-1 acceptance |

**Contract B — EP-TRAIN-6D-4V/4W Spectre-app clients (what the queue worker would send):**

| Dimension | Value | Source |
|-----------|-------|--------|
| Auth header | `Authorization: Bearer <MODAL_SPECTRE_SHARED_TOKEN>` | `transcription/modal-client.ts:99`, `generation/modal-client.ts:87` |
| Shared token var | `MODAL_SPECTRE_SHARED_TOKEN` | Both clients |
| Response integrity | HMAC-SHA-256 over response body via `X-Spectre-Signature` header | Both clients |
| Timeout | 10 min via `AbortController` | Both |
| Signed video transfer | Spectre issues short-lived URL; Modal downloads over HTTPS | `video-signed-url.ts` + `handlers.ts:508` |
| Response schema lock | `transcribe-v1` / `training-proposals-v1` | Both |

**Reconciliation options (each a separate authorised slice, OUT OF 4Y-A scope):**

- **Option X — Redeploy Modal with the Bearer contract.** Author
  the Modal Python function to accept `Authorization: Bearer`
  (verify against the Modal workspace secret) + sign the response
  body with HMAC-SHA-256 (same shared token). Deploy both
  `spectre-training-generate` and `spectre-training-transcribe`.
  Lose the 6C-11 PilotAuthorizationV1 granularity (but the 4V/4W
  design gives per-job idempotency tokens + rolling-24 h cost
  caps, which replace most of what PilotAuthorizationV1 provided).
- **Option Y — Adapt 4V/4W clients to the 6C-11 contract.** Rework
  `transcription/modal-client.ts` + `generation/modal-client.ts`
  to emit `Modal-Key`/`Modal-Secret` proxy auth + a per-call
  `PilotAuthorizationV1` envelope signed with the Spectre-local
  fingerprint secret. Keep the current Modal function as-is.
  Higher ongoing cost (every call needs an auth envelope).
- **Option Z — Dual-path, bridged.** Redeploy Modal to accept
  BOTH auth schemes. Keep the 6C-11 workstation path for operator-
  driven ad-hoc generation + run the 4V/4W app pipeline on the
  Bearer path. Higher Modal-side surface; two trust boundaries.

**Recommendation for the pilot plan**: Option X. The 4V/4W clients
are already deployed on staging v1098 image `sha-e7fbb0b158cd`;
changing them is a shared-code change with staging implications.
Redeploying the Modal Python function is Modal-side only.

### 4.3 Fly secrets required (on both apps)

Three secrets must be set on `spectre-staging` AND
`spectre-staging-worker` before the first live invocation. All
three via DRH-1 `flyctl secrets set`:

```
MODAL_TRANSCRIBE_URL=<deployed transcribe function URL>
MODAL_GENERATE_URL=<deployed generate function URL>
MODAL_SPECTRE_SHARED_TOKEN=<32+ bytes hex, never checked in>
```

**Terminal-safety invariants (already enforced in code):**

- Both Modal clients read env via `env.MODAL_SPECTRE_SHARED_TOKEN`
  and never pass the value to `logger`.
- `worker-handler.ts` for both stages logs `jobId`, `elapsedMs`,
  `audioSha256` tail, status — never the token.
- The Playwright 4V/4W contract tests mock `fetch` and assert no
  network egress offline.
- `scripts/spectre-sec-1/SpectreModalCredentials.psm1` is a
  workstation-developer tool (DPAPI); it is NOT runtime and must
  NOT be deployed to Fly.

### 4.4 §G.A–G.F outstanding founder approvals

Six binary decisions block provisioning, verbatim from
[EP-TRAIN-6A-2 §G](../../ep-train-6a-audit.md):

- **G.A — GPU host**: Modal (recommended) or RunPod.
- **G.B — Model variant**: Qwen 2.5 **7B** AWQ-INT4 (6C-11 used
  7B on A10) or 32B AWQ-INT4.
- **G.C — Data-boundary consent**: audio + transcript + prompt
  payloads cross HTTPS from Fly `iad` to Modal (US-based). GPU
  vendor does not persist payload beyond function execution (no
  Modal Volume writes). Reconfirm this crossing is acceptable for
  Silver Springs **DRAFT** content.
- **G.D — Quality thresholds + eval spec** (see
  [PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md)).
- **G.E — Pilot budget cap**: $100 USD Modal spend ceiling for the
  4Y-A pilot (EP-TRAIN-6C-11 consumed $0.029; the Spectre-app
  pipeline adds transcription workload which 6C-11 did not touch).
- **G.F — Secret-management plan**: `MODAL_SPECTRE_SHARED_TOKEN`
  via DRH-1 secret-deploy; unset after pilot closes if no further
  work authorised.

### 4.5 Modal readiness decision gate

```
Spectre-side ready ─────────────── YES
Modal workspace exists ─────────── YES
Modal functions deployed ───────── NO (generate stopped; transcribe never)
Auth-scheme bridge in place ────── NO
G.A–G.F signed off ─────────────── NO
Spend-limit review ─────────────── $10 cap intact (0.29% consumed)
Pilot source identity verified ─── YES (§3.1, Silver Springs)
Terminal-safety invariants ─────── YES (code-level)
────────────────────────────────────────────────
LIVE PILOT GATE ─────────────────── BLOCKED by auth-scheme bridge + Modal deploy + G.A–G.F
```

---

## 5. §6 — Cost governance

### 5.1 Modal account-level spend limit (authoritative)

Workspace cap: **$10 USD** (6C-11 §8 confirmed intact).

The directive says: "Do not modify the founder's Modal Spend
Limit." This preflight **preserves it**. If G.E raises the pilot
budget to $100, the founder MUST explicitly lift the Modal account
limit — never the pilot operator.

### 5.2 Daily cost threshold at the DB layer

The 4W offline branch adds `DEFAULT_DAILY_USD_MICROS = 10 × 1e6`
per-tenant rolling-24 h cap (per memory
`project_ep_train_6d_4w_offline_impl.md`). A DB-layer threshold is
a safety net, not a substitute for the Modal account limit.

### 5.3 6C-11 observed costs (reality baseline)

| Metric | Value |
|--------|------:|
| GPU family used | **A10** (not L40S) |
| Per-call GPU seconds (Q4, cold) | 3.166 s + 3.993 s LMFE setup |
| Per-call GPU seconds (warm, median Q5-Q8) | 4.353 ms (median) |
| Modal estimated cost per call | **$0.0058** |
| Total metered for 5 generations | **$0.029** |
| Workspace cap utilisation | **0.29 %** |
| Billed (Starter credit) | **$0.00** |

### 5.4 Estimated 4Y-A pilot cost

Assuming Silver Springs ≥ 131 s video + 1 transcription + 1 plan +
~12 generations (checkpoints × 2 + final × 10):

| Line item | Est. cost |
|-----------|----------:|
| Transcription (131 s video, ~30 s wall-clock on A10) | ~$0.020 |
| Generation (12 calls × $0.006) | ~$0.072 |
| Cold-start wastage (one cold boot amortised) | ~$0.015 |
| **Total per end-to-end run** | **~$0.11** |

Twenty end-to-end runs (five pilot + iteration): ~$2.20. Well
inside $10 workspace cap and G.E $100 pilot cap.

### 5.5 Governance invariants

| Invariant | Enforcement | Status |
|-----------|-------------|--------|
| Max 2 attempts per job | Service layer | Default; pilot may set `maxAttempts=1` for first 3 runs |
| One live job per video | DB unique constraint | Enforced |
| `CREDENTIAL_ABSENT` → terminal (no retry) | Worker handler | Enforced |
| `MODAL_TIMEOUT` → retryable within budget | Worker handler | Enforced |
| HMAC mismatch → terminal | Worker handler | Enforced |
| Response schemaVersion mismatch → terminal | Worker handler | Enforced |
| Rolling-24 h tenant cap | 4W code (`DEFAULT_DAILY_USD_MICROS=10e6`) | Enforced on generation path only; transcription path has no equivalent |
| No automatic retry during initial pilot | Must be set explicitly via `maxAttempts=1` in the request body or via a service-level override | Operator discretion |
| Zero GPU containers after pilot | Modal scale-to-zero + `modal app stop` | Operator action at cleanup |

### 5.6 Gaps vs the directive's §6 requirements

| Directive expectation | Spectre-side state |
|-----------------------|---------------------|
| "Maximum retry count" | Default is 2. Recommend `maxAttempts=1` for the first 3 live runs (operator discretion). |
| "Abort conditions" | Non-retryable: `CREDENTIAL_ABSENT`, `SHA_MISMATCH`, `MODAL_HMAC_INVALID`, `MODAL_BODY_INVALID`. Retryable: `MODAL_TIMEOUT`, HTTP 5xx. **No cost-cap abort on transcription path** — gap; the generation path has the 4W daily cap. Pilot operator monitors Modal dashboard manually. |
| "How to verify zero running GPU containers afterward" | Modal dashboard container count + `modal app list` / `modal container list`. Spectre operator runs this at pilot close (same pattern as 6C-11). |
| "Daily cost threshold in DB does not replace account limit" | Confirmed — the Modal $10 cap is authoritative; the 4W DB daily cap is a defence-in-depth safety net. |

---

## 6. §7 — Question-quality acceptance criteria (summary)

Full table in
[PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md).

The 6C-11 average rubric score across 5 candidates was **74.8/100**
with 1 candidate exhibiting a factual attribution error (Q6: 52)
and 1 producing an invented prescriptive interpretation (Q7: 62).
The acceptance-criteria doc translates those observed failure modes
into pilot-level thresholds.

---

## 7. §8 — Manager workflow gap analysis

### 7.1 What the 4Y workspace exposes today

| Control | Endpoint | Permission | Currently clickable in staging? |
|---------|----------|------------|---------------------------------|
| Request transcription | `POST /api/admin/training/versions/[id]/transcribe` | `hr:training:write` | Yes — returns `503` (`CREDENTIAL_ABSENT`) |
| Inspect transcript | GET transcription-status + evidence reader | `hr:training:read` | Yes if a build exists |
| Build assessment plan | Server-side; computed by `generate` route | — | Via Generate click |
| Start generation | `POST /api/admin/training/versions/[id]/generate` | `hr:training:write` | Yes — returns `503` (`CREDENTIAL_ABSENT`) |
| Inspect proposed checkpoints | 4Y UI pulls `trainingCheckpointProposal` rows | `hr:training:read` | Yes |
| Review question evidence | 4N Approval Dialog — grounding passages inline | `hr:training:ai:read` | Yes |
| Approve question | 4N POST | `hr:training:ai:approve` | Yes (`TRAINING_AI_REVIEWER` + `CLUB_ADMIN`) |
| Promote question | 4T POST | `hr:training:write` | Yes (`CLUB_ADMIN`) |
| Preview assembled course | Existing admin version editor | `hr:training:read` | Yes |

### 7.2 Gaps — steps still needing an operator / developer action

| Step | Gap | Remediation |
|------|-----|-------------|
| Assign TRAINING_AI_REVIEWER to a real reviewer | Only synthetic users have it on staging | Operator action post-G.A–G.F via Tenant Admin UI at `/app/admin/settings/users` |
| Modal credentials | Three Fly secrets must be set on both apps | Operator action (DRH-1 secret deploy) |
| Modal functions deployed on Bearer contract | Not deployed; current `modal app list` → 0 rows | Separate authorised slice: operator action with Modal Python source outside this repo |
| `maxAttempts=1` override for first live runs | Service default is 2 | Operator discretion |
| Cost-cap on transcription path | Only generation path has 4W daily cap | Deferred — add in a future slice |

### 7.3 "No developer script may substitute for a manager-facing action"

Reaffirming the 4Z-F §14 rule: every pilot-acceptance claim must
be driven through the 4Y workspace UI by an authenticated
manager (or two — per 4Z-F's two-role split). No workstation
script (including `generate-lite-run.mjs` from 6C-11) counts
toward the 4Y-A acceptance.

---

## 8. Blockers inventory (ordered by prerequisite depth)

1. **G.A–G.F signed off** (§4.4). *Decision only; no code.*
2. **Auth-scheme bridge** (§4.2 — pick Option X / Y / Z).
   *Decision only.*
3. **Modal workspace preparation**: author + commit the two Modal
   Python functions (transcribe faster-whisper + generate Qwen 2.5
   7B) honouring the chosen auth scheme. Deploy to the
   `spectreautomation-admin` workspace. Mount model-cache volumes.
   Issue the shared token. — *New authorised slice, OUT OF 4Y-A
   scope.*
4. **Fly secrets set on both staging apps** via DRH-1.
   — *Operator action, OUT OF 4Y-A scope.*
5. **Tenant Admin grants `TRAINING_AI_REVIEWER` to a real reviewer**
   (separate from the pilot operator). — *UI action.*
6. **Pilot source identity verification** (§3.2) — read-only
   preflight by the operator.
7. **Execute pilot per
   [PHASE-4Y-A-PILOT-PLAN.md](PHASE-4Y-A-PILOT-PLAN.md)** with
   `maxAttempts=1` on the first three runs.
8. **Acceptance walk per
   [PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md)**
   — publish the actual-vs-threshold table + the 6C-11-style
   rubric scoring + the founder-facing review doc.

Nothing in 1 – 8 is addressed by this preflight. Each subsequent
step requires its own authorisation.

---

## 9. Spectre-side fault-tolerance posture

| Failure class | Behaviour | Operator signal |
|---------------|-----------|------------------|
| Modal credentials missing | `CREDENTIAL_ABSENT` → FAILED (non-retryable) | status endpoint returns `failureCode=CREDENTIAL_ABSENT` |
| Modal HTTP 5xx | retried once within `maxAttempts` budget | audit + `failureCode=MODAL_HTTP_ERROR` after exhaustion |
| Modal HTTP 4xx (not 401/403) | TERMINAL | audit |
| Modal HTTP 401/403 | credential invalidation → FAIL + alert | audit |
| HMAC mismatch | TERMINAL — treated as tampering | audit + alert |
| Response schemaVersion mismatch | TERMINAL | audit |
| Audio SHA mismatch (Modal computed vs Spectre stored) | TERMINAL `SHA_MISMATCH` | audit |
| 10-min wall-clock | `MODAL_TIMEOUT` retryable | audit |
| Worker crash mid-run | lease expires; next worker tick reclaims. Stale-lease recovery job NOT implemented — see §5.6 gap. | DB: `leaseExpiresAt < now` AND `state='RUNNING'` |
| CANCELLED mid-run | late Modal response discarded; audit records both the cancel + late receipt | audit |

---

## 10. STOP compliance (§11 directive)

| STOP boundary | Posture |
|---------------|---------|
| No live Modal/Qwen/Whisper invocation | **Honoured** — no Modal network call in authoring this preflight |
| No GPU activation | Honoured |
| No Fly secrets changes | Honoured |
| No staging / production deployment | Honoured |
| No shared DB migration | Honoured (all repo inspection is `git show` + read-only) |
| No historical candidate modification | Honoured |
| No publication | Honoured |
| No employee assignments | Honoured |
| No permanent role grants | Honoured |
| No changes to the Modal spending limit | Honoured — $10 cap intact per 6C-11 |
| Preserve 126 unrelated WIP files | Honoured — 4Y-A docs live in an isolated worktree on a new branch; the WIP tree on `staging-deploy/web1b1-framer-fidelity` is untouched |

---

## 11. Final-response fields (directive §10)

| Field | Value |
|-------|-------|
| Deliverable 1 | `PHASE-4Y-A-LIVE-AI-PREFLIGHT.md` (this file) |
| Deliverable 2 | [PHASE-4Y-A-PILOT-PLAN.md](PHASE-4Y-A-PILOT-PLAN.md) |
| Deliverable 3 | [PHASE-4Y-A-ACCEPTANCE-CRITERIA.md](PHASE-4Y-A-ACCEPTANCE-CRITERIA.md) |
| Decision | **CONDITIONAL GO** |
| Blocker 1 | G.A–G.F sign-off (§4.4) |
| Blocker 2 | Auth-scheme bridge decision (§4.2 Option X/Y/Z) |
| Blocker 3 | Modal functions deployed on chosen contract + Fly secrets set (§8 steps 3-4) |
| Blocker 4 | Real `TRAINING_AI_REVIEWER` grant (§8 step 5) |
| Prior-art reference | EP-TRAIN-6C-11 (`a865fe4e`) — 5 A10 generations on 2026-11-04, $0.029 metered, workspace cap intact |

**Await founder review.**
