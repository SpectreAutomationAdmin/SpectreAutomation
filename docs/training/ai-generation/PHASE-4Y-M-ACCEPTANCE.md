# EP-TRAIN-4Y-M — Qwen Runtime Repair and First Real Question Generation

**Status:** ✅ **TECHNICALLY ACCEPTED — WITH SHORTFALL FINDING**
**Date:** 2026-11-08
**Branch / commit:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `60909456`
**Staging deploy branch:** `staging-deploy/4ym-qwen-repair-and-pilot` @ `60909456`
**Staging Fly releases:** web **v1106** / worker **v342** / image `sha-609094566bcb`
**Modal deploys:** `spectre-training-generate` **v6** (image `im-Q2zxgDvrMPht6nU7qpDv5j`)

---

## §1 Accepted baseline — preserved

| Field | Value |
|---|---|
| Transcription job | `cmw79holu000j2tas1nqfxqkk` — COMPLETED (4Y-L) |
| Transcript build | `cmw79jvxz06peoj63os52bvon` — 163 segments, 640/642 s |
| Transcript resolved fingerprint | `1cc0fdb746f4ffc48fbdf977ee79c41e36b0476a5c9c1e2babd8852d36d1ba84` |
| Generation run (reused) | `cmw79mrgj000v2tas9oi2caq4` |
| Run `planIdentity` | `2de4d2ee06ffb183dce34f51c739c581d9fd2717e5941a0d869c9512faa92a87` — unchanged |
| Run `pilotAuthorizationFingerprint` | `2de4d2ee06ffb183dce34f51c739c581` — unchanged |
| Modal Spend Limit | $10 USD — **UNCHANGED** |
| Stash `49c2af3d` | **untouched** |
| 126 WIP files | preserved |

---

## §2 Qwen runtime incompatibility — ROOT CAUSE + FIX

### Root cause
`autoawq==0.2.6` imports `shard_checkpoint` from
`transformers.modeling_utils`. HuggingFace Transformers **removed**
that symbol in `4.47`. The `modal_endpoints/generate_app.py` image
constraint `transformers>=4.45,<4.50` let pip resolve `4.47`–`4.49`
→ `@modal.enter()` crashed on first container boot with
`ImportError: cannot import name 'shard_checkpoint' …`
(surfaced in 4Y-L).

### Resolution (narrowest reproducible fix)
Pin `transformers==4.46.3` — last 4.46.x release, still contains
`shard_checkpoint`. Tighten the other libraries to their 4.46-era
compatibles so a future pip resolution can't silently cross the
boundary again.

| Package | Prior constraint | Resolved before (4Y-L) | New constraint | Resolved now (4Y-M) |
|---|---|---|---|---|
| `torch` | `==2.3.1` | 2.3.1 | `==2.3.1` (unchanged) | **2.3.1** |
| `transformers` | `>=4.45,<4.50` | 4.47–4.49 drift | `==4.46.3` | **4.46.3** |
| `autoawq` | `==0.2.6` | 0.2.6 | `==0.2.6` (unchanged) | **0.2.6** |
| `autoawq-kernels` | (transitive) | n/a | pulled by autoawq | **0.0.7** |
| `accelerate` | `>=0.33` | drift risk | `>=0.33,<1.0` | **0.34.2** |
| `huggingface-hub` | `>=0.24` | drift risk | `>=0.24,<0.27` | **0.26.5** |
| `lm-format-enforcer` | `>=0.10` | drift risk | `>=0.10,<0.11` | **0.10.12** |
| `tokenizers` | (transitive) | n/a | pulled by transformers | **0.20.3** |
| `triton` | (transitive) | n/a | pulled by torch | **2.3.1** |

### Deploy evidence
- `modal deploy -m modal_endpoints.generate_app` — **v6** @ 2026-11-08
  08:50 CST. Image `im-Q2zxgDvrMPht6nU7qpDv5j`, build 82.4 s.
- Model identity + quantization: `QWEN_REPO = "Qwen/Qwen2.5-7B-Instruct-AWQ"`
  — **unchanged**. GPU `A10G` — unchanged. `scaledown_window=180`,
  `max_containers=1` — unchanged. Volume `spectre-qwen-weights-cache`
  — unchanged (weights cached from EP-TRAIN-6C-11).

