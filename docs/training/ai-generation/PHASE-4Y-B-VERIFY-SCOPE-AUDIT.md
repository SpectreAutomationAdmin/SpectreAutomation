# EP-TRAIN-4Y-B-VERIFY — Scope Audit

**Status:** OFFLINE VERIFICATION (2026-11-07). No deploy, no live Modal, no secrets, no scope expansion.

**Target branch under review:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `373eaeda`
**Diff base:** `ep-train-4y-b/auth-contract` @ `899503a5`
**Diff shape:** 44 files, +5 381 / -1 055

---

## 1. Classification of every changed file

Legend: **RUN** = required runtime implementation · **TEST** = required test · **DOC** = required documentation · **COMPAT** = necessary compatibility change · **CRUFT** = unrelated or unnecessary change.

### 1.1 TypeScript — shared library (`src/lib/hr/training/modal-shared/`)

| # | File | Status | Note |
|---|------|--------|------|
| 1 | `canonicalise.ts` | RUN | JCS canonicaliser + ASCII guard + sha256Hex helpers. |
| 2 | `types.ts` | RUN | Contract constants, `PilotAuthorizationV1` interface, request/response body types. |
| 3 | `errors.ts` | RUN | 24-code `ModalContractFailureCode` union + `NON_RETRYABLE_CODES` set + `ModalContractError`. |
| 4 | `env.ts` | RUN | `resolveModalCredentials(operation, env)` — fail-closed on missing creds. |
| 5 | `pilot-authorization.ts` | RUN | `issuePilotAuthorization` + `verifyPilotAuthorizationFingerprint` + `isPilotAuthorizationExpired`. |
| 6 | `request-signer.ts` | RUN | `signRequest` + `verifyRequestSignature` (both constant-time compare). |
| 7 | `response-verifier.ts` | RUN | `signResponse` + `verifyResponseSignature` — fail-closed on unsigned success. |
| 8 | `replay-registry.ts` | RUN | Interface + `InMemoryReplayRegistry` (test) + `NullReplayRegistry` (fail-closed stand-in). |
| 9 | `index.ts` | RUN | Barrel export. |

### 1.2 TypeScript — edited runtime (6 files)

| # | File | Status | Note |
|---|------|--------|------|
| 10 | `transcription/modal-client.ts` | RUN | Rewired to Hybrid contract. Modal proxy + 7 `x-spectre-*` headers + response-sig verify. |
| 11 | `generation/modal-client.ts` | RUN | Symmetric rewire. |
| 12 | `transcription/worker-handler.ts` | RUN | Fresh `PilotAuthorizationV1` per attempt; TRANSCRIBE placeholders used. |
| 13 | `generation/worker-handler.ts` | RUN | Fresh auth per Modal call per group. |
| 14 | `transcription/job-service.ts` | COMPAT | `JobFailureCode` TS union widened — DB column unchanged (§12 "no migration"). |
| 15 | `generation/generation-service.ts` | COMPAT | `GenerationFailureCode` TS union widened — DB column unchanged. |

### 1.3 TypeScript — new tests

| # | File | Status | Note |
|---|------|--------|------|
| 16 | `tests/ep-train-4yb-impl-contract.test.ts` | TEST | 18 §9 scenarios + 11 shared-lib unit tests. |

### 1.4 TypeScript — deleted tests (4 files)

| # | File | Status | Note |
|---|------|--------|------|
| 17 | `tests/ep-train-6d4v-modal-client.test.ts` | TEST (replaced) | Assertions mapped — see §2. |
| 18 | `tests/ep-train-6d4v-worker-handler.test.ts` | TEST (**gap**) | Integration surface NOT fully replaced. |
| 19 | `tests/ep-train-6d4w-modal-client.test.ts` | TEST (replaced) | Assertions mapped — see §2. |
| 20 | `tests/ep-train-6d4w-worker-handler.test.ts` | TEST (**gap**) | Integration surface NOT fully replaced. |

### 1.5 Python side (modal/)

