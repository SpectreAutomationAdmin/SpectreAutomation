# EP-TRAIN-4Y-B — Implementation Plan (Option C, Hybrid)

**Status:** READ-ONLY offline design (2026-11-07). Nothing in
this plan runs without explicit founder approval of §D.1–D.6
from [PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md](PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md).

**Scope:** directive §7 — recommended option, affected files,
compatibility, migration, test plan, deploy order, rollback,
remaining decisions.

**STOP compliance:** no live Modal calls, no GPU, no Modal
redeploy, no Fly secret writes, no staging / production deploy,
no DB migration, no Modal spend-limit change, no publication /
assignments, 126 WIP files preserved via worktree isolation.

---

## 0. Scope of this implementation slice

**Recommended option: Contract C (Hybrid).** Modal proxy auth +
request-side HMAC + PilotAuthorizationV1 envelope + response-side
HMAC.

This plan covers:
1. Spectre-side changes (new + edited files).
2. Modal-side changes (described; the Python source lives
   outside this repo).
3. New Fly secrets (listed; no values).
4. New DB columns (audit-only; additive).
5. Test plan (12 §6 scenarios + 4V/4W existing suites).
6. Deploy order (small, reversible slices).
7. Rollback runbook.
8. Operator checklist.
9. Remaining founder decisions.

Nothing in §1–§8 below starts before §D.1–§D.6 approval.

---

## 1. Spectre-side changes

### 1.1 New files (7)

| Path | Purpose |
|------|---------|
| `src/lib/hr/training/modal-shared/canonicalise.ts` | Deterministic JSON canonicaliser (sorted keys). Lifted from `scratchpad/ep-train-6b/gen/generate-lite-run.mjs:33-38` with Zod-validated input. Shared between transcribe + generate clients. |
| `src/lib/hr/training/modal-shared/request-signer.ts` | `signModalRequest({ operation, requestId, timestamp, body, hmacKey })` → returns the six `x-spectre-*` headers + the canonical body. Pure function; mockable via injected `hmac` factory. |
| `src/lib/hr/training/modal-shared/response-verifier.ts` | `verifyModalResponse({ bodyText, signatureHeader, hmacKey, authorizationId })`. Same `timingSafeEqual` pattern as the current 4V/4W clients, but with `authorizationId` mixed into the signed message. |
| `src/lib/hr/training/modal-shared/pilot-authorization.ts` | `issuePilotAuthorization({ tenantId, courseId, versionId, sourceVideoSha256, resolvedTranscriptBuildId, approvedGroundingProjectionSha256, operation, maxRequestedQuestions, pilotRestrictions, ttlSec, fingerprintSecret })` → returns `PilotAuthorizationV1`. Signs with `createHmac("sha256", fingerprintSecret).update(canonicalise(bodyWithoutFingerprint))`. |
| `src/lib/hr/training/modal-shared/types.ts` | Re-export `PilotAuthorizationV1` + `PilotRestrictions` from `src/lib/training/ai-generation/types.ts` so 4V/4W no longer reach across module boundaries. |
| `src/lib/hr/training/modal-shared/errors.ts` | New error class `ModalContractError` with the full failure-code union: `CREDENTIAL_ABSENT` \| `MODAL_HTTP_ERROR` \| `MODAL_TIMEOUT` \| `REQUEST_HMAC_INVALID` \| `MODAL_HMAC_INVALID` \| `MODAL_BODY_INVALID` \| `PILOT_AUTH_FINGERPRINT_MISMATCH` \| `PILOT_AUTH_EXPIRED` \| `TIMESTAMP_SKEW_EXCEEDED` \| `REPLAY_DETECTED` \| `TENANT_MISMATCH`. |
| `tests/ep-train-6d-4yb-contract.test.ts` | 12 §6 scenarios + rotation + fingerprint-secret-change + canonicaliser determinism. Mocked `fetch`; no network. |

### 1.2 Edited files (2)

