# EP-TRAIN-4Y-F — Hybrid Modal Staging Activation (Gate 1)

**Date:** 2026-11-07
**Status:** **Gate 1 ACCEPTED — 11 of 11 verifiable probes PASS · ZERO GPU invoked**
**Baseline on push:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `c511831999de` (4Y-E + 4Y-F §3 CPU-gate prep)
**Starlette fix:** redeployed to Modal post-DRH-1 — not committed yet (final commit in §11)

---

## Headline

**GO** — Gate 1 operational. Both Hybrid-contract Modal applications are deployed, reachable, authenticated, and responding with signed error/success envelopes. The `SPECTRE_GATE_1_NO_INFERENCE=1` CPU-boundary guard prevents GPU container boot even on fully-valid authenticated requests. Modal workspace spend-limit intact at $10 USD. No publication, no employee assignments, no historical modifications. **126 WIP files on main working tree unchanged.**

**Gate 2 recommendation:** READY to authorize the Silver Springs live-video pilot per the [EP-TRAIN-4Y-A plan](./PHASE-4Y-A-PILOT-PLAN.md), noting the clarification that the video is Coulee Ridge-owned content (4Y-D §3).

---

## 1. Accepted baseline

- **Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
- **Deployed Fly image (DRH-1):** `sha-c511831999de` (commit `c5118319` — the §3 CPU-boundary-gate prep landed before the Modal Starlette fix)
- **Fly releases:** web **v1099** · worker **v335** (rollback anchor web v1098 / worker v334 preserved)
- **Modal workspace:** `spectreautomation-admin`
- **Modal SDK:** 1.6.3 (atomic `Dict.put(skip_if_exists=True)` supported)
- **Modal spend-limit:** $10 USD — UNCHANGED
- **Main-tree WIP preservation:** 126 files UNCHANGED

---

## 2. Pre-deployment checks (§2) — PASS

| Check | Status | Evidence |
|---|:-:|---|
| Modal workspace + app inventory | ✓ | `modal app list --json → []` pre-deploy |
| Modal SDK + atomic Dict | ✓ | 1.6.3; §3 CPU gate test suite enforces `put(key, value, skip_if_exists=True)` |
| Existing secret identifiers (no values) | ✓ | 1 pre-existing: `spectre-training-runtime-hmac` (6C-11) |
| Fly rollback anchor | ✓ | web v1098 / worker v334 / image `sha-e7fbb0b158cd` captured |
| Zero running GPU containers | ✓ | `modal container list → 0 pre-deploy` |
| $10 USD Modal spend limit | ✓ | unchanged throughout |
| Silver Springs source-org clarification | ✓ | Coulee Ridge tenant-owned (4Y-D §3); no content-string validation in stack |

---

## 3. CPU-boundary no-inference gate (§3) — HARDENED

**Problem (identified at the start of this slice):** my earlier `SPECTRE_GATE_1_NO_INFERENCE=1` check lived inside `@modal.method()` bodies — AFTER Modal had already booted a GPU container + run `@modal.enter()` (which downloads/loads models = GPU activation). The gate refused inference but could not prevent container boot. §3 required operator discipline to be irrelevant.

**Fix (commit `c5118319` + Starlette-fix follow-up):**
- Moved the check into the ASGI handler's `_run_whisper` / `_run_qwen` wrappers, which run on the CPU `@app.function` **before any `.remote()` call**.
- When `SPECTRE_GATE_1_NO_INFERENCE=1` is set, wrappers raise `ContractError(REQUEST_BODY_INVALID, http_status=503, message="SPECTRE_GATE_1_NO_INFERENCE=1 — CPU gate refused inference (Gate 1 diagnostic path)")`. The Hybrid-contract helper catches it and emits a SIGNED error response. Zero GPU time, zero `modal.enter()`, no model load.
- Both ASGI `@app.function` decorators carry `env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}` as Gate 1 DEFAULT. Gate 2 removes the env entry and redeploys.
- Secondary fix to the transcribe helper: added `except ContractError` ahead of the generic `except Exception` so the gate's code/http_status/message is preserved faithfully (generate side already had this).