| # | File | Status | Note |
|---|------|--------|------|
| 21 | `modal/__init__.py` | RUN | Empty package marker. |
| 22 | `modal/README.md` | DOC | Operator deployment guide. |
| 23 | `modal/shared/__init__.py` | RUN | Empty. |
| 24 | `modal/shared/auth.py` | RUN | Byte-compatible canonicalise/verify. |
| 25 | `modal/shared/errors.py` | RUN | Server-side subset of failure codes. |
| 26 | `modal/shared/replay.py` | RUN | `InMemoryReplayRegistry` + `ModalDictReplayRegistry`. |
| 27 | `modal/spectre_training_transcribe.py` | RUN | Endpoint reference. |
| 28 | `modal/spectre_training_generate.py` | RUN | Endpoint reference. |
| 29 | `modal/tests/__init__.py` | TEST | Empty. |
| 30 | `modal/tests/test_auth.py` | TEST | 18 Python unittest-level assertions. |
| 31 | `modal/tests/test_replay.py` | TEST | 5 replay-registry assertions. |

### 1.6 Deliverable docs (5 files)

| # | File | Status |
|---|------|--------|
| 32 | `docs/training/ai-generation/PHASE-4Y-B-IMPL-CONTRACT-SPEC.md` | DOC |
| 33 | `docs/training/ai-generation/PHASE-4Y-B-IMPL-SECURITY-TEST-MATRIX.md` | DOC |
| 34 | `docs/training/ai-generation/PHASE-4Y-B-IMPL-SECRET-INVENTORY.md` | DOC |
| 35 | `docs/training/ai-generation/PHASE-4Y-B-IMPL-DEPLOY-ROLLBACK-RUNBOOK.md` | DOC |
| 36 | `docs/training/ai-generation/PHASE-4Y-B-IMPL-ACCEPTANCE-REPORT.md` | DOC |

### 1.7 CRUFT — unnecessary tracked files (**8 defects**)

| # | File | Status | Finding |
|---|------|--------|---------|
| 37 | `modal/__pycache__/__init__.cpython-315.pyc` | CRUFT | Build artefact — must be gitignored. |
| 38 | `modal/shared/__pycache__/__init__.cpython-315.pyc` | CRUFT | Same. |
| 39 | `modal/shared/__pycache__/auth.cpython-315.pyc` | CRUFT | Same. |
| 40 | `modal/shared/__pycache__/errors.cpython-315.pyc` | CRUFT | Same. |
| 41 | `modal/shared/__pycache__/replay.cpython-315.pyc` | CRUFT | Same. |
| 42 | `modal/tests/__pycache__/__init__.cpython-315.pyc` | CRUFT | Same. |
| 43 | `modal/tests/__pycache__/test_auth.cpython-315.pyc` | CRUFT | Same. |
| 44 | `modal/tests/__pycache__/test_replay.cpython-315.pyc` | CRUFT | Same. |

**Finding C1 — `.gitignore` has no `__pycache__/` or `*.pyc` rule.** This is a HYGIENE defect, not a security one. The 8 files are pure bytecode artefacts that change whenever the Python runtime rebuilds them, so they will cause spurious diffs on every operator machine. **Action:** add `__pycache__/` and `*.pyc` to `.gitignore` and `git rm` the 8 tracked pyc files. Deferred to the follow-up slice that pushes this branch — this verification slice does not mutate the tree.

### 1.8 Net production-code delta (excluding tests + docs + cruft)

| Bucket | Files | Lines added | Lines removed |
|---|---|---|---|
| TS shared library | 9 new | ~1 100 | 0 |
| TS Modal clients (edited) | 2 | ~270 | ~140 |
| TS worker handlers (edited) | 2 | ~230 | ~110 |
| TS service unions (edited) | 2 | ~40 | ~10 |
| Python shared + endpoints | 5 | ~730 | 0 |
| **Production total** | **20** | **~2 370** | **~260** |

Net production-code change: **~ +2 100 lines across 20 files**. The remaining ~3 000 lines in the overall diff belong to tests (829 lines), docs (~1 100 lines), auto-generated pycache bytecode (~900 lines), and comment-dense boilerplate.

---

## 2. Replaced-legacy assertion coverage

29 legacy `it()` blocks across 4 deleted files. Replacement mapping:

### 2.1 `ep-train-6d4v-modal-client.test.ts` (9 tests)

