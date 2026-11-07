# EP-TRAIN-4Y-B-VERIFY — Cross-Language Verification

**Status:** OFFLINE VERIFICATION (2026-11-07). No live Modal, no GPU, no deploy.

**Directive §4:** *"Create one authoritative versioned test-vector fixture shared by TypeScript and Python. … Both implementations must independently produce identical expected bytes and signatures. Do not generate the expected values dynamically from either implementation during the test."*

---

## 1. Fixture

**File:** [tests/fixtures/ep-train-4yb-cross-language-vectors.json](../../../tests/fixtures/ep-train-4yb-cross-language-vectors.json)
**Fixture version:** `4yb-verify-v1`
**Contract version:** `4yb-v1`
**Generator (offline, Python stdlib only):** [tests/fixtures/gen-cross-language-vectors.py](../../../tests/fixtures/gen-cross-language-vectors.py)

The generator is deliberately INDEPENDENT of both production impls:

- Canonical bytes computed by `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)` — Python's stdlib JCS equivalent, NOT `modal.shared.auth.canonicalise`.
- HMAC-SHA-256 computed via `hmac` + `hashlib` — NOT either production helper.
- Base64url-nopad computed via `base64.urlsafe_b64encode(...).rstrip(b"=")` — NOT either production helper.

The fixture encodes **expected outputs** (canonical bytes, body digests, signatures, fingerprints) alongside the inputs. Neither production test re-derives expected values during the test — they load the fixture and assert `produced == expected`.

### 1.1 Vector inventory

| Category | Count | Covers |
|---|------:|---|
| Canonicalisation | 13 | sort order, nested, empty, null, booleans, zero/negative, ASCII escapes (`"`, `\n`, `\t`, `\\`), Unicode payload (incl. em-dash), array order preservation, deep nesting, same-content-different-input-order equivalence |
| Fingerprint | 1 | GENERATE auth-body fingerprint over all 14 bound fields |
| Request signing | 2 | TRANSCRIBE body + GENERATE body full envelopes with x-spectre-* signed-message format |
| Response signing | 1 | GENERATE response 200 with `response-sig-v1.{cv}.{op}.{reqId}.{status}.{bodyDigest}` binding |
| Timestamp boundary | 4 | ±300 s acceptance band (inclusive at ±300, reject at ±301) |
| Tamper | 2 | Mutated body yields different sha256; NaN/Infinity rejected |
| **Total vectors** | **23** | — |

Each category also implicitly tests secret-separation: the generator uses three distinct synthetic keys (request-HMAC, response-HMAC, fingerprint secret) and the production verifiers reject cross-secret substitution.

---

## 2. Loader suites

Both suites load the SAME fixture file and assert against the SAME expected values.

### 2.1 TypeScript loader — [tests/ep-train-4yb-cross-language.test.ts](../../../tests/ep-train-4yb-cross-language.test.ts)

- Uses PRODUCTION impls from `src/lib/hr/training/modal-shared/` ONLY.
- `canonicalise` → asserts bytes match `expectedCanonical`.
- `sha256HexOfCanonicalSync` → asserts hex matches `expectedSha256Hex`.
- `signRequest` → asserts both the signed headers AND the body text match.
- `verifyRequestSignature` → asserts the production verifier accepts the fixture bytes.
- `signResponse` / `verifyResponseSignature` → symmetric.
- `verifyPilotAuthorizationFingerprint` → fingerprint round-trip.
- Timestamp vectors exercise `verifyRequestSignature` with injected `Clock`.

**Run:** `npx vitest run tests/ep-train-4yb-cross-language.test.ts`

### 2.2 Python loader — [modal/tests/test_cross_language.py](../../../modal/tests/test_cross_language.py)