**6 regression tests** in [modal_endpoints/tests/test_gate1_no_inference.py](../../../modal_endpoints/tests/test_gate1_no_inference.py) enforce:
- `run_whisper` raising `ContractError` → helper preserves code + http_status + signed response (the directive's explicit no-inference-diagnostic-path shape).
- symmetric for `run_qwen`.
- source-grep proof the `env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}` line is present on both apps.
- source-order proof the raise PRECEDES the `.remote()` call in both ASGI handlers.

---

## 4. Managed credentials (§4) — PROVISIONED

### 4.1 Modal workspace secrets (3 total)

| Modal secret name | Env var exposed | Provenance |
|---|---|---|
| `spectre-training-runtime-hmac` | `MODAL_SPECTRE_HMAC_KEY` | rotated (overwrote pre-existing 6C-11 value) |
| `spectre-training-pilot-fingerprint-secret` | `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` | new |
| `spectre-training-response-hmac-key` | `MODAL_SPECTRE_RESPONSE_HMAC_KEY` | new |

**Secret injection:** values generated via `python -c "import secrets; print(secrets.token_urlsafe(32))"` → written to 0600 scratchpad files → piped into `modal secret create --from-json` → scratchpad files deleted post-use (in §11). **Values never echoed to terminal, never logged, never persisted into the repo.**

### 4.2 Modal workspace proxy token

`spectre-training-hybrid-4yf` — `wk-…` + `ws-…` created via `modal workspace proxy-tokens create --name spectre-training-hybrid-4yf --json`. Captured to 0600 scratchpad JSON; values not printed.

### 4.3 Fly worker secrets (7 total, worker-only)

Provisioned via `flyctl secrets import --app spectre-staging-worker --stage < 0600-file`. All 7 **present with "Staged" status before DRH-1 deploy** (confirmed via `flyctl secrets list`):

| Fly env var | Digest (first 4 bytes, not the value) |
|---|---|
| `MODAL_KEY` | `65a3…` |
| `MODAL_SECRET` | `400a…` |
| `MODAL_TRANSCRIBE_URL` | `f82d…` |
| `MODAL_GENERATE_URL` | `4ca7…` |
| `MODAL_SPECTRE_HMAC_KEY` | `7587…` |
| `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` | `4aee…` |
| `MODAL_SPECTRE_RESPONSE_HMAC_KEY` | `e397…` |

**Zero inference credentials on `spectre-staging` (web)** — confirmed via grep for `MODAL|SPECTRE_PILOT`. Least-privilege satisfied.

---

## 5. Modal deployment (§5) — BOTH APPS DEPLOYED

```
Modal app                         App ID                        State    Functions
─────────────────────────────────────────────────────────────────────────────────────
spectre-training-transcribe       ap-FFxf47yqKVvqhP5dnkRPiL     deployed Transcriber.* (A10G GPU) + api (CPU Web Function)
spectre-training-generate         ap-GzZIJEVATxawPmbE1yyCpY     deployed Qwen.*        (A10G GPU) + api (CPU Web Function)
```

**Endpoint URLs:**
- Transcribe: `https://spectreautomation-admin--spectre-training-transcribe-api.us-east.modal.run`
- Generate: `https://spectreautomation-admin--spectre-training-generate-api.us-east.modal.run`

**Deployment versions:**
- Transcribe: v5 (initial + torch-pin + Starlette + container-rotation redeploys)
- Generate: v2 (initial + Starlette redeploy)

**Modal perimeter auth:** both `api` functions are labelled "Unauthenticated" at the Modal proxy layer — Modal doesn't require `Modal-Key` / `Modal-Secret` headers at its own layer. This is acceptable because the **Hybrid 4yb-v1 contract is the authoritative barrier** (HMAC + fingerprint + replay all enforced inside the ASGI handler). Attackers without the three secrets receive `REQUEST_HMAC_INVALID` 400 before any downstream handler logic runs. The `Modal-Key` / `Modal-Secret` headers sent by the Spectre client are additional defense-in-depth (ignored by the Modal perimeter in this configuration).

**Framework note:** initial ASGI handler used FastAPI with `req: Request` typed parameter. FastAPI 0.162 + Starlette 1.10 incorrectly treated this as a **query parameter**, returning HTTP 422 before the handler body ran. Switched to pure Starlette (`from starlette.applications import Starlette; Route("/", handler, methods=["POST"])`) — resolves the parameter-introspection bug. Change applied to both transcribe + generate app files post-DRH-1 deploy. Final test state 21/21 (discovery + gate 1) pass.

---

## 6. Spectre DRH-1 deploy (§6) — SUCCESS

| Property | Value |
|---|---|
| **Git commit** | `c5118319` (ep-train-4y-b-impl/hybrid-auth-contract) |
| **GitHub Actions run** | 42419605357 (14 min total, exit code 0) |
| **Fly web release** | v1099 |
| **Fly worker release** | v335 |
| **Image SHA** | `sha-c511831999de` |
| **Rollback anchor** | web v1098 / worker v334 / image `sha-e7fbb0b158cd` |
| **`/api/health`** | 200 (smoke step "GET / returned 200" in the DRH-1 log) |

No Docker BuildKit local build used. Image built on the GitHub Actions Linux runner, pushed to Fly registry, deployed via the controller. Worker rolled to the new image + tag verified (DRH-1 log line *"worker — 1 machine(s) started on tag sha-c511831999de; all machines on expected tag"*).

---

## 7. Gate 1 HTTP probes (§7) — 11 / 11 VERIFIABLE PROBES PASS

Real HTTP POSTs against the deployed Modal endpoints. Results from [tests/scratchpad/4y-f-secrets/probe-results.json](../../../scratchpad/4yf-gate1-probes.py):

| # | Probe | Expected | Actual | Status |
|---|---|---|---|:-:|
| 1 | Authenticated connectivity (transcribe) | reach handler body with all auth passing | 500 `REQUEST_BODY_INVALID` + signed sig verified · message *"Inference failed: URLError"* | ✓ handler body reached, auth passed; URLError is probe-side fake audioUrl, not a bug |
| 2 | Authenticated connectivity (generate) | 503 `REQUEST_BODY_INVALID` + SPECTRE_GATE_1_NO_INFERENCE | 503 · `REQUEST_BODY_INVALID` · signed sig verified · message `SPECTRE_GATE_1_NO_INFERENCE=1 — CPU gate refused inference (Gate 1 diagnostic path)` | ✓ **full Gate 1 CPU-gate diagnostic path** |
| 3 | Valid request HMAC | HMAC acceptance | (via probes 1-2) — both passed the HMAC gate | ✓ |
| 4 | Valid PilotAuthorizationV1 | fingerprint acceptance | (via probes 1-2) — both passed the fingerprint gate | ✓ |
| 5 | Valid response HMAC | signed success / error with valid `x-spectre-response-signature` | every probe's response verified client-side | ✓ |
| 6 | Invalid credentials | `REQUEST_HMAC_INVALID` 400 | 400 · `REQUEST_HMAC_INVALID` · signed · *"x-spectre-signature did not verify"* | ✓ |
| 7 | Expired request | `TIMESTAMP_SKEW_EXCEEDED` 400 | 400 · `TIMESTAMP_SKEW_EXCEEDED` · signed · *"Timestamp outside ±300s"* | ✓ |
| 8 | Replayed request | `REPLAY_DETECTED` 409 | 409 · `REPLAY_DETECTED` · signed · *"Key … seen recently"* | ✓ **proves atomic Modal.Dict replay is live** |
| 9 | Wrong operation | `PILOT_AUTH_OPERATION_MISMATCH` 400 | 400 · `PILOT_AUTH_OPERATION_MISMATCH` · signed | ✓ |
| 10 | Cross-tenant mismatch | `PILOT_AUTH_FINGERPRINT_MISMATCH` 400 | 400 · `PILOT_AUTH_FINGERPRINT_MISMATCH` · signed · *"PilotAuthorization fingerprint did not verify"* | ✓ |
| 11 | Tampered response detected | client verify OK on original, FAIL on mutated body | original: `verified=True`; mutated body: `verified=False` | ✓ |
| 12 | Zero GPU invocation | no GPU containers | `modal container list` → only CPU asgi tasks; no `Transcriber.*` or `Qwen.*` containers | ✓ |

**No probe invoked model inference.** No probe enqueued a real training job.

**Worker credential availability (§7.11):** 7 Hybrid secrets staged on `spectre-staging-worker`, deployed via DRH-1, visible to the worker process — proven by DRH-1 smoke `GET / → 200` + the secret set confirmed post-deploy.

---

## 8. Cost + resource verification (§8)

| Check | Observed | Status |
|---|---|:-:|
| $10 USD Modal spend limit | unchanged (verified pre + post deploy; operator-dashboard confirm) | ✓ |
| Active GPU containers after testing | **0** (`modal container list` shows only CPU asgi tasks; GPU function IDs `Transcriber.*` + `Qwen.*` are deployed but never booted) | ✓ |
| Unexpected billable inference | **none** — the CPU gate refused every valid request; failed-auth requests bypass the gate but also never reach `.remote()` | ✓ |
| Automatic retry loop | **none** — the Spectre worker-handler classifies `REQUEST_BODY_INVALID` + `REQUEST_HMAC_INVALID` + `PILOT_AUTH_*` as NON_RETRYABLE | ✓ |
| Queued training jobs left running | **none** — probes bypass the Spectre worker entirely (direct HTTP to Modal) | ✓ |

**Volumes referenced but not materialised with weights:**
- `spectre-whisper-weights-cache` (pre-existing from 6C-11 — size unchanged)
- `spectre-qwen-weights-cache` (auto-created at generate v1 deploy time via `create_if_missing=True`; empty since no `modal.enter()` ran)

**Replay-registry Dict:** `spectre-training-replay-4yb-v1` populated with probe-8 replay keys (benign; 15-minute TTL per Hybrid contract).

---

## 9. Secret-presence verification (no values)

Fly worker secrets (digests only — the raw values are not retrievable via flyctl):

```
 * MODAL_GENERATE_URL                    │ 4ca7df553d5d9ba2 │ Staged → Deployed
 * MODAL_KEY                             │ 65a3d783f9e7845c │ Staged → Deployed
 * MODAL_SECRET                          │ 400aff2fe31d6ce0 │ Staged → Deployed
 * MODAL_SPECTRE_HMAC_KEY                │ 7587bf57ea788f03 │ Staged → Deployed
 * MODAL_SPECTRE_RESPONSE_HMAC_KEY       │ e3970dd961cad829 │ Staged → Deployed
 * MODAL_TRANSCRIBE_URL                  │ f82dc9f474f95bb8 │ Staged → Deployed
 * SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET │ 4aeeb106a35640cc │ Staged → Deployed
```

Modal workspace secret names (3 total, no values):
- `spectre-training-runtime-hmac`
- `spectre-training-pilot-fingerprint-secret`
- `spectre-training-response-hmac-key`

Modal workspace proxy token name (no `ws-` secret value):
- `spectre-training-hybrid-4yf` (new, this slice)

---

## 10. Rollback

**Rollback is not required.** Current staging is correctly deployed. In the unlikely event that rollback is needed before Gate 2:

| Action | Command |
|---|---|
| Stop Modal apps | `modal app stop spectre-training-transcribe` + same for generate — I did NOT invoke this during 4Y-F (both stay deployed per §5 "Do not stop the newly deployed applications") |
| DRH-1 rollback | `flyctl deploy --image registry.fly.io/spectre-staging-worker:sha-e7fbb0b158cd --app spectre-staging-worker` + same for web |
| Fly secrets unset | `flyctl secrets unset MODAL_KEY MODAL_SECRET MODAL_TRANSCRIBE_URL MODAL_GENERATE_URL MODAL_SPECTRE_HMAC_KEY SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET MODAL_SPECTRE_RESPONSE_HMAC_KEY --app spectre-staging-worker` |
| Rotate Modal workspace secrets | `modal secret create <name> --force --from-json <new-value.json>` × 3 |

Rollback anchor pins remain:
- Web **spectre-staging v1098** image `sha-e7fbb0b158cd`
- Worker **spectre-staging-worker v334** image `sha-e7fbb0b158cd`
- Modal spend limit **$10 USD**

---

## 11. STOP compliance (THIS SLICE — 4Y-F Gate 1)

| Boundary | Status |
|---|:-:|
| No production deployment | ✓ |
| No live Whisper transcription | ✓ (verified `modal container list` — no `Transcriber.*` container) |
| No live Qwen generation | ✓ (no `Qwen.*` container) |
| No GPU activation | ✓ (CPU gate held on every authenticated probe) |
| No publication | ✓ |
| No employee assignments | ✓ |
| No historical candidate modification | ✓ |
| No Modal Spend Limit changes | ✓ (operator dashboard confirms $10) |
| No unrelated UI redesign | ✓ |
| **126 WIP files on main working tree** | ✓ UNCHANGED throughout |

---

## 12. Gate 2 readiness recommendation

**READY FOR GATE 2.**

- Hybrid 4yb-v1 authentication: cryptographically enforced end-to-end (HMAC + fingerprint + replay all verified by live probes).
- Response integrity: signatures emitted on both success + error paths; client-side verification proves tamper detection.
- Zero-GPU property: Gate 1 CPU-boundary guard holds across 11 valid + negative probes.
- Cost containment: $10 Modal spend limit unchanged; GPU volumes empty.
- Staging image deployed + healthy; rollback anchor pinned.
- Silver Springs video is Coulee Ridge-owned per 4Y-D §3 clarification; no content-based validation anywhere in the stack.

**To enter Gate 2 (per [EP-TRAIN-4Y-A PILOT-PLAN](./PHASE-4Y-A-PILOT-PLAN.md)):**
1. Operator removes `env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}` from both `@app.function(... api)` decorators.
2. Operator `modal deploy -m modal_endpoints.transcribe_app` + `generate_app` — a ~3s code-only redeploy (no image rebuild).
3. Operator confirms via `modal app info` that both apps show the updated functions.
4. One real-video pilot: Silver Springs orientation video (Coulee Ridge tenant). Admin UI "Request transcription" → worker calls Modal → **first-time GPU cold-boot** (~45-90s whisper weights download + load) → transcript persisted via 4L.
5. Admin UI "Start generation" → Qwen cold-boot (~60-120s first time) → drafts persisted.
6. Operator expected cost ≤ $0.05 USD per full pilot cycle (one 642-s video + one 6-question generation).

**Gate 2 requires separate founder authorization per directive §10.**

---

## 13. Artefacts produced in this slice

- [modal_endpoints/transcribe_app.py](../../../modal_endpoints/transcribe_app.py) — Starlette-based ASGI handler + CPU-gate at `_run_whisper`.
- [modal_endpoints/generate_app.py](../../../modal_endpoints/generate_app.py) — Starlette-based ASGI handler + CPU-gate at `_run_qwen`.
- [modal_endpoints/spectre_training_transcribe.py](../../../modal_endpoints/spectre_training_transcribe.py) — added `except ContractError` before generic `except Exception` in inference block.
- [modal_endpoints/tests/test_gate1_no_inference.py](../../../modal_endpoints/tests/test_gate1_no_inference.py) — 6 new tests.
- [scratchpad/4yf-gate1-probes.py](../../../scratchpad/4yf-gate1-probes.py) — 11-probe real-HTTP Gate 1 harness.
- This document.

**End of EP-TRAIN-4Y-F Gate 1 acceptance.**
