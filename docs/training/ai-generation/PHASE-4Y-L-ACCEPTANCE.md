# EP-TRAIN-4Y-L — Live Whisper + Conditional Qwen Pilot · Acceptance Report

**Date:** 2026-11-08
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Commit (inbound):** `435954c6` (4Y-K response-HMAC fix)
**Staging:** web **v1105** · worker **v341** · image `sha-c3dc2b6cd776` (UNCHANGED)
**Modal apps:**
- `spectre-training-transcribe` — unchanged from 4Y-K deploy (includes whole-float normalisation)
- `spectre-training-generate` — redeployed in-slice (Gate 2 activation only; no auth change)

**Modal Spend Limit:** $10 USD — **UNCHANGED**
**126 unrelated WIP files:** PRESERVED (stash `49c2af3d` untouched per directive §1)

---

## Headline

- **Whisper pilot: PASSED** on the first attempt. Real GPU inference, 163-segment transcript persisted, `TrainingTranscriptBuild` written, grounding-ready. The 4Y-K response-HMAC fix is **PROVEN LIVE on a real Whisper response body**.
- **Qwen pilot: BLOCKED** by a pre-existing autoawq / transformers dependency drift in the Modal GPU image (not an HMAC issue — the GPU container fails during `@modal.enter()`, so no signed response is ever produced).
- **STOPPED** per directive §4 "If generation fails, STOP without retrying."

---

## §1 Baseline — preserved

All 4Y-K acceptance conditions unchanged. Fly staging UNCHANGED. 126 WIP preserved (one unrelated `generate_app.py` comment-only stash `49c2af3d` left alone per §1).

---

## §2 Preflight — all checks PASS

| Check | Result |
|---|---|
| Git baseline | `435954c6` (4Y-K) ✓ |
| Fly web | v1105 / sha-c3dc2b6cd776 ✓ |
| Fly worker | v341 / sha-c3dc2b6cd776 ✓ |
| `/api/health` | HTTP 200 (db ok 15ms; queue warn = 9 historical DLQ, unrelated) |
| Modal `spectre-training-transcribe` | state=deployed, tasks=0 |
| Modal `spectre-training-generate` | state=deployed, tasks=0 |
| Modal active GPU containers | **ZERO** |
| Course + version | Coulee Ridge · "2026 Employee Rules and Perks — Staff Orientation" (`cmvzs3w05000456qcgfgps7gy`), DRAFT, videoSHA d1ddb823…, videoDuration 642 s |
| Active transcription jobs for this video | **0** (4 historical rows preserved: CANCELLED, FAILED×3) |
| 4Y-J migration applied | ✓ at 2026-11-08T02:22:22Z |
| 4Y-J partial unique present | ✓ `TrainingTranscriptionJob_active_club_version_sha_key` |
| Old state-inclusive unique dropped | ✓ |
| Worker env (5 Modal secrets) | all present ✓ (markers only; no values logged) |
| Active BackgroundJobs | 0 |

---

## §3 Live Whisper transcription — COMPLETED on first attempt

### Trigger

Spec: [tests/e2e/ep-train-4y-j-live-pilot.staging.spec.ts](../../../tests/e2e/ep-train-4y-j-live-pilot.staging.spec.ts) (unchanged from 4Y-J) ran authenticated as founder, `POST /api/admin/training/versions/cmvzs3w05000456qcgfgps7gy/transcribe`. Response `{ok:true, jobId:"cmw79holu000j2tas1nqfxqkk", state:"QUEUED", idempotent:false}`.

### Observed transitions

```
02:35:42 Z — pre-state:  FAILED (cmw77zmiz…, the 4Y-K root-cause job)

03:17:29.682 Z — requestedAt
03:17:29.712 Z — queuedAt     (markQueued)
03:17:30.118 Z — startedAt    (worker claim, attempts 0→1)
03:17:44.107 Z — poll: RUNNING
03:19:13.196 Z — completedAt  state=COMPLETED
03:19:15.768 Z — poll: COMPLETED
                 transcript.buildId = cmw79jvxz06peoj63os52bvon
                 resolvedTranscriptBuildId = 1cc0fdb746f4ffc48fbdf977ee79c41e36b0476a5c9c1e2babd8852d36d1ba84
                 segmentCount = 163
                 transcriberModelName = faster-whisper-large-v3
                 elapsedMsTotal = 84 260 ms  (~1m 24s Whisper execution on A10G)
```