| Path | Change summary |
|------|-----------------|
| `src/lib/hr/training/transcription/modal-client.ts` | Rewire: build + sign request via `request-signer.ts`; issue `PilotAuthorizationV1` via `pilot-authorization.ts`; verify response HMAC via `response-verifier.ts`. Env reads change from `MODAL_SPECTRE_SHARED_TOKEN` to the three secrets (`MODAL_KEY`, `MODAL_SECRET`, `MODAL_SPECTRE_HMAC_KEY`, `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`, optionally `MODAL_SPECTRE_RESPONSE_HMAC_KEY`). Headers change: drop `Authorization: Bearer`, add `Modal-Key` + `Modal-Secret` + six `x-spectre-*`. Request body adds `pilotAuthorization` field. Error classification expands. |
| `src/lib/hr/training/generation/modal-client.ts` | Symmetric to transcription. Request body adds `pilotAuthorization`. Operation string changes from the 4W default to `spectre.training.generate.v1`. |

### 1.3 Edited files (3) — worker handlers + job service

| Path | Change summary |
|------|-----------------|
| `src/lib/hr/training/transcription/worker-handler.ts` | Build `PilotAuthorizationV1` from `claim` fields before calling the Modal client. On a FRESH `PilotAuthorizationV1` per retry (§Q.4). Record `authorizationId` on the job row for audit. |
| `src/lib/hr/training/generation/worker-handler.ts` | Same pattern. Record per-group `authorizationId`. |
| `src/lib/hr/training/transcription/job-service.ts` | Add nullable column `pilotAuthorizationIdLast` + migration (ADDITIVE; §2.1 below). Record last-issued authorizationId for forensic trace. |

### 1.4 Edited files (0) — API routes

Routes do NOT change. The permission gates (`hr:training:write`),
the response shapes, the 503 behaviour on `CREDENTIAL_ABSENT`,
all stay identical. The envelope change is entirely internal to
the worker's Modal call.

### 1.5 Fly secrets (new)

Set on BOTH `spectre-staging` and `spectre-staging-worker` via
DRH-1 secret deploy. Values typed into `flyctl` directly, never
echoed or logged.

```
MODAL_KEY=<Modal workspace key, wk-… prefix>
MODAL_SECRET=<Modal workspace secret, ws-… prefix>
MODAL_TRANSCRIBE_URL=<deployed transcribe function URL>
MODAL_GENERATE_URL=<deployed generate function URL>
MODAL_SPECTRE_HMAC_KEY=<32 bytes hex — shared with Modal workspace secret spectre-training-runtime-hmac>
SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET=<32 bytes hex — shared with Modal workspace secret spectre-training-pilot-fingerprint-secret>
MODAL_SPECTRE_RESPONSE_HMAC_KEY=<optional; 32 bytes hex — if §Q.5 chooses separate request + response secrets>
```

**Replacement**: the current `MODAL_SPECTRE_SHARED_TOKEN`
(unset everywhere today — staging buttons already fail closed)
is NOT set at all. If it was ever provisioned in a prior
experiment it MUST be unset in the same deploy.

### 1.6 DB migration (additive)

One Prisma migration, additive, zero backfill:

```prisma
model TrainingTranscriptionJob {
  // ... existing fields ...
  pilotAuthorizationIdLast  String?
}

model TrainingQuestionGenerationRun {
  // ... existing fields ...
  pilotAuthorizationIdLast  String?
}
```

Both columns are nullable, created with `?`. No existing rows
need updating. Migration name:
`prisma-postgres/migrations/{ts}_ep_train_4y_b_pilot_authorization_audit/`.

### 1.7 Existing contract tests

The current 4V/4W contract tests (`tests/ep-train-6d4v-modal-client.test.ts`,
`tests/ep-train-6d4w-modal-client.test.ts`) must be rewritten
to:
- Inject the six HMAC + canonicaliser dependencies.
- Expect the new header set.
- Expect the new body shape (with `pilotAuthorization`).
- Expect the new error-class set.

Existing worker-handler tests (`tests/ep-train-6d4v-worker-handler.test.ts`,
`tests/ep-train-6d4w-worker-handler.test.ts`) must be rewritten
to:
- Inject `PilotAuthorizationV1` issuer.
- Verify the issued auth binds to the claim's tenant / version
  / SHA.
- Verify FRESH issuance per retry (§Q.4).
- Verify `authorizationId` recorded on the job row.

---

## 2. Modal-side changes

The Modal Python source does not live in this repo. The
required changes are described here for the operator who will
author + deploy the new functions.

### 2.1 `spectre-training-generate` — modifications

Preserve existing 6C-11 verification logic (already deployed +
tested):
- Verify Modal proxy auth (workspace-managed; no code change
  needed).
- Parse `x-spectre-*` headers; verify HMAC over
  `v1.{operation}.{requestId}.{ts}.{sha256(canonicalBody)}`
  with `spectre-training-runtime-hmac` as the key.
