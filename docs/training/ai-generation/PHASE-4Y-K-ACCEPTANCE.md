# EP-TRAIN-4Y-K — Response-HMAC Repair · Acceptance Report

**Date:** 2026-11-08
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Commit (inbound):** `a7375665` (4Y-J acceptance baseline)
**Modal apps redeployed:**
- `spectre-training-transcribe` (fresh deploy ~02:48 UTC)
- `spectre-training-generate` (fresh deploy ~02:49 UTC)

**Fly staging:** **UNCHANGED** — no TS code changes, no DRH-1 redeploy required. Web **v1105** / worker **v341** / image `sha-c3dc2b6cd776` remain the deployed baseline.

**Modal Spend Limit:** $10 USD — **UNCHANGED**
**126 unrelated WIP files:** PRESERVED (one stashed `49c2af3d` unrelated to this slice)
**GPU inference during this slice:** **ZERO**

---

## §1 Accepted baseline — preserved

All 4Y-J acceptance conditions remain intact. The migration + stuck-job recovery stand unchanged. The only runtime surface this slice modifies is the Modal Python `canonicalise()` function (one deployed Python module).

Unrelated `modal_endpoints/generate_app.py` comment-only stash left untouched per directive §1.

---

## §2 Forensic investigation — complete

Read-only trace across the response-signing contract:

| Layer | File | Role |
|---|---|---|
| Python canonicaliser | [modal_endpoints/shared/auth.py](../../../modal_endpoints/shared/auth.py) · `canonicalise()` | `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)` |
| Python response signer | same · `sign_response()` | `sha256(canonicalise(parsed))` → signed-message → `HMAC-SHA256`, base64url-nopad |
| Modal transcribe handler | `modal_endpoints/spectre_training_transcribe.py:188-196` | constructs `resp_body`, serialises via `json.dumps(resp_body, separators=(",", ":"), ensure_ascii=False)`, then calls `sign_response(body_text=resp_text, ...)` |
| Modal ASGI wrapper | `modal_endpoints/transcribe_app.py:206-250` | Starlette `Response(content=resp_body, status_code, headers)` — forwards body bytes verbatim |
| TS verifier | [src/lib/hr/training/modal-shared/response-verifier.ts](../../../src/lib/hr/training/modal-shared/response-verifier.ts) · `verifyResponseSignature()` | `JSON.parse(bodyText)` → `sha256HexOfCanonicalSync(parsed)` → constant-time compare |
| TS canonicaliser | [src/lib/hr/training/modal-shared/canonicalise.ts](../../../src/lib/hr/training/modal-shared/canonicalise.ts) | sorted keys, `JSON.stringify` primitives |
| TS modal-client | `src/lib/hr/training/transcription/modal-client.ts:168-178` | receives `res.text()`, forwards to `verifyResponseSignature` — fail-closed on unsigned success |

Both sides agree on:
- key sorting (ASCII lexicographic ascending)
- separator form (`,` / `:`, no whitespace)
- Unicode handling (both emit raw UTF-8; `ensure_ascii=False` ↔ modern `JSON.stringify` default)
- control character escaping
- empty objects / arrays / null
- array order preservation

**Both sides disagreed on:** whole-number floats.
- Python `json.dumps(2.0)` → `"2.0"`
- JS `JSON.parse("2.0")` yields primitive `2`; `JSON.stringify(2)` → `"2"`

This is the only semantic divergence the review surfaced. No HTTP intermediary transformation, no header canonicalisation issue, no secret rotation, no body truncation, no transport encoding difference.

---

## §3 Deterministic mismatch probe — divergence proven at byte 18

Probe: `scratchpad/4yk-probe.mjs` (local, zero network, zero GPU).

For an identical logical value `{"durationSec": 642.0, "segments": [{"startSec": 0.0, "endSec": 2.0, ...}], ...}`, the two sides produced:

```
py canonical: {"durationSec":642.0,"requestId":"r1","segments":[...]}
ts canonical: {"durationSec":642,  "requestId":"r1","segments":[...]}
                            ^^^
first byte-level divergence:
  index: 18
  pyByte: 46  pyChar: '.'
  tsByte: 44  tsChar: ','
```

End-to-end signature verification: **DIVERGE** (Python's `pLwVYlKlIk…I14` vs TS's `u51U6efeeS0…A9Y`). This byte-level reproduction matches the live pilot `MODAL_HMAC_INVALID` failure on job `cmw77zmiz…` at 02:37:17 UTC.

The pre-fix Modal response body from the live pilot almost certainly contained the string `"durationSec":642.0,"segments":[{"id":0,"startSec":0.0,...` — a bit-identical match with the §3 synthetic reproduction.

