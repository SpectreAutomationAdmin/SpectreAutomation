"""EP-TRAIN-4Y-B-IMPL — Python-side auth unit tests.

Run with:
    python -m unittest discover -s modal/tests -v

No Modal install required. No live Modal call. These exercise the
Modal-side verification logic directly.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import unittest

from ..shared import auth
from ..shared.errors import ContractError, FailureCode


FIXTURE_HMAC_KEY = b"test-hmac-key-32-bytes-0000000000"
FIXTURE_FINGERPRINT_SECRET = b"test-fingerprint-secret-00000000"
FIXTURE_RESPONSE_HMAC_KEY = b"test-response-hmac-key-0000000000"


def _fresh_pilot_auth(*, operation: str = auth.PILOT_AUTH_OP_GENERATE, ttl: int = 3600, **overrides) -> dict:
    """Build a signed PilotAuthorizationV1 dict as issued by the
    Spectre TypeScript side."""
    now = int(time.time())
    body = {
        "schemaVersion": auth.PILOT_AUTH_SCHEMA,
        "authorizationId": overrides.get("authorizationId", "auth-abc-123"),
        "tenantId": overrides.get("tenantId", "club-silver-springs"),
        "courseId": overrides.get("courseId", "course:cmvzs3w05000456qcgfgps7gy"),
        "versionId": overrides.get("versionId", "cmvzs3w05000456qcgfgps7gy"),
        "sourceVideoSha256": overrides.get("sourceVideoSha256", "a" * 64),
        "resolvedTranscriptBuildId": overrides.get("resolvedTranscriptBuildId", "b" * 64),
        "approvedGroundingProjectionSha256": overrides.get("approvedGroundingProjectionSha256", "c" * 64),
        "operation": operation,
        "maxRequestedQuestions": overrides.get("maxRequestedQuestions", 6),
        "pilotRestrictions": overrides.get(
            "pilotRestrictions",
            {
                "publicationProhibited": True,
                "employeeAssignmentProhibited": True,
                "databaseWritesProhibited": False,
                "automaticRetriesProhibited": False,
                "excludedSegmentIds": [16, 17],
                "scope": "test-scope",
            },
        ),
        "issuedAtUtc": overrides.get("issuedAtUtc", auth.canonicalise(now)) if False else "2026-11-07T00:00:00.000Z",
        "expiresAtUtc": overrides.get("expiresAtUtc", _iso_in_future(ttl)),
        "issuedBy": overrides.get("issuedBy", "system:training"),
    }
    fp = auth.b64url_nopad(
        hmac.new(
            FIXTURE_FINGERPRINT_SECRET,
            auth.canonicalise(body).encode("utf-8"),
            hashlib.sha256,
        ).digest()
    )
    body["fingerprint"] = fp
    return body


def _iso_in_future(seconds: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(tz=timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _sign_request(
    *,
    operation: str,
    request_id: str,
    pilot_authorization: dict,
    payload: dict,
    hmac_key: bytes = FIXTURE_HMAC_KEY,
    timestamp_override: int | None = None,
):
    ts = str(timestamp_override if timestamp_override is not None else int(time.time()))
    body = {
        "contractVersion": auth.CONTRACT_VERSION,
        "operation": operation,
        "requestId": request_id,
        "timestamp": ts,
        "pilotAuthorization": pilot_authorization,
        "payload": payload,
    }
    body_text = auth.canonicalise(body)
    body_digest = auth.sha256_hex(body_text)
    signed_message = f"{auth.SIG_VERSION}.{operation}.{request_id}.{ts}.{body_digest}".encode("utf-8")
    sig = auth.b64url_nopad(hmac.new(hmac_key, signed_message, hashlib.sha256).digest())
    headers = {
        "x-spectre-sig-version": auth.SIG_VERSION,
        "x-spectre-operation": operation,
        "x-spectre-request-id": request_id,
        "x-spectre-timestamp": ts,
        "x-spectre-body-digest": body_digest,
        "x-spectre-signature": sig,
        "x-spectre-contract-version": auth.CONTRACT_VERSION,
    }
    return headers, body_text


class CanonicaliseTest(unittest.TestCase):
    def test_sorted_key_output(self):
        self.assertEqual(auth.canonicalise({"b": 1, "a": 2}), '{"a":2,"b":1}')

    def test_nested_sort(self):
        self.assertEqual(
            auth.canonicalise({"z": [1, 2], "a": {"c": 1, "b": 2}}),
            '{"a":{"b":2,"c":1},"z":[1,2]}',
        )

    def test_non_ascii_strings_pass(self):
        # User content may carry Unicode.
        self.assertEqual(auth.canonicalise({"q": "naïve"}), '{"q":"naïve"}')

    def test_ascii_guard_rejects_em_dash_in_scope(self):
        with self.assertRaises(ContractError) as ctx:
            auth.assert_printable_ascii("pilotRestrictions.scope", "EP — em-dash")
        self.assertEqual(ctx.exception.code, FailureCode.ASCII_SCOPE_REQUIRED)


class RequestSignatureTest(unittest.TestCase):
    def test_valid_request_passes(self):
        pa = _fresh_pilot_auth(operation=auth.PILOT_AUTH_OP_GENERATE)
        hdrs, body_text = _sign_request(
            operation=auth.OPERATION_GENERATE,
            request_id="req-123",
            pilot_authorization=pa,
            payload={"x": 1},
        )
        result = auth.verify_request_signature(
            headers=hdrs,
            body_text=body_text,
            hmac_key=FIXTURE_HMAC_KEY,
            now_sec=int(time.time()),
        )
        self.assertEqual(result["operation"], auth.OPERATION_GENERATE)
        self.assertEqual(result["request_id"], "req-123")

    def test_invalid_hmac_rejected(self):
        pa = _fresh_pilot_auth()
        hdrs, body_text = _sign_request(
            operation=auth.OPERATION_GENERATE,
            request_id="req-456",
            pilot_authorization=pa,
            payload={},
        )
        bad = dict(hdrs)
        bad["x-spectre-signature"] = "A" * 43
        with self.assertRaises(ContractError) as ctx:
            auth.verify_request_signature(
                headers=bad,
                body_text=body_text,
                hmac_key=FIXTURE_HMAC_KEY,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.REQUEST_HMAC_INVALID)

    def test_tampered_body_rejected(self):
        pa = _fresh_pilot_auth()
        hdrs, body_text = _sign_request(
            operation=auth.OPERATION_GENERATE,
            request_id="req-789",
            pilot_authorization=pa,
            payload={},
        )
        tampered = body_text.replace('"payload":{}', '"payload":{"evil":true}')
        with self.assertRaises(ContractError) as ctx:
            auth.verify_request_signature(
                headers=hdrs,
                body_text=tampered,
                hmac_key=FIXTURE_HMAC_KEY,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.REQUEST_HMAC_INVALID)

    def test_expired_timestamp_rejected(self):
        pa = _fresh_pilot_auth()
        hdrs, body_text = _sign_request(
            operation=auth.OPERATION_GENERATE,
            request_id="req-ts",
            pilot_authorization=pa,
            payload={},
            timestamp_override=1_000_000_000,
        )
        with self.assertRaises(ContractError) as ctx:
            auth.verify_request_signature(
                headers=hdrs,
                body_text=body_text,
                hmac_key=FIXTURE_HMAC_KEY,
                now_sec=1_000_000_000 + 400,
            )
        self.assertEqual(ctx.exception.code, FailureCode.TIMESTAMP_SKEW_EXCEEDED)

    def test_unknown_operation_rejected(self):
        hdrs = {
            "x-spectre-sig-version": auth.SIG_VERSION,
            "x-spectre-operation": "spectre.unknown.v1",
            "x-spectre-request-id": "r",
            "x-spectre-timestamp": str(int(time.time())),
            "x-spectre-body-digest": auth.sha256_hex("{}"),
            "x-spectre-signature": "x" * 43,
            "x-spectre-contract-version": auth.CONTRACT_VERSION,
        }
        with self.assertRaises(ContractError) as ctx:
            auth.verify_request_signature(
                headers=hdrs,
                body_text="{}",
                hmac_key=FIXTURE_HMAC_KEY,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.UNKNOWN_OPERATION)


class PilotAuthorizationTest(unittest.TestCase):
    def test_valid_fingerprint_passes(self):
        pa_dict = _fresh_pilot_auth(operation=auth.PILOT_AUTH_OP_GENERATE)
        parsed = auth.parse_pilot_authorization(pa_dict)
        auth.verify_pilot_authorization(
            parsed,
            fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
            operation=auth.OPERATION_GENERATE,
            now_sec=int(time.time()),
        )

    def test_tampered_fingerprint_rejected(self):
        pa_dict = _fresh_pilot_auth()
        pa_dict["fingerprint"] = base64.urlsafe_b64encode(b"X" * 32).rstrip(b"=").decode("ascii")
        parsed = auth.parse_pilot_authorization(pa_dict)
        with self.assertRaises(ContractError) as ctx:
            auth.verify_pilot_authorization(
                parsed,
                fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
                operation=auth.OPERATION_GENERATE,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.PILOT_AUTH_FINGERPRINT_MISMATCH)

    def test_transcribe_requires_placeholders(self):
        # Build a GENERATE-shaped auth and try to use it for TRANSCRIBE.
        pa_dict = _fresh_pilot_auth(operation=auth.PILOT_AUTH_OP_TRANSCRIBE)
        parsed = auth.parse_pilot_authorization(pa_dict)
        # resolvedTranscriptBuildId = 'b'*64 != placeholder.
        with self.assertRaises(ContractError) as ctx:
            auth.verify_pilot_authorization(
                parsed,
                fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
                operation=auth.OPERATION_TRANSCRIBE,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.PILOT_AUTH_SCHEMA_MISMATCH)

    def test_generate_rejects_placeholders(self):
        pa_dict = _fresh_pilot_auth(
            operation=auth.PILOT_AUTH_OP_GENERATE,
            resolvedTranscriptBuildId="0" * 64,
        )
        parsed = auth.parse_pilot_authorization(pa_dict)
        with self.assertRaises(ContractError) as ctx:
            auth.verify_pilot_authorization(
                parsed,
                fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
                operation=auth.OPERATION_GENERATE,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.PILOT_AUTH_SCHEMA_MISMATCH)

    def test_operation_mismatch(self):
        pa_dict = _fresh_pilot_auth(operation=auth.PILOT_AUTH_OP_GENERATE)
        parsed = auth.parse_pilot_authorization(pa_dict)
        with self.assertRaises(ContractError) as ctx:
            auth.verify_pilot_authorization(
                parsed,
                fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
                operation=auth.OPERATION_TRANSCRIBE,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.PILOT_AUTH_OPERATION_MISMATCH)

    def test_expired_auth_rejected(self):
        pa_dict = _fresh_pilot_auth(expiresAtUtc="2000-01-01T00:00:00.000Z")
        # Need to re-sign fingerprint after mutating expiresAtUtc.
        body = {k: v for k, v in pa_dict.items() if k != "fingerprint"}
        pa_dict["fingerprint"] = auth.b64url_nopad(
            hmac.new(FIXTURE_FINGERPRINT_SECRET, auth.canonicalise(body).encode("utf-8"), hashlib.sha256).digest()
        )
        parsed = auth.parse_pilot_authorization(pa_dict)
        with self.assertRaises(ContractError) as ctx:
            auth.verify_pilot_authorization(
                parsed,
                fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
                operation=auth.OPERATION_GENERATE,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.PILOT_AUTH_EXPIRED)


class ResponseSigningTest(unittest.TestCase):
    def test_signed_response_shape(self):
        hdrs = auth.sign_response(
            operation=auth.OPERATION_GENERATE,
            request_id="req-x",
            http_status=200,
            body_text='{"ok":true}',
            response_hmac_key=FIXTURE_RESPONSE_HMAC_KEY,
        )
        self.assertEqual(hdrs["x-spectre-contract-version"], auth.CONTRACT_VERSION)
        self.assertEqual(hdrs["x-spectre-response-operation"], auth.OPERATION_GENERATE)
        self.assertEqual(hdrs["x-spectre-response-request-id"], "req-x")
        # Signature is a 43-char base64url (no padding) of 32 bytes.
        self.assertEqual(len(hdrs["x-spectre-response-signature"]), 43)


class EnvelopeIntegrationTest(unittest.TestCase):
    def test_full_valid_envelope_passes(self):
        pa = _fresh_pilot_auth(operation=auth.PILOT_AUTH_OP_GENERATE)
        hdrs, body_text = _sign_request(
            operation=auth.OPERATION_GENERATE,
            request_id="req-integration",
            pilot_authorization=pa,
            payload={"ok": True},
        )
        parsed_auth, body = auth.verify_request_envelope(
            headers=hdrs,
            body_text=body_text,
            hmac_key=FIXTURE_HMAC_KEY,
            fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
            expected_operation=auth.OPERATION_GENERATE,
            now_sec=int(time.time()),
        )
        self.assertEqual(parsed_auth.operation, auth.PILOT_AUTH_OP_GENERATE)
        self.assertEqual(body["requestId"], "req-integration")

    def test_tenant_mismatch_via_body_mutation(self):
        # Mutate the pilot auth's tenantId to something the fingerprint
        # won't cover. Fingerprint check should catch it.
        pa = _fresh_pilot_auth()
        pa["tenantId"] = "club-attacker"  # fingerprint now stale
        hdrs, body_text = _sign_request(
            operation=auth.OPERATION_GENERATE,
            request_id="req-tenant",
            pilot_authorization=pa,
            payload={},
        )
        with self.assertRaises(ContractError) as ctx:
            auth.verify_request_envelope(
                headers=hdrs,
                body_text=body_text,
                hmac_key=FIXTURE_HMAC_KEY,
                fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
                expected_operation=auth.OPERATION_GENERATE,
                now_sec=int(time.time()),
            )
        self.assertEqual(ctx.exception.code, FailureCode.PILOT_AUTH_FINGERPRINT_MISMATCH)


if __name__ == "__main__":
    unittest.main()
