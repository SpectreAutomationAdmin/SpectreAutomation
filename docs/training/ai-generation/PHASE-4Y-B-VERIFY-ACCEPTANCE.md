# EP-TRAIN-4Y-B-VERIFY — Acceptance Report

**Date:** 2026-11-07
**Status:** OFFLINE VERIFICATION COMPLETE
**Baseline reviewed:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `373eaeda`
**Verification worktree:** `c:/tmp/spectre-4yb-impl` (isolated; main working tree + 126 WIP files unchanged)

---

## Headline — Deployment recommendation: **CONDITIONAL GO**

The Hybrid auth contract (4yb-v1) is **functionally sound and byte-compatible across TypeScript and Python**. 94 of 94 offline tests pass against the production implementations. The contract correctly enforces §5 authentication-and-authorization requirements and §6 tenant/course/version binding.

**Three resolvable pre-deploy conditions** must clear before any live Modal invocation. None of them require redesign — all are operator-side or follow-up-slice work with concrete remediation steps.

---

## 1. Test counts

| Suite | Tests | Pass | File |
|---|---:|:-:|---|
| TS — 4Y-B-IMPL contract (18 §9 scenarios + 11 unit) | 29 | ✓ 29 | [tests/ep-train-4yb-impl-contract.test.ts](../../../tests/ep-train-4yb-impl-contract.test.ts) |
| TS — cross-language vectors | 25 | ✓ 25 | [tests/ep-train-4yb-cross-language.test.ts](../../../tests/ep-train-4yb-cross-language.test.ts) |
| TS — replay concurrency | 5 | ✓ 5 | [tests/ep-train-4yb-replay-concurrency.test.ts](../../../tests/ep-train-4yb-replay-concurrency.test.ts) |
| Python — auth (original) | 18 | ✓ 18 | [modal/tests/test_auth.py](../../../modal/tests/test_auth.py) |
| Python — replay (original) | 5 | ✓ 5 | [modal/tests/test_replay.py](../../../modal/tests/test_replay.py) |
| Python — cross-language vectors | 9 | ✓ 9 | [modal/tests/test_cross_language.py](../../../modal/tests/test_cross_language.py) |
| Python — replay concurrency | 3 | ✓ 3 | [modal/tests/test_replay_concurrency.py](../../../modal/tests/test_replay_concurrency.py) |
| **Total** | **94** | **✓ 94** | |

### 1.1 Delta vs 4Y-B-IMPL baseline

| | Before VERIFY | After VERIFY | Added |
|---|---:|---:|---:|
| TS tests | 29 | 59 | +30 |
| Python tests | 23 | 35 | +12 |
| Cross-language fixture vectors | 0 | 23 | +23 |

---

## 2. Replaced legacy assertion coverage

29 legacy `it()` blocks in 4 deleted test files. **16 of 29** have a direct or source-level replacement in the new suite; **13 of 29** cover integration behaviors (worker-handler state transitions, 4L persistence, cancellation race, EXCLUDED_SEGMENT_INDICES filtering, INSUFFICIENT_EVIDENCE terminal) that are NOT directly replaced.

Verification concurs with the acceptance-report "known gaps" classification — the deleted tests exercised **DB-integration mechanics** that were unchanged by the 4Y-B-IMPL rewire. The source-level mechanics remain in place; the regression safety net is thinner until the `ep-train-4y-b-impl/integration-tests` follow-up slice restores them.

Full mapping: [PHASE-4Y-B-VERIFY-SCOPE-AUDIT.md §2](./PHASE-4Y-B-VERIFY-SCOPE-AUDIT.md).

---

## 3. Shared test-vector evidence

Fixture: [tests/fixtures/ep-train-4yb-cross-language-vectors.json](../../../tests/fixtures/ep-train-4yb-cross-language-vectors.json) (`fixtureVersion = "4yb-verify-v1"`, 23 vectors).

Generated OFFLINE by [tests/fixtures/gen-cross-language-vectors.py](../../../tests/fixtures/gen-cross-language-vectors.py) using Python stdlib JCS canonicalisation — INDEPENDENT of either production impl.

Both TS and Python production implementations load this fixture and produce **byte-identical** output for every vector. No divergence observed.

Full analysis: [PHASE-4Y-B-VERIFY-CROSS-LANGUAGE.md](./PHASE-4Y-B-VERIFY-CROSS-LANGUAGE.md).

---

## 4. Replay backing-store architecture

- **In-process TS + Python InMemoryReplayRegistry**: atomic in a single event loop / under GIL. Verified under 10-way concurrent record() — exactly one success.
- **Production Python ModalDictReplayRegistry**: uses `self._dict.contains(key)` then `self._dict.put(key, ...)`. This is a check-then-set race, NOT atomic across containers.

Per directive §5: *"If the implementation is process-local or cannot provide cross-instance guarantees, classify it as a deployment blocker."* This verification classifies the current `ModalDictReplayRegistry.record` as a **CONDITIONAL deployment blocker**.

Operator-side remediation at deploy time:

1. Identify Modal SDK's atomic put-if-absent primitive (`modal.Dict.setnx` or `put(key, value, condition=NOT_EXISTS)`).
2. Replace the current `contains` → `put` sequence.
3. Add a Modal-live test that confirms cross-container atomicity.

Full analysis: [PHASE-4Y-B-VERIFY-SECURITY.md §1](./PHASE-4Y-B-VERIFY-SECURITY.md).

---

## 5. Tenant authorization trace

Verified: tenant/course/version/video identity is established at the **enqueue** path (`hasPermission(... "hr:training:write")` + `version.course.clubId !== clubId → 404`) and cryptographically bound into the `PilotAuthorizationV1.fingerprint` before the request is signed. Mutating any bound field invalidates the fingerprint; the Modal verifier catches the mutation and refuses.

Worker retries re-issue a FRESH authorization using the SAME DB-row bound-fields — the envelope cannot be widened. The `claimNextTranscriptionJob()` global claim is `jobId`-compared at the handler and mismatches are SKIPPED without mutation.

Full trace: [PHASE-4Y-B-VERIFY-SECURITY.md §2](./PHASE-4Y-B-VERIFY-SECURITY.md).

---

## 6. §5 security requirements — status

| § | Requirement | Status |
|---|---|:-:|
| 5.1 | Authenticated caller identity | ✓ |
| 5.2 | Explicit tenant/course/version/video binding | ✓ |
| 5.3 | Request integrity (HMAC + body-digest + timestamp) | ✓ |
| 5.4 | Response integrity (signed success) | ✓ **success path** / ⚠ **error path unverified client-side** |
| 5.5 | Bounded timestamp validity (±300 s) | ✓ (inclusive at boundary, reject at ±301 s, both impls) |
| 5.6 | Atomic replay protection | ✓ in-process / ⚠ **cross-container pending operator fix** |
| 5.7 | Safe signed R2 URL handling (body-digest coverage) | ✓ |
| 5.8 | Fail-closed on every missing-creds / integrity-failure path | ✓ |
| 5.9 | No credentials in logs | ✓ (code-audited — see §7 below) |
| 5.10 | No cross-tenant inference | ✓ (fingerprint-bound tenantId) |

---

## 7. Outstanding defects

### 7.1 **CONDITIONAL deployment blocker** — `ModalDictReplayRegistry` atomicity

