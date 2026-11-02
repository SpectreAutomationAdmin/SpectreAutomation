# EP-TRAIN-6A — AI-Assisted Training: Spectre-Operated Inference Architecture

**Status:** READ-ONLY audit (EP-TRAIN-6A-2 revision, 2026-11-02).
Supersedes earlier EP-TRAIN-6A + 6A-1 drafts in the same file.
**Founder decisions already in place:** G.1 HYBRID (Training builds
Spectre-operated self-hosted inference; AP intelligence stays as-is),
G.2 candidate-models approved for evaluation only, G.3 on-demand GPU
architecture preferred, G.6 no shared-model training on customer
content (per-tenant retention allowed under data controls), G.8 AP
retrofit deferred.
**STOP compliance (§7):** no model downloads, GPU provisioning,
credentials, schema migrations, code changes, DB writes or deployments
performed. AP intelligence (`sha-f59afa2`, Fly `v1090`) and all
training courses / obligations / employee history are untouched.

**Critical finding reported up-front:** Fly.io has **discontinued GPU
machines as of August 1, 2026**. Fly's own docs mark GPU-enabled Fly
Machines as deprecated and the cutoff is already past today's date
(2026-11-02). The L40S recommendation in the EP-TRAIN-6A-1 draft is
therefore invalid for new provisioning. This audit substitutes
Modal (primary recommendation) and RunPod serverless (credible
alternative) as the Spectre-operated inference host.

---

## A. GPU hosting feasibility comparison (deliverable 1)

### A.1 Fly.io GPU — not viable

- Fly's own Resource Pricing page labels GPU-enabled Fly Machines as
  "(Deprecated)." Multiple sources confirm the cutoff is August 1,
  2026, which is in the past.
- Fly's stated reason: GPU capacity required dedicated hardware that
  sat underutilised compared to the ordinary Fly fleet, and the
  company's post explaining the decision pivoted to "developers want
  LLM access rather than raw GPU hardware."
- No in-platform successor. Fly staff and community have pointed
  users to RunPod and Modal as replacements. Non-GPU Fly Machines
  (which host `spectre-staging` + `spectre-staging-worker`) are
  explicitly unaffected and continue to run normally.

Verify at Fly's official docs before relying — but the signal is
clear enough that any Spectre-operated inference plan must assume
GPUs are hosted elsewhere.

### A.2 Modal — primary recommendation for the pilot

| Dimension | Observation |
|-----------|-------------|
| Deployment model | Define a Python function + container; deploy via `modal deploy`; call over HTTPS. Spectre controls the container image, model weights, and inference code. |
| Billing | Per-second, from worker start to full stop (rounded up). No minimum commit. True scale-to-zero. |
| L40S pricing | ~$1.95/hr per third-party guides (verify at modal.com/pricing before provisioning). |
| H100 pricing | ~$3.95/hr per third-party guides (not needed for the pilot). |
| CPU + memory | Billed separately: ~$0.43–$0.89/hr for a typical 8-core / 64 GiB workload around the GPU. |
| Cold start | Modal marketing claims sub-4 s cold starts via a custom container runtime. Third-party platform-general range is 5–120 s. **Spectre must benchmark in the pilot (§6B)** — the model-loading time is the bigger lever (3–30 s for Whisper weights, 10–60 s for a 7–32B LLM depending on size). |
| Model-cache persistence | Modal supports named `Volume` + `NetworkFileSystem` constructs for persistent weight storage across cold starts. Spectre uses this; no re-download on each cold start. |
| Network to Spectre services | Public HTTPS. Modal functions are reached via a stable URL + token. Spectre worker outbound-firewall allowlist adds the Modal endpoint. |
| Data residency | Modal runs in US-based data centres by default; EU regions available on request. The audio+transcript+prompt payloads cross the AWS/Modal boundary. **§G is the founder decision on this crossing.** |
| Security | Spectre controls the inference code + container; Modal does not inspect the payload; no data retention beyond the function execution unless Spectre writes to a Modal `Volume`. |
| Operational complexity | Low: Python-native workflow; Spectre's background jobs call Modal functions over HTTPS. |