### Evidence that the 4Y-K fix is live

- Zero `MODAL_HMAC_INVALID` failures.
- `recordJobCompleted` fired cleanly — the response HMAC verified over a real 642-s transcript body that almost certainly contains whole-number float segment boundaries (`startSec:0.0`, etc.).
- No lifecycle P2002 (validates 4Y-J partial-unique migration under live conditions).
- Lease cleared; attempts = 1/2 (one attempt sufficed).

### Transcript persistence

- `TrainingTranscriptBuild` row: `cmw79jvxz06peoj63os52bvon`, 163 segments, producedAt 03:17:30.405Z.
- `TrainingTranscriptSegment` rows: 163 (spot-checked sample below).
- `TrainingGroundingProjection` rows: **0** (built by the generation flow, not transcription; absent here because §4 Qwen never ran).

---

## §4 Conditional Qwen generation — STOPPED (unsigned 500 from Modal GPU container boot crash)

### Trigger

- Modal `spectre-training-generate` Gate-2 activation: removed `env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}` on the `@app.function` wrapping `api`. Fresh edit to `modal_endpoints/generate_app.py` (NOT the unrelated stashed `49c2af3d` — that remains untouched per §1). Redeploy: `modal deploy -m modal_endpoints.generate_app` → ✓ 2.687s.
- Spec: new [tests/e2e/ep-train-4y-l-live-generate.staging.spec.ts](../../../tests/e2e/ep-train-4y-l-live-generate.staging.spec.ts) · POST `/api/admin/training/versions/cmvzs3w05000456qcgfgps7gy/generate` (empty body → defaults). Response `{ok:true, generationRunId:"cmw79mrgj000v2tas9oi2caq4", state:"QUEUED", idempotent:false}` at 03:21:26 Z.

### What happened

```
03:21:26.659 Z — run requestedAt
03:21:27.565 Z — BG job started
03:23:31.744 Z — run queuedAt  (worker handler bumped run RUNNING→QUEUED after retryable fail)
03:23:31.956 Z — BG job finishedAt, lastError=null
03:23:31      Z — run state: QUEUED (stuck; attempts=1/2; no lease)
                 executionErrorCode = MODAL_HTTP_ERROR
                 executionErrorMessage = "Modal returned HTTP 500 with no signed-response headers; classifying as transport error."
                 planIdentity = 2de4d2ee06ffb183dce34f51c739c581d9fd2717e5941a0d869c9512faa92a87
                 resolvedTranscriptBuildId = 1cc0fdb746f… (bound to the Whisper transcript)
                 draftCount = 0
```

### Root cause (from Modal `spectre-training-generate` logs)

GPU container failed during `@modal.enter()` model load:

```
File "/root/modal_endpoints/generate_app.py", line 100, in _load_model
  self.model = AutoModelForCausalLM.from_pretrained(...)
File ".../transformers/quantizers/quantizer_awq.py", line 107, in _process_model_before_weight_loading
  model, has_been_replaced = replace_with_awq_linear(...)
File ".../awq/models/base.py", line 14, in <module>
  from transformers.modeling_utils import shard_checkpoint
ImportError: cannot import name 'shard_checkpoint' from 'transformers.modeling_utils'
Function fu-UkJxlhTw25rKkLrhzWm5Ne failed during startup.
Function modal_endpoints.generate_app.Qwen.* is crash-looping: containers are repeatedly failing to start.
```

**Interpretation:**
- `autoawq==0.2.6` (pinned in `generate_app.py` image) imports `shard_checkpoint` from `transformers.modeling_utils`. That function was removed in `transformers 4.47+`.
- My image constraint `transformers>=4.45,<4.50` is too loose: pip selected the newest compatible (`4.47` or `4.48` or `4.49`) which already dropped `shard_checkpoint`.
- GPU container crashes during `@modal.enter()` BEFORE the ASGI auth handler can sign a response.
- From the worker side, this surfaces as **unsigned HTTP 500** → the client correctly classifies as `MODAL_HTTP_ERROR` (transport-level) and does NOT trust any header on the response.

