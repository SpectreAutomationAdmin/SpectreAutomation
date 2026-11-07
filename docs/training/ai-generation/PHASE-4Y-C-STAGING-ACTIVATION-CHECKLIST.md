# EP-TRAIN-4Y-C §7 — Staging Activation Checklist

**Status:** EXECUTION-READY RUNBOOK (2026-11-07). Each step is explicitly bounded. Nothing in this slice has executed any of these steps yet; they need separate founder authorisation as a sequenced slice.

**Baseline before activation:**
- Branch: `ep-train-4y-b-impl/hybrid-auth-contract` (needs commit with 4Y-C work)
- Staging (current): Fly web v1098 / worker v334 / image `sha-e7fbb0b158cd`
- Modal workspace spend limit: **$10 USD** (verify unchanged in the dashboard)
- 126 WIP files on main working tree — must stay untouched

**Prerequisite — founder approves (yes/no each):**
1. [ ] 6C-11 operator-path retirement direction: **T** (stop) / **K** (keep both) / **R** (not recommended; implement legacy branch). See [PHASE-4Y-C-6C11-RETIREMENT-RATIONALE.md](./PHASE-4Y-C-6C11-RETIREMENT-RATIONALE.md).
2. [ ] Push the 4Y-C branch to origin.
3. [ ] Spin up a single real-video pilot in staging (Silver Springs orientation per EP-TRAIN-4Y-A).

---

## 1. Modal workspace preparation (OPERATOR, local workstation)

Pre-check — Modal SDK version on the operator's workstation:
```
pip show modal
```
Required: `modal >= 0.65.42` (first version documenting `Dict.put(key, value, skip_if_exists=True)`). The replay-registry atomicity depends on this; the Python code refuses to serve traffic with an older SDK.

Create the three workspace secrets (operator pastes locally-generated 32-byte hex; nothing is printed to the terminal history):
```
modal secret create spectre-training-runtime-hmac
modal secret create spectre-training-pilot-fingerprint-secret
modal secret create spectre-training-response-hmac-key    # optional per §Q.5
```

Deploy the two Hybrid-contract Modal apps:
```
modal deploy -m modal_endpoints.transcribe_app
modal deploy -m modal_endpoints.generate_app
```

Immediately stop both apps so no GPU container stays warm:
```
modal app stop spectre-training-transcribe
modal app stop spectre-training-generate
```

Capture both function URLs for Fly secret provisioning. Confirm:
- `modal container list` → 0 rows.
- Modal dashboard spend-limit utilisation unchanged.

**Per founder decision on §2 — 6C-11 retirement:**
- (T) Stop the old generate-lite endpoint: `modal app stop spectre-training-generate-lite`.
- (K) Leave `spectre-training-generate-lite` as-is.

---

## 2. Fly secret provisioning (DRH-1 pathway, worker-only)

Rollback anchor (capture BEFORE setting new secrets):
```
flyctl releases list --app spectre-staging-worker | head -5
# Expected: v334, image sha-e7fbb0b158cd
```

Set the seven secrets on `spectre-staging-worker` ONLY. Operator pipes values from a local file; no secret text appears in shell history.

| Env var | Source |
|---|---|
| `MODAL_KEY` | Modal workspace proxy key |
| `MODAL_SECRET` | Modal workspace proxy secret |
| `MODAL_TRANSCRIBE_URL` | `modal deploy` output (step 1) |
| `MODAL_GENERATE_URL` | `modal deploy` output (step 1) |
| `MODAL_SPECTRE_HMAC_KEY` | Pair of `spectre-training-runtime-hmac` |
| `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` | Pair of `spectre-training-pilot-fingerprint-secret` |
| `MODAL_SPECTRE_RESPONSE_HMAC_KEY` | Pair of `spectre-training-response-hmac-key` (optional per §Q.5) |

Important:
- Do NOT set any of these on `spectre-staging` (the web app). §7 least-privilege: web enqueues; worker calls Modal.
- After `flyctl secrets set ... --stage`, confirm with `flyctl secrets list --app spectre-staging-worker` that all 7 are listed.
- If `MODAL_SPECTRE_SHARED_TOKEN` is present (leftover from 4V/4W experiments), unset it on BOTH apps: `flyctl secrets unset MODAL_SPECTRE_SHARED_TOKEN --app spectre-staging-worker --stage` + same for `spectre-staging`.

---

## 3. DRH-1 staging deploy

1. Push branch to origin (requires founder sign-off per Prerequisite §2).
2. Trigger DRH-1 workflow for branch `ep-train-4y-b-impl/hybrid-auth-contract`.
3. Monitor with the Fly deploy hang policy (5-min no-progress = stalled; MAX 1 retry; second stall = STOP + BLOCKED).
4. Capture new image sha for the next rollback anchor.
5. `/api/health` → 200 on both `spectre-staging` and `spectre-staging-worker`.
6. Log scan: zero `ModalContractError` / `CREDENTIAL_ABSENT` / `REPLAY_STORE_UNAVAILABLE` in the first 5 min after release.

---

## 4. No-inference authentication smoke tests (NO GPU USE)

**Goal:** prove the Spectre→Modal auth envelope works end-to-end without burning GPU seconds.

Smoke sequence (operator-driven via the AI workspace UI):