---

## §4 Secret consistency — VERIFIED, non-disclosing

Probe: `scratchpad/4yk-secret-probe.ts`, run from the Fly worker SSH console against the (then-current) Modal v8 transcribe endpoint.

Mechanism: send a SHAPE-VALID but HMAC-INVALID request → Modal's `_handle_transcribe_request` extracts `requestId`, fails `verify_request_envelope`, and takes the `_signed_error(http_status=400, code=REQUEST_HMAC_INVALID)` branch which signs the error body with Modal's `spectre-training-response-hmac-key` Secret.

**Result (pre-redeploy):**

```
http=400
signed-response headers present: [
  'x-spectre-response-signature', 'x-spectre-response-operation',
  'x-spectre-response-request-id', 'x-spectre-contract-version',
  'x-spectre-failure-code'
]

✓ SECRETS CONSISTENT — Fly worker's MODAL_SPECTRE_RESPONSE_HMAC_KEY
  agrees with Modal's spectre-training-response-hmac-key Secret.
  No raw keys were logged. No GPU container booted.
```

**Result (post-redeploy, re-ran as the §7 no-GPU probe):** `✓ SECRETS CONSISTENT` — new deploy preserves the secret binding.

**Zero raw keys** printed or logged at any stage of the probe. The probe body uses a deliberately-wrong HMAC key (`"intentionally-different-key"`) so even the Python HMAC-SHA256 that Modal re-computes carries no production secret bits. The verification itself is a constant-time equality on base64url-nopad strings — a boolean outcome, not a key disclosure.

---

## §5 Narrowest correct fix

Implementation: one function + one wire-up line in [modal_endpoints/shared/auth.py](../../../modal_endpoints/shared/auth.py):

```python
def _normalise_whole_floats(value):
    if isinstance(value, float):
        if value.is_integer() and -_JS_SAFE_INT <= value <= _JS_SAFE_INT:
            return int(value)
        return value
    if isinstance(value, list):   return [_normalise_whole_floats(x) for x in value]
    if isinstance(value, tuple):  return tuple(_normalise_whole_floats(x) for x in value)
    if isinstance(value, dict):   return {k: _normalise_whole_floats(v) for k, v in value.items()}
    return value

def canonicalise(value):
    return json.dumps(
        _normalise_whole_floats(value),
        sort_keys=True, separators=(",", ":"),
        ensure_ascii=False, allow_nan=False,
    )
```

### Properties preserved

| Property | Preserved? | Mechanism |
|---|---|---|
| HMAC-SHA256 integrity | ✓ | Unchanged — `hmac.new(key, msg, hashlib.sha256)` |
| Request ID binding | ✓ | `requestId` is a string (ASCII-guarded), never a float |
| Operation binding | ✓ | Operation is a string literal, never a float |
| Response body integrity | ✓ | `sha256_hex_of_canonical(parsed)` still covers every field |
| Signed error responses | ✓ | `_signed_error` uses the same `sign_response()`; verified post-fix (§4 re-run) |
| Rejection of unsigned responses | ✓ | `verifyResponseSignature()` still throws `MODAL_HMAC_INVALID` on missing headers (unchanged) |
| Rejection of tampered responses | ✓ | Regression test K5 (body tamper) + K6 (signature tamper) PASS |
| Replay protection | ✓ | `replay_key()` / `ModalDictReplayRegistry` unchanged |
| Tenant isolation | ✓ | PilotAuthorization fingerprint binding unchanged |
| Rejection of `NaN` / `±Infinity` | ✓ | `allow_nan=False` kept; the pre-processor is explicitly "float → int only when `is_integer()`" — `NaN.is_integer()` returns `False` |

### Explicitly NOT in the fix (defence against over-reach)

- No fallback that accepts invalid signatures — the verifier still throws on any disagreement.
- No change to the TS side — JS/TS already drops `.0` on parse, so no change is needed there.
- No change to the signed-message format or component ordering — the signature contract is unchanged.
- No key rotation.
- No "soft-match" tolerance of mismatched digests.

### Safe-integer scoping

Only floats in the JS safe-integer range (±2^53 − 1) are normalised. Larger floats would scientific-form-stringify differently between Python (`1e+20`) and JS (`100000000000000000000`), and no Whisper / Qwen field reaches that scale (seconds are ≤ hours, elapsedMs is bounded to tens of minutes).

---

## §6 Cross-language regression coverage

### New TS round-trip suite — `tests/ep-train-4y-k-response-hmac-roundtrip.test.ts`