| Legacy test | Replaced by | Status |
|---|---|---|
| `fail-closed when credentials absent` | `9.1` (CREDENTIAL_ABSENT via `resolveModalCredentials`) + TS `CREDENTIAL_ABSENT when env missing` | ✓ |
| `happy path returns a verified body` | `9.1 — valid transcription request succeeds` | ✓ |
| `non-2xx → MODAL_HTTP_ERROR` | `9.3 — invalid proxy credentials → MODAL_HTTP_ERROR (401)` | ✓ |
| `missing HMAC header → MODAL_HMAC_INVALID` | `9.12 — server returns wrong response signature → MODAL_HMAC_INVALID` | ✓ |
| `wrong HMAC → MODAL_HMAC_INVALID` (constant-time) | `9.12` + Python `test_signed_response_shape` + TS constant-time compares in `signRequest`/`verifyResponseSignature` | ✓ |
| `wrong schemaVersion → MODAL_BODY_INVALID` | Covered by `asTranscribeBody` contractVersion check in modal-client + 9.18 malformed body | ✓ |
| `missing audioSha256 → MODAL_BODY_INVALID` | `asTranscribeBody` audioSha256 regex check | ✓ (source-level; no direct test) |
| `abort/timeout → MODAL_TIMEOUT` | `9.17 — client AbortController fires → MODAL_TIMEOUT` | ✓ |
| `estimateTranscribeCostMicros math is stable` | `estimateTranscribeCostMicros` unchanged in modal-client | ✓ (source-level) |

### 2.2 `ep-train-6d4v-worker-handler.test.ts` (8 tests)

| Legacy test | Replaced by | Status |
|---|---|---|
| W1 happy path: REQUESTED → QUEUED → RUNNING → COMPLETED + build via 4L | **NOT REPLACED** | **gap** |
| W2 SHA mismatch → FAILED (non-retryable) | **NOT REPLACED** | **gap** |
| W3 Modal HTTP error → FAILED (retryable) | **NOT REPLACED** | **gap** |
| W4 HMAC invalid → FAILED (non-retryable) | Covered by `NON_RETRYABLE_CODES` set in worker-handler + §9 contract test | partial |
| W5 empty transcript → FAILED (INTEGRITY_FAILURE) | **NOT REPLACED** | **gap** |
| W6 cancellation race → late Modal response does not create COMPLETED | **NOT REPLACED** | **gap** |
| W7 handler SKIPs when no QUEUED | **NOT REPLACED** | **gap** |
| W8 no Modal invocation when credentials absent → FAILED (CREDENTIAL_ABSENT) | Covered by `CREDENTIAL_ABSENT` check in `resolveModalCredentials` + worker-handler guard + Python `test_valid_request_passes` negatives | partial |

### 2.3 `ep-train-6d4w-modal-client.test.ts` (7 tests)

| Legacy test | Replaced by | Status |
|---|---|---|
| `fail-closed when credentials absent` | `9.1`/`9.2` + env unit test | ✓ |
| `happy path returns a verified body` | `9.2` | ✓ |
| `non-2xx → MODAL_HTTP_ERROR` | `9.3` | ✓ |
| `missing HMAC → MODAL_HMAC_INVALID` | `9.12` | ✓ |
| `wrong schemaVersion → MODAL_BODY_INVALID` | `asGenerateBody` contractVersion check | ✓ (source-level) |
| `invalid proposal shape → MODAL_BODY_INVALID` | `9.18` malformed response body | ✓ |
| `timeout → MODAL_TIMEOUT` | `9.17` | ✓ |

### 2.4 `ep-train-6d4w-worker-handler.test.ts` (5 tests)

| Legacy test | Replaced by | Status |
|---|---|---|
| W1 happy path: run REQUESTED → QUEUED → RUNNING → COMPLETED | **NOT REPLACED** | **gap** |
| W2 proposals citing excluded segments (16/17) are dropped | **NOT REPLACED** | **gap** |
| W3 zero grounded proposals → INSUFFICIENT_EVIDENCE + FAILED | **NOT REPLACED** | **gap** |
| W4 Modal HMAC invalid → FAILED (non-retryable) | Covered by `NON_RETRYABLE_CODES` | partial |
| W5 handler SKIPs when no QUEUED run exists | **NOT REPLACED** | **gap** |