**File:** [modal/shared/replay.py:85-91](../../../modal/shared/replay.py#L85-L91).

**Fix:** operator-side substitution with Modal SDK's atomic put-if-absent primitive at `modal deploy` time.

**Owner:** operator executing the deployment runbook.

### 7.2 **Non-blocking** — Error-response signature not verified client-side

**File:** [src/lib/hr/training/transcription/modal-client.ts:123-130](../../../src/lib/hr/training/transcription/modal-client.ts#L123-L130) + [src/lib/hr/training/generation/modal-client.ts:103-110](../../../src/lib/hr/training/generation/modal-client.ts#L103-L110).

**Issue:** server emits signed error responses, but TS client reads only the unsigned `x-spectre-failure-code` HTTP header. A MITM-crafted error response could force a retry classification. Does not widen authorization; worst case is DoS via forced retry. 

**Fix:** follow-up slice `ep-train-4y-b-impl/verify-error-responses` (already tracked in the IMPL acceptance report).

### 7.3 **Non-blocking** — Legacy 6C-11 operator path docs/code divergence

**Docs claim** (deploy-rollback runbook §5): Modal function accepts requests without `x-spectre-contract-version` as legacy envelope. **Code refuses** missing required headers.

**Fix:** either remove the runbook §5 claim (plan to retire the workstation operator path at Hybrid-contract cutover) OR add a legacy-envelope branch with explicit test per §D.6 "Backward-compatibility exceptions must be explicit and separately tested".

### 7.4 **Non-blocking** — 8 `__pycache__` files tracked in repo

**Files:** `modal/__pycache__/*.pyc` + `modal/shared/__pycache__/*.pyc` + `modal/tests/__pycache__/*.pyc`.

**Issue:** `.gitignore` has no `__pycache__/` or `*.pyc` rule. Pure hygiene; not a security concern.

**Fix:** add rules to `.gitignore` and `git rm` the 8 files in the next tidy slice that pushes this branch.

### 7.5 **Non-blocking** — Draft audit-trail uses literal strings instead of per-call authorization identity

**File:** [src/lib/hr/training/generation/worker-handler.ts:356-357](../../../src/lib/hr/training/generation/worker-handler.ts#L356-L357). The persisted draft rows carry `pilotAuthorizationId: "4w-generation"` instead of `pilotAuth.authorizationId`.

**Issue:** traceability — cannot tie a specific draft back to the specific Modal call that produced it.

**Fix:** follow-up slice; wire the actual `pilotAuth.authorizationId` + `pilotAuth.fingerprint` into the persisted draft fields.

---

## 8. §5.9 — logs audit

Grep over the production diff:
- `src/lib/hr/training/modal-shared/*.ts`: zero `logger.*` calls referencing `MODAL_KEY`, `MODAL_SECRET`, `MODAL_SPECTRE_HMAC_KEY`, `SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET`, `MODAL_SPECTRE_RESPONSE_HMAC_KEY`.
- `src/lib/hr/training/{transcription,generation}/{modal-client,worker-handler}.ts`: `logger.info` calls carry only `jobId`, `runId`, `claimedJobId`/`claimedRunId`. No HMAC / token / secret values.
- `modal/shared/auth.py` + `modal/spectre_training_*.py`: no `logging` imports; no `print` of any secret-carrying variable.
- `env.ts` error path emits only logical env var NAMES — never values.

**Conclusion:** no credential leakage in logs.

---

## 9. STOP compliance

| § | Boundary | Verification-slice status |
|---|---|:-:|
| §10.1 | No Modal deployment or invocation | ✓ |
| §10.2 | No GPU activation | ✓ |
| §10.3 | No Fly secrets | ✓ |
| §10.4 | No staging / production deployment | ✓ |
| §10.5 | No shared database migration | ✓ (TS type unions widened only; DB columns unchanged — see Scope §1.2 row 14-15) |
| §10.6 | No spending-limit changes | ✓ |
| §10.7 | No historical candidate modification | ✓ |
| §10.8 | No publication / assignments | ✓ |
| §10.9 | No unrelated redesign | ✓ |
| §10.10 | Preserve all 126 WIP files | ✓ — this slice is in an isolated worktree; the main working tree `c:/dev/SpectreAutomation` on `staging-deploy/web1b1-framer-fidelity` is untouched |

---

## 10. GO / CONDITIONAL GO / NO-GO deployment recommendation

**Verdict: CONDITIONAL GO.**

The 4Y-B-IMPL slice is correct enough to go live PROVIDED THAT, before any Spectre-worker→Modal traffic flows:

1. **(CRITICAL)** `ModalDictReplayRegistry.record` is replaced with an atomic primitive during the operator Modal deployment slice. The fix is well-scoped and does not require redesign. Without it, cross-container replays are not provably prevented.
2. **(ACCEPTABLE)** The legacy 6C-11 operator-path divergence is reconciled one way or the other — either by removing the runbook §5 claim OR by implementing the legacy-envelope branch with an explicit test.
3. **(ACCEPTABLE)** The client-side error-response signature-verification follow-up slice (`ep-train-4y-b-impl/verify-error-responses`) is explicitly ACKNOWLEDGED as deferred, and the deploy proceeds with the current unsigned-error-header residual risk accepted.

With (1), (2) and (3) addressed, the Hybrid contract is ready for the operator-authorized Modal deployment slice.

**If (1) is skipped, this flips to NO-GO** — replay cannot be guaranteed cross-container, and the Modal function's §5 atomic-replay property is violated.

The verification artefacts, tests, fixture, and 94-pass test matrix stand as the evidence base for operator sign-off at the next slice boundary.

---

## 11. Artefacts

**Created by this verification slice** (`ep-train-4y-b-impl/hybrid-auth-contract` branch, uncommitted):

| Artefact | Path |
|---|---|
| Scope audit | [docs/training/ai-generation/PHASE-4Y-B-VERIFY-SCOPE-AUDIT.md](./PHASE-4Y-B-VERIFY-SCOPE-AUDIT.md) |
| Cross-language verification | [docs/training/ai-generation/PHASE-4Y-B-VERIFY-CROSS-LANGUAGE.md](./PHASE-4Y-B-VERIFY-CROSS-LANGUAGE.md) |
| Security verification | [docs/training/ai-generation/PHASE-4Y-B-VERIFY-SECURITY.md](./PHASE-4Y-B-VERIFY-SECURITY.md) |
| This acceptance report | [docs/training/ai-generation/PHASE-4Y-B-VERIFY-ACCEPTANCE.md](./PHASE-4Y-B-VERIFY-ACCEPTANCE.md) |
| Shared fixture | [tests/fixtures/ep-train-4yb-cross-language-vectors.json](../../../tests/fixtures/ep-train-4yb-cross-language-vectors.json) |
| Fixture generator (stdlib-only) | [tests/fixtures/gen-cross-language-vectors.py](../../../tests/fixtures/gen-cross-language-vectors.py) |
| TS cross-language loader | [tests/ep-train-4yb-cross-language.test.ts](../../../tests/ep-train-4yb-cross-language.test.ts) |
| Python cross-language loader | [modal/tests/test_cross_language.py](../../../modal/tests/test_cross_language.py) |
| TS replay concurrency | [tests/ep-train-4yb-replay-concurrency.test.ts](../../../tests/ep-train-4yb-replay-concurrency.test.ts) |
| Python replay concurrency | [modal/tests/test_replay_concurrency.py](../../../modal/tests/test_replay_concurrency.py) |

All artefacts are OFFLINE — no deploy, no secret, no Modal call. The isolated worktree remains in `c:/tmp/spectre-4yb-impl`; the main working tree and its 126 WIP files are untouched.

**End of acceptance report.**
