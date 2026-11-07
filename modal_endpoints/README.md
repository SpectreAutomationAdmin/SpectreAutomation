# Spectre Training — Modal Function Reference Implementation

**Status (2026-11-07):** OFFLINE REFERENCE. Not deployed. Not
invoked.

**Scope:** EP-TRAIN-4Y-B-IMPL — the Modal-side half of the Hybrid
authentication contract. This directory is authored for an
operator to review + `modal deploy` in a separately authorised
slice. **No Modal deployment happens from this slice.**

**STOP compliance (§12 of the EP-TRAIN-4Y-B-IMPL directive):**
- No live Modal invocation.
- No GPU activation.
- No Modal deployment.
- No credential materials in this repo (no `.modal.toml`, no
  tokens, no proxy keys).

---

## Files

| File | Purpose |
|------|---------|
| `shared/auth.py` | Request/response HMAC + PilotAuthorizationV1 fingerprint verification. Mirror of `src/lib/hr/training/modal-shared/*.ts`. |
| `shared/replay.py` | In-memory + `modal.Dict`-backed replay registry. Fail-closed on store outage. |
| `shared/errors.py` | Failure-code enum shared across both endpoints. Mirror of `src/lib/hr/training/modal-shared/errors.ts`. |
| `spectre_training_transcribe.py` | `spectre.training.transcribe.v1` endpoint. Downloads signed R2 URL, runs faster-whisper, returns transcript + segments. |
| `spectre_training_generate.py` | `spectre.training.generate.v1` endpoint. Qwen 2.5 7B AWQ inference with LM Format Enforcer. |
| `tests/test_auth.py` | `python -m unittest modal.tests.test_auth`. Server-side verification tests (symmetric to TS `request-signer` and `response-verifier` suites). |
| `tests/test_replay.py` | Replay-registry tests. |

---

## Shared contract — byte-identical to the Spectre TypeScript side

The Python code in `shared/auth.py` MUST stay byte-for-byte compatible
with the TypeScript in `src/lib/hr/training/modal-shared/*.ts`:

- `canonicalise` output is identical: sorted keys, no whitespace,
  `json.dumps(..., separators=(",", ":"), sort_keys=True,
  ensure_ascii=False)` matches.
- HMAC-SHA-256 signed message format:
  `v1.{operation}.{requestId}.{ts}.{sha256HexOfCanonical(body)}`.
- Response signing message format:
  `response-sig-v1.{contractVersion}.{operation}.{requestId}.{httpStatus}.{sha256HexOfCanonical(body)}`.
- PilotAuthorizationV1 fingerprint signs the envelope WITHOUT the
  `fingerprint` field.
- `base64url` encoding without padding on signatures (Python
  `base64.urlsafe_b64encode(sig).rstrip(b"=")`).

---

## Modal workspace secrets (NOT provisioned here)

The function code reads these Modal workspace secrets via
`modal.Secret.from_name(...)`. **Do not create them from this
repo.** Operator provisions them in a separately authorised slice
with `modal secret create`:

- `spectre-training-runtime-hmac` — the request- and response-HMAC
  key. MUST match Spectre Fly secret `MODAL_SPECTRE_HMAC_KEY`.
- `spectre-training-pilot-fingerprint-secret` — the
  `PilotAuthorizationV1.fingerprint` key. MUST match Spectre Fly
  secret `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`.

Optional (§Q.5 separate response key):

- `spectre-training-response-hmac-key` — separate response-signing
  key. MUST match Spectre Fly secret `MODAL_SPECTRE_RESPONSE_HMAC_KEY`.

---

## Deploy (OUT OF SCOPE for this slice)

```
# NOT TO BE RUN FROM THIS SLICE. For operator reference only.
cd modal
modal deploy spectre_training_transcribe.py
modal deploy spectre_training_generate.py
```

A separately authorised slice will execute the deploy after all
§D.1-§D.6 founder decisions and the associated Fly secret
provisioning.

---

## Testing

Pure Python unittests (no Modal runtime needed):

```
python -m unittest discover -s modal/tests -v
```

Requires: Python 3.11+, `base64`, `hmac`, `hashlib`, `json`,
`unittest` — all stdlib. No Modal install required.