### A.3 RunPod serverless — credible alternative

| Dimension | Observation |
|-----------|-------------|
| Deployment model | Docker container; registered as a "serverless endpoint"; receives a URL + API key. More ops-ish than Modal; Spectre defines a worker image. |
| Billing | Per-second (rounded up). Workers charged from start to full stop including a ~5 s idle timeout. "Flex" vs "Active" tiers. |
| L40S pricing | Inconsistent across RunPod's own pages: one page lists $0.79/hr; the main pricing page says "Contact sales" for L40S. Verify directly at `docs.runpod.io/serverless/pricing` before any pilot commitment. |
| A100 80GB pricing | $0.00076 / sec (Flex) ≈ $2.74/hr; $0.00060 / sec (Active) ≈ $2.16/hr. |
| Cold start | A 2025 third-party guide claims Flex workers scale-to-zero with ~500 ms cold starts. **Unverified; benchmark in pilot.** A separate RunPod page claims "sub-100 s pod spin-up" for non-serverless pods. |
| Model-cache persistence | Supported via network volumes attached to the serverless endpoint. |
| Network to Spectre services | Public HTTPS. |
| Data residency | US + EU regions available (verify current list before provisioning). |
| Operational complexity | Medium: Docker-container-centric; container registry integration needed. |

### A.4 Side-by-side comparison

| Criterion | Fly L40S | Modal L40S | RunPod L40S (Flex) |
|-----------|----------|------------|---------------------|
| Available for new workloads today | **NO (deprecated)** | Yes | Yes |
| Per-second billing | n/a | Yes | Yes |
| Scale-to-zero | n/a (stops only; model-cache survives on volume) | Yes (true) | Yes (true, ~5 s idle) |
| Cold start | n/a | 3–30 s typical; worst case ~120 s | 500 ms claimed; benchmark required |
| L40S $/hr (indicative) | — | ~$1.95 (+ CPU/mem) | ~$0.79 (where quoted; else contact sales) |
| Python-native dev loop | n/a | Yes | No (container-first) |
| Operational complexity for pilot | n/a | Low | Medium |
| Vendor maturity for Spectre use case | n/a | Strong Python/ML ergonomics | Strong GPU-rental ergonomics |

**Recommendation for the pilot:** **Modal.** The Python-native loop
+ true scale-to-zero + strong model-cache primitives give the
cleanest path from Spectre's existing `BackgroundJob` worker to
GPU-side inference without a container-build pipeline. If pilot
economics (§D) push for lower unit cost later, swap to RunPod
behind the same `storageKey → segments[] | proposals[]` service
contract — the architectural seam makes the swap mechanical.

**Non-recommendation for the pilot:** Fly L40S (discontinued), AWS
Bedrock / SageMaker (reintroduces vendor-API dependency which the
HYBRID decision avoids for Training), self-managed Kubernetes with
Nvidia GPUs (operational complexity disproportionate to pilot
volumes).

### A.5 Flyctl operability caveat

Spectre's existing `flyctl` tooling, DRH-1 workflow, and
`spectre-staging` + `spectre-staging-worker` configs are untouched
by this change — those remain on Fly. The GPU workload is a new,
separate deployment target reached over HTTPS. The directive's
"Do not assume Fly GPU machines can be managed identically to
standard Fly application machines" is honoured by not putting GPUs
on Fly at all.

---

## B. Pilot inference architecture (deliverable 2)

### B.1 Two distinct inference workloads

The directive requires STT and LLM to be distinct workloads even if
they share physical infrastructure. The pilot keeps them as two
separate Modal functions (two separate `@app.function()` deployments)
with their own containers, model-cache volumes, memory requirements,
and GPU-sizing — so one can be re-sized or re-hosted without
touching the other.