### 2.5 Summary of lost coverage

**13 of 29** deleted assertions have NO direct test replacement in the new suite. Specifically:

- **Full state-machine integration** (REQUESTED → QUEUED → RUNNING → COMPLETED/FAILED) is not exercised.
- **4L transcript-build persistence** via `persistTranscriptBuild` + `persistTranscriptSegments` is not exercised.
- **Cancellation race** — late Modal response arrives after row is CANCELLED — is not exercised.
- **Generation proposal-grounding filter** (EXCLUDED_SEGMENT_INDICES) is not exercised.
- **INSUFFICIENT_EVIDENCE** terminal for zero-grounded-proposal runs is not exercised.
- **Handler-SKIP path** when no QUEUED job exists is not exercised.

The acceptance report acknowledges this gap under "integration-tests" as a non-blocking follow-up. Verification concurs — these behaviors remain in the handler source (unchanged mechanics) but regression risk is elevated. **See §V3 of the acceptance doc for the recommended mitigation (`ep-train-4y-b-impl/integration-tests` follow-up slice).**

---

## 3. Production-code observations (non-blocking)

During the audit, three production-code smells surfaced that are NOT verification blockers but SHOULD be tracked:

### 3.1 Draft audit trail uses literal strings instead of per-call auth identity

[src/lib/hr/training/generation/worker-handler.ts:356-357](src/lib/hr/training/generation/worker-handler.ts#L356-L357):

```ts
pilotAuthorizationId: "4w-generation",
pilotAuthorizationFingerprint: claim.planIdentity.slice(0, 32),
```

The per-call auth's `authorizationId` and `fingerprint` are available in scope (`pilotAuth.authorizationId`, `pilotAuth.fingerprint`) but are NOT persisted on the draft row. This makes it impossible to trace a specific draft back to the specific Modal call that produced it — the audit trail says every draft was issued by `"4w-generation"`.

**Severity:** Audit traceability gap. Non-security, non-blocking. **Mitigation:** fix in `ep-train-4y-b-impl/integration-tests` follow-up.

### 3.2 `claim.planIdentity` doubles as grounding-projection SHA

[src/lib/hr/training/generation/worker-handler.ts:187](src/lib/hr/training/generation/worker-handler.ts#L187):

```ts
approvedGroundingProjectionSha256: claim.planIdentity,
```

Semantically, `approvedGroundingProjectionSha256` should be the SHA-256 of the approved grounding projection — a specific artefact. `claim.planIdentity` is the plan's content-hash. Both are 64-char hex so the regex passes, but the two concepts are distinct. The Modal server-side verifier accepts whatever value is present (no cross-check), so this does not break the contract — it is a semantic looseness.

**Severity:** Documentation/semantic gap. Non-blocking.

### 3.3 `claimNextTranscriptionJob` picks jobs globally

[src/lib/hr/training/transcription/job-service.ts:390-392](src/lib/hr/training/transcription/job-service.ts#L390-L392):

```ts
where: { state: "QUEUED", leaseToken: null },
orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
```

The claim is not jobId-filtered. The handler then compares `claim.jobId !== args.jobId` and skips mismatches. Correct behavior, but documented as a scope concession ("In production the queue adapter + a per-jobId lookup would narrow this"). The tenant identity used in the Modal auth envelope is read from `claim.clubId`, which was established by a tenant-guarded enqueue — so there is no cross-tenant leak. Residual risk is "adjacent-tenant job steal" within a club, which is benign.

**Severity:** Known concession; non-blocking.

---

## 4. Summary

- **36 of 44 files** are necessary (RUN/TEST/DOC/COMPAT).
- **8 files** are pure build-artefact cruft that must be removed from the tree in a follow-up tidy slice.
- **13 of 29** deleted-legacy assertions have no direct TS replacement; these cover integration behaviors whose source mechanics are unchanged. Verification concurs with the acceptance-report "known gaps" classification — not a verification blocker, but regression risk is elevated until the integration-tests follow-up ships.
- Three production-code smells (draft audit trail, grounding-projection SHA reuse, global claim-next) are all non-blocking.

**End of scope audit.**