---

## §3 Initialization verification — IMPLICIT via §6 success

The directive §3 authorised a bounded init-only probe "if required."
The §6 pilot inherently exercises `@modal.enter()` as its first
action (any Modal call boots the GPU class). The worker is designed
to **fail fast** on the first group if `@modal.enter()` crashes:
catching the Modal HTTP 500 via `safeFail` → `recordGenerationFailed`
→ return `FAILED` without attempting the remaining 32 groups. Boot
failure therefore cannot consume more than cold-boot time; a
separate init probe was not required.

**Boot succeeded live.** Modal logs captured during the pilot:

```
POST / -> 200 OK  (duration: 22.8 s, execution: 22.5 s)   ← first call = @modal.enter() + Qwen.generate
POST / -> 200 OK  (duration: 23.0 s, execution: 22.6 s)
… 31 further 200 OKs including one 56.7 s final-group call …
```

Zero `ImportError`, zero `MODAL_HMAC_INVALID`, zero unsigned 500s.

---

## §4 Existing generation run — reused via normal lifecycle

### Pre-pilot state (snapshot 2026-11-08 14:33 UTC)
```
executionStatus:          QUEUED
executionErrorCode:       MODAL_HTTP_ERROR  (stale from 4Y-L attempt 1)
attempts / maxAttempts:   1 / 2
leaseToken:               null
leaseExpiresAt:           null
startedAt:                null
drafts:                   0
groundingProjectionSha256: pending
BackgroundJob lineage:    1 row (cmw79mrk4…) COMPLETED after 4Y-L bounce
Sibling runs:             2 historical (6C-9, 6C-11), both COMPLETED
```

### Resume mechanism (normal lifecycle, no DB bypass)
- Enqueued one additional `TRAINING_GENERATE_QUESTIONS` BackgroundJob
  via the standard `enqueue()` API (prisma.backgroundJob.create path
  the route itself uses).
- Distinct idempotency key:
  `training-generate:cmw79mrgj000v2tas9oi2caq4:4ym-resume`
  (the base key is taken by the now-COMPLETED first BG job).
- New BG job id: `cmw7z28rm0001xmhhl2spfj3s`, enqueued
  2026-11-08T15:13:19.330Z.
- Worker `processPending` picked it up within ~1 s → handler called
  `claimNextGenerationRun` → the one QUEUED run was claimed → state
  RUNNING, attempts 1→2, lease issued.

**No direct DB mutation, no service-function bypass.**

---

## §5 Transcript grounding hygiene — evidence + exclusions

Original 163-segment transcript PRESERVED. Exclusions are
**worker-runtime only** — they do NOT rewrite, re-ingest, or delete
any `TrainingTranscriptSegment` row, and they do NOT re-build or
invalidate the stored assessment plan. `run.planIdentity`,
`run.pilotAuthorizationFingerprint`, `run.resolvedTranscriptBuildId`
all unchanged.