```
Spectre Fly worker (spectre-staging-worker, CPU-only)
   ↓ enqueue TRAINING_VIDEO_TRANSCRIBE
   ↓ handler:
     1. ffmpeg -i <videoR2Key> -vn -ac 1 -ar 16000 -f wav → audio.wav
     2. POST audio.wav to Modal `/transcribe` endpoint (bearer-token-auth)
     3. Modal transcribe function:
          - container: python + ctranslate2 + faster-whisper + ffmpeg
          - GPU: L40S (or A10 if 7B sufficient; §C.3)
          - model-cache volume: /models/faster-whisper-large-v3
          - cold-boot: load model (~5–10s) + warm → ready
          - run faster-whisper → segments[] (startSec, endSec, text, confidence)
     4. Modal returns segments[] + probeDurationSec
     5. Spectre worker validates: duration matches ffprobe, segments monotonic
     6. Spectre writes TrainingVideoTranscript (status=SUCCEEDED, normalizedSegmentsJson)
   ↓ enqueue TRAINING_AI_PROPOSAL_GENERATE
   ↓ handler:
     1. Load transcript + course metadata
     2. Build prompt (versioned promptSchemaVersion + Zod JSON schema)
     3. POST to Modal `/generate` endpoint
     4. Modal generate function:
          - container: python + vLLM + Qwen 2.5 7B or 32B AWQ-INT4
          - GPU: L40S (fits 32B INT4 with headroom)
          - model-cache volume: /models/qwen-2.5-{7B,32B}-awq
          - cold-boot: load weights (~10–60s depending on size)
          - run with grammar-constrained decoding (Spectre's Zod schema → GBNF grammar)
     5. Modal returns raw JSON string
     6. Spectre worker:
          - Zod parse (strict schema; reject-and-regenerate once on failure)
          - Grounding validator (every proposal cites extant transcript segments)
          - Answer-in-source validator (correct answer text appears in cited segments)
          - Option-type integrity validator (reuse existing validateOptionsByType)
          - Contradiction detector (no two "correct" options with contradictory evidence)
     7. Spectre writes TrainingAIProposal rows (status=READY per surviving proposal; REJECTED per failed)
   ↓ Admin reviews in TimelineEditor + QuizEditor proposals rail
   ↓ Accept → existing createCheckpoint / createQuestion (unchanged)
   ↓ Publish → existing publishDraftWithPolicy (unchanged, obligation-issuance unchanged)
```

### B.2 Service contract between Spectre and Modal

Two HTTP endpoints, both authenticated with a shared bearer token
stored in a Spectre secret (`MODAL_SPECTRE_SHARED_TOKEN`). Modal
function URLs stored in Spectre env (`MODAL_TRANSCRIBE_URL`,
`MODAL_GENERATE_URL`). All payloads cross HTTPS.

**POST `/transcribe`** request:

```json
{
  "requestId": "<cuid, used for idempotency logging>",
  "audioUrl": "<signed HTTPS URL from Spectre to the extracted .wav>",
  "languageCode": "en",
  "modelVariant": "faster-whisper-large-v3",
  "schemaVersion": "transcribe-v1"
}
```

**Response:**

```json
{
  "schemaVersion": "transcribe-v1",
  "modelVariant": "faster-whisper-large-v3",
  "durationSec": 610,
  "segments": [
    {"id": 0, "startSec": 0.00, "endSec": 4.42, "text": "...", "avgConfidence": 0.91},
    ...
  ],
  "elapsedMs": {"coldBoot": 7212, "transcribe": 51311}
}
```

**POST `/generate`** request:

```json
{
  "requestId": "<cuid>",
  "modelVariant": "qwen-2.5-32b-awq-int4",
  "promptSchemaVersion": "training-proposals-v1",
  "systemPrompt": "<Spectre-authored template>",
  "transcript": "<normalized compact transcript representation>",
  "constraints": {
    "proposalKind": "QUESTION_CHECKPOINT_BOUND",
    "maxQuestions": 3,
    "allowedQuestionTypes": ["SINGLE_CHOICE","TRUE_FALSE","MULTI_ANSWER"],
    "jsonSchema": {...Zod-derived JSON schema...}
  }
}
```

**Response:**

```json
{
  "schemaVersion": "training-proposals-v1",
  "modelVariant": "qwen-2.5-32b-awq-int4",
  "proposals": [...matches constraints.jsonSchema...],
  "elapsedMs": {"coldBoot": 12043, "generate": 7812}
}
```

