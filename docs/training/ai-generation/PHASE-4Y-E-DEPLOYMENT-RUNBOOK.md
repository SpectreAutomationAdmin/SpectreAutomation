# EP-TRAIN-4Y-E — Deployment Runbook

**Status:** EXECUTION-READY for the next authorised Gate 1 slice. Nothing in 4Y-E itself executes any of these steps.

**Baseline the runbook ships from:** `ep-train-4y-b-impl/hybrid-auth-contract` + 4Y-E commit (see acceptance report §11 for sha).

**Target staging:** Fly web `v1098` · worker `v334` · image `sha-e7fbb0b158cd`
**Modal workspace:** `spectreautomation-admin` · $10 USD spend limit · 0 running apps.

---

## 1. Pre-deploy checklist

- [ ] Founder confirms Modal dashboard spend limit still $10 USD (not CLI-surfaced).
- [ ] Operator workstation has Modal SDK ≥ 0.65.42 (verified: `modal --version` ⇒ 1.6.3 on current workstation).
- [ ] `modal app list --json → []` (no leftover 6C-11 apps running).
- [ ] `git log --oneline -1` on `ep-train-4y-b-impl/hybrid-auth-contract` matches the 4Y-E commit sha.
- [ ] 193/193 offline tests pass:
  - `python -m unittest discover -s modal_endpoints/tests -t .` → 55/55
  - `npx vitest run tests/ep-train-4y*.test.ts tests/ep-train-6d4v* tests/ep-train-6d4w*` → 138/138
- [ ] Rollback anchor captured: web v1098 / worker v334 / image `sha-e7fbb0b158cd`.
- [ ] 126 WIP files on main working tree unchanged.

---

## 2. Deploy sequence

### 2.1 Modal workspace secrets (OPERATOR, one-time)

**Secure injection** — values typed into stdin or from a 0600 dotenv file; never on the command line.

```
# ── reuse of existing spectre-training-runtime-hmac is permitted
#    because no app is currently consuming it. Operator may rotate
#    with --force, OR keep the existing value AND set the same
#    bytes on Fly's MODAL_SPECTRE_HMAC_KEY (requires operator's
#    local copy of the value from creation time).
modal secret create spectre-training-runtime-hmac            --from-dotenv ./.hmac.tmp
modal secret create spectre-training-pilot-fingerprint-secret --from-dotenv ./.fp.tmp
modal secret create spectre-training-response-hmac-key       --from-dotenv ./.resp.tmp
# Each .tmp file contains one line: KEY=value, e.g.
#   MODAL_SPECTRE_HMAC_KEY=<32-byte base64>
# File must be 0600 and deleted immediately after:
rm .hmac.tmp .fp.tmp .resp.tmp
```

### 2.2 Modal apps

```
modal deploy -m modal_endpoints.transcribe_app
#   → prints endpoint URL for the `api` web function; capture it
#     verbatim for Fly's MODAL_TRANSCRIBE_URL

modal deploy -m modal_endpoints.generate_app
#   → prints endpoint URL for the `api` web function; capture it
#     verbatim for Fly's MODAL_GENERATE_URL
```

**Immediate post-deploy:** both apps are deployed but not actively serving traffic (no live HTTP yet from Fly). The GPU containers scale-to-zero (`scaledown_window=180`), so until Fly worker fires a request, no GPU time accrues.

### 2.3 Fly secrets (DRH-1 pathway)

Set the 7 secrets on `spectre-staging-worker` ONLY. Operator uses `flyctl secrets import` from a 0600 file to avoid command-history exposure:

```
# .fly-secrets.tmp (0600):
MODAL_KEY=wk-...
MODAL_SECRET=ws-...
MODAL_TRANSCRIBE_URL=https://...modal.run
MODAL_GENERATE_URL=https://...modal.run
MODAL_SPECTRE_HMAC_KEY=<same value as Modal secret above>
SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET=<same value>
MODAL_SPECTRE_RESPONSE_HMAC_KEY=<same value>

flyctl secrets import --app spectre-staging-worker --stage < .fly-secrets.tmp
rm .fly-secrets.tmp
```

**Critical** — do NOT set these on `spectre-staging` (web). §7 of the 4Y-B-IMPL directive: least-privilege.

### 2.4 DRH-1 deploy

```
# From the current operator workstation:
gh workflow run deploy-staging.yml \
  --ref ep-train-4y-b-impl/hybrid-auth-contract
```

**Monitoring:**
- 5-min no-progress threshold applies (memory: `feedback_fly_deploy_hang_policy.md`).
- MAX 1 retry on transient infra (memory: `feedback_drh1_retry_policy.md`).
- Capture new image sha + Fly web+worker version IDs post-deploy.

### 2.5 Health check

```
curl -s https://staging.spectreautomation.com/api/health
# expected: 200
```

---

## 3. Cost / concurrency / cold-start table

All values derived from the Modal app definitions in `modal_endpoints/transcribe_app.py` + `generate_app.py`.