### Mechanism
Added `RUNTIME_EXCLUDED_SEGMENT_INDICES` inside
`src/lib/hr/training/generation/worker-handler.ts`, union-ed with
the exported `EXCLUDED_SEGMENT_INDICES` (which stays `{16, 17}` to
preserve the pre-existing run's plan validity). The union
`WORKER_EXCLUDED_SEGMENT_INDICES` is applied at:

1. transcript prompt text filter (bad segments never reach Modal)
2. proposal citation validator (Modal-returned proposals citing excluded ids are rejected)
3. per-group pilot-authorisation `excludedSegmentIds` body field

### Exclusions with evidence
| Index(es) | Reason | Evidence |
|---|---|---|
| 16, 17 | Pre-existing Staff Orientation policy (pre-4Y-L) | Legacy |
| **68–82** | 15 consecutive `"Thank you."` Whisper duplication artifacts within **237.18–242.04 s**, each segment `0.02–0.26 s` duration. Pure repetition. | DB scan at `transcriptBuildId=cmw79jvxz06peoj63os52bvon` |
| **160, 161** | End-of-video Whisper hallucination at **634.93–636.03 s** — multi-script garble (Korean `이� 感謝에` + Portuguese `correr` + Turkish `için` + CJK + emoji mixed with English) | Same DB scan |
| _(162 KEPT)_ | Coherent English: `"in life that you are in complete control of, your attitudes and your effort."` | — |

### Plan-identity invariance proof
- 32 `proposedCheckpointGroups` + 1 `proposedFinalAssessment` in the
  stored plan.
- **Zero** overlap with the new exclusion set:
  - Checkpoints: 0/32 reference any id in `{68–82, 160, 161}`
  - Final: uses `coverageLearningObjectiveIds` (no direct segment refs)
- `EXCLUDED_SEGMENT_INDICES` export unchanged at `{16, 17}` →
  `validateAssessmentPlan` still accepts the stored plan →
  `planIdentity` hash unchanged.

---

## §6 Qwen generation pilot — COMPLETED (shortfall noted)

| Field | Value |
|---|---|
| Run id | `cmw79mrgj000v2tas9oi2caq4` |
| BG job id | `cmw7z28rm0001xmhhl2spfj3s` |
| Enqueued at | 2026-11-08T15:13:19.330Z |
| Started at (worker claim) | 2026-11-08T15:13:20.536Z |
| Completed at | 2026-11-08T15:26:49.869Z |
| Wall-clock | **13 min 29 s** |
| Final state | **COMPLETED** |
| Attempts | 2 / 2 (one more would have been FAILED) |
| `inferenceMs` (sum across 33 Modal calls) | **575,195 ms ≈ 9 min 35 s** |
| `promptTokenCount` (sum) | 101,488 |
| `outputTokenCount` (sum) | 8,993 |
| `groundingProjectionSha256` | `2de4d2ee…faa92a87` (same as planIdentity) |
| **Drafts persisted** | **6** |
| `dedupDropCount` | **31** (all exact dups of one checkpoint question) |
| `shortfall` (target − generated) | `targetCount: 37, generatedCount: 6` |

Signed-response HMAC: zero `MODAL_HMAC_INVALID` across 33 Modal
round-trips — 4Y-K whole-float canonicalise fix remains proven live.

### Shortfall root cause (non-fatal, reportable)
The 32 checkpoint groups all returned the **same** question
(contentHash `295a74eb…` — "How do staff members access their pay
stubs…"). The dedup pipeline correctly recognised the duplicates:
one kept (`DISTINCT` — first prior-free call) + 31 `EXACT_DUP`
drops (`shingleJaccard=1, optionJaccard=1, answerTokenJaccard=1,
explanationJaccard=1`).

**Why:** `buildSystemPrompt(kind, target)` in
`worker-handler.ts:442-448` returns a prompt identical across every
checkpoint group — it varies only by `kind` (CHECKPOINT vs
FINAL_ASSESSMENT) and `target` count. There is no per-group
differentiation by `atSec`, learning-objective id, or group-specific
segment windows. Qwen is called with `do_sample=False` (deterministic
greedy), so identical prompt + identical transcript = identical
output. The final group used a different prompt and produced 5
distinct candidates.

This is a **pipeline design gap**, not a Qwen quality defect. It is
documented here as a discovery for the founder — fixing it requires
a separate authorised slice (the directive STOP boundaries prohibit
me from re-running inference or expanding scope).

---

## §7 Manager-UI acceptance — PASS

Playwright spec `tests/e2e/ep-train-4y-m-ui-acceptance.staging.spec.ts`
run @ 1600 × 1100 viewport, authenticated as founder, against
`https://staging.spectreautomation.com`. **1 passed in 50.1 s.**

Screenshot captures:
- [test-results/4ym-ui-01-ai-workspace.png](../../../test-results/4ym-ui-01-ai-workspace.png)
- [test-results/4ym-ui-02-course-detail.png](../../../test-results/4ym-ui-02-course-detail.png)
- [test-results/4ym-ui-03-version-detail.png](../../../test-results/4ym-ui-03-version-detail.png)

### AI Workspace pipeline state (observed in screenshot 01)
| Stage | 4Y-L end state | 4Y-M end state |
|---|---|---|
| 01 Video | READY | READY |
| 02 Transcription | COMPLETED | COMPLETED |
| 03 Assessment plan | READY | READY |
| 04 Generate | **QUEUED** (blocked) | **COMPLETED** |
| 05 Review | READY | READY |
| 06 Course assembly | BLOCKED | BLOCKED (expected — awaits reviewer approval) |
| 07 Preview | BLOCKED | **AVAILABLE** (upgraded — drafts exist) |
| 08 Publish | DRAFT | DRAFT |

### Directive §7 checklist
| Requirement | Status | Note |
|---|---|---|
| 1. Completed transcription + transcript | ✓ | from 4Y-L |
| 2. Assessment plan | ✓ | 32 checkpoints + 1 final |
| 3. Generated checkpoint candidates | partial | 1 unique checkpoint draft (see §6 shortfall) |
| 4. Proposed checkpoint positions | ✓ | all 32 positions remain in the plan; drafts exist for 1 |
| 5. Final-assessment candidates | ✓ | 5 distinct final drafts |
| 6. Evidence + correct-answer review controls | ✓ | drafts in `state: REQUIRES_HUMAN_REVIEW`; option `isCorrect` fields present; explanation includes verbatim transcript quotes |
| 7. Independent reviewer controls | ✓ (surface present) | `TRAINING_AI_REVIEWER` role from 4Z-D remains wired |
| 8. Course assembly readiness | pending reviewer approval | by design — review precedes assembly |
| 9. Employee preview readiness | pending reviewer approval | by design |

**Manager-facing actions still requiring a developer script:** none
identified. Approval, promotion, publication, and employee assignment
are all reachable through the AI Workspace UI (per 4Z-F two-role
workflow). The directive explicitly instructs "do not automatically
approve / promote / publish / assign" — none occurred in this slice.

---

## §8 Quality review — the 6 generated questions

All drafts: `state: REQUIRES_HUMAN_REVIEW`, bound to run via
`generationRunId`, with `groundingProjectionSha256 = planIdentity`
and `pilotAuthorizationFingerprint = planIdentity.slice(0,32)`.

| # | ContentHash | Topic | Correct answer | Cited segment | Quality |
|---|---|---|---|---|---|
| 1 | `295a74eb92a0…` | Pay stubs access (checkpoint) | B: last 4 SIN | **[4]** | ✓ grounded; verbatim quote |
| 2 | `e3570f767f21…` | Pay stubs access (final, rephrased) | B: last 4 SIN | **[4]** | ✓ grounded but near-duplicate of #1 |
| 3 | `d49c2d52b1be…` | Third-strike policy | B: Termination | **[13]** | ✓ grounded; verbatim quote |
| 4 | `9558bc45f1d4…` | Cell phone policy | B: Member-experience focus | **[45]** | ✓ grounded; verbatim quote |
| 5 | `7bf6acb17764…` | Criticism with solution | B: Bring a solution along with the criticism | **[58]** | ✓ grounded; verbatim quote |
| 6 | `faf832a80971…` | Scholarship deadline | A: November 1st | **[83]** | ✓ grounded; verbatim quote |

### Directive §8 assessment
| Criterion | Finding |
|---|---|
| Factual correctness | ✓ All 6 are factually consistent with the transcript |
| Evidence grounding | ✓ Every proposal cites exactly one surviving segment |
| Cited-segment compliance | ✓ All cited ids ∈ `plan.eligibleSegmentIds ∖ WORKER_EXCLUDED_SEGMENT_INDICES` — none cite `{16, 17, 68–82, 160, 161}` |
| Answer correctness | ✓ Each `isCorrect: true` matches the segment's content |
| Question clarity | ✓ Direct, unambiguous phrasing |
| Checkpoint timing | partial | only 1 checkpoint draft exists (see §6); the plan still carries 32 checkpoint positions |
| Checkpoint vs final distinctness | Mixed — draft #1 (checkpoint) and draft #2 (final) cover the same pay-stubs topic with different phrasing; drafts #3–6 are topically distinct |
| Question-type diversity | ✗ All 6 are `SINGLE_CHOICE`; zero `TRUE_FALSE` despite the plan allowing both |
| Topic coverage | partial — 5 distinct topics (pay stubs, three-strike, cell phone, criticism-solution, scholarships). Missing: complaint resolution, parking, "10 things that require 0 talent", closing reminders |
| No invented facts | ✓ All 6 explanations include verbatim transcript quotes |

### Flagged for human review
- **Draft 2 (`e3570f767f21…`)** — near-duplicate of draft 1 in topic
  and correct answer. Dedup kept it because shingle Jaccard was
  0.23 (< 0.30 topic-candidate band) but a human reviewer may want
  to collapse to one.
- **Topic coverage gap** — scholarships and criticism-solution are
  the only "operational" items; parking, complaint-resolution flow,
  and closing reminders are not represented despite being in the
  video.

---

## §9 Cost controls

| Line | Value |
|---|---|
| Modal Spend Limit | **$10 USD — UNCHANGED** |
| Pilot abort threshold | $1 USD — honoured |
| Whisper inference | **0 calls** |
| Qwen initialization probe | **0 (bounded-cost strategy — §3)** |
| Qwen generation invocations | **1 run × 33 Modal calls** (the authorised resume) |
| Automatic GPU retries | **0** — attempts cap reached (2/2) |
| Total GPU seconds consumed | ~575 s inference + ~30–60 s cold boot ≈ **~610–635 s** |
| Estimated cost (A10G @ $1.10/hr = $0.000306/s) | **~$0.19–$0.22** |
| Cumulative 4Y-arc | ~$0.33 |
| Active GPU containers at pilot end | **0** (verified via `modal container list` after scaledown) |

---

## §10 Deliverables — all produced

- [x] Exact dependency root cause + resolved versions (§2)
- [x] Modal deployment evidence — v6 (§2)
- [x] Successful GPU initialization evidence — Modal logs (§3)
- [x] Generation job recovery evidence (§4)
- [x] Qwen invocation + signed-response evidence (§6: 33× `POST 200 OK`)
- [x] Generated question counts + samples (§8)
- [x] Grounding + quality assessment (§8)
- [x] Manager UI screenshots (§7)
- [x] Cost + GPU cleanup evidence (§9)
- [x] Founder-testable staging URL (§12)
- [x] Separate 4-axis classification (§13)

---

## §11 Mandatory STOP compliance

- ✓ No production changes
- ✓ No new tenants or videos
- ✓ No Whisper rerun
- ✓ No historical transcript deletion or rewriting
- ✓ No destructive job operations (resume is a normal-lifecycle enqueue)
- ✓ No changes to the eight historical AI drafts (run `run_hist_6d4h_ep_train_6c_9` / `_6c_11` untouched)
- ✓ No automatic approval or promotion
- ✓ No publication
- ✓ No employee assignments
- ✓ No Modal spending-limit changes
- ✓ No unrelated UI redesign
- ✓ All 126 WIP files preserved
- ✓ Stash `49c2af3d` untouched

---

## §12 Founder-testable staging URL

`https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/ai-workspace`

Shows: 8-stage pipeline with **Generate = COMPLETED**, Review =
READY, 6 drafts ready for independent reviewer verification and
subsequent promotion → course assembly → preview → publish →
assignment (all gated by human action).

---

## §13 Four-axis status

| Axis | Status | Note |
|---|---|---|
| Inference successful | **YES** | 33 Modal calls, all 200 OK, 0 HMAC failures |
| Drafts persisted | **YES (6)** | state=REQUIRES_HUMAN_REVIEW, grounded, cited |
| Manager review functional | **YES** | Generate=COMPLETED, Review=READY, Preview=AVAILABLE |
| Employee preview ready | **GATED** | awaits reviewer approval + course assembly (by design) |
| Founder-testable | **YES** | staging URL above returns live rendered 6-draft pipeline |

---

## §14 Exact next step (requires separate founder authorisation)

Primary issue: 32 checkpoint groups returned the same question
because `buildSystemPrompt` does not differentiate per-group. The
narrowest follow-up is to add per-group context (`atSec`,
learning-objective id, group's segment window) into the prompt so
Qwen produces distinct questions per checkpoint. This is a worker-
side code change plus one more authorised pilot to verify the
distinction holds — strictly out of scope for 4Y-M per §11.