- Parse `body.pilotAuthorization`; verify fingerprint with
  `spectre-training-pilot-fingerprint-secret` as the key.
- Verify `timestamp` within ±300 s of server-side now.
- Verify `authorizationId` / `requestId` not seen in the last
  2×300 s window (in-memory cache with TTL eviction).
- Verify `pilotAuthorization.tenantId === grounding.tenantId`
  (and similarly for courseId, versionId, sourceVideoSha256,
  resolvedTranscriptBuildId, approvedGroundingProjectionSha256).
- Verify `pilotAuthorization.operation ===
  "GENERATE_DRAFT_QUESTIONS"`.
- Verify `pilotAuthorization.maxRequestedQuestions >=
  body.maxQuestions`.
- Run inference under all the above gates.

**New additive step**:
- Compute `responseHmac = HMAC-SHA-256(spectre-training-response-hmac OR same shared secret, canonicalResponseBody + authorizationId)`.
- Return it as `X-Spectre-Signature` header.
- Return `X-Spectre-Response-Operation: spectre.training.generate.v1`
  header (per §Q.3 — recommended YES).

### 2.2 `spectre-training-transcribe` — new deployment

First-time deploy. Same structure as generate with these
operation-specific differences:
- `operation = "spectre.training.transcribe.v1"`.
- `PilotAuthorizationV1.operation` widens to accept
  `"TRANSCRIBE_VIDEO"` (per §Q.2 — recommended YES).
- Request body adds `audioUrl` (signed R2 URL); Modal downloads
  via HTTPS GET.
- Response body returns `audioSha256` (SHA-256 of the
  downloaded bytes; Spectre verifies against stored
  `videoSha256`).
- Response adds `X-Spectre-Response-Operation: spectre.training.transcribe.v1`.

### 2.3 Modal workspace secrets

