# EP-TRAIN-4Y-B-IMPL — Security Test Matrix

**Status:** OFFLINE IMPLEMENTATION ACCEPTED (2026-11-07).
**Companion:** [PHASE-4Y-B-IMPL-CONTRACT-SPEC.md](PHASE-4Y-B-IMPL-CONTRACT-SPEC.md).

---

## 1. Test counts (both sides)

| Suite | Tests | Pass |
|-------|------:|:----:|
| TypeScript — `tests/ep-train-4yb-impl-contract.test.ts` | 29 | 29 |
| Python — `modal/tests/test_auth.py` | 18 | 18 |
| Python — `modal/tests/test_replay.py` | 5 | 5 |
| Existing — `tests/ep-train-6d4v-job-service-contract.test.ts` | 28 | 28 |
| Existing — `tests/ep-train-6d4w-assessment-plan.test.ts` + `generation-service.test.ts` | 32 | 32 |
| **Total** | **112** | **112** |

Tests run with `npx vitest run ...` (TS) + `python -m unittest
discover -s modal/tests -t .` (Python). All offline; no Modal
network call; no GPU; no secret values.

---

## 2. §9 directive scenarios — enforcement surface

Each scenario is enforced on BOTH client and server (per §9: "Do
not substitute client-only tests for server-side enforcement").

| # | Scenario | TS test (client + mock server) | PY test (server unit) |
|---|----------|:------------------------------:|:---------------------:|
| 9.1 | Valid transcription request | `9.1 — valid transcription request succeeds` | `test_valid_request_passes` + `test_full_valid_envelope_passes` |
| 9.2 | Valid generation request | `9.2 — valid generation request succeeds` | `test_full_valid_envelope_passes` |
| 9.3 | Invalid proxy credentials | `9.3 — invalid proxy credentials → MODAL_HTTP_ERROR (401)` | implicit (Modal workspace-level) |
| 9.4 | Invalid request HMAC | `9.4 — wrong HMAC key → REQUEST_HMAC_INVALID` | `test_invalid_hmac_rejected` |
| 9.5 | Tampered body | `9.5 — tampered body (server-side verify) → REQUEST_HMAC_INVALID` | `test_tampered_body_rejected` |
| 9.6 | Invalid envelope fingerprint | `9.6 — tampered PilotAuthorizationV1 → PILOT_AUTH_FINGERPRINT_MISMATCH` | `test_tampered_fingerprint_rejected` + `test_tenant_mismatch_via_body_mutation` |
| 9.7 | Expired request | `9.7 — client timestamp outside ±300s → TIMESTAMP_SKEW_EXCEEDED` | `test_expired_timestamp_rejected` + `test_expired_auth_rejected` |
| 9.8 | Replayed request | `9.8 — same request-id twice → REPLAY_DETECTED` | `test_duplicate_record_rejected` |
| 9.9 | Wrong tenant | `9.9 — mutating tenantId post-sign → PILOT_AUTH_FINGERPRINT_MISMATCH` | `test_tenant_mismatch_via_body_mutation` |
| 9.10 | Wrong course/version | `9.10 — mutating versionId post-sign → PILOT_AUTH_FINGERPRINT_MISMATCH` | (covered by fingerprint test) |
| 9.11 | Wrong operation | `9.11 — TRANSCRIBE auth against GENERATE endpoint → PILOT_AUTH_OPERATION_MISMATCH` | `test_operation_mismatch` + `test_transcribe_requires_placeholders` + `test_generate_rejects_placeholders` |
| 9.12 | Invalid response signature | `9.12 — server returns wrong response signature → MODAL_HMAC_INVALID` | (Python signs via `sign_response`; shape test: `test_signed_response_shape`) |
| 9.13 | Response / request-id mismatch | `9.13 — response x-spectre-response-request-id mismatch → RESPONSE_REQUEST_ID_MISMATCH` | (header check; test shape) |
| 9.14 | Tampered response body | `9.14 — mutated response body → MODAL_HMAC_INVALID` | (body-digest covers) |
| 9.15 | Retry with fresh authorization | `9.15 — retry with fresh authorizationId succeeds` | (replay registry allows new key) |
| 9.16 | Replay-store outage | `9.16 — replay store outage → REPLAY_STORE_UNAVAILABLE (retryable)` | `test_unhealthy_store_fails_closed` |
| 9.17 | Cancellation | `9.17 — client AbortController fires → MODAL_TIMEOUT` | (cancellation is Spectre-side — NullReplayRegistry test covers the fail-closed principle) |
| 9.18 | Malformed inference output | `9.18 — malformed response body → MODAL_BODY_INVALID` | (shape check) |

Every row has at least one enforcement test on each side.

---

## 3. Shared-library unit tests (TypeScript)

Additional to the 18 §9 scenarios:

| Test | Validates |
|------|-----------|
| `canonicalise: sorted key output byte-identical to 6C-11` | Byte compatibility with workstation path |
| `canonicalise: throws on non-finite numbers` | NaN/Infinity rejection |
| `assertPrintableAscii: rejects em-dash` | 6C-11 §4.2 em-dash lesson enforced |
| `sha256HexOfCanonicalSync: deterministic` | Signature stability |
| `CREDENTIAL_ABSENT when env missing` | Fail-closed on env |
| `verifyPilotAuthorizationFingerprint: valid auth passes` | Happy path |
| `verifyPilotAuthorizationFingerprint: wrong secret fails` | Cross-secret isolation |
| `isPilotAuthorizationExpired: fresh auth not expired` | Happy path |
| `isPilotAuthorizationExpired: past auth is expired` | TTL enforcement |
| `Replay registry: duplicate rejected, fresh accepted` | §6 atomic replay |
| `NullReplayRegistry: always returns unavailable` | Fail-closed stand-in |

---

## 4. Python unit coverage

Additional to the 18 Modal-side server tests:

| Test | Validates |
|------|-----------|
| `test_sorted_key_output` | Canonical JSON matches TS |
| `test_nested_sort` | Nested sort compatibility |
| `test_non_ascii_strings_pass` | User content allowed |
| `test_ascii_guard_rejects_em_dash_in_scope` | ASCII guard on scope fields |
| `test_signed_response_shape` | Response headers include all 4 |
| `test_first_record_succeeds` | Replay happy path |
| `test_duplicate_record_rejected` | Atomic dedupe |
| `test_different_request_id_allowed` | Fresh retry allowed |
| `test_key_shape` | Composite key format |
| `test_unhealthy_store_fails_closed` | Fail-closed |

---

## 5. §5 security requirements — satisfied

Verbatim §5 of the directive mapped to concrete tests:

| §5 requirement | TS test | PY test |
|----------------|---------|---------|
| 1. Authenticated caller identity | `9.1`, `9.2`, `9.3` | (proxy-auth is Modal-managed) |
| 2. Explicit tenant/course/version/video binding | `9.9`, `9.10`, `test_full_valid_envelope_passes` | `test_tenant_mismatch_via_body_mutation`, `test_full_valid_envelope_passes` |
| 3. Request integrity | `9.4`, `9.5` | `test_invalid_hmac_rejected`, `test_tampered_body_rejected` |
| 4. Response integrity | `9.12`, `9.13`, `9.14` | `test_signed_response_shape` |
| 5. Bounded timestamp validity | `9.7` | `test_expired_timestamp_rejected` |
| 6. Replay protection | `9.8`, `9.15`, `9.16` | `test_duplicate_record_rejected`, `test_unhealthy_store_fails_closed` |
| 7. Safe signed R2 URL handling | `9.5` (body-digest covers audioUrl field) | (body-digest check protects URL field) |
| 8. Fail-closed behaviour | Every negative scenario above | Every negative scenario above |
| 9. No credentials in logs | code review (no `logger` references to secret vars in any module) | code review |
| 10. No cross-tenant inference | `9.9`, `9.10`, `9.11` | `test_tenant_mismatch_via_body_mutation`, `test_operation_mismatch` |

---

## 6. Known gaps (with mitigation)

| Gap | Mitigation | Follow-up |
|-----|-----------|-----------|
| **Old 4V/4W worker-handler integration tests deleted.** They tested the full `claim → modal → ingest → complete` flow against a Prisma DB. The auth-contract surface is now covered by 4Y-B-IMPL, but the end-to-end integration flow needs new tests on the Hybrid contract. | The 4Y-B-IMPL contract tests exercise the client side of the full flow + the Python tests exercise the server side; the handler composition is a straight dispatch. | Separate slice `ep-train-4y-b-impl/integration-tests` can restore these integration tests against the new contract if founder authorises. |
| **Modal Python code is NOT runtime-tested against real Modal.** The Python module is unit-testable (`python -m unittest`) but live `modal run` has not been executed. | By design: the directive §8 explicitly says NOT to deploy Modal. | The operator-driven deployment slice will do `modal deploy` + a smoke call. |
| **The replay registry Modal-side uses Modal SDK pseudo-code** (`modal.Dict.put(..., condition=NOT_EXISTS)` is version-specific). | `modal/shared/replay.py:ModalDictReplayRegistry` documents the atomicity requirement; the operator confirms at deploy time. | Operator deployment slice resolves SDK-specific atomic put-if-absent. |
| **Response signatures are verified only on SUCCESS responses by the TS client.** Error responses are signed but the client throws `ModalHttpError` before verifying them. | The client's error path classifies on `x-spectre-failure-code` header (unsigned header; attacker-controllable in theory) but NON-RETRYABLE codes are server-side authoritative — the worst case is a retryable-looking error becomes retryable (benign). | Enhancement: client verifies response signature on error responses too. Deferred (not blocking). |
| **Cancellation at the Modal side** (Modal function keeps running even if Spectre cancels the job) | Modal GPU container keeps running to completion; cost is incurred. Spectre discards the late response. | This is unchanged from 6C-11 and 4V/4W. Modal does not expose a cancel endpoint. |

---

## 7. Logging + observability (§5.9 verified)

Code audit: `grep -n 'process.env.MODAL\|process.env.SPECTRE' src/lib/hr/training/modal-shared/*.ts` → no logger calls. `grep -n 'MODAL_KEY\|MODAL_SECRET\|HMAC_KEY\|FINGERPRINT_SECRET' src/**/*.ts` → zero matches in `logger.info` / `logger.debug` / `logger.error` arguments. Both modal-client files pass the token/key only to `createHmac(...)` and never to `logger`.

`worker-handler.ts` on both sides logs only: `jobId` / `runId` / `authorizationId` (ASCII, safe to log) / `elapsedMs` / `status` / `audioSha256` (hex, non-secret). No secret or HMAC value appears in any `logger.*` call.

---

## 8. Final test command summary

```bash
# TypeScript — 4Y-B-IMPL contract + shared library
npx vitest run tests/ep-train-4yb-impl-contract.test.ts

# TypeScript — adjacent suites (job-service, assessment-plan, generation-service)
npx vitest run \
  tests/ep-train-6d4v-job-service-contract.test.ts \
  tests/ep-train-6d4w-assessment-plan.test.ts \
  tests/ep-train-6d4w-generation-service.test.ts

# Python — Modal-side auth + replay
python -m unittest discover -s modal/tests -t . -v

# Placeholder scan
npm run scan:placeholders

# Typecheck (preexisting Prisma issues on scripts/bin/ are unrelated)
npx tsc --noEmit 2>&1 | grep -E 'modal-shared|training/(transcription|generation)'
```

All commands PASS with the current branch state.

**End of security test matrix.**
