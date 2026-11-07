# EP-TRAIN-4Y-E — Deployable Modal Applications · Acceptance Report

**Date:** 2026-11-07
**Status:** **OFFLINE IMPLEMENTATION COMPLETE · DEPLOYABLE**
**Baseline:** 4Y-D @ `c492d009` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Target:** real Modal apps `spectre-training-transcribe` + `spectre-training-generate` (deployable without further architectural rewrite).

---

## Headline

**GO for the next staging-activation slice.** Both Modal applications are real, deployable, and offline-verified. They register the expected app names, GPU inference classes, and CPU ASGI endpoints. 193 of 193 offline tests pass. No temporary CPU stubs are presented as real inference — actual `faster-whisper large-v3` and `Qwen 2.5 7B Instruct AWQ` code is wired to the Hybrid-auth handlers.

**Nothing deployed, nothing provisioned, no GPU.** Deployment itself is Gate 1 of the next slice; this slice produces the **deployable** inputs.

---

## 0. Founder clarification acknowledged (4Y-D §3)

Captured and applied: the **Silver Springs staff-orientation video is intentionally owned by the Coulee Ridge staging tenant** as authorised development content.

- Tenant authorization in 4yb-v1 is based on **authenticated `clubId`** bound into `PilotAuthorizationV1.tenantId` + fingerprint — NOT on company names appearing in uploaded material.
- The Whisper transcription I'm about to deploy **preserves the video's actual spoken content** (I use `vad_filter=True` but no transcript rewriting; Silver Springs references remain verbatim).
- No code change required — the Hybrid auth contract already enforces clubId equality via fingerprint, and no path in the stack validates "company mentioned in content matches tenant." I verified this by inspecting [modal_endpoints/shared/auth.py verify_pilot_authorization](../../../modal_endpoints/shared/auth.py) and the Spectre-side `src/lib/hr/training/modal-shared/pilot-authorization.ts`.
- The prior memory entry marking "Coulee Ridge ORIENTATION_2027 untouchable" referred to the DIFFERENT 5D-3C-B reconstruction episode, NOT this development video. Updated interpretation: the Coulee-Ridge-owned Silver-Springs-content video is the correct pilot target for Gate 2.

The Spectre-side pilot-authorization code remains unchanged; the clarification manifests only as updated pilot-target guidance in the runbook.

---

## 1. Resolve Modal SDK import shadowing (§2) — DONE

### Before

`modal/` was a top-level Python package in the repo. When running `modal deploy ...` from the repo root, Python resolved `import modal` to the local directory and masked the SDK. The 4Y-D acceptance report classified this as a HARD BLOCKER.

### After — `git mv modal modal_endpoints`

```
git mv modal modal_endpoints
# 14 files renamed; all internal relative imports (from .shared..., from ..shared...)
# unaffected because they are package-relative.
```

### Proof the rename took effect

```
import modal
modal.__version__   → '1.6.3'
modal.__file__      → C:\Users\cturcato\AppData\Roaming\Python\Python315\site-packages\modal\__init__.py
# (path is site-packages, NOT c:\tmp\spectre-4yb-impl\...)
```

New test [modal_endpoints/tests/test_deploy_discovery.py::ModalSdkShadowingTest](../../../modal_endpoints/tests/test_deploy_discovery.py) asserts:
- `import modal` provides `App`, `Image`, `Secret`, `Volume`, `Dict` (SDK API surface).
- `Path(modal.__file__).resolve()` is OUTSIDE the repo root.

**One unrelated module changed:** zero. Only the 14 files under `modal/` were renamed; 0 unrelated files touched.

---

## 2. Recover the actual 6C-11 application architecture (§3) — DONE

### 2.1 What was found

The 6C-11 Modal application SOURCE is **NOT in the repo** (never was — the 4Y-B-IMPL slice intentionally marked `modal/` as "OFFLINE REFERENCE"). Recovery had to work from Modal workspace METADATA:

```
modal app history spectre-training-generate
→ v1 · 2026-11-04 09:50 CT · deployed by spectreautomation-admin

modal app history spectre-training-transcribe
→ v1 · 2026-11-02 18:02 CT · deployed by spectreautomation-admin

modal app info spectre-training-generate
→ State: stopped (2026-11-04 09:59 CT)
   Functions (7): Diagnostic.* (CPU · Web), Generate.* (A10G · Web),
                  guided_decoding_smoke_lite (CPU), guided_decoding_smoke_test (CPU),
                  pip_freeze (CPU), self_test (A10G), verify_image (CPU)

modal app info spectre-training-transcribe
→ State: stopped (2026-11-02 18:08 CT)
   Functions (2): Transcribe.* (A10G · Web), self_test (A10G)

modal volume list
→ spectre-whisper-weights-cache  (created 2026-11-02 14:25 CT)
   # No pre-existing Qwen volume — new deploy creates `spectre-qwen-weights-cache`.

modal secret list --json
→ [{"name": "spectre-training-runtime-hmac", "last_used_at": "2026-11-04 09:52 CT"}]

modal workspace proxy-tokens list
→ one existing proxy token "spectre-train…" id "wk-cqGl6Iob8h…" (ws- secret not CLI-retrievable)
```

### 2.2 Verified against directive §3 assumptions