Rotate / create:
- `spectre-training-runtime-hmac` (request + response HMAC key;
  same value as Spectre's `MODAL_SPECTRE_HMAC_KEY`).
- `spectre-training-pilot-fingerprint-secret` (PilotAuthorizationV1
  fingerprint key; same value as Spectre's
  `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`).
- Optional: `spectre-training-response-hmac-key` (response-HMAC
  key; same value as Spectre's optional separate response-HMAC
  env).

Rotation cadence: per deploy of either side (6C-11 pattern).

---

## 3. Compatibility and migration strategy

### 3.1 Protocol version handling

- Contract C emits `x-spectre-sig-version: v1`.
- Modal rejects unknown versions.
- Future upgrade: `v2` adds a header; both sides updated
  atomically in a single Modal redeploy + Spectre deploy.

### 3.2 Existing 6C-11 operator path

Decision point §D.6: the 6C-11 workstation path
(`generate-lite-run.mjs` + SPECTRE-SEC-1 DPAPI) is a parallel
caller to the same Modal function.

Option α: keep the operator path alive. The Modal function
already accepts the Contract A envelope (request HMAC +
PilotAuthorizationV1). Contract C is a strict superset for the
request side; the response-HMAC addition is OPTIONAL from the
workstation caller's point of view — it just doesn't verify.
Pro: ad-hoc generation stays available.
Con: two callers with different code paths = two surfaces to
audit.

Option β: deprecate the workstation path. All generation flows
through the Spectre app pipeline.
Pro: single surface to audit.
Con: operator loses ad-hoc generation convenience.

**Recommendation**: Option α for 3 months; revisit at pilot
retrospective. The workstation path is bounded by SPECTRE-SEC-1
DPAPI (single-workstation scope); the runtime path is bounded
by Fly secrets (shared ops surface). Having both for a
transition window lets operators compare quality / debug
regressions.

### 3.3 Backward compatibility of the DB schema

The new `pilotAuthorizationIdLast` columns are nullable. Rows
created before the migration remain valid with NULL. Rollback
drops the columns (or leaves them in place — see §5 below).

### 3.4 Shared code lifting from the 6C-11 operator path

`canonicalise()` (`generate-lite-run.mjs:33-38`), the signed-
message construction (`:45`), and the HMAC signing (`:46`) are
lifted verbatim into `src/lib/hr/training/modal-shared/*.ts`
with the following guarantees:
- Byte-identical output for the same input (test with the
  6C-11 fixtures).
- ASCII-only enforcement on `operation` + `requestId` +
  `scope` strings (prevents the 2026-11-04 em-dash bug per
  6C-11 §4.2).

---

## 4. Test plan

Mocked inference only. No live Modal call. Use the existing
`fetchImpl` injection pattern from the current 4V/4W clients.

### 4.1 Unit tests — canonicaliser determinism

| Test | Input | Expected |
|------|-------|----------|
| Deterministic ordering | `{b:1, a:2}` and `{a:2, b:1}` | Same output `{"a":2,"b":1}` |
| Nested sorting | `{z:[1,2], a:{c:1, b:2}}` | `{"a":{"b":2,"c":1},"z":[1,2]}` |
| ASCII-only guard on top-level `scope` | `"EP-TRAIN-4Y-A — Silver Springs"` (em-dash) | Throws `ASCII_SCOPE_REQUIRED` |
| Unicode in `questionText` (user content) | "naïve" | Passes through (not restricted) |

### 4.2 Unit tests — request signer

| Test | Behaviour |
|------|-----------|
| Signed-message construction matches 6C-11 fixtures byte-for-byte | Preserve prior-art |
| Signature is base64url (NOT hex) | Match 6C-11 |
| Timestamp is UNIX seconds, decimal string | — |
| Request-id is 32-char hex | — |

### 4.3 Unit tests — response verifier

| Test | Behaviour |
|------|-----------|
| Valid signature accepted | Pass |
| Missing header → `MODAL_HMAC_INVALID` | Pass |
| Mismatched length → `MODAL_HMAC_INVALID` | Pass |
| Wrong key → `MODAL_HMAC_INVALID` via `timingSafeEqual` false | Pass |
| Signature covers `authorizationId` — tampering `authorizationId` alone fails | **New in Option C** |

### 4.4 Unit tests — PilotAuthorizationV1 issuer

| Test | Behaviour |
|------|-----------|
| Shape-verified against type definition | Pass |
| Fingerprint signs over the canonicalised JSON WITHOUT `fingerprint` field | Prevent circular self-reference |
| TTL defaults to 3600 s | — |
| `issuedAtUtc` + `expiresAtUtc` computed from a mock clock | Test-friendly |
| ASCII-only enforced on `scope` | — |

### 4.5 Integration tests — 12 §6 scenarios

Each test spawns an in-memory mock Modal function that:
- Verifies request HMAC + PilotAuthorizationV1 fingerprint +
  timestamp window + replay cache.
- Returns a signed response.

| # | Scenario | Assertions |
|---|----------|-----------|
| 3.1 | Valid signed request | `{status: "COMPLETED"}`; job row has `authorizationId` set; audit log has success entry. |
| 3.2 | Missing credentials (one of MODAL_KEY / MODAL_SECRET / HMAC key / fingerprint secret unset) | `{status: "FAILED", failureCode: "CREDENTIAL_ABSENT"}`; retryable=false. Verify each env var independently. |
| 3.3 | Invalid credentials (wrong Modal-Key) | `{status: "FAILED", failureCode: "MODAL_HTTP_ERROR"}` (401 from mock proxy). |
| 3.4 | Tampered request (body mutated after signing) | `{status: "FAILED", failureCode: "REQUEST_HMAC_INVALID"}`; mock function returns 400. |
| 3.5 | Expired request (timestamp > +300 s or `PilotAuthorizationV1.expiresAtUtc` past) | `{status: "FAILED", failureCode: "TIMESTAMP_SKEW_EXCEEDED"` OR `"PILOT_AUTH_EXPIRED"}` (whichever fires first). |
| 3.6 | Replayed request (same request-id within 600 s) | `{status: "FAILED", failureCode: "REPLAY_DETECTED"}`. |
| 3.7 | Cross-tenant mismatch (PilotAuthorizationV1.tenantId ≠ grounding.tenantId) | `{status: "FAILED", failureCode: "TENANT_MISMATCH"}`. |
| 3.8 | Invalid response signature (mock function signs with wrong key) | `{status: "FAILED", failureCode: "MODAL_HMAC_INVALID"}`; non-retryable. |
| 3.9 | Worker retry (transient 500 then 200) | First call FAILS retryable; second call succeeds. FRESH `PilotAuthorizationV1` on second call. `attempts=2` on the job row. |
| 3.10 | Cancellation mid-run | Job row CANCELLED; late Modal response discarded (state mismatch in `recordJobCompleted`). |
| 3.11 | Endpoint timeout (mock stalls 11 min; client timeout 10 min) | `{status: "FAILED", failureCode: "MODAL_TIMEOUT"}`; retryable. |
| 3.12 | Malformed model output (mock returns incorrect schemaVersion) | `{status: "FAILED", failureCode: "MODAL_BODY_INVALID"}`; non-retryable. |

Target: all 12 pass offline. CI gate blocks merges that
regress any of them.

### 4.6 Existing test suite gates

- `npm run typecheck` — clean.
- `npx vitest run tests/ep-train-6d4v-*.test.ts` — all pass
  with rewritten clients.
- `npx vitest run tests/ep-train-6d4w-*.test.ts` — all pass.
- `npx vitest run tests/ep-train-6d-4yb-contract.test.ts` — new
  suite passes.
- `npm run scan:placeholders` — clean.
- Full regression on the 4Z-F baseline suite — no change
  expected because the contract is internal to the Modal path.

---

## 5. Deployment order

**Zero steps below execute without §D.1–§D.6 approval.** Each
is reversible on its own.

### Step 1 — Modal workspace prep (operator-only; before any Spectre code lands)

1. Rotate `spectre-training-runtime-hmac` (new 32-byte value).
2. Create `spectre-training-pilot-fingerprint-secret` (new 32-
   byte value).
3. Deploy `spectre-training-transcribe` for the first time
   using the Option C contract.
4. Redeploy `spectre-training-generate` to add response-HMAC
   signing (additive to existing 6C-11 verification code).
5. `modal app list` → confirm both apps show as deployed.
6. `modal app stop` BOTH apps immediately after deploy (they
   remain stopped until the pilot runs).

### Step 2 — Spectre-side changes land on a feature branch

1. Create new branch `ep-train-4y-b-impl/hybrid-auth-contract`
   forked from `ep-train-6d-4z-f/two-role-workflow`.
2. Add + edit the 9 files listed in §1.1–§1.3.
3. Run full test gate locally.
4. Commit; do NOT push without founder authorisation of the
   implementation slice (separate from §D.1–§D.6).

### Step 3 — Fly secrets set

Via DRH-1 secret-deploy. Both `spectre-staging` and
`spectre-staging-worker`. All seven values typed into `flyctl`
directly; nothing logged.

### Step 4 — Spectre staging deploy

DRH-1 deploy of the branch. Image sha captured.

### Step 5 — End-to-end live pilot

Per [PHASE-4Y-A-PILOT-PLAN.md](PHASE-4Y-A-PILOT-PLAN.md). The
pilot plan references Contract C (updated) as the accepted
auth contract.

### Step 6 — Modal cleanup

After pilot acceptance: `modal app stop` both apps. Fly secrets
remain set for the next authorised slice OR are unset per §G.F.

---

## 6. Rollback runbook

Rollback is possible at any step:

| Rolled-back step | Rollback action | Reversible? |
|------------------|-----------------|-------------|
| Modal workspace prep (Step 1) | `modal app delete spectre-training-transcribe`; `modal secret delete ...` | Fully reversible |
| Spectre feature branch (Step 2) | Branch stays unpushed OR a revert commit | Fully reversible |
| Fly secrets set (Step 3) | `flyctl secrets unset MODAL_* SPECTRE_*` | Fully reversible |
| Spectre staging deploy (Step 4) | Deploy previous image (`sha-e7fbb0b158cd`, the current v1098 baseline) | Fully reversible |
| Pilot execution (Step 5) | Cleanup script per 4Y-A pilot plan §7 | Fully reversible |
| DB migration (added columns) | Columns are nullable; rollback drops them OR leaves in place | Reversible BUT prefer to leave in place to preserve audit history |

**On any abort during Step 5**: the rollback anchor is image
`sha-e7fbb0b158cd` (current v1098). Deploy it via DRH-1; the
AI-workspace falls back to `CREDENTIAL_ABSENT` on every Modal
call.

---

## 7. Operator checklist (goes to acceptance report)

Before merging the implementation slice:

- [ ] `npm run typecheck` — clean.
- [ ] `npx vitest run tests/ep-train-6d-4yb-contract.test.ts` — 12/12 pass.
- [ ] `npx vitest run tests/ep-train-6d4v-*.test.ts` — all pass.
- [ ] `npx vitest run tests/ep-train-6d4w-*.test.ts` — all pass.
- [ ] `npm run scan:placeholders` — clean.
- [ ] 7 Fly secrets confirmed present on BOTH apps (via `flyctl secrets list`; values NEVER printed).
- [ ] Modal workspace shows 2 stopped apps (transcribe + generate) in `modal app list`.
- [ ] Modal workspace secrets rotated (`spectre-training-runtime-hmac` + fingerprint secret).
- [ ] `$10 USD` Modal account spend limit UNCHANGED.
- [ ] 126 unrelated WIP files unchanged on `staging-deploy/web1b1-framer-fidelity`.
- [ ] `/api/health` → 200 on staging.
- [ ] One contract-level smoke test driven via the 4Y workspace:
  admin clicks Transcription → observes `MODAL_TIMEOUT` or
  `COMPLETED` (NO `CREDENTIAL_ABSENT`).

---

## 8. Remaining founder decisions

Repeated from [PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md](PHASE-4Y-B-AUTH-CONTRACT-REVIEW.md)
for convenience:

- **D.1** — Adopt Option C (Hybrid) as the production auth
  contract.
- **D.2** — Approve the 5-7 Fly secret surface (depending on
  §Q.5).
- **D.3** — Modal secret rotation cadence (per deploy
  recommended).
- **D.4** — TTLs: PilotAuthorizationV1 1 h; timestamp window
  ±300 s; signed R2 URL 600 s.
- **D.5** — Operation strings: `spectre.training.transcribe.v1`
  + `spectre.training.generate.v1`.
- **D.6** — Workstation operator path (6C-11 `generate-lite-run.mjs`)
  — keep for 3 months OR deprecate.

And the open questions in §5 of the review doc:

- **Q.1** — PilotAuthorizationV1.`scope` content (recommend
  programmatic id + ASCII validation).
- **Q.2** — Widen `operation` union to include
  `"TRANSCRIBE_VIDEO"` (recommend YES).
- **Q.3** — Return `X-Spectre-Response-Operation` header
  (recommend YES).
- **Q.4** — FRESH PilotAuthorizationV1 on retry (recommend YES).
- **Q.5** — Separate request + response HMAC keys (recommend
  SEPARATE).

Each Q is defaulted to the recommendation above unless the
founder redirects.

---

## 9. Estimated engineering effort (reference only)

| Activity | Estimate |
|----------|----------|
| New shared Spectre files (§1.1) | 4-6 h |
| Rewrite 2 Modal clients (§1.2) | 3-4 h |
| Rewire 2 worker handlers (§1.3) | 2-3 h |
| DB migration + Prisma client regen (§1.6) | 1 h |
| Test suite (§4) | 8-12 h |
| Modal-side authoring (§2) — dependent on access to the Python source, not visible to Spectre | separate operator effort |
| Fly secrets provisioning (§Step 3) | 30 min |
| Staging deploy + smoke (§Step 4) | 1 h |
| Rollback drill (§6) | 1 h |
| **Spectre-side subtotal** | **~20-28 h** |

Modal-side effort is bounded by the current 6C-11 source's
existing verification code — the additive response-HMAC
signing is a one-hour change. The first-time transcribe
deployment is a few hours of authoring + model-cache volume
provisioning.

---

## 10. Final-response fields (per directive §7)

| Field | Value |
|-------|-------|
| Recommended option | **Option C — Hybrid** |
| Affected files | 7 new + 3 edited (Spectre); 2 Modal functions (one new, one modified); 1 Prisma migration; 7 Fly secrets |
| Compatibility and migration strategy | Preserve 6C-11 operator path for 3 months per §3.2; new columns additive-only per §3.3; canonicaliser lifted from 6C-11 per §3.4 |
| Test plan | 12 §6 scenarios + canonicaliser determinism + request signer + response verifier + PilotAuthorizationV1 issuer + rewritten 4V/4W contract suites |
| Deployment order | Modal prep → Spectre branch + tests → Fly secrets → Spectre deploy → pilot → cleanup |
| Rollback strategy | Reversible at every step; rollback anchor is image `sha-e7fbb0b158cd` (v1098); DB columns nullable and droppable |
| Remaining founder decisions | D.1–D.6 + Q.1–Q.5 (defaulted to recommendations) |

**No code lands before D.1–D.6 are answered. STOP compliance
preserved throughout.**

**End of implementation plan.**
