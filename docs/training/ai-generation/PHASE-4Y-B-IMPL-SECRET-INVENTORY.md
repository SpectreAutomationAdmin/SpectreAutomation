# EP-TRAIN-4Y-B-IMPL — Secret Inventory

**Status:** OFFLINE INVENTORY (2026-11-07). **No secret values
appear in this document.** Only logical names, locations, and
rotation policy per §D.2 (managed secrets, least-privilege) and
§D.3 (on-demand rotation with overlapping verification).

---

## 1. Fly secrets

### 1.1 Web app (`spectre-staging`) — Hybrid-contract secrets

**None.** Per §7 (least-privilege: avoid placing inference
credentials on the web application if only the worker needs
them). API routes enqueue jobs; the worker calls Modal. The web
app NEVER needs Modal credentials.

If `MODAL_SPECTRE_SHARED_TOKEN` was ever set on the web app
during the EP-TRAIN-6D-4V/4W experiment, it MUST be unset in the
same deploy that lands this slice.

### 1.2 Worker app (`spectre-staging-worker`) — Hybrid-contract secrets

| Logical name | Env var | Purpose | Rotation |
|--------------|---------|---------|----------|
| Modal proxy key | `MODAL_KEY` | Workspace-level proxy auth (ingress to Modal) | On operator demand; `modal workspace token rotate` |
| Modal proxy secret | `MODAL_SECRET` | Workspace-level proxy auth (ingress to Modal) | Same as `MODAL_KEY` (pair) |
| Transcribe URL | `MODAL_TRANSCRIBE_URL` | Deployed function URL | Changes on redeploy; not strictly a secret |
| Generate URL | `MODAL_GENERATE_URL` | Deployed function URL | Changes on redeploy; not strictly a secret |
| Request HMAC key | `MODAL_SPECTRE_HMAC_KEY` | HMAC for request-signing + response-signing (shared when `MODAL_SPECTRE_RESPONSE_HMAC_KEY` unset) | On operator demand; §D.3 overlapping-verification pattern |
| PilotAuth fingerprint secret | `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` | HMAC for `PilotAuthorizationV1.fingerprint` | On operator demand |
| Response HMAC key (optional) | `MODAL_SPECTRE_RESPONSE_HMAC_KEY` | Separate response-signing key (§Q.5 recommended) | On operator demand |

### 1.3 Secret-setting command (operator reference, not run from this slice)

```bash
# OPERATOR REFERENCE. DO NOT run from this slice.
# Values are typed into flyctl directly; never echoed or logged.
flyctl secrets set \
  MODAL_KEY=xxx \
  MODAL_SECRET=xxx \
  MODAL_TRANSCRIBE_URL=https://... \
  MODAL_GENERATE_URL=https://... \
  MODAL_SPECTRE_HMAC_KEY=xxx \
  SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET=xxx \
  MODAL_SPECTRE_RESPONSE_HMAC_KEY=xxx \
  --app spectre-staging-worker --stage
flyctl deploy --app spectre-staging-worker
```

**Do NOT set these secrets on `spectre-staging` (the web app).**

---

## 2. Modal workspace secrets

Created by the operator with `modal secret create ...`. **NOT
provisioned from this slice.**

| Secret name | Contents | Shared with Spectre env |
|-------------|----------|-------------------------|
| `spectre-training-runtime-hmac` | Request- + response-HMAC key (unless response key is separate) | `MODAL_SPECTRE_HMAC_KEY` |
| `spectre-training-pilot-fingerprint-secret` | `PilotAuthorizationV1.fingerprint` HMAC key | `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` |
| `spectre-training-response-hmac-key` (optional) | Separate response-HMAC key | `MODAL_SPECTRE_RESPONSE_HMAC_KEY` |

The Modal workspace proxy auth (`Modal-Key` / `Modal-Secret`) is
workspace-managed and not a per-function secret.

---

## 3. Rotation policy (§D.3)

**On-demand rotation with overlapping verification.** The Modal
function MUST temporarily accept BOTH the old and the new key
during a rotation window. Operator-driven:

1. Create the NEW Modal workspace secret alongside the old
   (e.g. `spectre-training-runtime-hmac-v2`).
2. Redeploy the Modal function configured to try verifying
   with BOTH secrets.
3. Rotate the Fly `MODAL_SPECTRE_HMAC_KEY` to the new value
   (via DRH-1 secret-deploy + worker redeploy).
4. Confirm live traffic passes on the new key (observe worker
   logs for successful calls).
5. Remove the old key from the Modal function.
6. Delete the old Modal workspace secret.

**Automatic per-deploy rotation is NOT done** (§D.3: "Do not
rotate automatically on every deployment"). Rotation is an
operator-initiated action.

---

## 4. Least-privilege summary

| Secret | Ingress point | Scope | Who holds it |
|--------|---------------|-------|--------------|
| `MODAL_KEY` / `MODAL_SECRET` | Modal proxy | Workspace-level | Fly worker + Modal workspace |
| `MODAL_SPECTRE_HMAC_KEY` | Request HMAC | Function-level signing/verifying | Fly worker + Modal function env |
| `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` | Auth envelope fingerprint | Spectre-authorship + Modal verifier | Fly worker (issuer) + Modal function env (verifier) |
| `MODAL_SPECTRE_RESPONSE_HMAC_KEY` | Response HMAC | Function-level signing/verifying | Fly worker + Modal function env |

**Secret-rotation blast radius** (§2.3 of the 4Y-B review):

- Compromise of `MODAL_KEY`+`MODAL_SECRET` alone: attacker can
  hit the Modal proxy but cannot forge a valid request body
  (fingerprint + request-HMAC both block). Low blast radius.
- Compromise of `MODAL_SPECTRE_HMAC_KEY` alone: attacker can
  forge request signatures but cannot forge
  `PilotAuthorizationV1.fingerprint`. Still blocked by fingerprint
  check. Low blast radius.
- Compromise of `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` alone:
  attacker can forge PilotAuthorizationV1 but cannot sign
  requests. Blocked by request-HMAC. Low blast radius.
- Compromise of BOTH `MODAL_SPECTRE_HMAC_KEY` AND
  `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` AND proxy credentials:
  attacker can forge end-to-end. **Defense: separate secrets +
  rotation + least-privilege (secrets only on worker app).**

---

## 5. Credentials NOT in this repo

Verified (grep across the worktree):

- No `.env` files with real values.
- No `.modal.toml` with auth tokens.
- No tokens / HMAC keys / proxy credentials in test fixtures
  (all test fixtures use clearly-synthetic strings like
  `"test-hmac-key-32-bytes-0000000000"`).
- No secret values in any `.md` doc.
- No secret values in any `.py` or `.ts` source file.
- No secret values in `tests/` or `modal/tests/`.

`npm run scan:placeholders` surfaces NO new violations in
`modal-shared/*`, `transcription/*`, `generation/*`, or
`modal/*`. All pre-existing placeholder hits are on the 4Y-A
baseline.

---

## 6. Deployment sequencing (§D.2 managed secrets)

See [PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md](PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md)
for the full runbook. **No secrets are provisioned from the
4Y-B-IMPL slice.** Provisioning is a separately authorised
operator slice that comes AFTER founder review of this
implementation.

**End of secret inventory.**