| Property | Transcribe | Generate | Source |
|---|---|---|---|
| GPU class | A10G (1 ×) | A10G (1 ×) | Matches EP-TRAIN-6C-11 deployment history |
| GPU price (Modal public) | ~$1.10 / hr | ~$1.10 / hr | A10G list rate |
| `max_containers` | 1 | 1 | Protects $10 spend cap |
| `timeout` | 1 800 s (30 min) | 900 s (15 min) | `@app.cls(...)` |
| ASGI `timeout` (CPU) | 120 s | 120 s | `@app.function(timeout=120)` |
| `scaledown_window` | 180 s (3 min idle) | 180 s (3 min idle) | Scale-to-zero after idle |
| Cold start (first container) | ~45-90 s (weights download first time; cached afterward on `spectre-whisper-weights-cache` volume) | ~60-120 s (Qwen ~5GB first-pull) |
| Cold start (cached weights) | ~5-15 s (CUDA init + model load) | ~10-25 s (CUDA + AWQ unpacking) |
| Per-642-s video — transcribe | ~40-80 s GPU time ≈ $0.012-$0.025 | n/a | Whisper large-v3 real-time factor ~0.1-0.15× |
| Per-6-question generation | n/a | ~15-60 s GPU time ≈ $0.005-$0.020 per batch | Qwen 2.5 7B AWQ with LMFE structured output |
| **Full Silver-Springs pilot (one video + one 6-question generation)** | — | — | **≤ $0.05 USD** estimated |
| Retry policy | Worker handler classifies `MODAL_TIMEOUT` / `MODAL_HTTP_ERROR 5xx` as retryable; HMAC / schema / envelope mismatches as non-retryable (per `NON_RETRYABLE_CODES` set) | Same | `src/lib/hr/training/modal-shared/errors.ts` |
| Automatic container shutdown | After `scaledown_window=180 s` idle, Modal stops the container; no residual spend | Same | Modal built-in |
| Cleanup procedure | `modal app stop spectre-training-transcribe` + `modal app stop spectre-training-generate` — both apps also auto-stop when no requests arrive within idle window | Same | Modal CLI |

**Replay-registry Dict:** `spectre-training-replay-4yb-v1` — workspace-level `modal.Dict`, negligible storage cost (one record per replay-key for 15 min). Shared across both apps so a request-id used for transcribe cannot be replayed on generate (and vice versa).

**Weights volumes:**
- `spectre-whisper-weights-cache` — ~3 GB after first Whisper download (negligible monthly cost).
- `spectre-qwen-weights-cache` — created on first generate deploy; ~5 GB after first Qwen download.

**$10 Spend Limit — safeguards:**
- `max_containers=1` on each app ⇒ at most 2 GPU containers can be live simultaneously (one per app).
- 1 800 s × 2 GPUs × $1.10/hr worst case ≈ $1.10 if a transcribe + generate both run full timeout.
- `scaledown_window=180` means idle cost is near-zero.
- Operator can `modal app stop <name>` at any moment to halt immediately.

---

## 4. Verification after deploy (next Gate 1 slice)

With the 7 Fly secrets in place and DRH-1 deploy complete:

1. `flyctl logs --app spectre-staging-worker | grep training` — confirm startup clean, no `CREDENTIAL_ABSENT`.
2. Enqueue an AuthN probe via the admin UI with INTENTIONALLY BAD inputs (wrong HMAC key temporarily set, tampered request-id, expired timestamp). Expect Modal 400 with signed `x-spectre-failure-code` header. GPU never touched.
3. Confirm Modal dashboard shows ≤ $0.00 spent during AuthN probes (no container boot).
4. Operator decision: proceed to Gate 2 (live-inference pilot) or defer.

---

## 5. Rollback

**Triggers** — any one of:
- Worker logs show unexpected `ModalContractError` codes beyond the §4 classification table.
- Modal spend trending toward 50% of $10 limit.
- Any `MODAL_HMAC_INVALID` / `PILOT_AUTH_FINGERPRINT_MISMATCH` / `TENANT_MISMATCH` observed (never legitimate in a pilot).
- `/api/health` fails on either app.
- Response signatures don't verify in the TS client (key drift).

**Actions** — in order, each independently reversible:

| # | Action |
|---|---|
| 1 | `modal app stop spectre-training-transcribe && modal app stop spectre-training-generate`. Clients fall back to `CREDENTIAL_ABSENT` / `MODAL_HTTP_ERROR` immediately. |
| 2 | Unset Fly secrets if the issue is secret-related: `flyctl secrets unset MODAL_KEY MODAL_SECRET MODAL_TRANSCRIBE_URL MODAL_GENERATE_URL MODAL_SPECTRE_HMAC_KEY SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET MODAL_SPECTRE_RESPONSE_HMAC_KEY --app spectre-staging-worker`. |
| 3 | DRH-1 rollback: `flyctl deploy --image registry.fly.io/spectre-staging-worker:sha-e7fbb0b158cd --app spectre-staging-worker`. |
| 4 | Rotate `spectre-training-runtime-hmac` + `spectre-training-pilot-fingerprint-secret` + `spectre-training-response-hmac-key` on Modal with `--force` and re-provision on Fly if any key may have been exposed. |
| 5 | `/api/health` on both Fly apps → 200. |
| 6 | `modal container list` → 0 rows. |

**Rollback anchor pins** (as of 4Y-E baseline):
- Web `spectre-staging` **v1098** image `sha-e7fbb0b158cd`
- Worker `spectre-staging-worker` **v334** image `sha-e7fbb0b158cd`
- Modal workspace **$10 USD** spend limit + zero running apps after rollback

---

## 6. STOP boundaries (THIS SLICE — 4Y-E)

Nothing in this runbook executes from 4Y-E. The 4Y-E slice produced:
- Rename `modal/` → `modal_endpoints/` (git mv; 14 files tracked under new path).
- `modal_endpoints/transcribe_app.py` — real deployable Modal App (Whisper large-v3, A10G).
- `modal_endpoints/generate_app.py` — real deployable Modal App (Qwen 2.5 7B AWQ, A10G).
- `modal_endpoints/tests/test_deploy_discovery.py` — 15 offline tests confirming discovery.

**No deployment, no secrets, no GPU, no inference. 126 WIP files preserved on main working tree.**

**End of deployment runbook.**