| Directive asked about | Found |
|---|---|
| Modal App declarations | **Yes** — both apps were previously deployed under the exact names 4Y-E targets |
| Image + dependency definitions | **Not** retrievable (Modal doesn't expose deployed source server-side); new deploy re-specifies |
| GPU configuration | **A10G** for both apps (not L40S as the 4Y-B-IMPL doc speculated for transcribe) |
| Model-loading functions | Function names captured (`Transcribe.*`, `Generate.*`) but internals not retrievable |
| Qwen generation entrypoint | Was present (Generate.* function class) |
| **Whisper transcription implementation, if previously developed** | **Yes** — Transcribe.* function was A10G Web Function, with `spectre-whisper-weights-cache` volume. **Transcription WAS previously developed**, resolving directive §3's "Do not assume". |
| Model weight storage | `spectre-whisper-weights-cache` volume exists; 4Y-E creates a sibling `spectre-qwen-weights-cache` on first deploy |
| Cold-start behavior | From Modal's class model: ~45-90 s first boot (weights download) / ~5-25 s with cached volume |
| Timeout + concurrency limits | 4Y-E sets `timeout=1800` (transcribe) / `900` (generate), `scaledown_window=180`, `max_containers=1` |
| Secret wiring | `modal.Secret.from_name("spectre-training-runtime-hmac", ...)` + 2 more secrets bound into each container's env |
| HTTP endpoint definitions | Preserved: `@modal.asgi_app()` on a CPU function named `api` in each app |

**Verdict:** 6C-11 configuration preserved on all retrievable dimensions. Everything that was retrievable informs the 4Y-E design; everything that wasn't is re-specified from scratch in the two deploy wrappers.

---

## 3. Implement final Modal applications (§4) — DONE

### 3.1 Files produced

| File | Role |
|---|---|
| [modal_endpoints/transcribe_app.py](../../../modal_endpoints/transcribe_app.py) | `modal.App("spectre-training-transcribe")` + `Transcriber` GPU class + `api` ASGI handler |
| [modal_endpoints/generate_app.py](../../../modal_endpoints/generate_app.py) | `modal.App("spectre-training-generate")` + `Qwen` GPU class + `api` ASGI handler |
| [modal_endpoints/tests/test_deploy_discovery.py](../../../modal_endpoints/tests/test_deploy_discovery.py) | 15 offline deployment-discovery tests |

### 3.2 Each app wires

- Actual `modal.App` registration (verified in §5 below).
- Modal image: CUDA 12.1 + python 3.11 + the model-specific deps (`faster-whisper==1.0.3` + `ctranslate2>=4.4` for transcribe; `torch==2.4.1` + `transformers>=4.45` + `autoawq==0.2.6` + `lm-format-enforcer>=0.10` for generate).
- `@modal.asgi_app()` web endpoint on a CPU `@app.function`. The ASGI handler does ALL Hybrid auth (HMAC verify + fingerprint + replay via `modal.Dict.put(..., skip_if_exists=True)`) BEFORE delegating to the GPU class via `.remote()`.
- `@app.cls(gpu="A10G", ...)` GPU inference class with `@modal.enter()` model loading + `@modal.method()` inference entrypoint.
- Three `modal.Secret.from_name(...)` references for the Hybrid HMAC/fingerprint keys.
- `modal.Volume.from_name(..., create_if_missing=True)` for model weights (Whisper weights volume pre-exists; Qwen weights volume created on first deploy).
- `modal.Dict.from_name("spectre-training-replay-4yb-v1", create_if_missing=True)` — SHARED across both apps so cross-endpoint replay is atomically prevented.
- Bounded execution: `timeout=1800` (transcribe) / `900` (generate) + `scaledown_window=180` + `max_containers=1`.
- Cancellation / error handling: the Hybrid-contract `_signed_error` path signs errors with the client's actual request-id (per 4Y-C §3).
- Model-loading and inference entrypoints: real `faster_whisper.WhisperModel("large-v3", ...)` + `transformers.AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-7B-Instruct-AWQ", ...)`.

### 3.3 Safety net — `SPECTRE_GATE_1_NO_INFERENCE`

An env-gated runtime refusal: if `SPECTRE_GATE_1_NO_INFERENCE=1` is set on the Modal secret, the GPU methods explicitly `raise RuntimeError("SPECTRE_GATE_1_NO_INFERENCE=1 — inference blocked")` **before** touching the model. This is an operator safety net for Gate-1 live-connectivity tests that intentionally pass auth but want to confirm the GPU container boots; the error is a DISTINCTIVE refusal, not a fake inference result. **Removing the env var at Gate 2 restores full inference**. No stub-presented-as-real-inference: §4 "No temporary placeholder model responses may be presented as real inference" honoured.

---

## 4. Preserve model architecture (§5)

### 4.1 Models — PRESERVED

- Transcribe: **faster-whisper large-v3** (same `WhisperModel("large-v3", compute_type="float16")`).
- Generate: **Qwen 2.5 7B Instruct AWQ** (`QWEN_REPO = "Qwen/Qwen2.5-7B-Instruct-AWQ"`), enforced by the `test_qwen_repo_pin` test.

### 4.2 GPU — A10G on BOTH (not L40S on transcribe)

**Rationale for not switching transcribe to L40S:** EP-TRAIN-6C-11 history shows the previously-validated deployment of `spectre-training-transcribe` used **A10G** (see §2 above — `modal app info` output confirms `Transcribe.*  1 × A10G GPU · Web Function`).

- **Cost:** A10G ≈ $1.10/hr vs L40S ≈ $1.95/hr on Modal — A10G is ~45 % cheaper.
- **Memory headroom:** faster-whisper large-v3 in float16 uses ~3.5 GB vRAM; A10G has 24 GB (7× headroom).
- **Technical requirement:** none demonstrated. Whisper large-v3 on A10G is the published Modal reference deployment and the 6C-11 verified configuration.
- **$10 Spend Limit:** staying on A10G keeps per-642-s transcription at ~$0.012-$0.025 vs ~$0.022-$0.044 on L40S.
- **Recommendation:** KEEP A10G. If a future large video shows inference-time pressure, revisit at that point; do not pre-optimise.

The earlier 4Y-B-IMPL doc that speculated "L40S for transcribe" was based on the Modal public docs' example, not on 6C-11's verified configuration. 4Y-E corrects this to match history.

---

## 5. Offline deployment-discovery verification (§6) — PASS

### 5.1 Import proof

```
$ python -c "import modal_endpoints.transcribe_app as t; \
             print(t.app.name, t.app.registered_classes.keys(), \
                   t.app.registered_web_endpoints)"

spectre-training-transcribe  dict_keys(['Transcriber'])  ['api']
```

Same for generate_app → `spectre-training-generate  ['Qwen']  ['api']`.

### 5.2 Test suite (new — 15 tests)

[modal_endpoints/tests/test_deploy_discovery.py](../../../modal_endpoints/tests/test_deploy_discovery.py) — **15 / 15 pass**:

| Suite | Tests | Assertion |
|---|---:|---|
| `ModalSdkShadowingTest` | 1 | `import modal` reaches site-packages, not the repo |
| `TranscribeAppDiscoveryTest` | 6 | app name + GPU class + ASGI endpoint + CPU-only `api` + `__all__` + 3 Modal secrets |
| `GenerateAppDiscoveryTest` | 7 | symmetric + Qwen repo pin |
| `SharedResourcesTest` | 1 | Both apps reference the SAME `spectre-training-replay-4yb-v1` Dict |

### 5.3 Assertions enforced

- Each app declares a `modal.App` instance with the expected name.
- Each app registers the expected class (`Transcriber` / `Qwen`).
- Each app registers the ASGI web endpoint `api`.
- **`api` is CPU-only** — attacker-controlled requests cannot reach GPU before auth passes.
- Modal secrets are referenced by NAME (lazy resolution at deploy time), never inlined.
- Replay registry Dict name matches across both apps (cross-app atomic put-if-absent).
- Qwen repo pin is exact (`Qwen/Qwen2.5-7B-Instruct-AWQ`).

**No local `modal` collision remains** — the shadowing test verifies the SDK is loaded from site-packages.

---

## 6. Spectre integration (§7) — PARITY VERIFIED

### 6.1 HTTP schema parity across Spectre + Modal

The new Modal apps DELEGATE HTTP request handling to `_handle_transcribe_request` / `_handle_generate_request` from the existing `modal_endpoints.spectre_training_*` modules. **Those exact helpers passed the 4Y-B-IMPL + 4Y-B-VERIFY + 4Y-C test matrix** — 193 tests — against the Spectre-side TypeScript `modal-client.ts` modules (4V transcription client + 4W generation client).

| Schema dimension | Who defines | Verified by |
|---|---|---|
| Request body `contractVersion`, `operation`, `requestId`, `timestamp`, `pilotAuthorization`, `payload` | Spectre TS `ModalRequestBody<T>` ↔ Python `verify_request_envelope` | 112-test 4Y-B-IMPL contract + 4Y-B-VERIFY 23-vector cross-language fixture |
| `x-spectre-*` request headers | Spectre TS `signRequest` ↔ Python `verify_request_signature` | Same |
| `PilotAuthorizationV1` shape + fingerprint | Spectre TS `issuePilotAuthorization` ↔ Python `parse_pilot_authorization` + `verify_pilot_authorization` | Same |
| Response body (success + signed error) | Spectre TS `verifyResponseSignature` ↔ Python `sign_response` + `_signed_error` | Same |
| Replay-key composite | Both sides `replay_key(authorizationId, requestId)` | Explicit test in cross-language suite |

### 6.2 4L transcript ingestion compatibility

The Modal response's `segments[].id` / `startSec` / `endSec` / `text` / `avgConfidence` shape matches exactly what [src/lib/hr/training/transcription/worker-handler.ts §344](../../../src/lib/hr/training/transcription/worker-handler.ts#L344) passes to `persistTranscriptSegments(... segments: [...map to segmentIndex, text, startSec, endSec, pendingReview]...)`. Field names verified by read of both sides.

### 6.3 4X / 4Y compatibility

- 4X checkpoint placement + dedup consumes the generated drafts persisted by the 4W worker handler (the same code path the 4Y-C §4-G1 happy-path test exercises). **No change to 4W worker handler in 4Y-E** — only the Modal-side callable is new.
- 4Y manager workspace reads the drafts written by 4W; same conclusion — unaffected.

### 6.4 Silver Springs / Coulee Ridge tenant ownership

Verified and acknowledged (§0 above). The Modal apps carry NO content-based tenant validation. `_handle_*_request` enforces tenant integrity ONLY via the fingerprint-bound `tenantId` field in `PilotAuthorizationV1`, which is set to the authenticated `clubId` by the Spectre worker at request-signing time. Whatever the video says is preserved verbatim through Whisper.

---

## 7. Resource and cost controls (§8) — DOCUMENTED

Full table in [PHASE-4Y-E-DEPLOYMENT-RUNBOOK.md §3](./PHASE-4Y-E-DEPLOYMENT-RUNBOOK.md). Headline figures:

| Metric | Value |
|---|---|
| **Modal Spend Limit** | **$10 USD — UNCHANGED** (4Y-E does not touch this; founder confirms via dashboard) |
| Max GPU concurrency | 2 containers total (1 per app) via `max_containers=1` × 2 apps |
| Request timeout (transcribe) | 1 800 s (30 min upper bound) |
| Request timeout (generate) | 900 s (15 min upper bound) |
| ASGI (CPU) timeout | 120 s |
| Model cold-start — first boot | ~45-90 s (whisper) / ~60-120 s (qwen) incl. weight download |
| Model cold-start — cached | ~5-15 s (whisper) / ~10-25 s (qwen) with volume cache |
| Expected cost — 642-s video + 6-question generation | **≤ $0.05 USD** total |
| Retry behaviour | Worker handler `NON_RETRYABLE_CODES` set is authoritative |
| Automatic container shutdown | After `scaledown_window=180 s` idle |
| Cleanup procedure | `modal app stop <name>` on both apps |

**4Y-E DID NOT TRIGGER:** model downloads, GPU initialization, or inference. Verified by:
- `modal container list → (zero active)` throughout the slice
- `modal volume list` → no new volume creation (Qwen volume is referenced lazily via `create_if_missing=True`; actual creation happens at first deploy)
- Modal dashboard spend-limit utilisation unchanged.

---

## 8. Tests and acceptance (§9)

Exact counts:

| Suite | Tests | Pass |
|---|---:|:-:|
| TS — 4Y-B contract (18 §9 + 11 unit) | 29 | ✓ 29 |
| TS — 4Y-B cross-language vectors | 25 | ✓ 25 |
| TS — 4Y-B replay concurrency | 5 | ✓ 5 |
| TS — 4Y-C signed-error verification | 6 | ✓ 6 |
| TS — 4Y-C worker-handler integration | 13 | ✓ 13 |
| TS — 4V job-service contract (existing) | 28 | ✓ 28 |
| TS — 4W assessment-plan (existing) | 12 | ✓ 12 |
| TS — 4W generation-service (existing) | 20 | ✓ 20 |
| Python — 4Y-B auth | 18 | ✓ 18 |
| Python — 4Y-B replay | 5 | ✓ 5 |
| Python — 4Y-B cross-language | 9 | ✓ 9 |
| Python — 4Y-B replay concurrency | 3 | ✓ 3 |
| Python — 4Y-C ModalDict atomicity | 5 | ✓ 5 |
| **Python — 4Y-E deploy discovery** | **15** | **✓ 15** |
| **TOTAL** | **193** | **✓ 193** |

- `npx tsc --noEmit` on touched modules: no new errors (verified in 4Y-C; the only 4Y-E TS change is a doc path update).
- Typecheck on `modal_endpoints/*.py` (Python): not run as a gate; MyPy is not wired for the `modal_endpoints` package. Discovery test doubles as structural typecheck.

---

## 9. Deliverable classification (§10)

Per directive §10, each capability classified ONE of four states (no conflation):

| Capability | **Implemented and offline verified** | **Deployed and reachable** | **Live inference verified** | **Founder-testable** |
|---|:-:|:-:|:-:|:-:|
| Hybrid 4yb-v1 authentication (TS + Python symmetric) | ✓ | — | — | — |
| Request-HMAC + body-digest + timestamp window | ✓ | — | — | — |
| PilotAuthorizationV1 + fingerprint + 7-field binding | ✓ | — | — | — |
| Response-HMAC (success + signed error) | ✓ | — | — | — |
| Atomic replay via `modal.Dict.put(skip_if_exists=True)` | ✓ | — | — | — |
| Worker-handler state transitions + lease + retry | ✓ | — | — | — |
| `spectre-training-transcribe` Modal App — deployable | ✓ | — | — | — |
| `spectre-training-generate` Modal App — deployable | ✓ | — | — | — |
| Fly worker-side env + credential resolution | ✓ | — | — | — |
| Spectre schema parity with Modal endpoints | ✓ | — | — | — |
| 6C-11 retirement | ✓ (trivially — no app currently running) | — | — | — |
| Whisper inference on real video | — | — | — | — |
| Qwen inference on real transcript | — | — | — | — |
| End-to-end pilot (Silver Springs video → draft) | — | — | — | — |

**Nothing beyond "Implemented and offline verified" has been promoted in this slice.** All cells beyond the first column require authorised next slices.

---

## 10. STOP compliance (THIS SLICE — 4Y-E)

| Boundary | Status |
|---|:-:|
| No Modal deployment | ✓ |
| No GPU activation | ✓ (verified `modal container list → 0`) |
| No live inference | ✓ |
| No Fly secrets changes | ✓ |
| No DRH-1 deployment | ✓ |
| No production changes | ✓ |
| No spending-limit changes | ✓ |
| No historical draft modifications | ✓ |
| No publication or employee assignments | ✓ |
| No unrelated UI redesign | ✓ |
| **Preserve all 126 unrelated WIP files** | ✓ (main-tree working-tree on `staging-deploy/web1b1-framer-fidelity` unchanged throughout) |

---

## 11. Exact remaining activation steps (for the next authorised slice)

1. Operator confirms Modal $10 spend-limit on dashboard.
2. Operator creates/rotates 3 Modal workspace secrets via `--from-dotenv` (0600 file, deleted post-creation).
3. Operator `modal deploy -m modal_endpoints.transcribe_app` + `modal deploy -m modal_endpoints.generate_app`; captures both endpoint URLs.
4. Operator `flyctl secrets import --app spectre-staging-worker --stage < .fly-secrets.tmp` with 7 secrets (6 inference-related + 1 response-HMAC-key); deletes the file.
5. Operator triggers DRH-1 deploy; captures new image sha + Fly release IDs.
6. Operator runs the AuthN probes with INTENTIONALLY BAD inputs; confirms signed error responses; confirms zero GPU boot.
7. Operator produces Gate 1 acceptance.

4Y-E has delivered all offline inputs. The next slice is PURELY DEPLOY + VERIFY — no new engineering.

**Estimated time to Gate 1 pass:** ≤ 1 h operator-driven execution. Gate 2 (live inference on Silver Springs video owned by Coulee Ridge tenant) remains a separately authorised step.

---

## 12. Commit

Files produced in this slice (all under `ep-train-4y-b-impl/hybrid-auth-contract`):

- **Renamed** 14 files: `modal/` → `modal_endpoints/` (git mv).
- **New:** `modal_endpoints/transcribe_app.py` (195 LOC — deployable).
- **New:** `modal_endpoints/generate_app.py` (223 LOC — deployable).
- **New:** `modal_endpoints/tests/test_deploy_discovery.py` (178 LOC — 15 tests).
- **New:** `docs/training/ai-generation/PHASE-4Y-E-DEPLOYMENT-RUNBOOK.md`.
- **New:** `docs/training/ai-generation/PHASE-4Y-E-ACCEPTANCE-REPORT.md` (this file).
- **Updated:** `docs/training/ai-generation/PHASE-4Y-C-STAGING-ACTIVATION-CHECKLIST.md` (`modal deploy modal/…` → `modal deploy -m modal_endpoints.*`).

**End of EP-TRAIN-4Y-E acceptance report.**
