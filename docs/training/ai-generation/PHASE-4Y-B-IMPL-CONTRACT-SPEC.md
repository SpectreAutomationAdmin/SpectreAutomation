# EP-TRAIN-4Y-B-IMPL — Versioned Authentication Contract Specification

**Status:** OFFLINE IMPLEMENTATION (2026-11-07). Contract version
`4yb-v1` both sides.
**Scope:** directive §4 (request auth), §5 (response integrity),
§6 (replay), §7 (secrets).

**Companion docs:**
- [PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md](PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md)
- [PHASE-4Y-B-IMPL-SECRET-INVENTORY.md](PHASE-4Y-B-IMPL-SECRET-INVENTORY.md)
- [PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md](PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md)
- [PHASE-4Y-B-IMPL-ACCEPTANCE-REPORT.md](PHASE-4Y-B-IMPL-ACCEPTANCE-REPORT.md)

---

## 1. Contract constants (both sides agree)

| Constant | Value | Source |
|----------|-------|--------|
| `CONTRACT_VERSION` | `"4yb-v1"` | TS: `src/lib/hr/training/modal-shared/types.ts`; PY: `modal/shared/auth.py` |
| `SIG_VERSION` (request) | `"v1"` | both |
| `RESPONSE_SIG_VERSION` | `"response-sig-v1"` | both |
| `OPERATION_TRANSCRIBE` | `"spectre.training.transcribe.v1"` | both |
| `OPERATION_GENERATE` | `"spectre.training.generate.v1"` | both |
| Timestamp skew (seconds) | `±300` | both |
| PilotAuthorizationV1 max TTL (seconds) | `3600` | both |
| Replay-window TTL (seconds) | `900` (2× skew + buffer) | both |
| Signed R2 URL TTL (seconds) | `600` | worker handler |
| Request client timeout (ms) | `600,000` (10 min) | TS clients |
| `TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID` | `"0" × 64` | both |
| `TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA` | `"0" × 64` | both |

---

## 2. Request format

### 2.1 HTTP transport

- Method: `POST`
- Scheme: `HTTPS`
- URL: Modal function URL (one per operation).

### 2.2 Headers (all required)

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `Modal-Key` | Modal workspace proxy key (secret: `MODAL_KEY`) |
| `Modal-Secret` | Modal workspace proxy secret (secret: `MODAL_SECRET`) |
| `x-spectre-sig-version` | `v1` |
| `x-spectre-operation` | `spectre.training.transcribe.v1` OR `spectre.training.generate.v1` |
| `x-spectre-request-id` | Printable-ASCII unique identifier (e.g. `t-<jobId>-<32-hex>`, `g-<runId>-<groupId>-<24-hex>`) |
| `x-spectre-timestamp` | UNIX seconds, decimal string |
| `x-spectre-body-digest` | `sha256(canonicalise(body))` as lowercase hex (64 chars) |
| `x-spectre-signature` | `base64url_nopad(HMAC-SHA-256(MODAL_SPECTRE_HMAC_KEY, "v1." + operation + "." + request_id + "." + timestamp + "." + body_digest))` |
| `x-spectre-contract-version` | `4yb-v1` |

### 2.3 Canonical body

```jsonc
{
  "contractVersion": "4yb-v1",
  "operation": "spectre.training.transcribe.v1",       // or generate
  "requestId":   "<x-spectre-request-id value>",
  "timestamp":   "<x-spectre-timestamp value>",
  "pilotAuthorization": { /* PilotAuthorizationV1 */ },
  "payload":    { /* operation-specific */ }
}
```

**Canonicalisation**: sorted object keys, no whitespace,
`JSON.stringify` primitives, arrays preserve order,
non-finite numbers rejected. TypeScript:
`src/lib/hr/training/modal-shared/canonicalise.ts`. Python:
`modal/shared/auth.py#canonicalise`.

### 2.4 Operation payloads

**Transcribe** (`src/lib/hr/training/modal-shared/types.ts`
`TranscribePayload`):

```jsonc
{
  "audioUrl":     "<signed R2 URL, ≤ 600 s TTL>",
  "languageCode": "en",
  "modelVariant": "faster-whisper-large-v3"
}
```

**Generate** (`src/lib/hr/training/modal-shared/types.ts`
`GeneratePayload`):

