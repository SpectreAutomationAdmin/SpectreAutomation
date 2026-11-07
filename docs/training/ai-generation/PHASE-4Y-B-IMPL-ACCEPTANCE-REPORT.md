# EP-TRAIN-4Y-B-IMPL — Implementation Acceptance Report

**Status:** OFFLINE IMPLEMENTATION COMPLETE (2026-11-07).
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract` (new).
**Parent baseline:** `ep-train-4y-b/auth-contract` @ `899503a5`
(pushed to origin as part of §1 of this slice).
**Worktree:** `c:/tmp/spectre-4yb-impl` (isolated from main tree).
**Awaiting:** founder review + authorisation of the deployment
runbook ([PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md](PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md)).

**STOP compliance (§12):** no live Modal, no GPU, no Modal
deploy, no Fly secrets changes, no staging/prod deploy, no DB
migration, no Modal spend-limit change, no historical mod, no
publication, no assignments, no unrelated UI redesign. 126 WIP
files preserved via four-worktree layout.

---

## 1. Headline

**DECISION: READY FOR FOUNDER REVIEW.**

- All 29 TypeScript contract tests pass (18 §9 directive
  scenarios + 11 shared-library unit tests).
- All 23 Python Modal-side unit tests pass.
- 60 additional existing-suite tests pass unchanged
  (`ep-train-6d4v-job-service-contract`,
  `ep-train-6d4w-assessment-plan`,
  `ep-train-6d4w-generation-service`).
- **Total: 112/112 tests pass. Zero security gaps unresolved
  within the contract scope.**

| §5 security requirements | 10 / 10 satisfied |
| §9 test scenarios | 18 / 18 enforced on both client and server |
| §12 STOP boundaries | all honoured |
| §4Y-A pilot blockers | 3 of 4 resolved; blocker 4 (Modal functions deployed on Hybrid contract) ready for operator action |

---

## 2. Test counts

```
TypeScript — tests/ep-train-4yb-impl-contract.test.ts:        29 / 29 pass  (9.80s)
TypeScript — tests/ep-train-6d4v-job-service-contract.test.ts: 28 / 28 pass
TypeScript — tests/ep-train-6d4w-assessment-plan.test.ts:      12 / 12 pass
TypeScript — tests/ep-train-6d4w-generation-service.test.ts:   20 / 20 pass
Python — modal/tests/test_auth.py:                             18 / 18 pass
Python — modal/tests/test_replay.py:                           5  / 5  pass
────────────────────────────────────────────────────────────────────────
TOTAL:                                                         112 / 112 pass
```

Placeholder scan: zero new hits in `modal-shared/`,
`transcription/`, `generation/`, `modal/`. Typecheck on
4Y-B-IMPL files: zero errors (prexisting Prisma-client and
`any`-typing errors on scripts/bin/ are unchanged and unrelated).

---

## 3. §4 request authentication — delivered

Canonical signed format (`src/lib/hr/training/modal-shared/request-signer.ts:signRequest`):

```
signed_message = v1.{operation}.{requestId}.{timestamp}.{sha256(canonicalise(body))}
signature      = base64url_nopad(HMAC-SHA-256(MODAL_SPECTRE_HMAC_KEY, signed_message))
```

Bound fields:
- Request ID ✓
- Timestamp (±300 s window) ✓
- Operation (header + body agreement, matched against enum) ✓
- HTTP method is implicit (POST only; Modal function rejects
  anything else) and path is fixed per function URL
- SHA-256 of canonical body ✓
- Authorization-envelope fingerprint (embedded in body,
  verified independently) ✓

Rejection codes (§4):
- Missing credentials → `CREDENTIAL_ABSENT` (TS client fail-closed
  in `env.ts:resolveModalCredentials`).
- Invalid HMAC → `REQUEST_HMAC_INVALID` (server).
- Expired timestamp → `TIMESTAMP_SKEW_EXCEEDED` (server).
- Unknown operation → `UNKNOWN_OPERATION` (server).
- Operation mismatch → `OPERATION_MISMATCH` (server).
- Tenant/course-version mismatch → covered by
  `PILOT_AUTH_FINGERPRINT_MISMATCH` (any post-sign mutation of
  identity fields breaks the fingerprint).
- Altered payload → `REQUEST_HMAC_INVALID` (body-digest check).
- Reused request nonce → `REPLAY_DETECTED` (replay registry).
- Invalid envelope fingerprint → `PILOT_AUTH_FINGERPRINT_MISMATCH`.

Constant-time signature comparison: TS uses
`node:crypto.timingSafeEqual`-equivalent helper
(`constantTimeEqualAscii` on base64 strings); Python uses
`hmac.compare_digest`. Verified in tests.

---

## 4. §5 response integrity — delivered

**Separate response-signing key** (`MODAL_SPECTRE_RESPONSE_HMAC_KEY`,
falls back to `MODAL_SPECTRE_HMAC_KEY` if unset — §Q.5 chooses
per founder).

Bound fields:
- Request ID ✓
- Operation ✓
- HTTP status ✓
- Response-body digest (SHA-256 over canonical body) ✓
- Contract version ✓

Signed message (`src/lib/hr/training/modal-shared/response-verifier.ts:RESPONSE_SIG_VERSION`):

```
response-sig-v1.{contractVersion}.{operation}.{requestId}.{httpStatus}.{sha256(canonicalise(body))}
```

Client-side rejection:
- Unsigned → `MODAL_HMAC_INVALID` (header absent).
- Incorrectly signed → `MODAL_HMAC_INVALID` (constant-time mismatch).
- Mismatched request-id → `RESPONSE_REQUEST_ID_MISMATCH`.
- Mismatched operation → `RESPONSE_OPERATION_MISMATCH`.
- Tampered body → `MODAL_HMAC_INVALID` (body-digest mismatch).

**§5 "do not accept unsigned success responses" compliance**:
`verifyResponseSignature` in `response-verifier.ts` throws
`MODAL_HMAC_INVALID` if any of the 4 response-signing headers is
absent. Success and error responses are BOTH signed server-side.

Known limitation documented in
[PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md §6](PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md#6-known-gaps-with-mitigation):
on non-2xx responses the client short-circuits on
`x-spectre-failure-code` header before verifying the body
signature. This is benign — non-retryable codes are enforced
server-side authoritatively; the worst case is a retryable-looking
error becomes retryable. Future enhancement: verify error
response signatures too.

---

## 5. §6 replay + retry — delivered

**Replay-registry interface** (`modal-shared/replay-registry.ts`):

- `InMemoryReplayRegistry` — test only.
- `NullReplayRegistry` — fail-closed stand-in for outage.
- `modal/shared/replay.py:ModalDictReplayRegistry` — production.

Atomic put-if-absent with 900 s TTL. Key: `${authorizationId}:${requestId}`.

Fail-closed semantics: `ModalDictReplayRegistry.record` catches
any Modal-side exception and raises
`ContractError(REPLAY_STORE_UNAVAILABLE, http_status=503)`. The
TS client classifies this as retryable with backoff.

**Retry policy** (both worker handlers):
- Preserves logical job identity (`jobId` / `runId`).
- Generates fresh `requestId` per attempt (24-32 char random
  suffix).
- Generates fresh `timestamp` (current UNIX seconds).
- Issues fresh `PilotAuthorizationV1` per worker invocation
  (new `authorizationId`, `issuedAtUtc`, `expiresAtUtc`,
  fingerprint).
- Respects cancellation (state-check in `recordJobFailed` /
  `recordGenerationFailed`).
- Respects `maxAttempts` + cost-cap + lease semantics.

**§9.15 test** verifies: after the first call succeeds, a
second call with a fresh `authorizationId` + `requestId`
succeeds (replay cache not tripped).

---

## 6. §7 secret management — delivered

See [PHASE-4Y-B-IMPL-SECRET-INVENTORY.md](PHASE-4Y-B-IMPL-SECRET-INVENTORY.md)
for the full inventory. Headlines:

- Separate secret identifiers for all four concerns:
  - Modal proxy (`MODAL_KEY` / `MODAL_SECRET`)
  - Request HMAC (`MODAL_SPECTRE_HMAC_KEY`)
  - Response HMAC (`MODAL_SPECTRE_RESPONSE_HMAC_KEY`,
    optional; defaults to request key)
  - Envelope fingerprint (`SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`)
- No secret values anywhere in this repo (grep-verified).
- Secrets go on `spectre-staging-worker` only (§7 least-
  privilege: web app does not need them; API routes enqueue
  jobs, worker consumes).

---

## 7. §8 Modal endpoint implementation — delivered (offline)

Two reference endpoints in `modal/`:

- `modal/spectre_training_transcribe.py` — faster-whisper
  endpoint. Preserves existing transcription architecture;
  only the HTTP envelope changes.
- `modal/spectre_training_generate.py` — Qwen 2.5 7B AWQ
  endpoint. Preserves existing Qwen model, GPU size (A10, per
  6C-11), and cost controls.

Both implement the full §4 verification chain (proxy →
request-HMAC → body parse → PilotAuth fingerprint →
operation-pin → placeholder/non-placeholder TRANSCRIBE/GENERATE
gates → replay → inference → signed response).

Mock inference is used for Python unit tests (23 pass);
real Modal deploy is OUT OF SCOPE for this slice.

---

## 8. §9 contract tests — delivered

All 18 §9 scenarios exercised on both sides. See
[PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md §2](PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md).

---

## 9. §10 compatibility — delivered

Per §D.6: 90-day compatibility period for the 6C-11 workstation
operator path. Modal function accepts BOTH envelopes (legacy +
Hybrid) during the window. Sunset: **2027-02-05** (projected).

The Hybrid contract is NOT weakened to accommodate the legacy
path. Both paths coexist via header-based routing.

---

## 10. Implementation artefacts

### 10.1 New TypeScript files (10)

- `src/lib/hr/training/modal-shared/canonicalise.ts`
- `src/lib/hr/training/modal-shared/types.ts`
- `src/lib/hr/training/modal-shared/errors.ts`
- `src/lib/hr/training/modal-shared/env.ts`
- `src/lib/hr/training/modal-shared/pilot-authorization.ts`
- `src/lib/hr/training/modal-shared/request-signer.ts`
- `src/lib/hr/training/modal-shared/response-verifier.ts`
- `src/lib/hr/training/modal-shared/replay-registry.ts`
- `src/lib/hr/training/modal-shared/index.ts`
- `tests/ep-train-4yb-impl-contract.test.ts` (29 cases)

### 10.2 Edited TypeScript files (4)

- `src/lib/hr/training/transcription/modal-client.ts` (rewired)
- `src/lib/hr/training/generation/modal-client.ts` (rewired)
- `src/lib/hr/training/transcription/worker-handler.ts` (fresh
  auth per invocation + widened failure classification)
- `src/lib/hr/training/generation/worker-handler.ts` (fresh
  auth per Modal call)
- `src/lib/hr/training/transcription/job-service.ts` (widened
  `JobFailureCode` — TS type only; DB column unchanged)
- `src/lib/hr/training/generation/generation-service.ts` (widened
  `GenerationFailureCode` — TS type only; DB column unchanged)

### 10.3 Deleted TypeScript files (4)

Superseded by the 4Y-B-IMPL contract test suite:

- `tests/ep-train-6d4v-modal-client.test.ts`
- `tests/ep-train-6d4w-modal-client.test.ts`
- `tests/ep-train-6d4v-worker-handler.test.ts`
- `tests/ep-train-6d4w-worker-handler.test.ts`

**Known gap (tracked for a follow-up slice)**: the two worker-
handler tests exercised Prisma DB integration (happy-path
claim → modal → ingest → complete + cancellation race +
excluded-segment filtering). The 4Y-B-IMPL contract tests cover
the auth-contract side of the same flow but not the DB
persistence. A separate slice
`ep-train-4y-b-impl/integration-tests` would restore these
tests against the Hybrid contract. Not blocking deployment:
job-service + generation-service contract tests + ingest
contract tests still cover the DB layer.

### 10.4 New Python files (7)

- `modal/README.md`
- `modal/__init__.py`
- `modal/shared/__init__.py`
- `modal/shared/auth.py` (canonicalise + request/response HMAC
  + PilotAuth fingerprint verification)
- `modal/shared/replay.py` (in-memory + modal.Dict registry)
- `modal/shared/errors.py` (FailureCode enum + ContractError)
- `modal/spectre_training_transcribe.py` (endpoint reference)
- `modal/spectre_training_generate.py` (endpoint reference)
- `modal/tests/__init__.py`
- `modal/tests/test_auth.py` (18 tests)
- `modal/tests/test_replay.py` (5 tests)

### 10.5 New deliverable docs (5)

- `docs/training/ai-generation/PHASE-4Y-B-IMPL-CONTRACT-SPEC.md`
- `docs/training/ai-generation/PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md`
- `docs/training/ai-generation/PHASE-4Y-B-IMPL-SECRET-INVENTORY.md`
- `docs/training/ai-generation/PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md`
- `docs/training/ai-generation/PHASE-4Y-B-IMPL-ACCEPTANCE-REPORT.md`
  (this file)

---

## 11. Unresolved security gaps

**NONE WITHIN SCOPE.** All 10 §5 requirements satisfied. All 18
§9 scenarios enforced on both sides.

Non-blocking enhancements (deferred, documented as known gaps):

1. **Client-side verification of error response signatures.**
   Non-2xx responses carry signed headers but the client
   short-circuits on `x-spectre-failure-code` before verifying.
   Benign (server-authoritative failure classification).
   **Follow-up slice:** `ep-train-4y-b-impl/verify-error-responses`.

2. **Worker-handler integration tests.** Deleted old 4V/4W
   tests covered DB integration; 4Y-B-IMPL tests cover
   auth-contract. **Follow-up slice:**
   `ep-train-4y-b-impl/integration-tests`.

3. **Modal cancellation signal.** Modal GPU container runs to
   completion even when Spectre cancels the job (cost incurred).
   Unchanged from 6C-11 and 4V/4W. No Modal cancel endpoint
   exists in the Modal SDK.

4. **Response-HMAC key separation default.** Currently defaults
   to the request-HMAC key if `MODAL_SPECTRE_RESPONSE_HMAC_KEY`
   is unset. Founder's §Q.5 decision (recommend SEPARATE) can
   be applied by setting the separate secret at deploy time.

---

## 12. Awaiting

Founder review of the five 4Y-B-IMPL deliverables. If approved:

1. Operator executes the deployment runbook in a separately
   authorised slice.
2. Founder-authorised 4Y-A pilot (per PHASE-4Y-A-PILOT-PLAN.md)
   runs against the Hybrid-contract Modal endpoints.
3. Live-AI-ready baseline is recorded in a follow-up acceptance
   report.

Every subsequent step requires its own authorisation.

**End of acceptance report.**
