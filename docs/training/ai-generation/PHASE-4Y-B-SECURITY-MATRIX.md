# EP-TRAIN-4Y-B — Security Matrix

**Status:** READ-ONLY analysis (2026-11-07). Companion to
[PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md](PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md).

**Scope:** directive §5 (ten security requirements) and §6
(twelve test scenarios). Each requirement is evaluated across
the three options, with specific attack-model framing and
concrete enforcement mechanisms.

---

## 1. Attack model (what we're defending against)

The pipeline sits on this trust path:

```
Admin operator session (browser, authenticated)
  → Spectre Next.js API (Fly web, trusted)
  → Spectre queue (Postgres, trusted)
  → Spectre worker (Fly worker, trusted)
  → HTTPS over public internet (UNTRUSTED)
  → Modal workspace (vendor, semi-trusted — may be compromised)
  → GPU inference (semi-trusted)
  → HTTPS back (UNTRUSTED)
  → Spectre worker
  → 4L / 4W persistence (Postgres, trusted)
```

The authentication contract must defend against:

- **M1 (passive adversary)** reading requests / responses in
  transit. *TLS handles this; no auth-level concern.*
- **M2 (active adversary)** in transit — splicing, tampering
  with body, swapping responses. **Must be caught by HMAC.**
- **M3 (replay adversary)** — recording a legitimate request
  and re-sending it later. **Must be caught by timestamp +
  nonce + auth TTL.**
- **M4 (confused-deputy Modal)** — Modal function compromised
  or misconfigured so it processes requests for tenant X with
  data for tenant Y. **Must be caught by tenant binding
  verified at the Modal boundary.**
- **M5 (compromised Modal workspace secret)** — attacker who
  reads `MODAL_SPECTRE_SHARED_TOKEN` / Modal-Key / Modal-Secret
  from disk or logs. **Rotation + least-privilege + separate
  secrets for separate concerns.**
- **M6 (compromised Spectre worker)** — attacker with Fly
  worker shell access. All Fly secrets readable. **Can't fully
  defend; limit blast radius via per-call TTLs + bounded
  attempts.**
- **M7 (compromised Fly web)** — attacker crafts a bad Spectre
  API request to the worker. **Spectre-side worker claims
  verify tenant scope before dispatching to Modal.**
- **M8 (compromised admin session)** — attacker steals a
  CLUB_ADMIN session. **Out of scope at auth layer; relies on
  session security + audit logging.**

---

## 2. Ten §5 requirements — detailed enforcement

For each requirement, the table reports the specific mechanism
and whether each contract satisfies it.

### §5.1 — Authenticated caller identity

| Mechanism | Contract A | Contract B | Contract C |
|-----------|:----------:|:----------:|:----------:|
| Transport-level mutual TLS | n/a (public Modal CDN) | n/a | n/a |
| Workspace-level proxy auth (Modal-Key/Modal-Secret) | ✓ | ✗ | ✓ |
| Workspace-level Bearer token | ✗ | ✓ | ✗ (replaced by proxy) |
| Per-call HMAC over request envelope | ✓ | ✗ | ✓ |
| Per-call PilotAuthorizationV1 fingerprint | ✓ | ✗ | ✓ |
| **Satisfies §5.1** | **✓** | **✓** (but weakest) | **✓** |

Threats addressed: M2 (tampering), M5 (compromised secret —
partial; a static Bearer leaks the whole workspace until
rotation, whereas three separate secrets limit blast radius).

### §5.2 — Explicit tenant / course / version binding

Mechanism — at the Modal boundary, the function must refuse a
request whose embedded tenant does not match the grounding
projection's tenant.

| Contract | Has tenant in envelope? | Modal verifies? |
|----------|:----------------------:|:---------------:|
| A | ✓ (PilotAuthorizationV1.tenantId / courseId / versionId / sourceVideoSha256 / resolvedTranscriptBuildId / approvedGroundingProjectionSha256) | ✓ (6C-11 §3 "fingerprint verified server-side by the Modal validator") |
| B | ✗ (no envelope; Bearer is workspace-wide) | ✗ (cannot verify what it does not receive) |
| C | ✓ (same as A) | ✓ (same as A) |

Threats addressed: M4 (confused-deputy Modal), M7 (compromised
Fly web).

