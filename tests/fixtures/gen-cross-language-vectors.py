#!/usr/bin/env python3
"""EP-TRAIN-4Y-B-VERIFY § 4 — fixture generator for cross-language
test vectors.

Produces the canonical fixture JSON at:
  tests/fixtures/ep-train-4yb-cross-language-vectors.json

The fixture encodes INPUT values + EXPECTED outputs (canonical bytes,
body digests, HMAC signatures, fingerprint). Both the TypeScript
contract test and the Python contract test load this fixture and
ASSERT their production implementations produce identical bytes.

This generator is INDEPENDENT of either production impl:
  - It uses `json.dumps(sort_keys=True, separators=(',', ':'),
    ensure_ascii=False, allow_nan=False)` directly — i.e. the RFC-8785
    JCS canonicalisation primitive from the Python standard library,
    NOT `modal.shared.auth.canonicalise`.
  - HMAC + SHA via `hashlib` + `hmac` directly.

So production tests that load this fixture are NOT comparing a
module to itself. They are comparing production output to
externally-computed ground truth.

Run:
  cd c:/tmp/spectre-4yb-impl
  python tests/fixtures/gen-cross-language-vectors.py
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any


FIXTURE_VERSION = "4yb-verify-v1"

# Deterministic synthetic secrets — NOT production. 32 bytes each,
# ASCII-only so the fixture file renders cleanly. DO NOT reuse these
# in a real environment.
HMAC_KEY = b"test-request-hmac-key-0000000000"
RESPONSE_HMAC_KEY = b"test-response-hmac-key-000000000"
FINGERPRINT_SECRET = b"test-fingerprint-secret-00000000"


def canonicalise(value: Any) -> str:
    # RFC-8785 JCS equivalent on Python stdlib. ensure_ascii=False
    # keeps Unicode characters raw (UTF-8 encoded for hashing).
    # allow_nan=False refuses NaN/Infinity (matches TS TypeError).
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def b64url_nopad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def hmac_b64(key: bytes, msg: bytes) -> str:
    return b64url_nopad(hmac.new(key, msg, hashlib.sha256).digest())


# ---------------------------------------------------------------- vectors


def _canonical_vector(name: str, value: Any, description: str) -> dict:
    canonical = canonicalise(value)
    return {
        "name": name,
        "description": description,
        "input": value,
        "expectedCanonical": canonical,
        "expectedSha256Hex": sha256_hex(canonical),
    }


def build_canonical_vectors() -> list[dict]:
    """Covers canonicalisation primitives: key sort, empty, null,
    nested, Unicode, escaping, whitespace invariance across inputs."""
    return [
        _canonical_vector("c1-simple-sort", {"b": 1, "a": 2}, "sorted keys ascending"),
        _canonical_vector(
            "c2-nested-sort",
            {"z": [1, 2], "a": {"c": 1, "b": 2}},
            "nested object + array preservation",
        ),
        _canonical_vector("c3-empty-object", {}, "empty object"),
        _canonical_vector("c4-empty-array", [], "empty array"),
        _canonical_vector("c5-null-value", {"x": None, "y": 1}, "null preserved"),
        _canonical_vector("c6-boolean", {"ok": True, "no": False}, "booleans"),
        _canonical_vector("c7-zero-integer", {"n": 0}, "zero integer"),
        _canonical_vector("c8-negative-integer", {"n": -1}, "negative integer"),
        _canonical_vector(
            "c9-ascii-text",
            {"text": 'hello "world"\n\t\\'},
            "ASCII with double-quote, newline, tab, backslash — escapes correct",
        ),
        _canonical_vector(
            "c10-unicode-payload",
            {"q": "naïve café — résumé"},
            "Unicode user content allowed (not identity scope); "
            "em-dash present — both impls must emit same UTF-8 bytes",
        ),
        _canonical_vector(
            "c11-array-preserves-order",
            {"ids": [3, 1, 2]},
            "array element order preserved (not sorted)",
        ),
        _canonical_vector(
            "c12-deep-nested",
            {"a": {"b": {"c": {"d": [1, {"e": 2, "f": 3}]}}}},
            "deep nested structure, all keys sorted at every level",
        ),
        _canonical_vector(
            "c13-same-content-different-input-order",
            {"c": 3, "a": 1, "b": 2},
            "same semantic content as different input key order must canonicalise identically to {'a':1,'b':2,'c':3}",
        ),
    ]


def build_request_vectors() -> list[dict]:
    """Covers:
    - Body digest = sha256(canonicalise(body))
    - Request HMAC signed message = v1.{op}.{reqId}.{ts}.{bodyDigest}
    - Signature as base64url, no padding
    """
    now_sec = 1_762_521_600  # 2026-11-07T08:00:00Z, deterministic
    out: list[dict] = []

    # Vector 1 — TRANSCRIBE request body shape
    transcribe_auth = _signed_pilot_auth(
        operation_envelope="TRANSCRIBE_VIDEO",
        authorization_id="auth-vector-1",
        resolved_build_id="0" * 64,
        approved_grounding="0" * 64,
    )
    transcribe_body = {
        "contractVersion": "4yb-v1",
        "operation": "spectre.training.transcribe.v1",
        "requestId": "r-vector-1",
        "timestamp": str(now_sec),
        "pilotAuthorization": transcribe_auth,
        "payload": {
            "audioUrl": "https://r2.example/v.mp4?sig=xxx",
            "languageCode": "en",
            "modelVariant": "faster-whisper-large-v3",
        },
    }
    canonical_body = canonicalise(transcribe_body)
    body_digest = sha256_hex(canonical_body)
    signed_message = (
        f"v1.spectre.training.transcribe.v1.r-vector-1.{now_sec}.{body_digest}"
    ).encode("utf-8")
    signature = hmac_b64(HMAC_KEY, signed_message)
    out.append(
        {
            "name": "r1-transcribe-request",
            "description": "TRANSCRIBE request, placeholders present, fingerprint over auth bound-fields",
            "input": {
                "body": transcribe_body,
                "operation": "spectre.training.transcribe.v1",
                "requestId": "r-vector-1",
                "timestampSec": now_sec,
                "hmacKeyB64": base64.b64encode(HMAC_KEY).decode("ascii"),
            },
            "expectedCanonicalBody": canonical_body,
            "expectedBodyDigest": body_digest,
            "expectedSignedMessage": signed_message.decode("utf-8"),
            "expectedSignature": signature,
        }
    )

    # Vector 2 — GENERATE request body shape
    generate_auth = _signed_pilot_auth(
        operation_envelope="GENERATE_DRAFT_QUESTIONS",
        authorization_id="auth-vector-2",
        resolved_build_id="b" * 64,
        approved_grounding="c" * 64,
    )
    generate_body = {
        "contractVersion": "4yb-v1",
        "operation": "spectre.training.generate.v1",
        "requestId": "r-vector-2",
        "timestamp": str(now_sec),
        "pilotAuthorization": generate_auth,
        "payload": {
            "modelVariant": "qwen-2.5-7b-instruct-awq",
            "systemPrompt": "Generate 5 questions.",
            "transcript": "[0] welcome\n[1] rules",
            "constraints": {
                "proposalKind": "QUESTION_CHECKPOINT_BOUND",
                "maxQuestions": 5,
                "allowedQuestionTypes": ["SINGLE_CHOICE", "TRUE_FALSE"],
                "jsonSchema": {},
            },
        },
    }
    canonical_body2 = canonicalise(generate_body)
    body_digest2 = sha256_hex(canonical_body2)
    signed_message2 = (
        f"v1.spectre.training.generate.v1.r-vector-2.{now_sec}.{body_digest2}"
    ).encode("utf-8")
    signature2 = hmac_b64(HMAC_KEY, signed_message2)
    out.append(
        {
            "name": "r2-generate-request",
            "description": "GENERATE request, placeholders absent, fingerprint over distinct bound-fields",
            "input": {
                "body": generate_body,
                "operation": "spectre.training.generate.v1",
                "requestId": "r-vector-2",
                "timestampSec": now_sec,
                "hmacKeyB64": base64.b64encode(HMAC_KEY).decode("ascii"),
            },
            "expectedCanonicalBody": canonical_body2,
            "expectedBodyDigest": body_digest2,
            "expectedSignedMessage": signed_message2.decode("utf-8"),
            "expectedSignature": signature2,
        }
    )
    return out


def _signed_pilot_auth(
    *,
    operation_envelope: str,
    authorization_id: str,
    resolved_build_id: str,
    approved_grounding: str,
) -> dict:
    body = {
        "schemaVersion": "pilot-generation-authorization-v1",
        "authorizationId": authorization_id,
        "tenantId": "club-silver-springs",
        "courseId": "course:cmvzs3w05000456qcgfgps7gy",
        "versionId": "cmvzs3w05000456qcgfgps7gy",
        "sourceVideoSha256": "a" * 64,
        "resolvedTranscriptBuildId": resolved_build_id,
        "approvedGroundingProjectionSha256": approved_grounding,
        "operation": operation_envelope,
        "maxRequestedQuestions": 6 if operation_envelope == "GENERATE_DRAFT_QUESTIONS" else 1,
        "pilotRestrictions": {
            "publicationProhibited": True,
            "employeeAssignmentProhibited": True,
            "databaseWritesProhibited": False,
            "automaticRetriesProhibited": False,
            "excludedSegmentIds": [16, 17],
            "scope": "vector-fixture",
        },
        "issuedAtUtc": "2026-11-07T08:00:00.000Z",
        "expiresAtUtc": "2026-11-07T09:00:00.000Z",
        "issuedBy": "system:training",
    }
    fp = hmac_b64(FINGERPRINT_SECRET, canonicalise(body).encode("utf-8"))
    body["fingerprint"] = fp
    return body


def build_fingerprint_vectors() -> list[dict]:
    """Pure-fingerprint vectors — isolates HMAC-SHA-256 over
    canonicalised auth body (without fingerprint field)."""
    auth = {
        "schemaVersion": "pilot-generation-authorization-v1",
        "authorizationId": "auth-vector-fp",
        "tenantId": "club-silver-springs",
        "courseId": "course:cmvzs3w05000456qcgfgps7gy",
        "versionId": "cmvzs3w05000456qcgfgps7gy",
        "sourceVideoSha256": "a" * 64,
        "resolvedTranscriptBuildId": "b" * 64,
        "approvedGroundingProjectionSha256": "c" * 64,
        "operation": "GENERATE_DRAFT_QUESTIONS",
        "maxRequestedQuestions": 6,
        "pilotRestrictions": {
            "publicationProhibited": True,
            "employeeAssignmentProhibited": True,
            "databaseWritesProhibited": False,
            "automaticRetriesProhibited": False,
            "excludedSegmentIds": [16, 17],
            "scope": "vector-fixture",
        },
        "issuedAtUtc": "2026-11-07T08:00:00.000Z",
        "expiresAtUtc": "2026-11-07T09:00:00.000Z",
        "issuedBy": "system:training",
    }
    canonical = canonicalise(auth)
    fp = hmac_b64(FINGERPRINT_SECRET, canonical.encode("utf-8"))
    return [
        {
            "name": "f1-generate-auth-fingerprint",
            "description": "fingerprint = b64url_nopad(HMAC-SHA-256(fpSecret, canonicalise(authWithoutFingerprint)))",
            "input": {
                "authWithoutFingerprint": auth,
                "fingerprintSecretB64": base64.b64encode(FINGERPRINT_SECRET).decode("ascii"),
            },
            "expectedCanonicalAuth": canonical,
            "expectedFingerprint": fp,
        },
    ]


def build_response_vectors() -> list[dict]:
    """Response-HMAC vectors. Signed message is:
    response-sig-v1.{contractVersion}.{op}.{reqId}.{httpStatus}.{bodyDigest}"""
    resp_body = {
        "contractVersion": "4yb-v1",
        "operation": "spectre.training.generate.v1",
        "requestId": "r-vector-2",
        "modelVariant": "qwen-2.5-7b-instruct-awq",
        "proposals": [
            {
                "questionType": "SINGLE_CHOICE",
                "questionText": "What does the brand standard require?",
                "options": [{"text": "A", "isCorrect": True}, {"text": "B", "isCorrect": False}],
                "explanation": "See segment 2.",
                "sourceSegmentIds": [2],
            }
        ],
        "elapsedMs": {"coldBoot": 500, "generate": 1200},
        "tokenCounts": {"prompt": 800, "output": 300},
    }
    body_text = canonicalise(resp_body)
    body_digest = sha256_hex(body_text)
    signed_message = (
        f"response-sig-v1.4yb-v1.spectre.training.generate.v1.r-vector-2.200.{body_digest}"
    ).encode("utf-8")
    signature = hmac_b64(RESPONSE_HMAC_KEY, signed_message)
    return [
        {
            "name": "resp1-generate-200",
            "description": "response signed message binds contractVersion, operation, requestId, httpStatus, canonical body digest",
            "input": {
                "responseBody": resp_body,
                "operation": "spectre.training.generate.v1",
                "requestId": "r-vector-2",
                "httpStatus": 200,
                "responseHmacKeyB64": base64.b64encode(RESPONSE_HMAC_KEY).decode("ascii"),
            },
            "expectedCanonicalResponseBody": body_text,
            "expectedResponseBodyDigest": body_digest,
            "expectedResponseSignedMessage": signed_message.decode("utf-8"),
            "expectedResponseSignature": signature,
        },
    ]


def build_tamper_vectors() -> list[dict]:
    """Tamper vectors — negative cases. Both impls must REFUSE these."""
    return [
        {
            "name": "t1-tampered-body-digest-mismatches",
            "description": "if body is mutated post-signing, its sha256 differs from x-spectre-body-digest",
            "originalBody": {"a": 1, "b": 2},
            "mutatedBody": {"a": 1, "b": 3},
            "originalDigest": sha256_hex(canonicalise({"a": 1, "b": 2})),
            "mutatedDigest": sha256_hex(canonicalise({"a": 1, "b": 3})),
            "expectedDiffer": True,
        },
        {
            "name": "t2-nan-is-rejected",
            "description": "NaN / Infinity must be rejected by canonicalise (TS TypeError, Python ValueError)",
            "shouldThrow": True,
            "forbiddenInput": "NaN",
        },
    ]


def build_timestamp_vectors() -> list[dict]:
    """Timestamp-boundary vectors. ±300s window from the signer's
    clock view."""
    reference_now_sec = 1_762_521_600
    return [
        {
            "name": "ts1-at-boundary-plus-300",
            "signedTimestampSec": reference_now_sec,
            "verifierNowSec": reference_now_sec + 300,
            "expectedValid": True,
        },
        {
            "name": "ts2-just-outside-plus-301",
            "signedTimestampSec": reference_now_sec,
            "verifierNowSec": reference_now_sec + 301,
            "expectedValid": False,
        },
        {
            "name": "ts3-at-boundary-minus-300",
            "signedTimestampSec": reference_now_sec,
            "verifierNowSec": reference_now_sec - 300,
            "expectedValid": True,
        },
        {
            "name": "ts4-just-outside-minus-301",
            "signedTimestampSec": reference_now_sec,
            "verifierNowSec": reference_now_sec - 301,
            "expectedValid": False,
        },
    ]


def main() -> None:
    fixture = {
        "fixtureVersion": FIXTURE_VERSION,
        "contractVersion": "4yb-v1",
        "notes": [
            "All expected values pre-computed OFFLINE with Python stdlib.",
            "Neither production module (TS canonicalise / Python auth.canonicalise) is used by this generator.",
            "Tests MUST load this fixture and assert their production output == these values.",
            "Secrets here are synthetic test keys — not production.",
        ],
        "canonicalisationVectors": build_canonical_vectors(),
        "fingerprintVectors": build_fingerprint_vectors(),
        "requestSigningVectors": build_request_vectors(),
        "responseSigningVectors": build_response_vectors(),
        "timestampBoundaryVectors": build_timestamp_vectors(),
        "tamperVectors": build_tamper_vectors(),
        "syntheticKeys": {
            "hmacKeyB64": base64.b64encode(HMAC_KEY).decode("ascii"),
            "responseHmacKeyB64": base64.b64encode(RESPONSE_HMAC_KEY).decode("ascii"),
            "fingerprintSecretB64": base64.b64encode(FINGERPRINT_SECRET).decode("ascii"),
        },
    }
    out_path = os.path.join(os.path.dirname(__file__), "ep-train-4yb-cross-language-vectors.json")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {out_path}")
    print(
        "counts:",
        {
            "canonicalisation": len(fixture["canonicalisationVectors"]),
            "fingerprint": len(fixture["fingerprintVectors"]),
            "requestSigning": len(fixture["requestSigningVectors"]),
            "responseSigning": len(fixture["responseSigningVectors"]),
            "timestampBoundary": len(fixture["timestampBoundaryVectors"]),
            "tamper": len(fixture["tamperVectors"]),
        },
    )


if __name__ == "__main__":
    main()