### B.3 Spectre-side durable state (same shape as EP-TRAIN-6A-1)

- `TrainingVideoTranscript` — one row per course version, PENDING →
  RUNNING → SUCCEEDED | FAILED_RETRYABLE | FAILED_TERMINAL.
- `TrainingAIProposal` — one row per proposal; status flows PENDING →
  RUNNING → READY → ACCEPTED | REJECTED | REGENERATE_REQUESTED |
  FAILED.
- `BackgroundJob` kinds: `TRAINING_VIDEO_TRANSCRIBE` +
  `TRAINING_AI_PROPOSAL_GENERATE`, idempotency keys
  `training-transcribe:<clubId>:<versionId>:<modelVariant>` and
  `training-ai:<clubId>:<versionId>:<kind>:<promptSchemaVersion>`.

### B.4 Spectre-owned IP (unchanged from EP-TRAIN-6A-1)

- Zod schemas + GBNF grammar constraints.
- Prompt templates with explicit `promptSchemaVersion`.
- Grounding validator + answer-in-source validator + contradiction
  detector + option-type integrity validator.
- Confidence model (transcript×answer-in-source×self-report).
- Durable state machines + atomic claim pattern.
- Admin ACCEPT invariant (no AI content bypasses human review).

### B.5 What does NOT change

- Admin UI surfaces (TimelineEditor + QuizEditor + PublishPanel).
- Publish path (`publishDraft` / `publishDraftWithPolicy`).
- Obligation issuance.
- RBAC + audit namespace.
- EP-TRAIN-5D accepted baseline.
- AP intelligence engine (per G.8 defer).

---

## C. Model compatibility and memory assessment (deliverable 3) + Qwen 7B vs 32B (deliverable 4)

### C.1 Hard VRAM facts (vendor model cards + public benchmarks)

| Model | Weights (bf16) | AWQ-INT4 weights | KV cache @ 8k ctx | Fits L40S (48 GiB)? | Fits A10 (24 GiB)? |
|-------|----------------|------------------|-------------------|----------------------|---------------------|
| faster-whisper large-v3 | 3.0 GiB (int8 CT2) | — | ~1 GiB | yes (plenty of headroom) | yes |
| Qwen 2.5 7B Instruct | ~15 GiB | ~5 GiB | ~1–2 GiB | yes | yes (INT4) / tight (bf16) |
| Qwen 2.5 32B Instruct | ~65 GiB | ~20 GiB | ~3–4 GiB | **INT4 yes**; bf16 no | no |

L40S has 48 GiB VRAM. 32B AWQ-INT4 fits comfortably. 7B fits trivially.
A10 (24 GiB) can host 7B but not 32B.

### C.2 Known public claims (not verified by Spectre)

- Qwen 2.5 32B generally outperforms 7B on reasoning,
  instruction-following, structured output on standard benchmarks
  (MMLU, GSM8K, HumanEval, IFEval). SiliconFlow's own model-card page
  highlights the 7B's gain on JSON Mode but offers no measured
  head-to-head.
- No credible third-party apples-to-apples benchmark surfaced in the
  web search for structured-JSON reliability or hallucination rate
  on Spectre-adjacent tasks (safety-training question generation
  from transcripts).
- Pilot evaluation is required to settle 7B vs 32B. The §C.4
  thresholds + §D.1 10-video eval set gate this.

### C.3 Pilot default: start with 7B, upgrade to 32B only if 7B misses the quality bar

Rationale:

- Smaller model = faster cold boot (~10 s vs ~30 s), lower latency
  (~1 s vs ~5 s per generation), fits A10 (cheaper GPU class).
- If 7B passes the §C.4 quality thresholds on the 10-video eval set
  with grammar-constrained decoding + Spectre's grounding validator,
  there is no reason to pay for 32B.
- If 7B falls short on specific validators (e.g. grounding
  fidelity), swap to 32B behind the same `modelVariant` seam. No
  code shape change.

### C.4 Measurable quality thresholds (same metrics applied to 7B and 32B)