Non-trivially, PilotAuthorizationV1 binds SEVEN identifiers at
once (tenant, course, version, video SHA, transcript build,
grounding projection SHA, operation). A request cannot succeed
if any single one is swapped. Contract B has zero of these.

### §5.3 — Request integrity

Mechanism — HMAC-SHA-256 over canonicalised body + timestamp +
request-id + operation + body-digest, signed with a shared
secret.

| Contract | Signed envelope | Signed headers |
|----------|-----------------|----------------|
| A | `v1.{operation}.{requestId}.{ts}.{sha256(canonicalBody)}` | `x-spectre-sig-version / operation / request-id / timestamp / body-digest / signature` |
| B | — | — |
| C | Same as A | Same as A |

Threats addressed: M2 (tampering — body or headers), M3 (replay
— timestamp + request-id in the signed message).

### §5.4 — Response integrity

Mechanism — HMAC-SHA-256 over response body, returned in
`X-Spectre-Signature` header; Spectre verifies with
`timingSafeEqual`.

| Contract | Response HMAC? | Spectre-side verify? |
|----------|:--------------:|:--------------------:|
| A | ✗ (6C-11 `generate-lite-run.mjs:70-71` reads plain text) | ✗ |
| B | ✓ (`modal-client.ts:122-137`) | ✓ |
| C | ✓ (add to Modal function on top of A) | ✓ |

Threats addressed: M2 (response tampering), M4 (Modal returning
a different tenant's inference by mistake — mitigated if the
response signature is computed over a server-side pin of
`PilotAuthorizationV1.authorizationId` + body).

**Design note for Option C**: the response HMAC's signed message
should include the `authorizationId` to prevent a response
substitution attack where Modal reuses a cached response from
another (concurrent) call.

### §5.5 — Bounded timestamp validity

| Mechanism | A | B | C |
|-----------|:-:|:-:|:-:|
| `x-spectre-timestamp` header | ✓ | ✗ | ✓ |
| Server-side window (±300 s recommended) | ✓ | ✗ | ✓ |
| PilotAuthorizationV1.`expiresAtUtc` (1 h) | ✓ | ✗ | ✓ |

Threats addressed: M3 (replay beyond the window).

**Implementation note**: the server-side window value must be
codified as a Modal function constant AND verified by Spectre
clock-skew checks before issuance. If Spectre clock drifts more
than ±300 s from Modal, the whole pipeline refuses — fail-closed,
not fail-open.

### §5.6 — Replay protection

Mechanism — multi-layer:
1. `x-spectre-request-id` uniqueness (Modal MAY cache seen ids
   for ≤ 2× timestamp window).
2. `x-spectre-timestamp` window (±300 s).
3. `PilotAuthorizationV1.authorizationId` TTL (1 h).

| Contract | Layered replay defence |
|----------|:----------------------:|
| A | ✓ (three layers) |
| B | ✗ |
| C | ✓ (same three layers) |

Threats addressed: M3 under all practical timeframes.

**Documented equivalent for Option B**: *"rotate the shared
Bearer every N hours."* This is NOT equivalent. Rotation is a
TTL on the secret, not a TTL on the request. A single
exfiltrated Bearer can be replayed unlimited times within its
rotation window.

### §5.7 — Safe handling of signed video URLs

| Mechanism | A | B | C |
|-----------|:-:|:-:|:-:|
| R2 signed URL with 600 s TTL | ✓ | ✓ | ✓ |
| Signed URL inside HMAC-covered body | ✓ (body-digest HMAC covers all fields) | ✗ | ✓ |
| Modal verifies `audioSha256` and returns to Spectre for comparison | ✓ (SHA_MISMATCH gate) | ✓ | ✓ |
| Tenant check on signed-URL issuance | ✓ (`makeSignedTrainingVideoUrl` cross-tenant throws NotFoundError) | ✓ | ✓ |