```jsonc
{
  "modelVariant":  "qwen-2.5-7b-instruct-awq",
  "systemPrompt":  "<string>",
  "transcript":    "<numbered segment text>",
  "constraints": {
    "proposalKind":          "QUESTION_CHECKPOINT_BOUND" | "QUESTION_FINAL_ASSESSMENT",
    "maxQuestions":          <int ≤ pilotAuthorization.maxRequestedQuestions>,
    "allowedQuestionTypes":  ["SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE", ...],
    "jsonSchema":            <object (grammar hint)>
  }
}
```

### 2.5 `PilotAuthorizationV1` envelope

```jsonc
{
  "schemaVersion":                        "pilot-generation-authorization-v1",
  "authorizationId":                      "<ASCII, unique per issuance>",
  "tenantId":                             "<ASCII>",
  "courseId":                             "<ASCII>",
  "versionId":                            "<ASCII>",
  "sourceVideoSha256":                    "<64-char lower-case hex>",
  "resolvedTranscriptBuildId":            "<64-char lower-case hex OR 0×64 for TRANSCRIBE>",
  "approvedGroundingProjectionSha256":    "<64-char lower-case hex OR 0×64 for TRANSCRIBE>",
  "operation":                            "TRANSCRIBE_VIDEO" | "GENERATE_DRAFT_QUESTIONS",
  "maxRequestedQuestions":                <positive integer>,
  "pilotRestrictions": {
    "publicationProhibited":           <bool>,
    "employeeAssignmentProhibited":    <bool>,
    "databaseWritesProhibited":        <bool>,
    "automaticRetriesProhibited":      <bool>,
    "excludedSegmentIds":              [<int>, ...],
    "scope":                           "<ASCII>"
  },
  "issuedAtUtc":  "<ISO-8601 UTC>",
  "expiresAtUtc": "<ISO-8601 UTC, ≤ issuedAtUtc + 3600 s>",
  "issuedBy":     "<ASCII identity>",
  "fingerprint":  "<base64url_nopad(HMAC-SHA-256(FINGERPRINT_SECRET, canonicalise(body-without-fingerprint)))>"
}
```

**ASCII-only fields** (per 6C-11 §4.2 em-dash lesson):
`authorizationId`, `tenantId`, `courseId`, `versionId`,
`sourceVideoSha256`, `resolvedTranscriptBuildId`,
`approvedGroundingProjectionSha256`, `operation`,
`pilotRestrictions.scope`, `issuedBy`. User content
(`questionText`, `transcript`, etc.) is Unicode-safe.

### 2.6 Server-side verification steps

Each in order. First failure returns a SIGNED error response with
`x-spectre-failure-code` header.

1. Proxy auth (workspace) — Modal infrastructure.
2. `verify_request_signature` (TS: `request-signer.ts`
   `verifyRequestSignature`; PY: `auth.py`
   `verify_request_signature`):
   - All required headers present.
   - `sig-version == "v1"`.
   - `contract-version == "4yb-v1"`.
   - Operation is known.
   - `|now − timestamp| ≤ 300 s`.
   - `sha256(body_text) == body_digest`.
   - `timingSafeEqual(expected_sig, sent_sig)`.
3. Parse body as JSON; reject if not object.
4. Body-level operation/requestId/timestamp/contractVersion
   agreement with headers.
5. Parse `PilotAuthorizationV1` shape (TS:
   `pilot-authorization.ts` `verifyPilotAuthorizationFingerprint`
   + fields; PY: `auth.py` `parse_pilot_authorization` +
   `verify_pilot_authorization`):
   - Schema version.
   - ASCII guard on identity fields.
   - Operation pin matches endpoint.
   - Hex regex on SHA fields.
   - `maxRequestedQuestions` positive integer.
   - TRANSCRIBE requires placeholder sentinels; GENERATE rejects
     them.
   - `now < expiresAtUtc`.
   - `timingSafeEqual(expected_fingerprint, sent_fingerprint)`.
6. Replay registry: atomic `record(key, ttl=900 s)`. Fail-closed
   on backing-store outage → `REPLAY_STORE_UNAVAILABLE`.
7. Operation-specific payload gates (e.g. for GENERATE: refuse
   if `payload.constraints.maxQuestions > auth.maxRequestedQuestions`).