- Uses PRODUCTION `modal.shared.auth` ONLY.
- Symmetric assertions on `auth.canonicalise`, `auth.sha256_hex`, `auth.verify_request_signature`, `auth.sign_response`, `auth.verify_pilot_authorization`.
- Fixture-replay time (`FIXTURE_NOW_SEC = 1_762_521_900`, 5 min into the fixture's TTL window) so the fixture's PilotAuth doesn't look expired against wall-clock time.

**Run:** `python -m unittest modal.tests.test_cross_language -v`

---

## 3. Results

| Suite | Tests | Pass |
|---|---:|:-:|
| TypeScript — cross-language | 25 | 25 |
| Python — cross-language | 9 | 9 |
| **Total — cross-language** | **34** | **34** |

---

## 4. Byte-identical confirmation

Spot-check of three fixture rows comparing production TS output vs production Python output, both reading the SAME fixture:

### 4.1 Canonicalisation — `c13-same-content-different-input-order`

Input: `{"c": 3, "a": 1, "b": 2}`

- Expected (fixture): `{"a":1,"b":2,"c":3}` — SHA-256 `43258cff783fe7036d64a4262b3b78ea3f46cd9f5d75feca1f18acb0b74dd4fc`
- TS `canonicalise(...)` output: identical ✓
- Python `auth.canonicalise(...)` output: identical ✓

### 4.2 Request HMAC — `r1-transcribe-request`

Pre-computed signature (fixture): base64url, no padding.

- TS `signRequest(...).headers["x-spectre-signature"]`: identical ✓
- Python `hmac.new(key, signed_message, sha256).digest()` → `b64url_nopad`: identical ✓
- Python `verify_request_signature(...)`: accepts TS-produced headers ✓

### 4.3 Fingerprint — `f1-generate-auth-fingerprint`

Expected fingerprint (fixture): base64url, no padding of HMAC-SHA-256 over canonicalised auth-without-fingerprint.

- TS `createHmac("sha256", secret).update(canonicalise(...)).digest("base64url")`: identical ✓
- Python `b64url_nopad(hmac.new(secret, canonicalise(...).encode(...), sha256).digest())`: identical ✓
- TS `verifyPilotAuthorizationFingerprint(...)`: accepts Python-produced fingerprint ✓
- Python `verify_pilot_authorization(...)`: accepts TS-produced fingerprint ✓

---

## 5. ASCII / Unicode / escaping

### 5.1 ASCII escape fidelity — `c9-ascii-text`

Input: `{"text": 'hello "world"\n\t\\'}`

Both impls emit identical canonical bytes:
```
{"text":"hello \"world\"\n\t\\"}
```

### 5.2 Unicode preservation — `c10-unicode-payload`

Input: `{"q": "naïve café — résumé"}` (user-content field, allowed to carry Unicode).

Both impls emit identical UTF-8 bytes. The em-dash (U+2014) — which was the EP-TRAIN-6C-11 §4.2 compatibility incident — now canonicalises identically on both sides. The 4yb-v1 contract's ASCII guard applies ONLY to identity fields (`authorizationId`, `tenantId`, `operation`, `pilotRestrictions.scope`, `issuedBy`); user content like question text and transcripts legitimately carries Unicode.

### 5.3 Identity-scope em-dash rejection

Both impls raise on an em-dash in `pilotRestrictions.scope`:

- TS: `assertPrintableAscii` throws `TypeError`.
- Python: `assert_printable_ascii` raises `ContractError(FailureCode.ASCII_SCOPE_REQUIRED)`.

This is covered by fixture tamper vector `t2` AND existing Python `test_ascii_guard_rejects_em_dash_in_scope` AND existing TS `assertPrintableAscii: rejects em-dash`.

---

## 6. Timestamp boundary verification

Fixture encodes 4 vectors at the ±300s boundary (inclusive at exact boundary, reject at +1):

| Vector | Signed TS | Verifier Now | Expected | TS result | Python result |
|---|---:|---:|:-:|:-:|:-:|
| `ts1-at-boundary-plus-300` | 1 762 521 600 | 1 762 521 900 | ACCEPT | ✓ | ✓ |
| `ts2-just-outside-plus-301` | 1 762 521 600 | 1 762 521 901 | REJECT (TIMESTAMP_SKEW_EXCEEDED) | ✓ | ✓ |
| `ts3-at-boundary-minus-300` | 1 762 521 600 | 1 762 521 300 | ACCEPT | ✓ | ✓ |
| `ts4-just-outside-minus-301` | 1 762 521 600 | 1 762 521 299 | REJECT (TIMESTAMP_SKEW_EXCEEDED) | ✓ | ✓ |

Both impls honour the same inclusive band.

---

## 7. Known compatibility caveats

### 7.1 Error-response signing uses `request_id="unknown"` when envelope parse fails

If the Python endpoint fails `verify_request_envelope` **before** it can extract the body's `requestId`, it signs the error response with `request_id="unknown"`. A TS client that attempted to verify this error response would correctly raise `RESPONSE_REQUEST_ID_MISMATCH` (expecting the client's own request id).

This is documented as a known gap in the acceptance report (§9.17). **Verification note:** the TS client currently short-circuits on the unsigned `x-spectre-failure-code` HTTP header on non-2xx and does not call `verifyResponseSignature` on error paths. Combined with `request_id="unknown"` on the Python side, the error path is effectively UNSIGNED end-to-end today. The server-side error payload is signed cryptographically, but the client never validates that signature.

**Severity:** Medium. Attacker-controlled error codes do not widen authorization (the worst case is a retryable-looking code becomes retryable). The non-retryable classification lives in the TS worker handler and the server-side state is authoritative on success. But §5 of the directive says "Error responses follow the contract" — this is only true on the Python emitter side; the client does not enforce it. **Defers to deploy prerequisite, not a verification-slice blocker.**

### 7.2 Response body ordering is not canonical as transmitted

Python's `_handle_transcribe_request` (and the generate counterpart) build the response as `json.dumps(resp_body, separators=(",", ":"), ensure_ascii=False)` — NOT key-sorted. The TS client parses it and re-canonicalises for the digest comparison. This works because both `sign_response` and `verifyResponseSignature` canonicalise the parsed body for the digest; the raw transmitted bytes do not have to be canonical.

**Verification note:** This is a correct implementation of a canonical-digest-with-non-canonical-wire protocol. No action required.

### 7.3 Legacy 6C-11 operator path is not accepted by the new Python endpoint

The deploy-rollback runbook §5 states the Modal function "accepts requests WITHOUT `x-spectre-contract-version` as the legacy envelope". **The current Python code does not implement this:** `verify_request_signature` refuses when any required `x-spectre-*` header is missing. If deployed as-is, the 6C-11 workstation `generate-lite-run.mjs` would receive `REQUEST_HMAC_INVALID` and fail.

**Severity:** Documentation vs code divergence. Non-blocking for the verification slice (the directive §10 doesn't require backward-compat verification). **Must be reconciled** either by removing the runbook claim OR by adding a legacy-envelope path to the Python endpoint with an explicit test.

---

## 8. Conclusion

- Both production implementations produce byte-identical canonical bytes for all 23 fixture vectors.
- Both production verifiers accept artefacts produced by the OTHER language's production signer (cross-language round-trip).
- The ASCII/Unicode boundary — the 6C-11 em-dash incident — is now defended symmetrically.
- The fixture is versioned (`4yb-verify-v1`) so future contract changes can introduce a new fixture version without breaking the current verification.

**Cross-language verdict:** **PASS.** No byte-level divergence observed between TS and Python for canonicalisation, body digests, request HMAC, response HMAC, fingerprint, or timestamp-boundary semantics.

**End of cross-language verification.**