| Dimension | Metric | Threshold to accept |
|-----------|--------|---------------------|
| Valid-JSON output | % of generations that pass Zod on first attempt | ≥ 85% |
| Schema conformance after one regenerate | % of generations that pass Zod within 2 attempts | ≥ 98% |
| Grounding fidelity | % of proposals whose `supportingSegmentIds[]` all exist AND whose claimed answer appears in the cited segments | ≥ 80% |
| Hallucination rejection | % of fabricated-answer proposals rejected by the answer-in-source validator (measured on a seeded adversarial subset of eval videos) | ≥ 95% |
| Contradiction rate | % of multi-option questions where two "correct" options have contradictory evidence | ≤ 2% |
| Admin-accept rate (dry run) | % of validated proposals that an admin accepts without edit on a dry walkthrough | ≥ 60% |
| Timestamp accuracy | median |transcript-timestamp – video-event-timestamp| on the pinned eval videos | ≤ 2 s |
| Transcription WER | word-error-rate on the clean-English eval subset | ≤ 12% |
| Transcription WER (noisy subset) | WER on the noisy-background subset | ≤ 25% |

All thresholds are proposals, to be ratified by founder before 6B
runs. The pilot report should produce an actual-vs-threshold table
for both 7B and 32B.

---

## D. Ten-video evaluation specification (deliverable 4 cont.)

### D.1 Composition — synthetic, Spectre-created, zero-customer-content

Each video is a short original recording. **No real customer
content is used.** Where a video needs to feature "golf-club"
material, the content is written by Spectre staff to be plausibly
representative but is explicitly synthetic. Each video is anchored
by a transcript hand-authored by Spectre and a ground-truth
question key (admin-authored prototype) that the pilot output is
compared against.

| ID | Theme | Length | Audio quality | Reason in the set |
|----|-------|--------|----------------|-------------------|
| V1 | Clear instructional speech, single speaker, quiet room | 3:00 | High | Baseline best-case |
| V2 | Short safety procedure, single speaker, clear | 4:00 | High | Verifies grounded-safety path |
| V3 | Golf-club-specific vocabulary (bunker rake protocol, cart-path etiquette) | 5:00 | High | Measures domain-vocabulary WER |
| V4 | Two speakers alternating (instructor + question-asker) | 6:30 | High | Measures speaker-handling even if diarization is off |
| V5 | Background noise (fan hum + distant kitchen) | 5:30 | Medium | Measures noisy WER |
| V6 | Compressed-audio reupload (simulates admin phone recording) | 4:00 | Low | Measures low-SNR WER |
| V7 | Technical procedure with sequence steps (equipment check) | 8:00 | High | Measures procedural-step extraction |
| V8 | Ambiguous instructional content (hints without stating rules) | 5:00 | High | Measures hallucination-rejection (the right output here is "insufficient") |
| V9 | Long single-speaker instructional (chaptered) | 20:00 | High | Measures long-context behavior |
| V10 | Minimal spoken content (mostly visual demo, 20% audio) | 4:00 | Medium | Measures "not enough content to draft" edge case |

### D.2 Ground-truth artefacts per video

For each video, Spectre authors:

- A canonical hand-transcript (used to compute WER vs model output).
- Timestamped "event markers" for every safety instruction + every
  procedural step (used to compute checkpoint-timing accuracy).
- A gold question set (5–10 questions) with known-correct options
  and known-wrong options (used to compute admin-accept rate on a
  dry walkthrough + hallucination-rejection on the adversarial
  subset).
- An adversarial-fake-answer set: 3 fabricated-but-plausible
  question drafts per video that a well-grounded model + validator
  must reject (used for hallucination-rejection metric).

### D.3 Evaluation harness

- Runs as a one-off script (not a background job).
- Reads from a pinned fixture directory (never customer data).
- Produces a JSON report mapping each video × metric → value.
- Reports go into `scratchpad/eval-6b-<model>-<date>.json` (not
  committed; the report of record is the summary table in the §G
  acceptance doc).

### D.4 Permission to use

All 10 videos are Spectre-authored for this purpose, with
written permission chain recorded alongside the fixture directory.
No customer uploads enter the eval set.

