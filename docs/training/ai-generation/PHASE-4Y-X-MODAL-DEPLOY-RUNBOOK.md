# EP-TRAIN-4Y-X — Modal Deploy Runbook (Batch C operator action)

**Scope: deploy the new `spectre.training.metadata.v1` operation to Modal.**
**No GPU inference is authorized — this runbook ships code only.**

## Pre-flight

Operator must have:
- Modal CLI installed locally (`pip install modal`).
- Authenticated as the `spectre-training` workspace owner (`modal token new` if needed).
- A checkout of the repo at commit `4f347163` (or newer HEAD on `ep-train-4y-b-impl/hybrid-auth-contract`).
- `MODAL_SPECTRE_HMAC_KEY`, `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`, `MODAL_SPECTRE_RESPONSE_HMAC_KEY` already present as **Modal Secrets** (no change needed — the generate app already has them).

## What is deployed

The existing Modal app `spectre-training-generate` gains:

- A new `Qwen.generate_metadata` method on the same GPU container (Qwen 2.5 7B Instruct AWQ, A10G, `max_containers=1`, unchanged image).
- A new ASGI route `POST /metadata` on the existing CPU HTTP endpoint.
- The same HMAC + replay + fingerprint auth envelope — signed with the existing keys.

Everything else is **unchanged**:

- Model: `Qwen/Qwen2.5-7B-Instruct-AWQ` (unchanged).
- GPU: A10G (unchanged).
- Dependency pins: `torch==2.3.1`, `transformers==4.46.3`, `autoawq==0.2.6` (unchanged).
- Weights volume: `spectre-qwen-weights-cache` (unchanged — subsequent boots stay cache-hot).
- Replay dict: `spectre-training-replay-4yb-v1` (shared across routes — cross-route replay protection).
- Spend cap: Modal account-level $10 (unchanged).

## Deploy command

```bash
# From the repo root at HEAD >= 4f347163:
modal deploy modal_endpoints/generate_app.py
```

Expected output: `modal` reports the app `spectre-training-generate` deployed with routes `/` and `/metadata`.

## Post-deploy verification — NO INFERENCE

### 1. Confirm routes

```bash
modal app list | grep spectre-training-generate
```

### 2. Probe the new route for 401 on an unauthenticated call

```bash
curl -i -X POST https://<app-url>/metadata -H "Content-Type: application/json" -d '{}'
```

Expected: HTTP 401 or signed 400 (the auth gate rejects before entering Qwen; no GPU time consumed).

### 3. Probe with the Gate-1 no-inference env var set (optional)

If the operator wants extra assurance that the Modal CPU boundary refuses inference even with valid auth, set the Gate-1 secret temporarily:

```bash
modal secret set SPECTRE_GATE_1_NO_INFERENCE=1 --app spectre-training-generate
# Re-deploy to pick up the secret.
modal deploy modal_endpoints/generate_app.py
# Now any authenticated metadata call returns 503 at the CPU boundary.
# After verification, remove it:
modal secret unset SPECTRE_GATE_1_NO_INFERENCE --app spectre-training-generate
modal deploy modal_endpoints/generate_app.py
```

### 4. Modal dashboard — check container logs

- No new container should have spun up (the CPU route only activates GPU on a signed, authenticated request that passes the fingerprint check).
- If a spin-up occurred, inspect logs for the 500 crash mode diagnosed in the 4Y-W post-mortem. Capture any Python traceback + report back.

### 5. Rollback

If anything is wrong, Modal supports instant rollback via the dashboard or:

```bash
modal app history spectre-training-generate
modal app rollback spectre-training-generate <previous-version-id>
```

The previous version (pre-4Y-X) is pinned at the deploy prior to 2026-11-09 Batch C.

## Co-ordination with the Fly deploy

The Fly worker-swap (`maybeGenerateCourseMetadata` → `callModalMetadata`) shipped in commit `4f347163` on the Deploy 2 Fly release. The order of operations is tolerant:

| Order | Outcome |
|---|---|
| Fly 2 first, Modal later | Fly worker tries `/metadata` → 404 (route missing) → `MODAL_HTTP_ERROR` → caught + logged in `maybeGenerateCourseMetadata` (non-fatal); question-generation loop continues normally. |
| Modal first, Fly 2 later | Fly worker still calls the pre-X `qwen-metadata-client` (repurposed-proposal schema against `/`). Still works. |
| Both deployed, no pilot | Metadata path remains dormant until a question-generation run fires (requires Batch D, which is NOT approved by this directive). |

**Batch D is not approved by this directive. No pilot fire should follow this Modal deploy until the founder authorizes it separately.**

## Exit criteria

- `modal app info spectre-training-generate` shows the `/metadata` route.
- Modal account spend since deploy: $0 (no GPU time consumed).
- Modal container logs show no spin-ups attributable to this deploy.
- Fly staging app health remains 200 and logs show no new WARN / ERROR referencing `spectre.training.metadata.v1`.

## Known 4Y-V HTTP 500 diagnosis status

Not conclusively diagnosed (Modal dashboard access required). Most-plausible hypothesis per PHASE-4Y-W-REPORT.md §3: cold-boot flakiness on the `@modal.enter() _load_model` path after ~24 h of idle. The operator deploying this runbook should also:

- Open the Modal dashboard and search for container crash logs within `2026-11-09T16:09Z ± 5 min` (the 4Y-V attempt 1 window).
- Export any Python traceback found. Do not log HMAC keys / tokens / signed URLs.
- Append the finding to PHASE-4Y-X-ACCEPTANCE.md §6 before Batch D is requested.