8. Dispatch to inference. On inference failure: signed error
   response.

---

## 3. Response format

### 3.1 Success response

HTTP 200. Body is JSON. Headers include response-signing set:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `x-spectre-response-signature` | `base64url_nopad(HMAC-SHA-256(MODAL_SPECTRE_RESPONSE_HMAC_KEY, "response-sig-v1." + contractVersion + "." + operation + "." + requestId + "." + httpStatus + "." + body_digest))` |
| `x-spectre-response-operation` | Mirror of request operation |
| `x-spectre-response-request-id` | Mirror of request-id |
| `x-spectre-contract-version` | `4yb-v1` |

**body_digest** = `sha256(canonicalise(response_body))`.

### 3.2 Transcribe response body

```jsonc
{
  "contractVersion": "4yb-v1",
  "operation":       "spectre.training.transcribe.v1",
  "requestId":       "<mirror>",
  "modelVariant":    "faster-whisper-large-v3",
  "durationSec":     <int>,
  "audioSha256":     "<64-char hex>",
  "segments": [
    { "id": <int>, "startSec": <num>, "endSec": <num>, "text": "<str>", "avgConfidence": <num>},
    ...
  ],
  "elapsedMs": { "coldBoot": <int>, "transcribe": <int> }
}
```

### 3.3 Generate response body

```jsonc
{
  "contractVersion": "4yb-v1",
  "operation":       "spectre.training.generate.v1",
  "requestId":       "<mirror>",
  "modelVariant":    "qwen-2.5-7b-instruct-awq",
  "proposals": [
    {
      "questionType":       "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE",
      "questionText":       "<str>",
      "options":            [ { "text": "<str>", "isCorrect": <bool> }, ... ],
      "explanation":        "<str>",
      "sourceSegmentIds":   [ <int>, ... ]
    },
    ...
  ],
  "elapsedMs":   { "coldBoot": <int>, "generate": <int> },
  "tokenCounts": { "prompt": <int>, "output": <int> }
}
```

### 3.4 Error response

HTTP 4xx or 5xx. SIGNED (same response-signing headers as
success). Additional header:

| Header | Value |
|--------|-------|
| `x-spectre-failure-code` | One of the `FailureCode` enum values |

Body:

```jsonc
{
  "contractVersion": "4yb-v1",
  "operation":       "<mirror>",
  "requestId":       "<mirror OR 'unknown' if couldn't parse>",
  "error": { "code": "<FailureCode>", "message": "<safe diagnostic>" }
}
```