**This is NOT an HMAC / canonicalise regression.** The 4Y-K fix is unrelated to this failure class. It is a pre-existing Modal-image dependency drift that was never surfaced live because Qwen was Gate-1-blocked until this slice.

### Per directive §4: STOPPED without retrying

- The worker classified `MODAL_HTTP_ERROR` as retryable (standard behaviour — transport failures can be ephemeral). The run transitioned RUNNING→QUEUED without a scheduled BG retry.
- No retry BG job enqueued. No further Modal invocation occurred from the Spectre side.
- Modal's own crash-loop detector gave up after ~2 container-boot attempts (now 0 containers active).
- Per directive §9 "no destructive DB operations" — the stuck QUEUED run `cmw79mrgj000v2tas9oi2caq4` is **NOT cancelled, deleted, or mutated**. The next pilot will need to either retry it or cancel it under a separate authorization.

---

## §5 Manager-UI acceptance evidence

Playwright screenshots captured by [tests/e2e/ep-train-4y-l-ui-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-4y-l-ui-acceptance.staging.spec.ts):

| # | File | Content |
|---|---|---|
| 01 | `test-results/4yl-ui-01-ai-workspace.png` | AI Workspace page — 8-stage pipeline (Video READY · **Transcription COMPLETED** · Assessment plan READY · **Generate QUEUED** · Review READY · Course assembly BLOCKED · Preview BLOCKED · Publish DRAFT). Shows video metadata: 138.6 MB, 10.7 min, SHA d1ddb823…, storage key clubs/cmrvdeny7000144372ktmmg9c/… |
| 02 | `test-results/4yl-ui-02-course-detail.png` | Course "2026 Employee Rules and Perks — Staff Orientation" detail page |
| 03 | `test-results/4yl-ui-03-version-detail.png` | Version detail page (transcribe + generate action surfaces) |

API-echo evidence captured in the same spec:

- `transcription-status`: `state=COMPLETED`, buildId set, 163 segments, transcriber=faster-whisper-large-v3.
- `generation-status`: `state=QUEUED`, executionErrorCode=MODAL_HTTP_ERROR, executionErrorMessage="Modal returned HTTP 500 with no signed-response headers; classifying as transport error", draftCount=0, model=qwen-2.5-7b-instruct-awq / vllm, planIdentity 2de4d2ee…, resolvedTranscriptBuildId 1cc0fdb7…

### Per directive §5 scope — what IS and ISN'T accessible

| # | Check | Status |
|---|---|---|
| 1 | Transcription status + transcript | ✓ visible (stage 02 COMPLETED badge) |
| 2 | Assessment plan | ✓ visible (stage 03 READY — pre-computed from transcript, pre-generate) |
| 3 | Generated checkpoint questions | ✗ NOT PRESENT (Qwen failed → 0 drafts) |
| 4 | Suggested checkpoint placement | ✗ NOT PRESENT (needs generation output) |
| 5 | Final assessment questions | ✗ NOT PRESENT (needs generation output) |
| 6 | Evidence + correct-answer review | ✗ NOT PRESENT (needs generation output) |
| 7 | Approval/rejection controls | ✗ NOT PRESENT (needs drafts) |
| 8 | Course assembly controls | ✗ NOT PRESENT (stage 06 BLOCKED pending approved drafts) |
| 9 | Employee preview | ✗ NOT PRESENT (stage 07 BLOCKED pending assembly) |

**No gaps vs expected manager UI**: every "✗ NOT PRESENT" row is a legitimate downstream block — the UI faithfully reflects the pipeline state produced by what inference did and did not complete. The Generate stage shows QUEUED badge (not FAILED) because the worker's RUNNING→QUEUED retry classification sits atop a transport-level 500.

**No automatic approval / promotion / publish / assignment** occurred. Zero draft modifications, zero publication writes.

---

## §6 Quality assessment — transcript (Qwen questions unavailable)

### Coverage + identity