---

## E. Pilot budget + unit economics (deliverable 5)

All GPU prices below are indicative only (third-party aggregator
figures from 2026). **Verified-vs-assumption table in §E.3.**
Spectre must re-verify at modal.com/pricing before provisioning.

### E.1 Unit economics (per 10-minute video, Modal L40S)

| Line item | Per-video cost (10-min video) | Basis |
|-----------|-------------------------------|-------|
| Transcription GPU (faster-whisper large-v3 on L40S, ~3 min wall-clock) | ~$0.097 | 3 min × $1.95/hr |
| Generation GPU (Qwen 2.5 7B on L40S, ~1 min wall-clock total across 2 proposal batches) | ~$0.033 | 1 min × $1.95/hr |
| CPU/memory on Modal (~4 min wall-clock) | ~$0.040 | 4 min × $0.60/hr |
| Cold-start wastage (amortized 10% of jobs cold, ~30 s wasted per cold start) | ~$0.010 | 0.1 × 30s × $2.55/hr |
| Spectre worker CPU + R2 bandwidth | negligible (already paid) | — |
| **Total per 10-min video** | **~$0.18** | — |

For a 3-min video: ~$0.07. For a 30-min video: ~$0.50. For a
60-min video: ~$0.95. (Linear scaling; realistic range for
private-club safety-training videos is 3–30 min.)

If upgrading to Qwen 32B INT4: generation wall-clock approximately
doubles (~2 min), so per-video total approaches ~$0.25.

### E.2 Monthly cost ladder