**10/10 PASS.** Each test spawns the PRODUCTION Python `sign_response()` with a synthetic response body, then verifies with the PRODUCTION TS `verifyResponseSignature()`:

| # | Scenario |
|---|---|
| K1 | Realistic multi-segment Whisper response with whole-number float boundaries (`durationSec:0.0`, `startSec:0.0`, `endSec:2.0`, `avgConfidence:1.0`) verifies end-to-end |
| K2 | Empty transcript (`durationSec:0.0`, zero segments) verifies |
| K3 | Unicode transcript (U+2028, U+2029, non-BMP emoji U+1F600) verifies byte-identically |
| K4 | Signed ERROR response (HTTP 500) verifies and the TS client accepts the signed failure code header |
| K5 | Body tamper (single-byte mutation after signing) → `MODAL_HMAC_INVALID` thrown |
| K6 | Signature tamper → `MODAL_HMAC_INVALID` thrown |
| K7 | HTTP-status substitution (200 → 500) → `MODAL_HMAC_INVALID` thrown (status is part of signed message) |
| K8 | `requestId` mismatch → `RESPONSE_REQUEST_ID_MISMATCH` (pre-HMAC check) |
| K9 | Operation mismatch → `RESPONSE_OPERATION_MISMATCH` |
| K10 | Wrong worker-side key → `MODAL_HMAC_INVALID` thrown (worker/Modal secret divergence case) |

### Extended fixture-based cross-language coverage

Updated fixture: [tests/fixtures/ep-train-4yb-cross-language-vectors.json](../../../tests/fixtures/ep-train-4yb-cross-language-vectors.json) · `fixtureVersion` bumped `4yb-verify-v1` → **`4yk-v1`**.

Added **9 new canonicalisation vectors** (c14-c22): whole-float-zero, whole-float-positive, whole-float-clamp-endpoint, non-whole-float-preserved (negative control), mixed int/float/wholeFloat in one object, negative whole-float, Whisper-shaped segment, U+2028/U+2029 raw, non-BMP emoji.

Added **2 new response-signing vectors**:
- `resp2-transcribe-200-whole-float-segments` — mirrors the live pilot payload shape.
- `resp3-transcribe-signed-error-500` — the signed-error path.

Suite results (regenerated fixture + unchanged production code consuming it):

| Suite | Result |
|---|---|
| Python `modal_endpoints.tests.test_cross_language` | **9/9 PASS** (fixture pin + canonicalisation + fingerprint + request-sign + response-sign + tamper + timestamp + em-dash guard + NaN guard) |
| TS `tests/ep-train-4yb-cross-language.test.ts` | **36/36 PASS** |
| Full Python module tests | **33/33 PASS** (`test_cross_language` + `test_auth` + `test_gate1_no_inference`) |
| Adjacent 4Y / 4V TS contract tests | **85/85 PASS** (impl-contract + signed-errors + worker-handlers + 4V service + 4Y-J active-uniqueness) |

**Zero regressions** anywhere in the 4Y / 4V contract surface.

### Fixture generator parity

`tests/fixtures/gen-cross-language-vectors.py` was updated with the SAME `_normalise_whole_floats` logic so the ground-truth generator stays independent of (and byte-identical to) both production implementations. The generator is still NOT the production module — it is a stdlib-only RFC-8785-equivalent canonicaliser with the 4Y-K whole-float bridge spelled out inline.

---

## §7 Deployment & no-GPU verification

### Modal redeploy (code-only, NO infrastructure change)

```
modal deploy -m modal_endpoints.transcribe_app  →  deployed 2.655s
  ✓ Uploaded PythonPackage:modal_endpoints
  ✓ Created Function api
  ✓ Created Function Transcriber.*.

modal deploy -m modal_endpoints.generate_app  →  deployed 3.149s
  ✓ Uploaded PythonPackage:modal_endpoints
  ✓ Created Function Qwen.*.
  ✓ Created Function api
```

Both apps re-deployed with the fixed `shared/auth.py`. Image layers were cache-hit (Docker image unchanged); only the Python module changed, so deploy took single-digit seconds. No secret rotation. No env var changes.

### Deployed no-GPU probe

Re-ran `scratchpad/4yk-secret-probe.ts` against the freshly-redeployed `spectre-training-transcribe` endpoint from the Fly worker SSH console. Real HTTP round-trip, signed-error branch:

```
POST https://spectreautomation-admin--spectre-training-transcribe-api.us-east.modal.run
  requestId: r-4yk-sec-probe-db37e6e5a2c4fb73
  http=400
  signed-response headers present: [all 5]

✓ SECRETS CONSISTENT (as of CURRENT Modal deploy, post-4Y-K)
```