1. **AuthN probe — unauthenticated** — hit the Modal URL directly from a non-worker machine with no Fly secrets. Expected: Modal proxy returns 401, no GPU activation.
2. **AuthN probe — worker with wrong HMAC** — temporarily set `MODAL_SPECTRE_HMAC_KEY=invalid` on the worker and enqueue a transcription. Expected: Modal returns 400 with `x-spectre-failure-code: REQUEST_HMAC_INVALID`; worker marks the job FAILED non-retryable; no GPU spent.
3. **AuthN probe — expired PilotAuthorizationV1** — temporarily patch `issuePilotAuthorization` to set `expiresAtUtc` to the past. Enqueue. Expected: Modal returns 400 `PILOT_AUTH_EXPIRED`; no GPU spent.
4. **AuthN probe — response-signature verification** — temporarily set `MODAL_SPECTRE_RESPONSE_HMAC_KEY` to a different value on the worker vs the Modal secret. Enqueue. Expected: inference runs (one GPU cold-boot), but client throws `MODAL_HMAC_INVALID` and marks job FAILED.

**IMPORTANT:** #4 does consume one GPU cold-boot (~5-10 seconds of A10). Skip #4 if founder prefers strict zero-GPU smoke; the equivalent is already covered by the offline tests (TS §9.12/§9.14 + Python `test_signed_response_shape`).

After each probe, revert the mis-set secret and confirm the next probe starts from a clean state.

---

## 5. One bounded real-video pilot

Scope (per EP-TRAIN-4Y-A plan):
- **Pilot video:** Silver Springs orientation (course `cmvzs3vz9000256qcu7lfysoz`, SHA `d1dd…ee29`).
- **DO NOT touch** Coulee Ridge ORIENTATION_2027 (different course; previously remediated per 5D-3C-B).
- Single transcription job + single generation run.
- Expected GPU spend: ≤ $0.10 (one Whisper + one Qwen generation).

Execution:

1. Operator navigates to `/app/admin/training/courses/[Silver Springs]` and clicks "Request transcription".
2. Worker claims the job; Modal transcribe endpoint fires (expect `STATE: QUEUED → RUNNING → COMPLETED`).
3. Transcript + segments visible in the AI workspace UI.
4. Operator clicks "Start generation" against the completed build.
5. Worker claims the run; Modal generate endpoint fires.
6. Drafts appear in the Review Queue.

Acceptance:
- Both `STATE: COMPLETED` transitions arrive.
- Transcript + ≥1 draft visible in the UI.
- Modal dashboard shows ≤ 2 container activations, both scaled-to-zero shortly after.
- Workspace spend limit still at $10, utilisation well under 10 %.

---

## 6. Rollback

Trigger conditions (any one):
- Worker logs show unexpected `ModalContractError` codes.
- Modal workspace spend trending toward 50 % without expected traffic.
- Modal container keeps running past expected wall-clock.
- Any `MODAL_HMAC_INVALID` / `PILOT_AUTH_FINGERPRINT_MISMATCH` / `TENANT_MISMATCH` observed in production traffic (must never happen in a legitimate pilot).
- `/api/health` fails on either app.
- Response signatures don't verify in the TS client (indicates key drift).

Actions (abort-safe, independently reversible):

| # | Action |
|---|---|
| 1 | `modal app stop spectre-training-transcribe && modal app stop spectre-training-generate`. Clients fall back to `CREDENTIAL_ABSENT` immediately. |
| 2 | Unset 7 Fly secrets on `spectre-staging-worker` if the issue is secret-related. |
| 3 | DRH-1 rollback `flyctl deploy --image registry.fly.io/spectre-staging-worker:sha-e7fbb0b158cd --app spectre-staging-worker`. |
| 4 | Rotate `spectre-training-runtime-hmac` secret if any key may have been inadvertently shared. |
| 5 | Verify `/api/health` → 200 on both apps. |
| 6 | Verify `modal container list` → 0 rows. |
| 7 | Log rollback cause in an incident scratchpad (NOT committed to this repo). |

Rollback anchor pin:
- Web `spectre-staging` v1098 image `sha-e7fbb0b158cd`.
- Worker `spectre-staging-worker` v334 image `sha-e7fbb0b158cd`.
- Modal workspace $10 USD spend limit + zero deployed Hybrid apps after rollback.

---

## 7. Cleanup

After the one-video pilot is accepted:

1. Operator confirms Modal dashboard shows both apps scaled-to-zero.
2. Review Queue drafts: discard the pilot drafts OR promote them (manager + `hr:training:ai:approve` reviewer workflow).
3. Confirm workspace spend limit is intact at $10.
4. No secrets provisioned on `spectre-staging` (web) — re-run `flyctl secrets list --app spectre-staging` to verify.
5. 126 WIP files on main working tree unchanged.

---

## 8. Spend-limit verification — explicit

The Modal workspace spend limit is set to **$10 USD** via the Modal dashboard. This slice makes NO change to that limit. The operator verifies at every step:

- Before deploy: $10 USD limit, utilisation at prior state.
- After deploy + smoke: $10 USD limit, utilisation ≤ 5 %.
- After real-video pilot: $10 USD limit, utilisation ≤ 15 %.

If the limit changes, that is an INDEPENDENT operator action requiring its own founder authorisation.

---

## 9. STOP boundaries (unchanged from the directive)

This checklist describes future authorised steps. **The 4Y-C slice itself executes none of them.** Per directive §Mandatory STOP:

- No live Modal inference (this slice).
- No GPU activation (this slice).
- No Modal deployment (this slice).
- No Fly secrets changes (this slice).
- No staging or production deployment (this slice).
- No database migration (this slice or any staging step).
- No historical candidate modification.
- No publication or employee assignments.
- No Modal spending-limit changes.
- Preserve all 126 WIP files on the main working tree.

**End of staging activation checklist.**
