"""EP-TRAIN-4Y-B-VERIFY §4 — cross-language test vectors (Python side).

Loads tests/fixtures/ep-train-4yb-cross-language-vectors.json and
asserts that the PRODUCTION Python implementation
(modal.shared.auth.canonicalise / verify_request_signature / sign_response /
verify_pilot_authorization) produces output byte-identical to the
fixture's pre-computed values.

The fixture is produced OFFLINE by
`tests/fixtures/gen-cross-language-vectors.py` using Python stdlib
JCS canonicalisation — NEVER using either production impl's own
functions. The sibling TypeScript suite
(`tests/ep-train-4yb-cross-language.test.ts`) loads the SAME fixture
and runs the SAME assertions against production TS. If both pass,
TS + Python are byte-compatible for every covered scenario.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import unittest
from typing import Any

from ..shared import auth
from ..shared.errors import ContractError, FailureCode


FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "tests", "fixtures",
    "ep-train-4yb-cross-language-vectors.json",
)


def _load_fixture() -> dict:
    with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _from_b64(s: str) -> bytes:
    return base64.b64decode(s)


FIXTURE = _load_fixture()

# The fixture pins issuedAtUtc = 2026-11-07T08:00:00Z and TTL = 1h.
# All verifier `now_sec` calls that depend on PilotAuthorization TTL
# must sit inside that window; otherwise the verifier correctly
# rejects as PILOT_AUTH_EXPIRED. This is a fixture-replay time, not
# wall-clock time.
FIXTURE_NOW_SEC = 1_762_521_900  # 2026-11-07T08:05:00Z (5 min into TTL)


class FixtureVersionTest(unittest.TestCase):
    def test_pinned_version(self):
        self.assertEqual(FIXTURE["fixtureVersion"], "4yb-verify-v1")
        self.assertEqual(FIXTURE["contractVersion"], auth.CONTRACT_VERSION)


class CrossLanguageCanonicalisationTest(unittest.TestCase):
    def test_all_canonicalisation_vectors(self):
        for v in FIXTURE["canonicalisationVectors"]:
            with self.subTest(name=v["name"]):
                produced = auth.canonicalise(v["input"])
                self.assertEqual(produced, v["expectedCanonical"], msg=f"canonical mismatch for {v['name']}")
                self.assertEqual(
                    auth.sha256_hex(produced),
                    v["expectedSha256Hex"],
                    msg=f"sha256 mismatch for {v['name']}",
                )


class CrossLanguageFingerprintTest(unittest.TestCase):
    def test_fingerprint_vectors(self):
        for v in FIXTURE["fingerprintVectors"]:
            with self.subTest(name=v["name"]):
                key = _from_b64(v["input"]["fingerprintSecretB64"])
                canonical = auth.canonicalise(v["input"]["authWithoutFingerprint"])
                self.assertEqual(canonical, v["expectedCanonicalAuth"])
                produced = auth.b64url_nopad(
                    hmac.new(key, canonical.encode("utf-8"), hashlib.sha256).digest()
                )
                self.assertEqual(produced, v["expectedFingerprint"])

                # Full production verifier chain.
                full_auth = {**v["input"]["authWithoutFingerprint"], "fingerprint": produced}
                parsed = auth.parse_pilot_authorization(full_auth)
                # verify_pilot_authorization enforces TTL + operation + fingerprint.
                auth.verify_pilot_authorization(
                    parsed,
                    fingerprint_secret=key,
                    operation=auth.OPERATION_GENERATE,
                    now_sec=FIXTURE_NOW_SEC,
                )


class CrossLanguageRequestSigningTest(unittest.TestCase):
    def test_request_signing_vectors(self):
        for v in FIXTURE["requestSigningVectors"]:
            with self.subTest(name=v["name"]):
                key = _from_b64(v["input"]["hmacKeyB64"])
                body = v["input"]["body"]
                body_text = auth.canonicalise(body)
                self.assertEqual(body_text, v["expectedCanonicalBody"])
                body_digest = auth.sha256_hex(body_text)
                self.assertEqual(body_digest, v["expectedBodyDigest"])

                signed_message = (
                    f"{auth.SIG_VERSION}.{v['input']['operation']}."
                    f"{v['input']['requestId']}.{v['input']['timestampSec']}.{body_digest}"
                ).encode("utf-8")
                self.assertEqual(signed_message.decode("utf-8"), v["expectedSignedMessage"])
                sig = auth.b64url_nopad(hmac.new(key, signed_message, hashlib.sha256).digest())
                self.assertEqual(sig, v["expectedSignature"])

                # Full production verifier chain.
                headers = {
                    "x-spectre-sig-version": auth.SIG_VERSION,
                    "x-spectre-operation": v["input"]["operation"],
                    "x-spectre-request-id": v["input"]["requestId"],
                    "x-spectre-timestamp": str(v["input"]["timestampSec"]),
                    "x-spectre-body-digest": body_digest,
                    "x-spectre-signature": sig,
                    "x-spectre-contract-version": auth.CONTRACT_VERSION,
                }
                parsed = auth.verify_request_signature(
                    headers=headers,
                    body_text=body_text,
                    hmac_key=key,
                    now_sec=v["input"]["timestampSec"],  # replay-time matches signing-time
                )
                self.assertEqual(parsed["operation"], v["input"]["operation"])


class CrossLanguageResponseSigningTest(unittest.TestCase):
    def test_response_signing_vectors(self):
        for v in FIXTURE["responseSigningVectors"]:
            with self.subTest(name=v["name"]):
                key = _from_b64(v["input"]["responseHmacKeyB64"])
                body_text = auth.canonicalise(v["input"]["responseBody"])
                self.assertEqual(body_text, v["expectedCanonicalResponseBody"])
                body_digest = auth.sha256_hex(body_text)
                self.assertEqual(body_digest, v["expectedResponseBodyDigest"])

                # Production signer.
                hdrs = auth.sign_response(
                    operation=v["input"]["operation"],
                    request_id=v["input"]["requestId"],
                    http_status=v["input"]["httpStatus"],
                    body_text=body_text,
                    response_hmac_key=key,
                )
                self.assertEqual(hdrs["x-spectre-response-signature"], v["expectedResponseSignature"])


class CrossLanguageTimestampBoundaryTest(unittest.TestCase):
    """Each vector exercises the production verify_request_signature
    with a specific signed-ts + verifier-now gap."""

    def test_timestamp_vectors(self):
        key = _from_b64(FIXTURE["syntheticKeys"]["hmacKeyB64"])
        for v in FIXTURE["timestampBoundaryVectors"]:
            with self.subTest(name=v["name"]):
                signed_ts = v["signedTimestampSec"]
                body = {
                    "contractVersion": "4yb-v1",
                    "operation": "spectre.training.transcribe.v1",
                    "requestId": "r-py-boundary",
                    "timestamp": str(signed_ts),
                    "pilotAuthorization": {},
                    "payload": {},
                }
                body_text = auth.canonicalise(body)
                body_digest = auth.sha256_hex(body_text)
                signed_message = (
                    f"v1.spectre.training.transcribe.v1.r-py-boundary.{signed_ts}.{body_digest}"
                ).encode("utf-8")
                sig = auth.b64url_nopad(hmac.new(key, signed_message, hashlib.sha256).digest())
                hdrs = {
                    "x-spectre-sig-version": auth.SIG_VERSION,
                    "x-spectre-operation": "spectre.training.transcribe.v1",
                    "x-spectre-request-id": "r-py-boundary",
                    "x-spectre-timestamp": str(signed_ts),
                    "x-spectre-body-digest": body_digest,
                    "x-spectre-signature": sig,
                    "x-spectre-contract-version": auth.CONTRACT_VERSION,
                }
                if v["expectedValid"]:
                    parsed = auth.verify_request_signature(
                        headers=hdrs,
                        body_text=body_text,
                        hmac_key=key,
                        now_sec=v["verifierNowSec"],
                    )
                    self.assertEqual(parsed["request_id"], "r-py-boundary")
                else:
                    with self.assertRaises(ContractError) as ctx:
                        auth.verify_request_signature(
                            headers=hdrs,
                            body_text=body_text,
                            hmac_key=key,
                            now_sec=v["verifierNowSec"],
                        )
                    self.assertEqual(ctx.exception.code, FailureCode.TIMESTAMP_SKEW_EXCEEDED)


class CrossLanguageTamperTest(unittest.TestCase):
    def test_mutated_body_differs(self):
        a = auth.sha256_hex_of_canonical({"a": 1, "b": 2})
        b = auth.sha256_hex_of_canonical({"a": 1, "b": 3})
        self.assertNotEqual(a, b)

    def test_nan_rejected(self):
        with self.assertRaises(ValueError):
            auth.canonicalise({"bad": float("nan")})
        with self.assertRaises(ValueError):
            auth.canonicalise({"bad": float("inf")})

    def test_em_dash_rejected_by_scope_guard(self):
        with self.assertRaises(ContractError) as ctx:
            auth.assert_printable_ascii("pilotRestrictions.scope", "EP — em-dash")
        self.assertEqual(ctx.exception.code, FailureCode.ASCII_SCOPE_REQUIRED)


if __name__ == "__main__":
    unittest.main()