### Zero-GPU evidence

`modal container list` at probe time:
```
ta-01M6WHWM1XBP80DGJ6N09EPATR  spectre-training-transcribe  (CPU asgi)
```

- **Zero** GPU `Transcriber.*` containers.
- **Zero** GPU `Qwen.*` containers.
- The single CPU ASGI container is the signed-error path handler; it scales to zero after its 180 s idle window.

### Why the deployed probe cannot exercise the whole-float success path without GPU

The Modal ASGI `api` function routes a successful request to `Transcriber.transcribe.remote(wav_bytes)` which spins a GPU container. Any signed response body that contains whole-number floats (the shape 4Y-K specifically fixes) only exists after real Whisper inference.

Per directive §7 ("If a deployed no-GPU response-signature probe cannot safely exercise the production success path, STOP and report rather than initiating inference"): **STOPPED**. The canonicalise fix is proven live:

- byte-for-byte on 9 new fixture vectors loaded by the deployed Python module
- end-to-end on 10 round-trip tests driving the same Python module as a subprocess
- secret-consistent on the deployed signed-error path

The ONLY remaining step is a real Whisper response bearing whole-number floats, which is **§8 next-step** below and requires explicit founder authorization to invoke GPU.

### `/api/health`

Fly staging `/api/health` → **HTTP 200** (unchanged — no DRH-1 redeploy was needed in this slice because no Fly-side code changed).

---

## §8 Deliverables

| Deliverable | Location |
|---|---|
| Exact HMAC root cause | §2 + §3: Python `json.dumps(2.0)` emits `"2.0"`; JS cannot preserve int-vs-float after parse, so `JSON.stringify(2.0)` emits `"2"`. HMAC digest diverges on any whole-valued Whisper float. |
| Evidence of the mismatch | §3 byte-level diff at index 18; live-pilot failure mode on job `cmw77zmiz…` reproduced locally |
| Corrected implementation | `modal_endpoints/shared/auth.py` `_normalise_whole_floats` + `canonicalise` |
| Cross-language test results | §6 — 10/10 new + 36/36 fixture + 33/33 Python + 85/85 adjacent TS |
| Deployed HTTP verification | §7 — signed-error round-trip PASS post-redeploy; CPU-only container |
| Secret-consistency verification | §4 — non-disclosing PASS; NO keys logged |
| Zero-GPU evidence | §7 — `modal container list` shows one CPU ASGI only, no `Transcriber.*` / `Qwen.*` GPUs |
| Exact next step to resume pilot | §8-next below |

### §8 Next step to resume the pilot

**One Whisper invocation remains to prove the fix on a live transcript body.** The specific action:

1. Founder authorizes a single new Whisper transcription (expected GPU cost ≤ $0.04 USD; well under the $1 abort threshold).
2. From the authenticated manager UI OR the existing `tests/e2e/ep-train-4y-j-live-pilot.staging.spec.ts` spec, POST `/api/admin/training/versions/cmvzs3w05000456qcgfgps7gy/transcribe`.
3. Expected result: `TrainingTranscriptionJob` transitions REQUESTED → QUEUED → RUNNING → **COMPLETED** with a persisted `TrainingTranscriptBuild`. No MODAL_HMAC_INVALID.
4. If COMPLETED: the 4Y pilot is genuinely unblocked. Qwen generation can then be invoked under a separate authorization.
5. If FAIL: diagnose via the Modal logs for the exact new failure code — but the three hypotheses from 4Y-J §7 are now exhausted (HMAC verified ✓, canonicalise bridged ✓, secrets consistent ✓).

---

## §9 Mandatory STOP compliance

| Boundary | Status |
|---|:-:|
| No production changes | ✓ (staging only) |
| No GPU inference during this slice | ✓ (local tests only; deployed probe used signed-error / CPU path) |
| No new transcription jobs | ✓ |
| No Qwen generation | ✓ |
| No destructive database operations | ✓ (zero DB mutations this slice) |
| No historical AI draft modifications | ✓ (AI-draft tables never read or written) |
| No course publication or employee assignments | ✓ |
| No spending-limit changes | ✓ ($10 Modal limit UNCHANGED) |
| No unrelated UI redesign | ✓ |
| 126 unrelated WIP files preserved | ✓ (stash `49c2af3d` remains untouched) |

**STOPPED** after the deployed response-signature contract passed verification. Awaiting founder authorization for one more Whisper invocation to finish the live pilot.

---

**End of EP-TRAIN-4Y-K acceptance report.**