Threats addressed: M2 (URL substitution), M4 (serving a
different tenant's video to Modal).

### §5.8 — Fail-closed behaviour

All three contracts fail closed on missing credentials
(`CREDENTIAL_ABSENT`). Difference:

| Failure mode | A | B | C |
|--------------|:-:|:-:|:-:|
| Missing env var | `CREDENTIAL_ABSENT` | `CREDENTIAL_ABSENT` | `CREDENTIAL_ABSENT` |
| Invalid request HMAC | `REQUEST_HMAC_INVALID` | n/a | `REQUEST_HMAC_INVALID` |
| Invalid response HMAC | n/a | `MODAL_HMAC_INVALID` | `MODAL_HMAC_INVALID` |
| PilotAuthorizationV1 fingerprint invalid | `PILOT_AUTH_FINGERPRINT_MISMATCH` | n/a | `PILOT_AUTH_FINGERPRINT_MISMATCH` |
| Timestamp skew exceeded | `TIMESTAMP_SKEW_EXCEEDED` | n/a | `TIMESTAMP_SKEW_EXCEEDED` |
| Replay detected (request-id seen) | `REPLAY_DETECTED` | n/a | `REPLAY_DETECTED` |
| Tenant mismatch | `TENANT_MISMATCH` | n/a | `TENANT_MISMATCH` |
| Response body shape mismatch | `MODAL_BODY_INVALID` | `MODAL_BODY_INVALID` | `MODAL_BODY_INVALID` |
| Audio SHA mismatch | `SHA_MISMATCH` | `SHA_MISMATCH` | `SHA_MISMATCH` |
| Modal HTTP error | `MODAL_HTTP_ERROR` | `MODAL_HTTP_ERROR` | `MODAL_HTTP_ERROR` |
| Modal timeout | `MODAL_TIMEOUT` | `MODAL_TIMEOUT` | `MODAL_TIMEOUT` |

Contract C has the richest failure-classification surface,
which is directly useful for operator triage.

### §5.9 — No credentials in logs

All three contracts are code-verified to not pass tokens to
`logger`. Implementation note:
- All HMAC keys MUST be read from env and used in a single
  `createHmac(...)` call; never concatenated into a log line.
- Headers emitted on the request MUST NOT include the token
  value in any `logger.debug` / `logger.info` call.
- Server-side responses MUST NOT echo any header value from the
  request.

### §5.10 — No unauthorised cross-tenant inference

| Mechanism | A | B | C |
|-----------|:-:|:-:|:-:|
| Spectre-side worker claim scoped to `clubId` | ✓ | ✓ | ✓ |
| Signed video URL tenant-checked at issuance | ✓ | ✓ | ✓ |
| Modal verifies PilotAuthorizationV1.tenantId matches grounding projection tenant | ✓ | ✗ | ✓ |
| Modal rejects request where auth operation ≠ function type | ✓ (operation pinned) | ✗ | ✓ |

Contract B satisfies §5.10 only to the extent that the Spectre
worker is uncompromised. If the Spectre worker is compromised
(M6) OR a confused-deputy Modal (M4) occurs, Contract B cannot
refuse cross-tenant inference at the Modal boundary.

---

## 3. §6 — Twelve test scenarios + how each contract enforces

Each test is runnable offline with mocked `fetch` (no live
Modal call, per directive §8).

### Legend

- **PASS/FAIL** = whether the TEST (when authored) would
  pass against that contract — i.e. whether the contract
  actually refuses the bad request.
- **n/a** = no enforcement surface exists; the test cannot be
  written meaningfully.

### 3.1 Valid signed request

| Contract | Expected outcome | Enforcement path |
|----------|------------------|------------------|
| A | Success | 6C-11 observed Q4-Q8 success |
| B | Success | 4V/4W unit tests pass offline |
| C | Success | Combined envelope accepted |

### 3.2 Missing credentials

| Contract | Outcome | Error code |
|----------|---------|------------|
| A | Terminal | `CREDENTIAL_ABSENT` (any of Modal-Key / Modal-Secret / HMAC / fingerprint secret missing) |
| B | Terminal | `CREDENTIAL_ABSENT` |
| C | Terminal | `CREDENTIAL_ABSENT` |

### 3.3 Invalid credentials (wrong Modal-Key)

| Contract | Outcome | Where enforced |
|----------|---------|----------------|
| A | 401 from Modal proxy | Modal workspace |
| B | 401 from Modal Bearer verification | Modal function |
| C | 401 from Modal proxy | Modal workspace |

### 3.4 Tampered request (body changed in flight)

| Contract | Outcome |
|----------|---------|
| A | `REQUEST_HMAC_INVALID` (body-digest check fails) |
| B | **Accepted and processed** (no request-side HMAC) — test cannot meaningfully assert refusal |
| C | `REQUEST_HMAC_INVALID` |

### 3.5 Expired request

| Contract | Outcome |
|----------|---------|
| A | `TIMESTAMP_SKEW_EXCEEDED` OR `PILOT_AUTH_EXPIRED` depending on which TTL is checked first |
| B | **n/a** (no timestamp enforcement) |
| C | Same as A |

### 3.6 Replayed request

| Contract | Outcome |
|----------|---------|
| A | `REPLAY_DETECTED` (request-id seen in recent window) OR `PILOT_AUTH_EXPIRED` if the auth has expired |
| B | **Succeeds** (no replay protection) — test cannot meaningfully assert refusal |
| C | Same as A |

### 3.7 Cross-tenant mismatch

Scenario: the signed envelope claims tenant X but the grounding
projection claims tenant Y.

| Contract | Outcome |
|----------|---------|
| A | `TENANT_MISMATCH` |
| B | **n/a** (no tenant in envelope) — test can only assert Spectre-side worker refusal |
| C | Same as A |

### 3.8 Invalid response signature

| Contract | Outcome |
|----------|---------|
| A | **n/a** (no response HMAC) — test cannot meaningfully assert refusal |
| B | `MODAL_HMAC_INVALID` |
| C | `MODAL_HMAC_INVALID` |

### 3.9 Worker retry

| Contract | Outcome |
|----------|---------|
| A | Retry gets a FRESH `PilotAuthorizationV1` (per Q.4). Request-id regenerates; timestamp regenerates; fingerprint re-signed. Modal accepts as a new call. |
| B | Retry reuses the same Bearer. Request body unchanged. Modal accepts. |
| C | Same as A |

Caveat for all three: `maxAttempts=2` (default in 4V job-service)
bounds the retry count. For the initial pilot, operator sets
`maxAttempts=1` per 4Y-A pilot plan.

### 3.10 Cancellation

| Contract | Outcome |
|----------|---------|
| A | Admin cancels mid-run → service marks row CANCELLED; worker's late Modal response is discarded on the Spectre side (CANCELLED state check). Modal never knows cancellation occurred; the GPU container still runs to completion and the inference cost is incurred. |
| B | Same as A |
| C | Same as A — plus optionally, Modal could expose a cancel endpoint on the Spectre→Modal path, but that is a future enhancement. |

Cancellation is a Spectre-side concern; no contract improves it.

### 3.11 Endpoint timeout

| Contract | Outcome |
|----------|---------|
| A | Spectre-side `AbortController` fires at 5 min (6C-11) or 10 min (4V/4W default). Modal may still complete and return later, discarded by Spectre. |
| B | Same as A |
| C | Same as A |

**Recommendation**: unify on 10 min for both operations; operator
override allowed via worker env.

### 3.12 Malformed model output

| Contract | Outcome |
|----------|---------|
| A | Modal-side validator catches structural issues (Zod / lm-format-enforcer). Spectre-side pipeline (`validateTrainingQuestion` from `ep-train-6c-10b:src/lib/training/ai-generation/grounding-validator.ts`) catches semantic issues → verdict `REJECTED` or `REQUIRES_HUMAN_VERIFICATION`. |
| B | Same as A (minus auth envelope) |
| C | Same as A |

Model-output quality is orthogonal to the auth contract; all
three options route through the same validator.

---

## 4. Per-test enforcement summary

The table below shows how many of the 12 scenarios have a
meaningful enforcement surface in each contract.

| # | Scenario | A | B | C |
|---|----------|:-:|:-:|:-:|
| 3.1 | Valid signed request | ✓ | ✓ | ✓ |
| 3.2 | Missing credentials | ✓ | ✓ | ✓ |
| 3.3 | Invalid credentials | ✓ | ✓ | ✓ |
| 3.4 | Tampered request | ✓ | ✗ | ✓ |
| 3.5 | Expired request | ✓ | ✗ | ✓ |
| 3.6 | Replayed request | ✓ | ✗ | ✓ |
| 3.7 | Cross-tenant mismatch | ✓ | ✗ | ✓ |
| 3.8 | Invalid response signature | ✗ | ✓ | ✓ |
| 3.9 | Worker retry | ✓ | ✓ | ✓ |
| 3.10 | Cancellation | ✓ | ✓ | ✓ |
| 3.11 | Endpoint timeout | ✓ | ✓ | ✓ |
| 3.12 | Malformed model output | ✓ | ✓ | ✓ |
| **Enforceable** | — | **11 / 12** | **8 / 12** | **12 / 12** |

Only Option C makes the complete test matrix meaningfully
runnable.

---

## 5. Secret-rotation + least-privilege matrix

Separate secrets for separate concerns — the directive's §5.5
points at this ("Secret exposure risks").

| Secret | Purpose | Rotation cadence | Blast radius if leaked |
|--------|---------|------------------|------------------------|
| `MODAL_KEY` | Modal workspace proxy ingress | Per quarter OR on known compromise | Attacker can hit the Modal workspace proxy. Cannot sign a valid HMAC or forge a PilotAuthorizationV1. Loses nothing unless also leaked other secrets. |
| `MODAL_SECRET` | Modal workspace proxy ingress | Per quarter | Same as MODAL_KEY |
| `MODAL_SPECTRE_HMAC_KEY` | Request-level HMAC | Per deploy of either side | Attacker can forge requests — but still blocked by PilotAuthorizationV1.fingerprint. |
| `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` | PilotAuthorizationV1 fingerprint | Per quarter OR per threat-model review | Attacker can forge PilotAuthorizationV1 — but still blocked by MODAL_SPECTRE_HMAC_KEY. |
| `MODAL_SPECTRE_RESPONSE_HMAC_KEY` (optional) | Response-level HMAC | Per deploy | Attacker can forge Modal responses — Spectre validators are the second line. |

Single-secret failure: NO single compromised secret allows a
complete end-to-end forgery. This is the defence-in-depth
posture that Option C provides and Option B does not.

For Option B's single `MODAL_SPECTRE_SHARED_TOKEN`: a single
leak gives the attacker both authentication AND response-signing
power. Rotation is the only defence.

---

## 6. Logging + observability

All three contracts REQUIRE:

- `audit()` entry per lifecycle transition (`REQUESTED → QUEUED
  → RUNNING → COMPLETED | FAILED | CANCELLED`).
- `logger.info` with `jobId`, `elapsedMs`, `audioSha256` (hex
  prefix only), status — never the secret.
- On failure: `failureCode` + `failureMessage` persisted in
  `TrainingTranscriptionJob` / `TrainingQuestionGenerationRun`;
  `failureMessage` must NOT contain any secret, token, URL
  signature, or HMAC value.

Additional for Option C:

- `TrainingTranscriptionJob.authorizationId` (new column — or
  reuse `failureMessage` metadata JSON) to record which
  `PilotAuthorizationV1.authorizationId` scoped the call.
  Audit-only; not an auth check.
- Request-id → audit row correlation for traceability.

---

## 7. Data-boundary consent (links to G.C)

All three contracts send the same payload across the Fly →
Modal HTTPS boundary:
- Audio file (via signed R2 URL — Modal downloads the bytes).
- Transcript text (plaintext in request body).
- Prompt + constraints.
- Tenant / course / version identifiers (Option A / C only; in
  Option B these are implicit in the signed R2 URL only).

Modal does not persist beyond function execution (no Modal
Volume writes in the known contract). This matches the G.C
expectation from EP-TRAIN-6A-2.

**Observation**: Option B sends LESS identity material in the
request body (no PilotAuthorizationV1 → no tenantId/courseId/
versionId strings). On a pure data-boundary count it's slightly
"less revealing" to Modal. But this is cosmetic — the signed R2
URL is tenant-encoded in its key path
(`clubs/{clubId}/training/{courseId}/{version}/{sha256}` per
`src/lib/hr/training/video.ts:118-119`), so Modal can trivially
infer tenant from the URL anyway.

---

## 8. Final security score

| Option | §5 requirements (10 total) | §6 testable scenarios (12 total) | Verdict |
|--------|:--------------------------:|:-------------------------------:|---------|
| A | 9 | 11 | Strong but missing response integrity |
| B | 4 | 8 | **Materially weaker**; recommended only for offline tests |
| **C** | **10** | **12** | **Strict superset; recommended** |

**Recommendation: Option C.**

**End of security matrix.**
