# EP-TRAIN-4Y-B-IMPL — Deployment + Rollback Runbook

**Status:** OFFLINE RUNBOOK (2026-11-07). Nothing here executes
from the 4Y-B-IMPL slice.

**Prerequisite for any Step below:** explicit founder authorisation
of the implementation (per directive §12 STOP). The founder
reviews the 4Y-B-IMPL slice first; a subsequent authorised slice
executes this runbook.

---

## 1. Pre-deployment checklist

- [ ] Founder has reviewed 4Y-B-IMPL (this slice).
- [ ] Founder has signed off §D.1-§D.6 + §Q.1-§Q.5 of the 4Y-B
      design review (`docs/training/ai-generation/PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md`).
- [ ] `npx vitest run tests/ep-train-4yb-impl-contract.test.ts` → 29/29 pass locally.
- [ ] `python -m unittest discover -s modal/tests -t . -v` → 23/23 pass locally.
- [ ] `npm run scan:placeholders` → no new hits in `modal-shared/`,
      `transcription/`, `generation/`, `modal/`.
- [ ] `npx tsc --noEmit` on the 4Y-B files → zero errors.
- [ ] Modal workspace spend limit intact at **$10 USD**
      (operator confirms in Modal dashboard).
- [ ] 126 unrelated WIP files preserved on
      `staging-deploy/web1b1-framer-fidelity`.

---

## 2. Deployment sequence

### Step 1 — Modal workspace preparation (OPERATOR only)

1. Create Modal workspace secrets (NOT from this repo):
   ```bash
   # OPERATOR REFERENCE
   modal secret create spectre-training-runtime-hmac --value <generated 32-byte hex>
   modal secret create spectre-training-pilot-fingerprint-secret --value <generated 32-byte hex>
   # Only if §Q.5 chooses separate response-HMAC key:
   modal secret create spectre-training-response-hmac-key --value <generated 32-byte hex>
   ```
2. Deploy the two Modal functions from `modal/` in this repo:
   ```bash
   modal deploy modal/spectre_training_transcribe.py
   modal deploy modal/spectre_training_generate.py
   ```
3. Capture the two function URLs (`modal app list` → copy URLs).
4. **Immediately stop both apps** so no GPU container stays warm:
   ```bash
   modal app stop spectre-training-transcribe
   modal app stop spectre-training-generate
   ```
5. Confirm zero active containers: `modal container list` → 0 rows.
6. Confirm workspace cap unchanged: Modal dashboard → `$10`.

### Step 2 — DRH-1 Fly secrets provisioning

Set the seven Fly secrets on **spectre-staging-worker ONLY**:

```bash
# Rollback anchor (capture BEFORE setting new secrets):
flyctl releases list --app spectre-staging-worker | head -5
# Expected current version: v334, image sha-e7fbb0b158cd

flyctl secrets set \
  MODAL_KEY=xxx \
  MODAL_SECRET=xxx \
  MODAL_TRANSCRIBE_URL=https://... \
  MODAL_GENERATE_URL=https://... \
  MODAL_SPECTRE_HMAC_KEY=xxx \
  SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET=xxx \
  MODAL_SPECTRE_RESPONSE_HMAC_KEY=xxx \
  --app spectre-staging-worker --stage
```

**IMPORTANT**: do NOT also set on `spectre-staging` web app (§7
least-privilege).

### Step 3 — Confirm no `MODAL_SPECTRE_SHARED_TOKEN` leftover

```bash
flyctl secrets list --app spectre-staging-worker | grep MODAL_SPECTRE_SHARED_TOKEN
# If present (from a prior 4V/4W experiment): unset immediately.
flyctl secrets unset MODAL_SPECTRE_SHARED_TOKEN --app spectre-staging-worker --stage
flyctl secrets unset MODAL_SPECTRE_SHARED_TOKEN --app spectre-staging --stage
```

### Step 4 — DRH-1 deploy

The 4Y-B-IMPL branch chain:
- `ep-train-4y-b/auth-contract` (design, `899503a5`)
- `ep-train-4y-b-impl/hybrid-auth-contract` (implementation, this slice)

Deploy via DRH-1:

1. Push the implementation branch to origin (operator decision).
2. Trigger DRH-1 workflow for branch `ep-train-4y-b-impl/hybrid-auth-contract`.
3. DRH-1 builds + deploys `spectre-staging` (web) + `spectre-staging-worker`.
4. Deploy completes with new image sha; capture it for rollback.
5. `/api/health` → 200 verified.

### Step 5 — Smoke verification

**Admin operator action in the 4Y workspace UI** (no developer
script — §12 reaffirmed: "no live Modal invocation" in 4Y-B-IMPL
itself; smoke happens in a subsequent authorised pilot slice, per
PHASE-4Y-A-PILOT-PLAN).

Smoke expectation:
- Click "Request transcription" on a pilot course.
- Response should transition `REQUESTED → QUEUED → RUNNING → COMPLETED`
  (NOT `CREDENTIAL_ABSENT`).
- Transcript + segments visible in UI.
- Click "Start generation".
- Drafts visible in Review Queue.

### Step 6 — Observability checks

- Modal dashboard: both apps show container activity, then
  scale-to-zero after idle.
- Fly worker logs: `queue.handler.training_*` entries with
  `jobId` / `authorizationId` / `elapsedMs`. Zero secret values
  in logs.