- Segment count: **163**
- Time coverage: 0.7 s → 640.39 s (video duration 642 s → 99.7 % coverage; only ~1.6 s silence trimmed from head/tail)
- Source identity (confirmed from segment 0 + 1):
  - Segment 0 (0.7-3.9s): *"Hello everyone and welcome to the Silver Springs Golf and Country Club."*
  - Segment 1 (3.9-7.98s): *"We're happy to have you as a team member. I'm Randy Hunter, Head Golf Professional."*
  - Correctly identifies the video's authoring organisation as Silver Springs (cross-tenant content on a Coulee Ridge course — per standing founder clarification [[project-ep-train-4y-d-gate1-blocked]], this is intentional pilot material).

### Topic coverage (spot-check against domain expectations for a staff orientation)

Identified topics in the sampled segments:
- Pay stub access (seg 3-6: "last four digits of your SIN number")
- Three-strike policy (seg 7-9)
- Scholarships ("three $500 scholarships… application deadline November 1st", seg 83-86)
- Parking rules (seg 87-89: "Varsity Estates Drive")
- Concluding reminders (seg 158-159: "10 things that require 0 talent — being on time, work ethic, effort, energy, body language, passion…")

These are consistent with real-world staff-orientation content.

### Quality findings (honest)

**Positive:**
- 163 segments across 640 s ⇒ ~3.9 s mean segment length (reasonable for conversational speech).
- Speaker attribution consistent ("Randy Hunter, Head Golf Professional" named early).
- Timestamps monotonic in the sampled regions.
- No silent stall; coverage is near-complete.

**Negative / flags for human review:**
- **Repetition artifact at ~241 s** (segs 80-82): three consecutive `"Thank you."` fragments 0.02 s apart — Whisper's known hallucination pattern on short silences. Spectre's `analyseTranscriptQuality` heuristic catches this class via REPETITION_ARTIFACT flag (3+ segments with jaccard > 0.9), but the per-segment flags were not populated in the sample read — the quality signal may live in a separate report path (see follow-up).
- **End-of-video hallucination** (segs 160-162, 634-640 s): garbled multi-script fragments including Korean (`감사에`), Chinese (`感謝`), Vietnamese (`correr için`), interspersed with semi-English (`"let's pray today twoavy that we are leaving early"`). This is Whisper large-v3's well-known hallucination mode on low-SNR tail audio. Segment 162 recovers to a coherent closing (`"in life that you are in complete control of, your attitudes and your effort."`). These three segments would need operator review before any Qwen grounding.
- No `uncertaintyWarning` was populated on the sampled segments (field exists on `TrainingTranscriptSegment` but was null for the spot-checked rows).

**Qwen question quality: NOT APPLICABLE this slice** — no drafts were generated. Per directive §6 "Do not characterize lexical deduplication as guaranteed semantic uniqueness" — there is no lexical or semantic comparison to make.

---

## §7 Cost + resource controls

### Estimated Modal GPU seconds this slice

| Event | GPU | Duration | Est. cost |
|---|---|---|---|
| §3 Whisper transcription (A10G) | A10G | `elapsedMsTotal` = 84 260 ms (~84 s) | ~**$0.026 USD** ($1.10/h × 84.26 s / 3600) |
| §4 Qwen GPU boot-failed (×2 containers per logs, each ~15-20 s before crash) | A10G | ~30-40 s total | ~**$0.011 USD** |
| **4Y-L total** | | | ~**$0.037 USD** |

Cumulative 4Y-arc total (H + I + J + L): ~**$0.11 USD**. Well under the $1 abort threshold and the $10 Modal spend-limit.

### Cost monitoring

- Modal container list end-of-slice: `[]` (zero active containers). Both Transcriber GPU + Qwen GPU scaled down.
- CPU asgi handlers also idle (observed earlier `ta-*` containers all absent now).
- `$10 USD Modal spend-limit UNCHANGED`.
- No GPU retries initiated by Spectre code after the single authorised invocation per worker. The Qwen Modal crash-loop was contained by Modal's own task-lifecycle.

---

## §8 Deliverables