**§5 invariant**: there is NO unsigned success response. Every
non-2xx is still signed under the response-HMAC pattern. Clients
reject unsigned success. Clients also reject unsigned errors on
the same code path (§5: "do not accept unsigned success
responses").

---

## 4. Failure-code taxonomy

Mirrored across both sides (TS:
`src/lib/hr/training/modal-shared/errors.ts`; PY:
`modal/shared/errors.py`).

| Code | Side | HTTP | Retryable (worker) |
|------|------|:----:|:------------------:|
| `CREDENTIAL_ABSENT` | client | — | NO |
| `MODAL_HTTP_ERROR` | client | — | YES (idempotent retries) |
| `MODAL_TIMEOUT` | client | — | YES |
| `REQUEST_HMAC_INVALID` | server | 400 | NO |
| `REQUEST_BODY_INVALID` | server | 400 | NO |
| `TIMESTAMP_SKEW_EXCEEDED` | server | 400 | YES (clock drift) |
| `UNKNOWN_OPERATION` | server | 400 | NO |
| `OPERATION_MISMATCH` | server | 400 | NO |
| `CONTRACT_VERSION_MISMATCH` | server | 400 | NO |
| `ASCII_SCOPE_REQUIRED` | server | 400 | NO |
| `PILOT_AUTH_FINGERPRINT_MISMATCH` | server | 400 | NO |
| `PILOT_AUTH_EXPIRED` | server | 400 | YES (fresh auth) |
| `PILOT_AUTH_OPERATION_MISMATCH` | server | 400 | NO |
| `PILOT_AUTH_SCHEMA_MISMATCH` | server | 400 | NO |
| `TENANT_MISMATCH` | server | 400 | NO |
| `COURSE_VERSION_MISMATCH` | server | 400 | NO |
| `VIDEO_SHA_MISMATCH_AT_BOUNDARY` | server | 400 | NO |
| `REPLAY_DETECTED` | server | 409 | YES (fresh request-id + auth) |
| `REPLAY_STORE_UNAVAILABLE` | server | 503 | YES (backoff) |
| `MODAL_HMAC_INVALID` | client (response) | — | NO |
| `MODAL_BODY_INVALID` | client | — | NO |
| `RESPONSE_REQUEST_ID_MISMATCH` | client | — | NO |
| `RESPONSE_OPERATION_MISMATCH` | client | — | NO |

Classification sources:
- TS: `src/lib/hr/training/modal-shared/errors.ts` `NON_RETRYABLE_CODES`
  + `isRetryable()`.
- Worker handlers: inline `NON_RETRYABLE` sets (same values).

---

## 5. Replay registry (§6)

### 5.1 Semantics

- Key: `${authorizationId}:${requestId}`.
- TTL: `900` seconds (configurable in impl, default declared in
  `types.ts`).
- Put-if-absent is **atomic**. Read-then-write is NOT acceptable.
- Backing-store outage → `REPLAY_STORE_UNAVAILABLE` (fail-closed).

### 5.2 Implementations

| Impl | Location | Purpose |
|------|----------|---------|
| `InMemoryReplayRegistry` | TS: `replay-registry.ts`; PY: `replay.py` | Tests only. Not durable, not distributed. |
| `NullReplayRegistry` | TS: `replay-registry.ts` | Stand-in for "store is down" — every `record()` returns `unavailable`. |
| `ModalDictReplayRegistry` | PY: `replay.py` | Production. Uses `modal.Dict` put-if-absent semantics. Fails closed on any Modal-side exception. |

### 5.3 Retry policy (§6 — retry semantics)

Retries MUST:
- Preserve logical job identity (`TrainingTranscriptionJob.id`
  / `TrainingQuestionAiGenerationRun.id`).
- Generate a **fresh** `requestId` (new 24-32 char random suffix).
- Generate a **fresh** `timestamp` (current UNIX seconds at
  retry time).
- Issue a **fresh** `PilotAuthorizationV1` (new
  `authorizationId` + `issuedAtUtc` + `expiresAtUtc` +
  recomputed fingerprint). This is implemented by calling
  `issuePilotAuthorization(...)` once per worker invocation —
  queue-level retries re-enter the handler and emit a new auth
  automatically.
- Respect job cancellation (handler drops the Modal response if
  the row state is CANCELLED under the current lease).
- Respect existing `maxAttempts` + cost-cap + lease semantics
  (unchanged from EP-TRAIN-6D-4V/4W).

---

## 6. Secret management (§7) — identifiers only

Secret VALUES are never checked into this repo. This section
names the IDENTIFIERS and their expected locations. See
[PHASE-4Y-B-IMPL-SECRET-INVENTORY.md](PHASE-4Y-B-IMPL-SECRET-INVENTORY.md)
for the full inventory.

| Logical name | Fly location | Modal location | Shared? |
|--------------|--------------|----------------|---------|
| Modal proxy key | `spectre-staging-worker` (`MODAL_KEY`) | Modal workspace proxy ingress | Workspace-managed |
| Modal proxy secret | `spectre-staging-worker` (`MODAL_SECRET`) | Modal workspace proxy ingress | Workspace-managed |
| Transcribe URL | `spectre-staging-worker` (`MODAL_TRANSCRIBE_URL`) | Modal function URL | Non-secret (URL only) |
| Generate URL | `spectre-staging-worker` (`MODAL_GENERATE_URL`) | Modal function URL | Non-secret (URL only) |
| Request HMAC key | `spectre-staging-worker` (`MODAL_SPECTRE_HMAC_KEY`) | Modal secret `spectre-training-runtime-hmac` | YES — identical bytes |
| PilotAuth fingerprint secret | `spectre-staging-worker` (`SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`) | Modal secret `spectre-training-pilot-fingerprint-secret` | YES |
| Response HMAC key (optional separate; else reuses request HMAC key) | `spectre-staging-worker` (`MODAL_SPECTRE_RESPONSE_HMAC_KEY`) | Modal secret `spectre-training-response-hmac-key` | YES |

**§7 least-privilege: inference credentials go on the WORKER app only.**
The web app does NOT need them — API routes enqueue jobs; the
worker consumes jobs and calls Modal. This is enforceable by
putting the secrets only on `spectre-staging-worker`.

---

## 7. Backward-compatibility — 6C-11 workstation path

Per §D.6 (90-day compatibility): the 6C-11 operator script
(`scripts/spectre-sec-1/invoke-modal-runner.ps1` +
`scratchpad/ep-train-6b/gen/generate-lite-run.mjs`) continues to
work against the deployed Modal function as long as the function
accepts BOTH envelopes. This is straightforward because:

- The 6C-11 envelope and the 4Y-B-IMPL envelope use the SAME:
  - Canonicalisation.
  - Request-HMAC algorithm (over `v1.{operation}.{requestId}.{ts}.{body_digest}`).
  - `Modal-Key` / `Modal-Secret` proxy headers.
  - `PilotAuthorizationV1` shape (with the operation widening
    from 4Y-B).
- The 4Y-B-IMPL envelope ADDS:
  - `contract-version` header + body field.
  - `response-signing` headers on the response.
  - Replay registry.

The 4Y-B-IMPL Modal function MUST:
- Accept requests WITHOUT `x-spectre-contract-version` header as
  the legacy 6C-11 envelope (contract version = "legacy-6c11")
  AND return UNSIGNED legacy responses to those callers.
- Accept requests WITH `x-spectre-contract-version=4yb-v1` as
  the Hybrid envelope and return SIGNED responses.

The compatibility mode sunsets at `2027-02-05` (90 days after
accepted deployment, pinned in the acceptance report). After
sunset, `x-spectre-contract-version` becomes required.

**The 4Y-B-IMPL contract MUST NOT be weakened to accommodate the
legacy path.** The two paths coexist via header-based routing
at the Modal function; neither side relaxes its own guarantees.

---

## 8. File inventory

**Spectre side (TypeScript):**

| File | Role |
|------|------|
| `src/lib/hr/training/modal-shared/canonicalise.ts` | Canonical JSON + ASCII guard |
| `src/lib/hr/training/modal-shared/types.ts` | Constants, types, operation ids |
| `src/lib/hr/training/modal-shared/errors.ts` | `ModalContractError` + classification |
| `src/lib/hr/training/modal-shared/env.ts` | Fail-closed env reader |
| `src/lib/hr/training/modal-shared/pilot-authorization.ts` | PilotAuthorizationV1 issuer + verifier |
| `src/lib/hr/training/modal-shared/request-signer.ts` | Request HMAC signer + verifier |
| `src/lib/hr/training/modal-shared/response-verifier.ts` | Response HMAC verifier + signer |
| `src/lib/hr/training/modal-shared/replay-registry.ts` | Interface + in-memory + null impl |
| `src/lib/hr/training/modal-shared/index.ts` | Barrel |
| `src/lib/hr/training/transcription/modal-client.ts` | Rewired for Hybrid contract |
| `src/lib/hr/training/generation/modal-client.ts` | Rewired for Hybrid contract |
| `src/lib/hr/training/transcription/worker-handler.ts` | Issues fresh auth per invocation |
| `src/lib/hr/training/generation/worker-handler.ts` | Issues fresh auth per Modal call |
| `src/lib/hr/training/transcription/job-service.ts` | `JobFailureCode` widened |
| `src/lib/hr/training/generation/generation-service.ts` | `GenerationFailureCode` widened |
| `tests/ep-train-4yb-impl-contract.test.ts` | 29 Vitest cases, incl. 18 §9 scenarios |

**Modal side (Python, offline reference):**

| File | Role |
|------|------|
| `modal/shared/auth.py` | Request/response HMAC + PilotAuth verification |
| `modal/shared/replay.py` | Replay-registry interface + in-memory + modal.Dict |
| `modal/shared/errors.py` | `FailureCode` enum + `ContractError` |
| `modal/spectre_training_transcribe.py` | Transcribe endpoint |
| `modal/spectre_training_generate.py` | Generate endpoint |
| `modal/tests/test_auth.py` | 18 Python unittests |
| `modal/tests/test_replay.py` | 5 replay-registry unittests |
| `modal/README.md` | Operator deployment guide |

**End of contract spec.**