- Workspace spend cap utilisation: well under 10% on first
  smoke run.

---

## 3. Rollback

### 3.1 Rollback triggers

Any of:

- Worker logs show unexpected `ModalContractError` codes beyond
  §4 classification table.
- Spend-cap trending toward 50% without expected traffic.
- Modal function container keeps running past expected
  wall-clock.
- Any `MODAL_HMAC_INVALID` / `PILOT_AUTH_FINGERPRINT_MISMATCH` /
  `TENANT_MISMATCH` observed in production traffic (should
  never happen in legitimate pilot).
- Response signatures not verifying (indicates
  client/server key drift).

### 3.2 Rollback actions (in order, abort-safe)

Each step is independently reversible.

| Step | Action |
|------|--------|
| 1 | **Stop Modal apps**: `modal app stop spectre-training-transcribe && modal app stop spectre-training-generate`. Clients fall back to `CREDENTIAL_ABSENT` immediately. |
| 2 | **Unset Fly secrets** (if desired): `flyctl secrets unset MODAL_KEY MODAL_SECRET MODAL_TRANSCRIBE_URL MODAL_GENERATE_URL MODAL_SPECTRE_HMAC_KEY SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET MODAL_SPECTRE_RESPONSE_HMAC_KEY --app spectre-staging-worker`. |
| 3 | **Rollback deploy** (if the Spectre-side implementation is at fault): `flyctl releases list --app spectre-staging-worker` → identify prior version (`v334`, image `sha-e7fbb0b158cd`) → `flyctl deploy --image registry.fly.io/spectre-staging-worker:sha-e7fbb0b158cd --app spectre-staging-worker`. |
| 4 | **Rotate Modal workspace secrets**: `modal secret create spectre-training-runtime-hmac --force --value <new>` (rotate because the key may have been inadvertently logged / shared). |
| 5 | **Verify `/api/health` → 200** on web + worker. |
| 6 | **Verify zero running containers**: `modal container list` → 0 rows. |
| 7 | **Log rollback cause** in an incident scratchpad (NOT committed to this repo). |

### 3.3 Rollback anchor pins

| Role | Pin |
|------|-----|
| Web app | `spectre-staging` v1098 image `sha-e7fbb0b158cd` |
| Worker app | `spectre-staging-worker` v334 image `sha-e7fbb0b158cd` |
| Modal workspace | `$10 USD` spend limit + zero deployed apps after rollback |

Rolling back to the above anchor restores the pre-4Y-B-IMPL
state exactly. All AI-workspace buttons fall back to
`CREDENTIAL_ABSENT` (safe).

---

## 4. Post-deployment acceptance gate

Within 1 hour of deploy:

- [ ] At least one Hybrid-contract Modal call verified via the
      4Y workspace UI (no developer script).
- [ ] Transcript ingested through 4L.
- [ ] Generation proposal surfaced (for a DRAFT course).
- [ ] No `MODAL_SPECTRE_SHARED_TOKEN` in `flyctl secrets list`
      on either app.
- [ ] 7 new Hybrid secrets present on worker app; **0 on web
      app**.
- [ ] 126 unrelated WIP files unchanged.
- [ ] Modal workspace cap intact at `$10`.
- [ ] Rollback drill rehearsed on a disposable staging record.

---

## 5. 6C-11 operator path — RETIRED (EP-TRAIN-4Y-C §2)

**Status change (2026-11-07):** this section's prior claim that the
Hybrid Modal function would accept the 6C-11 legacy envelope was
architecturally incorrect. See
[PHASE-4Y-C-6C11-RETIREMENT-RATIONALE.md](./PHASE-4Y-C-6C11-RETIREMENT-RATIONALE.md)
for the full analysis. Summary:

- The 6C-11 operator script (`generate-lite-run.mjs`) targets a
  DIFFERENT Modal operation (`spectre.training.generate.lite.v1`)
  at a DIFFERENT URL (its own `web_lite` endpoint), NOT
  `spectre.training.generate.v1` served by the new
  `spectre_training_generate.py`. Making one endpoint serve both
  envelopes would require wiring a second operation into it,
  which is more work than simply keeping the two endpoints
  separate.
- The 6C-11 endpoint is operator-only; no tenant or customer
  depends on it. Retiring compatibility on the NEW endpoint has
  no customer impact.

**Retirement plan:**

1. The NEW endpoints (`spectre_training_transcribe` +
   `spectre_training_generate`) REQUIRE `x-spectre-contract-version`.
   Any legacy envelope arriving at these URLs gets rejected with
   `REQUEST_HMAC_INVALID` — safe, closed.
2. Operator may keep the 6C-11 `generate_lite` endpoint running
   independently if the workstation diagnostic is still useful.
   It lives at its own Modal app and consumes its own secrets.
3. On the first Hybrid deploy cutover, the operator SHOULD stop
   the 6C-11 `generate_lite` Modal app to avoid dual-spend. The
   runbook is updated to reflect this.

**Pending founder authorisation:** per EP-TRAIN-4Y-C §2, this
retirement requires founder sign-off before proceeding. See the
final acceptance report for the explicit YES/NO decision.

---

## 7. STOP boundaries (reiterated)

Nothing in this runbook executes from the 4Y-B-IMPL slice. Each
step requires its own authorisation. The 4Y-B-IMPL slice
produces the OFFLINE implementation + tests + docs ONLY.

**End of deploy + rollback runbook.**
