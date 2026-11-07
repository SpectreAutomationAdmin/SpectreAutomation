# EP-TRAIN-4Y-B — Modal Authentication Contract Reconciliation

**Status:** READ-ONLY review + offline design (2026-11-07).
**Scope:** directive §3-§5 — inspect, compare, recommend.
**Companion docs:**
- [PHASE-4Y-B-SECURITY-MATRIX.md](PHASE-4Y-B-SECURITY-MATRIX.md)
- [PHASE-4Y-B-IMPLEMENTATION-PLAN.md](PHASE-4Y-B-IMPLEMENTATION-PLAN.md)

**Baseline:** `ep-train-4y-a/preflight` @ `b760c010` (pushed to
origin as part of this slice's §1). Isolated worktree at
`c:/tmp/spectre-4yb` on new branch `ep-train-4y-b/auth-contract`.

**STOP compliance (§8):** no live Modal calls, no GPU, no Modal
redeploy, no Fly secret writes, no staging / production deploy,
no DB migration, no Modal spend-limit change, no historical
modification, no publication / assignments. 126 unrelated WIP
files on `staging-deploy/web1b1-framer-fidelity` preserved via
worktree isolation.

---

## 0. RECOMMENDATION — Option C (Hybrid, strengthened)

The **recommended authentication contract** is Option C — proxy
authentication (6C-11 pattern) **plus** request-side HMAC
(6C-11 pattern) **plus** `PilotAuthorizationV1` envelope (6C-11
pattern) **plus** response-side HMAC (4V/4W pattern).

This is the only one of the three evaluated options that
satisfies **all 10 security requirements** in directive §5. See
[PHASE-4Y-B-SECURITY-MATRIX.md](PHASE-4Y-B-SECURITY-MATRIX.md).

The ranking below is based on the §5 security-requirement count
and the directive's explicit instruction *"Do not select an
option solely because it requires fewer code changes"* and *"Do
not assume Modal proxy authentication alone provides tenant-
scoped authorization."*

| Rank | Option | §5 requirements satisfied | Rationale summary |
|-----:|--------|:--------------------------:|-------------------|
| **1** | **C — Hybrid** | **10 / 10** | Preserves 6C-11 request-side strength; adds 4V/4W response-side strength; preserves PilotAuthorizationV1 tenant binding. Largest Spectre-side code change; smallest Modal-side code change (one addition). |
| 2 | A — Preserve Modal proxy | 9 / 10 (no response integrity) | Keeps 6C-11 exactly; rebuilds Spectre clients. One §5 requirement (response integrity) unsatisfied. |
| 3 | B — Standardize on Bearer | 4 / 10 (no replay resistance, no tenant binding, no operation pinning, no per-call restrictions, no per-call Q cap) | Materially weaker; the Bearer+response-HMAC pattern was designed for offline testing, not for the security envelope a live inference pipeline requires. Would REGRESS the security posture established in 6C-11. |

**The directive's phrase "most secure and maintainable" settles
the choice.** Option B is the easiest to ship but materially
weaker. Option A has the same security as Option C minus
response integrity. Option C is the strict superset.

---

## 1. §3 — Read-only inspection (surfaces + file citations)

Every claim below cites `branch:file:line`. No live Modal call
was made.

### 1.1 Modal generation entrypoint (Python side)

**Not visible in the repo.** Per EP-TRAIN-4Y-A §4.1, the
`@app.function()` Python source lives in a separate operator-
maintained tree used with `modal deploy`. The 6C-11 acceptance
report captures the deployed URL
(`https://spectreautomation-admin--spectre-training-generate-gener-a9d84d.us-east.modal.run`,
`ep-train-6c-11:docs/training/ai-generation/PHASE-C-11-ACCEPTANCE.md §4.1`)
and the deterministic deployment hash, but not the source. This
review is therefore based on:

- The OBSERVED request-/response-contract as emitted + received
  by the 6C-11 workstation caller.
- The DECLARED fingerprint-verification assertion
  (`6C-11 §3`: "All five fingerprints verified server-side by
  the Modal validator.").

### 1.2 Modal transcription entrypoint (Python side)

**Never deployed.** `6C-11 §9`: "Confirm
`spectre-training-transcribe` not deployed ✓
`transcribe deployed: False`." The Spectre-side 4V client exists
and is contract-tested (`ep-train-6d-4z-f:src/lib/hr/training/transcription/modal-client.ts`
+ `tests/ep-train-6d4v-modal-client.test.ts`), but the function
it would call has no corresponding Modal deployment yet.

### 1.3 PilotAuthorizationV1 (Spectre-authored)

Type definition at
`ep-train-6c-10b:src/lib/training/ai-generation/types.ts:140-154`.
Verbatim shape:

```ts
export interface PilotRestrictions {
  readonly publicationProhibited: boolean;
  readonly employeeAssignmentProhibited: boolean;
  readonly databaseWritesProhibited: boolean;
  readonly automaticRetriesProhibited: boolean;
  readonly excludedSegmentIds: readonly number[];
  readonly scope: string;
}

export interface PilotAuthorizationV1 {
  readonly schemaVersion: "pilot-generation-authorization-v1";
  readonly authorizationId: string;
  readonly tenantId: string;
  readonly courseId: string;
  readonly versionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly approvedGroundingProjectionSha256: string;
  readonly operation: "GENERATE_DRAFT_QUESTIONS";
  readonly maxRequestedQuestions: number;
  readonly pilotRestrictions: PilotRestrictions;
  readonly issuedAtUtc: string;
  readonly expiresAtUtc: string;
  readonly issuedBy: string;
  readonly fingerprint: string;
}
```

Server-side validator usage at
`ep-train-6c-10b:src/lib/training/ai-generation/grounding-validator.ts:472-487`:
`authorization.pilotRestrictions.excludedSegmentIds` is read and
intersected with the proposal's `supportingCitations[].segmentId`
to reject citations against excluded passages (hard error
`CITATION_SEGMENT_EXCLUDED`).

6C-11 §3 documents that the fingerprint is "HMAC-SHA-256 of
canonical JSON (fingerprint secret = `ep-train-6c-1-pilot-fingerprint-secret-v1`)"
and is "verified server-side by the Modal validator." The
fingerprint secret is therefore **shared between Spectre
(issuer) and Modal (verifier)** — but is entirely independent
of the Modal-Key/Modal-Secret proxy credentials.

### 1.4 Spectre transcription client (4V)

`ep-train-6d-4z-f:src/lib/hr/training/transcription/modal-client.ts:63-147`.
Verbatim shape:

- Env read: `MODAL_TRANSCRIBE_URL`, `MODAL_SPECTRE_SHARED_TOKEN`
  (`:80-81`).
- Fail-closed: `throw new ModalClientError("CREDENTIAL_ABSENT", …)`
  when either env var is missing (`:83-88`).
- Request: `fetch(url, { method: "POST", headers: { Authorization: Bearer <token>, "Content-Type": "application/json" }, body: JSON.stringify(request) })` (`:95-103`).
- Request body shape (`ModalTranscribeRequest`, `:17-23`):
  `{ requestId, audioUrl, languageCode, modelVariant, schemaVersion: "transcribe-v1" }`.
- Timeout: `AbortController` default 10 min (`:92`).
- Response verification (`:122-137`):
  - Read body as text.
  - Require `X-Spectre-Signature` header.
  - Compute `createHmac("sha256", token).update(bodyText, "utf-8").digest()`.
  - `timingSafeEqual(supplied, expected)`.
  - On failure: `MODAL_HMAC_INVALID` (non-retryable).
- Schema validation (`:139-151`):
  - `schemaVersion === "transcribe-v1"` (else `MODAL_BODY_INVALID`).
  - `segments` is Array.
  - `audioSha256` matches `/^[a-f0-9]{64}$/`.
- Error classification (`:48-56`): `MODAL_HTTP_ERROR |
  MODAL_TIMEOUT | MODAL_HMAC_INVALID | MODAL_BODY_INVALID |
  CREDENTIAL_ABSENT`.
- Cost estimate (`:160-166`): `estimateTranscribeCostMicros(elapsedMsTotal)`
  returns `elapsedMs / 3,600,000 × $1.95 × 1e6`.

**No request-side HMAC.** **No tenant binding in the request
envelope** beyond `audioUrl` (which is signed server-to-server
by Spectre's R2 helper). **No timestamp / nonce in the request.**

### 1.5 Spectre generation client (4W)

`ep-train-6d-4z-f:src/lib/hr/training/generation/modal-client.ts:1-142`.
Structurally symmetric to 4V with these shape differences:

- URL env var: `MODAL_GENERATE_URL` (`:77`).
- Request body shape (`ModalGenerateRequest`, `:17-24`):
  `{ requestId, modelVariant, promptSchemaVersion: "training-proposals-v1",
  systemPrompt, transcript, constraints: { proposalKind, maxQuestions,
  allowedQuestionTypes, jsonSchema } }`.
- Response schema: `"training-proposals-v1"` (`:124`).
- Response integrity: identical HMAC pattern via
  `X-Spectre-Signature` (`:108-121`).
- Same `CREDENTIAL_ABSENT` fail-closed (`:78-81`).

**No `pilotAuthorization` field in the request body.** **No
tenant binding in the request envelope.** **No request-side
HMAC.** **No timestamp / nonce.**

### 1.6 Request signing + response verification — 6C-11 workstation path

`generate-lite-run.mjs` at
`C:\dev\SpectreAutomation\scratchpad\ep-train-6b\gen\generate-lite-run.mjs`
(untracked WIP, not in branch tree). Verbatim:

- Request body: `{ schemaVersion: "generate-questions-v2",
  requestId, pilotAuthorization, grounding, mode: "FINAL_ASSESSMENT",
  maxQuestions: 1, courseTitle }` (`:22-31`).
- Canonicaliser: sorted-key JSON (`:33-38`).
- `bodyDigest = sha256(canonicalBody)` (`:42`).
- `ts = String(Math.floor(Date.now() / 1000))` (`:43`).
- `operation = "spectre.training.generate.lite.v1"` (`:44`).
- `signedMessage = v1.{operation}.{requestId}.{ts}.{bodyDigest}`
  (`:45`).
- `sig = createHmac("sha256", HMAC_HEX).update(signedMessage, "utf-8").digest("hex")`
  (`:46`).
- Headers (`:56-66`):
  - `Modal-Key`, `Modal-Secret` (Modal workspace proxy auth).
  - `x-spectre-sig-version: v1`
  - `x-spectre-operation`
  - `x-spectre-request-id`
  - `x-spectre-timestamp`
  - `x-spectre-body-digest`
  - `x-spectre-signature`
- Client timeout: 5 min (`:52`).
- **Response integrity: NONE** (`:70-71`: plain `await resp.text()` + `JSON.parse`).

### 1.7 Tenant / course-version binding

**Contract B (4V/4W)**:
- Tenant binding is implicit through the Spectre worker-side
  context: `handleTranscribeJob` reads `claim.clubId` /
  `claim.courseVersionId` and verifies `version.videoSha256 ===
  claim.sourceVideoSha256` BEFORE calling Modal
  (`ep-train-6d-4z-f:src/lib/hr/training/transcription/worker-handler.ts:107-125`).
- `audioUrl` is tenant-scoped via `makeSignedTrainingVideoUrl`
  (`video-signed-url.ts:18-60`): cross-tenant access throws
  `NotFoundError`.
- **Modal has no tenant context.** The Bearer token is
  workspace-level. Modal has no way to refuse a request on
  tenant-mismatch grounds — it trusts the Spectre worker's own
  correctness.

**Contract A (6C-11)**:
- `PilotAuthorizationV1.tenantId / courseId / versionId /
  sourceVideoSha256 / resolvedTranscriptBuildId /
  approvedGroundingProjectionSha256` are embedded in the signed
  request body.
- Modal server-side verifies the fingerprint AND can refuse any
  mismatch between the embedded identifiers and the
  `grounding` passages supplied alongside.
- **This is tenant-scoped authorization** at the Modal boundary.

### 1.8 Timestamp and nonce handling

**Contract B (4V/4W)**: no timestamp, no nonce. Replay of a
previously signed request body against the same Bearer token
would succeed (the shared token has no bounded validity beyond
the Fly-secret lifetime).

**Contract A (6C-11)**:
- `x-spectre-timestamp` is a UNIX-seconds string
  (`generate-lite-run.mjs:43`).
- Expected server-side policy (per 6C-11's design): reject if
  `|server_now - request_ts| > N seconds` (e.g. N=300).
- `x-spectre-request-id` is a per-call random id — intended as
  a nonce on the server side (verify not-seen-before within a
  bounded window, or let the request-id's timestamp-pair enforce
  bounded replay).
- `PilotAuthorizationV1.issuedAtUtc / expiresAtUtc` give a
  1-hour outer bound (6C-11 §3).

**This is explicit replay-resistance.** Contract B has none.

### 1.9 Replay protection

- **Contract B**: none, beyond "rotate the Fly secret
  periodically."
- **Contract A**: multi-layer — timestamp window, request-id
  nonce candidate, PilotAuthorizationV1 TTL, fingerprint.

### 1.10 Signed R2 URL handling

Both contracts use the same path:
`ep-train-6d-4z-f:src/lib/hr/training/video-signed-url.ts:18-60`
→ `storage.signUrl(storageKey, ttlSec)` with `ttlSec = 600`
(10 min; `transcription/worker-handler.ts:127-132`). Cross-
tenant access is treated as NotFoundError (same-shape hiding).

The signed URL carries its own TTL (10 min) and is passed as a
plain field in the request body. Modal downloads the MP4 bytes
via standard HTTPS GET; the signature on the URL is R2-native,
not Spectre-authored.

**Observation**: the signed R2 URL is NOT inside the request's
HMAC-signed envelope in Contract B — meaning a tampered body
could carry a MITM-substituted `audioUrl` and the Bearer token
alone wouldn't catch it. In Contract A / C, the body digest is
HMAC-signed, so substitution is caught.

### 1.11 Error responses

**Contract B (4V/4W)**:
- `MODAL_HTTP_ERROR` (any non-2xx; retryable)
- `MODAL_TIMEOUT` (`AbortController`; retryable)
- `MODAL_HMAC_INVALID` (response HMAC mismatch; non-retryable)
- `MODAL_BODY_INVALID` (shape mismatch; terminal)
- `CREDENTIAL_ABSENT` (env missing; non-retryable)

**Contract A (6C-11)**:
- `PILOT_AUTH_FINGERPRINT_MISMATCH` (observed on 2026-11-04
  when the pilot-authorization scope contained an em-dash; see
  6C-11 §4.2 — a pre-inference 403 that never allocated a GPU).
- Standard Modal proxy errors (401 on bad Modal-Key/Secret).
- Validator errors on body content.

**Both** classify failures cleanly; Contract A adds a few extra
classes for the richer envelope.

### 1.12 Worker retries, leases, cancellation

`ep-train-6d-4z-f:src/lib/hr/training/transcription/job-service.ts`:
- `leaseToken` + `leaseExpiresAt` (`:341-342`).
- `claimNextTranscriptionJob` prefers QUEUED jobs with `leaseToken IS NULL`;
  falls back to stale-lease RUNNING jobs
  (`:353-357`).
- Refuses when `attempts >= maxAttempts` → flips row to FAILED
  (`:356`).
- Cost-cap tripped → directly transitions to CANCELLED with
  code `COST_CAP_EXCEEDED` (`:159`, `:242-261`).
- Cancellation race: every `recordJobCompleted` / `recordJobFailed`
  gates on `(state='RUNNING' AND leaseToken=expected)`; a late
  Modal response against a CANCELLED row is discarded
  (worker-handler.ts §cancellation safety).

Retry classification map (worker-handler.ts `:149-171`):
- `CREDENTIAL_ABSENT`, `MODAL_HMAC_INVALID` → non-retryable.
- `MODAL_HTTP_ERROR`, `MODAL_TIMEOUT` → retryable.
- `SHA_MISMATCH` → non-retryable (upstream SHA change).
- `INGEST_FAILED` → retryable.

### 1.13 Credential management

**Contract B**: three Fly secrets (`MODAL_TRANSCRIBE_URL`,
`MODAL_GENERATE_URL`, `MODAL_SPECTRE_SHARED_TOKEN`) + Modal-
workspace secret (none — Bearer token verification is a plain
string compare against env).

**Contract A**: two Modal-workspace secrets (`spectre-training-runtime-hmac`
per 6C-11 §4.1 + `spectre-training-pilot-fingerprint-secret-v1`)
+ Modal proxy credentials (`Modal-Key` / `Modal-Secret`,
workspace-level). On the Spectre side today the Modal proxy
credentials are stored in **Windows DPAPI** via SPECTRE-SEC-1
(`scripts/spectre-sec-1/SpectreModalCredentials.psm1:250-266`)
— workstation only, NOT in Fly secrets.

If Contract A is adopted for the runtime path, the Spectre-side
secret surface must add:
- `MODAL_KEY` (proxy)
- `MODAL_SECRET` (proxy)
- `MODAL_SPECTRE_HMAC_KEY` (request-side HMAC — mirror of
  Modal's `spectre-training-runtime-hmac`)
- `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET` (PilotAuthorizationV1
  fingerprint — mirror of Modal's slice-local secret)

**Four Fly secrets vs three.** Contract C adds a fifth (the
response-HMAC secret, which could be the same as the request-
HMAC secret).

**All secrets are workspace-level.** Per the directive's
warning *"Do not assume Modal proxy authentication alone
provides tenant-scoped authorization"*: correct — Modal proxy
auth is workspace-wide. Tenant scoping comes from
PilotAuthorizationV1, not from the Modal proxy credentials.

---

## 2. §4 — Three options compared

Each dimension reports the status a FULLY-IMPLEMENTED version of
that option would have, not today's half-state.

### 2.1 Twelve-dimension matrix

| Dimension | Contract A (Preserve 6C-11) | Contract B (Bearer) | Contract C (Hybrid) |
|-----------|-----------------------------|---------------------|---------------------|
| Authentication guarantees | Modal proxy (workspace) + request HMAC (per-call) | Shared Bearer (workspace) only | Modal proxy + request HMAC |
| Authorization guarantees | PilotAuthorizationV1 (tenant / course / version / video / transcript / grounding) with 1 h TTL + fingerprint | **None at Modal boundary** — Modal trusts the Spectre worker's own correctness | Same as A (PilotAuthorizationV1 required by Modal) |
| Replay resistance | Timestamp window + request-id nonce + auth TTL | **None** — static Bearer | Same as A |
| Response integrity | **None** | HMAC on body via `X-Spectre-Signature` | HMAC on body via `X-Spectre-Signature` |
| Tenant isolation | Explicit at Modal boundary (PilotAuthorizationV1) + Spectre-side (worker claims scoped to `clubId`) + signed R2 URL | Spectre-side only; Modal has no tenant context | Explicit at Modal boundary + Spectre-side |
| Secret exposure risk | Four Fly secrets; two shared with Modal (HMAC + fingerprint); proxy creds workspace-level | One Fly secret; shared workspace-wide | Five Fly secrets (same four as A plus response-HMAC key, which MAY equal the request-HMAC key) |
| Operational complexity | High on Spectre side (new HMAC + PilotAuthorizationV1 issuance + canonicalisation + 4 new env vars) | Low on Spectre side (already in place); Low on Modal side (reduce current Modal contract) | Highest Spectre-side complexity; smallest Modal-side change |
| Deployment requirements | Spectre: rebuild 2 Modal clients + add issuance code + 4 new Fly secrets. Modal: NO CHANGE (6C-11 contract already live for generate; transcribe needs first-time deploy using same contract). | Spectre: NO CHANGE (already in place). Modal: redeploy BOTH functions with simplified Bearer contract + first-time transcribe deploy. | Spectre: same as A. Modal: ADD response-HMAC signing to existing 6C-11 request-verification path + first-time transcribe deploy. |
| Compatibility with both endpoints | YES — same envelope used for transcribe + generate | YES | YES |
| Failure behaviour | All classes carried forward; `PILOT_AUTH_FINGERPRINT_MISMATCH` kept | Simpler but fewer classes; loses pre-inference refusal path | All classes of A plus response-side classes of B |
| Testability | 12 scenarios (directive §6) all testable; mocked `fetch`; `PilotAuthorizationV1` fixture helpers already exist | 12 scenarios testable but 4 (tenant mismatch / replay / expired / tampered body) have no code-level enforcement to test against — can only test Spectre-side refusal patterns | All 12 scenarios have real enforcement surfaces |
| Migration risk | Low Modal-side (preserves the current deployed contract); High Spectre-side (rewrite) | High Modal-side (redeploy both functions with new verification path); Low Spectre-side | Medium Modal-side (additive change); High Spectre-side |

### 2.2 Security-requirement scorecard (directive §5)

| §5 requirement | A | B | C |
|----------------|:-:|:-:|:-:|
| 1. Authenticated caller identity | ✓ | ✓ | ✓ |
| 2. Explicit tenant / course / version binding | ✓ | ✗ | ✓ |
| 3. Request integrity | ✓ | ✗ | ✓ |
| 4. Response integrity | ✗ | ✓ | ✓ |
| 5. Bounded timestamp validity | ✓ | ✗ | ✓ |
| 6. Replay protection (or documented equivalent) | ✓ | ✗ | ✓ |
| 7. Safe handling of signed video URLs (inside signed envelope) | ✓ | ✗* | ✓ |
| 8. Fail-closed behaviour | ✓ | ✓ | ✓ |
| 9. No credentials in logs | ✓ | ✓ | ✓ |
| 10. No unauthorised cross-tenant inference | ✓ | ✗ | ✓ |
| **Total** | **9/10** | **4/10** | **10/10** |

\* Contract B's signed URL is a plain body field, not covered by
a request-level HMAC. It IS tamper-protected end-to-end only
because Bearer-plus-TLS keeps the request path confidential; but
there is no authenticated check at the Modal boundary that
`audioUrl` came from Spectre unaltered.

### 2.3 Maintainability analysis

The directive says to weigh security AND maintainability, not
code-change volume. The relevant maintainability dimensions:

| Maintainability dimension | A | B | C |
|---------------------------|:-:|:-:|:-:|
| Single auth-contract across operator + runtime paths | ✓ (6C-11 operator path matches runtime) | ✗ (operator path still needs its own) | ✓ |
| Separable concerns (auth vs request integrity vs envelope auth) | ✓ | ✗ (one secret, everything else trusted) | ✓ |
| Future rotation safety | ✓ (separate secrets for separate concerns) | ✗ (one secret rotates everything) | ✓ |
| Observability on failure | ✓ (distinct error classes per layer) | △ (fewer classes) | ✓ |
| Future extensibility (e.g. per-call Q cap, per-call restrictions) | ✓ (PilotAuthorizationV1 carries) | ✗ (require protocol change) | ✓ |
| Test matrix completeness | ✓ (all 12 scenarios land) | △ (4 scenarios have nothing to test) | ✓ |

### 2.4 Why Option C beats Option A

A and C differ in one dimension: §5 requirement 4 (response
integrity). 6C-11's workstation caller does NOT verify response
HMAC (see §1.6 above). If the production pipeline adopts
Contract A verbatim, a compromised Modal response path (e.g. a
man-in-the-middle at the Modal CDN layer, however unlikely)
could substitute responses and the Spectre pipeline would have
no cryptographic way to detect it. Contract C closes that gap by
adding ONE server-side signing step on the Modal function + ONE
client-side verification step on the Spectre side (the exact
`X-Spectre-Signature` pattern already in `transcription/modal-client.ts`
and `generation/modal-client.ts`).

The marginal Modal-side cost is one line of code (HMAC the
response body with the same secret). The marginal Spectre-side
cost is zero (code already in place). This is a strict Pareto
improvement.

### 2.5 Why Option B is rejected

Option B drops five §5 requirements. The directive explicitly
instructs me not to choose on code-volume grounds. The 4V/4W
Bearer-plus-response-HMAC contract was designed and is unit-
tested for an **offline / development** context (every test
injects a mocked `fetchImpl`). That design choice is fine for
tests; it is not an acceptable production security envelope.

Staying on Option B would be a regression against the security
posture already established by 6C-11 — a production-grade
envelope exists today; abandoning it to simplify Spectre-side
code is backward.

---

## 3. §5 — Security-requirement gap analysis vs today's state

Column "Current staging state" = what is deployed on Fly v1098
image `sha-e7fbb0b158cd` (built from 4Z-F branch).

| §5 requirement | Current staging state | Gap vs Option C |
|----------------|-----------------------|-----------------|
| 1. Authenticated caller identity | 4V/4W clients emit Bearer; staging secrets UNSET so every call returns `CREDENTIAL_ABSENT`. | No change — Bearer / Modal-Key both are workspace-level. |
| 2. Explicit tenant / course / version binding | None in request envelope. Spectre-side worker trusts its own `claim.clubId`. | **New requirement**: issue `PilotAuthorizationV1` on every request. |
| 3. Request integrity | None. Bearer token is a plain string. | **New requirement**: canonicalised body + HMAC-SHA-256 with `x-spectre-*` headers. |
| 4. Response integrity | Implemented (`X-Spectre-Signature`). | Preserve. |
| 5. Bounded timestamp validity | None. | **New requirement**: `x-spectre-timestamp` + server-side ±N sec window. |
| 6. Replay protection | None. | **New requirement**: `x-spectre-request-id` + `PilotAuthorizationV1.expiresAtUtc`. |
| 7. Safe signed R2 URL | Signed URL is in body but not covered by any client-side HMAC. | Preserve URL signing (R2-side); add Spectre-side request HMAC to protect the URL field from substitution. |
| 8. Fail-closed | Implemented (`CREDENTIAL_ABSENT`, `MODAL_HMAC_INVALID`, `MODAL_BODY_INVALID`). | Preserve. Add `PILOT_AUTH_FINGERPRINT_MISMATCH` + `REQUEST_HMAC_INVALID` + `TIMESTAMP_SKEW_EXCEEDED` as new terminal classes. |
| 9. No credentials in logs | Verified in code review — neither modal-client logs the token. | Preserve. The new HMAC keys + Modal proxy secret MUST also never reach `logger`. |
| 10. No cross-tenant inference | Enforced on Spectre side only (worker claims scoped to clubId). Modal has no check. | **New requirement**: Modal server rejects a request where `PilotAuthorizationV1.tenantId` ≠ the grounding projection's tenant. |

---

## 4. Remaining founder decisions

Before the EP-TRAIN-4Y-B implementation slice can start, the
founder must approve:

- **D.1** — Adopt **Option C (Hybrid)** as the runtime auth
  contract for both transcription and generation.
- **D.2** — Approve the five-secret surface on Fly:
  - `MODAL_KEY` (workspace proxy)
  - `MODAL_SECRET` (workspace proxy)
  - `MODAL_SPECTRE_HMAC_KEY` (request- + response-HMAC key —
    may be ONE shared secret or two separate secrets; §2.3
    recommends two)
  - `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`
  - *(optional)* `MODAL_SPECTRE_RESPONSE_HMAC_KEY` if the
    founder prefers separate request- and response-HMAC keys.
- **D.3** — Approve the Modal workspace secret rotation cadence
  (6C-11 rotated `spectre-training-runtime-hmac` per session via
  `modal secret create --force`; the production cadence should
  be at least per-deploy).
- **D.4** — Approve the chosen TTLs:
  - PilotAuthorizationV1 (recommend **1 h** per 6C-11).
  - Timestamp window (recommend **±300 s** = 5 min).
  - Signed R2 URL (already **600 s** = 10 min).
- **D.5** — Approve the operation-string contract:
  - `spectre.training.transcribe.v1` (new)
  - `spectre.training.generate.v1` (replaces 6C-11's
    `spectre.training.generate.lite.v1`)
- **D.6** — Approve that EP-TRAIN-6C-11's workstation operator
  path (`generate-lite-run.mjs` + SPECTRE-SEC-1) remains as an
  alternate ad-hoc generator, OR is deprecated once Option C is
  live.

These decisions are prerequisite to the implementation slice
described in
[PHASE-4Y-B-IMPLEMENTATION-PLAN.md](PHASE-4Y-B-IMPLEMENTATION-PLAN.md).
No code lands before D.1-D.6 are answered.

---

## 5. Open questions (for founder discretion)

- **Q.1** — Should PilotAuthorizationV1.`scope` carry a human-
  readable one-liner (e.g. "EP-TRAIN-4Y-A pilot transcription on
  Silver Springs Staff Orientation v<versionId> 2026-11-07") or
  a programmatic id? 6C-11's em-dash bug suggests ASCII-only is
  mandatory. Recommend programmatic id + mandatory ASCII regex
  validation on issuance.
- **Q.2** — Should `PilotAuthorizationV1.operation` widen from
  `"GENERATE_DRAFT_QUESTIONS"` to a union that also includes
  `"TRANSCRIBE_VIDEO"`? Recommend YES — one auth envelope
  shape, two operation values.
- **Q.3** — Should the Modal function return a
  `X-Spectre-Response-Operation` header to pin the responded-to
  operation? Defence in depth against a compromised server
  returning a generate response to a transcribe request.
  Recommend YES.
- **Q.4** — On a `MODAL_TIMEOUT`, should the retry get a FRESH
  `PilotAuthorizationV1` (new `authorizationId`, new
  `issuedAtUtc`) or reuse? Reuse is simpler; fresh is cleaner
  for audit. Recommend FRESH — the authorisation issuance is
  cheap and the audit trail is clearer.
- **Q.5** — Response-HMAC key separation from request-HMAC key:
  a single shared secret is simpler; separate secrets allow
  independent rotation. Recommend SEPARATE on principle of
  least privilege.

**End of auth-contract review.**