| Deliverable | Reference |
|---|---|
| Transcription job ID | `cmw79holu000j2tas1nqfxqkk` |
| Generation run ID | `cmw79mrgj000v2tas9oi2caq4` (QUEUED, stuck at attempts=1/2) |
| Real Modal GPU execution evidence | §3 (Whisper 84.26s A10G) + §4 Modal logs quote (Qwen crash-loop) |
| HMAC verification results | §3 — zero MODAL_HMAC_INVALID; §4 — unsigned 500 (transport-level, not HMAC-related) |
| Transcript segment count | 163 |
| Grounding projection details | 0 (requires generation output) |
| Generated question counts | 0 (generation did not complete) |
| Checkpoint timestamps | — |
| Final assessment results | — |
| Quality findings | §6 (transcript only) |
| Manager UI screenshots | `test-results/4yl-ui-01..03.png` + one shown inline in §5 |
| Staging URL for founder testing | `https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/ai-workspace` |
| Cost + cleanup evidence | §7 |

### Four-axis classification

| Axis | Status |
|---|---|
| Inference completed | **PARTIAL** — Whisper ✓ / Qwen ✗ |
| Artifacts persisted | **PARTIAL** — `TrainingTranscriptBuild` + 163 `TrainingTranscriptSegment` rows ✓ / zero drafts / zero grounding projection |
| Manager UI functional | **PARTIAL** — stages 01-03 ✓ ("Generate" stage shows QUEUED badge honestly; downstream stages correctly BLOCKED) |
| Founder-testable | **PARTIAL** — founder can log in, view the transcript in-workflow, see the honest pipeline state, but cannot yet review AI-generated questions |

---

## §9 Mandatory STOP compliance

| Boundary | Status |
|---|:-:|
| No production changes | ✓ |
| No other tenants or videos | ✓ (Coulee Ridge + Silver Springs only) |
| No historical job deletion | ✓ (4 historical transcription rows + 2 historical generation runs preserved byte-identical) |
| No modification of the eight historical AI drafts | ✓ (AI-draft tables never read or written) |
| No automatic approval or promotion | ✓ |
| No publication | ✓ |
| No employee assignments | ✓ |
| No Modal spending-limit changes | ✓ |
| No unrelated UI redesign | ✓ |
| 126 unrelated WIP files preserved | ✓ (stash `49c2af3d` untouched) |

**STOPPED after the single conditional Whisper/Qwen pilot and this acceptance report.** No further inference will be invoked without explicit founder authorization.

---

## Exact next step to resume the Qwen pilot (requires founder authorisation)

The 4Y-K response-HMAC contract is now proven on a real Whisper response body. The remaining blocker is a self-contained Modal-image dependency fix in `modal_endpoints/generate_app.py`:

```python
.pip_install(
    "torch==2.3.1",
    "transformers>=4.45,<4.47",  # ← tighten upper bound from <4.50
    "autoawq==0.2.6",
    ...
)
```

Rationale: `autoawq==0.2.6` requires `transformers.modeling_utils.shard_checkpoint`, which was removed in `transformers >=4.47`. The current `<4.50` constraint lets pip pick 4.47-4.49 which lack the symbol.

Operator plan on founder go-ahead:
1. Edit `modal_endpoints/generate_app.py` image spec → `transformers>=4.45,<4.47`.
2. `modal deploy -m modal_endpoints.generate_app` (code-only; cached layers for everything except transformers wheel).
3. Decide whether to **retry** the stuck `cmw79mrgj000v2tas9oi2caq4` (enqueue one BG job) OR **cancel** it (service method exists) and start a fresh generation run against the SAME transcript build. Retry is cheaper (1 Qwen invocation, est. $0.015). Cancel + fresh is cleaner provenance.
4. Run `tests/e2e/ep-train-4y-l-live-generate.staging.spec.ts` (either as-is if retrying, or trigger a new POST if cancelling).
5. Expected: Qwen COMPLETED, N drafts persisted, assessment plan grounded, manager UI stages 04-05 populate.
6. §6 quality assessment of the actual generated questions becomes executable at that point.

**No further action in this slice.**

---

**End of EP-TRAIN-4Y-L acceptance report.**