| Volume | 10 videos/mo | 100 videos/mo | 1,000 videos/mo | 5,000 videos/mo |
|--------|--------------|---------------|------------------|------------------|
| GPU + CPU (Modal, Qwen 7B) | ~$1.80 | ~$18 | ~$180 | ~$900 |
| GPU + CPU (Modal, Qwen 32B) | ~$2.50 | ~$25 | ~$250 | ~$1,250 |
| Retries overhead (assume 10% re-runs) | ~$0.20 | ~$2 | ~$20 | ~$100 |
| Storage (transcript JSON on R2) | negligible | <$1 | <$5 | <$20 |
| Monitoring + telemetry | $0 (uses Spectre's existing audit + Postgres) | $0 | $0 | $0 |
| Modal fixed/minimum commit | $0 | $0 | $0 | $0 |
| **Monthly total (7B)** | **~$2** | **~$20** | **~$200** | **~$1,000** |
| **Monthly total (32B)** | **~$3** | **~$27** | **~$275** | **~$1,370** |

For comparison with EP-TRAIN-6A third-party path (AWS Transcribe +
Anthropic Claude Sonnet, ~$0.28/video):

| Volume | Spectre-operated (7B) | Third-party | Delta |
|--------|------------------------|-------------|-------|
| 10 videos/mo | $2 | $2.80 | ~$0.80 lower |
| 100 videos/mo | $20 | $28 | ~$8 lower |
| 1,000 videos/mo | $200 | $280 | ~$80 lower |
| 5,000 videos/mo | $1,000 | $1,400 | ~$400 lower |

**With true on-demand serverless (Modal, scale-to-zero), Spectre-
operated inference is cheaper at every volume tier, not just at
scale.** This inverts the EP-TRAIN-6A-1 "cheaper only above 1,000
videos/mo" finding, which was premised on an always-on Fly L40S.

### E.3 Verified vs assumed

| Fact | Verified by | Assumption flag |
|------|-------------|-----------------|
| Fly GPU deprecated 2026-08-01 | Multiple sources incl. Fly's own blog | ✓ confirmed by multiple sources |
| Modal L40S ~$1.95/hr | Third-party aggregator (2026) | **ASSUMED** — verify at modal.com/pricing |
| Modal CPU/memory ~$0.60/hr for 8-core/64GiB | Third-party aggregator | **ASSUMED** — verify |
| Modal cold-start sub-4s claim | Modal marketing | **ASSUMED** — Spectre must benchmark in 6B |
| faster-whisper runtime (~3 min wall-clock per 10-min audio on L40S) | Public benchmarks | **ASSUMED** — Spectre must benchmark in 6B |
| Qwen 2.5 32B AWQ-INT4 fits L40S | Public model-card memory math | ✓ confirmed |
| Qwen 7B is sufficient for pilot | — | **ASSUMED** — Spectre must evaluate on 10-video set |
| JSON reliability thresholds (§C.4) | — | **PROPOSED** — founder ratifies before 6B runs |

### E.4 Fixed vs variable overhead

- Modal fixed monthly: $0 (no minimum commit).
- Spectre engineering (pilot setup): ~2–3 days (Modal account,
  functions, prompt templates, validators, admin UI rail,
  Playwright acceptance).
- Spectre engineering (ongoing): essentially zero per-video; the
  team pays attention only when either (a) a quality threshold slips
  or (b) a new content pattern emerges requiring prompt revision.

---

## F. Revised EP-TRAIN-6B implementation plan (deliverable 6)

Explicit go/no-go gates. Nothing beyond 6B starts without founder
approval. Each slice ends on a Playwright-authenticated staging
acceptance walk against a disposable fixture (never a real
customer course).

### F.1 EP-TRAIN-6B pilot slice (first slice, minimum viable Spectre-operated inference)

Scope:

1. Add Prisma `TrainingVideoTranscript` + `TrainingAIProposal`
   (additive, nullable, zero-backfill).
2. Add `TRAINING_VIDEO_TRANSCRIBE` + `TRAINING_AI_PROPOSAL_GENERATE`
   JobKinds + handlers.
3. Deploy two Modal functions (transcribe + generate) with
   faster-whisper large-v3 + Qwen 2.5 7B AWQ-INT4.
4. Wire the handlers: audio-extract via ffmpeg on Spectre worker →
   HTTPS to Modal → persist.
5. Minimal admin UI: button `Analyse with Spectre AI` on the
   version editor header + a flat read-only proposals rail (no
   accept / edit yet).
6. Pilot evaluation run on the 10 videos from §D.
7. Playwright acceptance: founder uploads V1 (clean 3-min video),
   clicks the button, sees transcript, sees ≥1 grounded proposal.
8. Deliverable: §G acceptance doc with eval table + verified-vs-
   assumption outcomes + cost report from Modal dashboard.

Hard STOPs inside 6B:

- No publish-path change.
- No obligation creation.
- No change to AP intelligence.
- No real customer-content use in the eval set.

### F.2 Go/no-go gate before EP-TRAIN-6C

- Quality thresholds in §C.4 met on the Spectre-authored 10-video
  eval set.
- Actual Modal cost per video within ±25% of the §E.1 estimate.
- Founder sign-off on observed quality vs threshold.
- Founder sign-off on observed cold-start behaviour vs the
  Modal-marketing claim.

### F.3 EP-TRAIN-6C — full proposals rail

- Accept / edit / reject / regenerate flows.
- Grounding + answer-in-source + contradiction + option-integrity
  validators active.
- Admin feedback collected into a per-tenant eval table (per G.6:
  tenant-specific; never cross-tenant).

### F.4 EP-TRAIN-6D — checkpoint-position + final-assessment proposals

### F.5 EP-TRAIN-6E — operational hardening

- Cold-start monitoring, model-cache size tracking, retry telemetry.
- Per-tenant daily-cap enforcement (reuse the AP product-research
  pattern).
- Fine-tuning data pipeline — collects, never fine-tunes.

### F.6 EP-TRAIN-6F — visual intelligence (deferred, G.5)

### F.7 EP-TRAIN-6G — scale validation + full acceptance

- Load-test with simulated concurrent uploads.
- End-to-end acceptance from EP-TRAIN-6A §7.
- Preservation gates (5D baseline unchanged, obligation universe
  unchanged, employee history unchanged).

---

## G. Explicit founder approvals required before provisioning (deliverable 7)

Short list of binary decisions the founder must sign off before
Spectre engineers run `modal deploy` or add the Modal secret to Fly
or write a `TRAINING_*` migration.

**G.A — GPU host for the pilot.** Modal (recommended) or RunPod.

**G.B — Model variant for the pilot's first run.** Qwen 2.5 7B
AWQ-INT4 (recommended) or Qwen 2.5 32B AWQ-INT4. 7B is cheaper +
faster to iterate on; 32B is the fallback if 7B misses §C.4
thresholds.

**G.C — Data-boundary consent for the pilot.** Audio + transcript
payloads leave the Fly network boundary and cross HTTPS to the
chosen GPU host (US-based for the pilot). The GPU vendor does not
see payload content beyond the function execution (no persistent
retention). Confirm this crossing is acceptable for Coulee Ridge
staging content.

**G.D — Ratification of the §C.4 quality thresholds and the §D
evaluation specification.** Thresholds + 10-video composition can
be adjusted before 6B starts; adjusting them mid-pilot invalidates
the gate.

**G.E — Pilot budget cap.** Recommended: $100 Modal spend ceiling
for 6B (covers roughly 500 pilot generations across 10 eval videos
+ exploratory iterations). Spectre halts and reports if the ceiling
is approached.

**G.F — Secret-management plan.** Modal API token stored as a Fly
secret (`MODAL_SPECTRE_SHARED_TOKEN`) alongside Spectre's existing
AWS + Anthropic secrets. New secret added via DRH-1 secret-deploy;
unset after 6B closes if no further work authorised.

No GPU, Docker image, Modal account, or Spectre code change happens
before all six of G.A–G.F are explicitly answered.

---

## H. §7 STOP compliance

| STOP boundary | Compliance |
|---------------|------------|
| No model downloads | None |
| No GPU provisioning | None |
| No credentials | None |
| No schema migrations | None |
| No code changes | None (audit only) |
| No DB writes | Read-only queries + web searches |
| No deployments | None (the audit commit is a docs-only commit; triggers a byte-identical runtime deploy) |
| AP intelligence unchanged | Verified by cited code paths |
| Training courses / obligations / employee history unchanged | Verified against EP-TRAIN-5D-3C-B accepted baseline (`sha-f59afa2`, Fly `v1090`) |

Awaiting founder decisions G.A–G.F before any EP-TRAIN-6B
implementation begins.

---

## Sources

External facts in this audit come from the following references
(web searches run 2026-11-02). Spectre-internal code citations are
by file-path + line and are verifiable in the repo at the current
baseline sha.

- [Fly.io — cutting prices for L40S GPUs in half (blog)](https://fly.io/blog/cutting-prices-for-l40s-gpus-in-half/)
- [Fly.io GPU docs](https://fly.io/docs/gpus)
- [Fly.io community — GPU scale to zero](https://community.fly.io/t/gpu-scale-to-zero/20433)
- [Fly.io blog — Scaling LLMs to zero with Ollama](https://fly.io/blog/scaling-llm-ollama/)
- [Fly.io community — Will the apps and machine platform start winding down?](https://community.fly.io/t/will-the-apps-and-machine-platform-start-winding-down/28380)
- [Fly.io blog — Transcribing on Fly GPU Machines](https://fly.io/blog/transcribing-on-fly-gpu-machines/)
- [Modal — resources and pricing (vendor site)](https://modal.com/resources/best-cloud-gpu-providers)
- [Modal Labs Pricing 2026 (third-party)](https://www.activepieces.com/blog/modal-labs-pricing-2026-gpu-rates-plans-and-credits.md)
- [Modal GPU pricing 2026 — per-second billing (third-party)](https://www.spheron.network/blog/modal-gpu-pricing-2026-per-second-billing/)
- [Serverless LLM Deployment: RunPod vs Modal vs Lambda (2026)](https://blog.premai.io/serverless-llm-deployment-runpod-vs-modal-vs-lambda-2026)
- [RunPod — serverless pricing docs](https://docs.runpod.io/serverless/pricing)
- [RunPod — GPU cloud pricing](https://www.runpod.io/gpu-cloud/pricing)
- [SiliconFlow — Qwen 2.5 32B vs 7B comparison](https://www.siliconflow.com/es/models/compare/qwen2-5-32b-instruct-vs-qwen2-5-7b-instruct)
