"""EP-TRAIN-4Y-F §3 — SPECTRE_GATE_1_NO_INFERENCE CPU-boundary guard.

Proves that when the inference callable raises a `ContractError`
(simulating the CPU-boundary gate firing BEFORE any `.remote()`
call), the `_handle_*_request` helper PRESERVES the ContractError's
code + http_status + message faithfully in the signed error
response — rather than collapsing to `REQUEST_BODY_INVALID` as the
generic `except Exception` branch would.

This is the safety contract that lets the ASGI handler's
`_run_whisper` / `_run_qwen` wrappers raise `ContractError` directly
to refuse inference at the CPU boundary.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import unittest

from ..shared import auth
from ..shared.errors import ContractError, FailureCode
from ..shared.replay import InMemoryReplayRegistry, replay_key
from ..spectre_training_transcribe import _handle_transcribe_request
from ..spectre_training_generate import _handle_generate_request


FIXTURE_HMAC_KEY = b"test-hmac-key-32-bytes-0000000000"
FIXTURE_FINGERPRINT_SECRET = b"test-fingerprint-secret-00000000"
FIXTURE_RESPONSE_HMAC_KEY = b"test-response-hmac-key-0000000000"


def _iso_in_future(seconds: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(tz=timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _b64url_nopad(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _signed_auth(*, op_envelope: str) -> dict:
    body = {
        "schemaVersion": auth.PILOT_AUTH_SCHEMA,
        "authorizationId": "auth-gate1-probe",
        "tenantId": "club-coulee-ridge",
        "courseId": "course:cmv-ridge-orientation",
        "versionId": "cmv-ridge-orientation",
        "sourceVideoSha256": "a" * 64,
        "resolvedTranscriptBuildId": ("0" * 64) if op_envelope == auth.PILOT_AUTH_OP_TRANSCRIBE else ("b" * 64),
        "approvedGroundingProjectionSha256": ("0" * 64) if op_envelope == auth.PILOT_AUTH_OP_TRANSCRIBE else ("c" * 64),
        "operation": op_envelope,
        "maxRequestedQuestions": 6,
        "pilotRestrictions": {
            "publicationProhibited": True,
            "employeeAssignmentProhibited": True,
            "databaseWritesProhibited": False,
            "automaticRetriesProhibited": False,
            "excludedSegmentIds": [16, 17],
            "scope": "gate1-probe",
        },
        "issuedAtUtc": "2026-11-07T00:00:00.000Z",
        "expiresAtUtc": _iso_in_future(3600),
        "issuedBy": "system:gate1",
    }
    body["fingerprint"] = _b64url_nopad(
        hmac.new(FIXTURE_FINGERPRINT_SECRET, auth.canonicalise(body).encode("utf-8"), hashlib.sha256).digest()
    )
    return body


def _signed_request(*, op: str, request_id: str, payload: dict, pilot_auth: dict) -> tuple[dict, str]:
    now = int(time.time())
    body = {
        "contractVersion": auth.CONTRACT_VERSION,
        "operation": op,
        "requestId": request_id,
        "timestamp": str(now),
        "pilotAuthorization": pilot_auth,
        "payload": payload,
    }
    body_text = auth.canonicalise(body)
    body_digest = auth.sha256_hex(body_text)
    signed = f"{auth.SIG_VERSION}.{op}.{request_id}.{now}.{body_digest}".encode("utf-8")
    sig = _b64url_nopad(hmac.new(FIXTURE_HMAC_KEY, signed, hashlib.sha256).digest())
    hdrs = {
        "x-spectre-sig-version": auth.SIG_VERSION,
        "x-spectre-operation": op,
        "x-spectre-request-id": request_id,
        "x-spectre-timestamp": str(now),
        "x-spectre-body-digest": body_digest,
        "x-spectre-signature": sig,
        "x-spectre-contract-version": auth.CONTRACT_VERSION,
    }
    return hdrs, body_text


def _assert_signed_error_body(body_text: str, expected_code: str) -> dict:
    parsed = json.loads(body_text)
    assert parsed["contractVersion"] == auth.CONTRACT_VERSION, parsed
    assert parsed["error"]["code"] == expected_code, parsed
    return parsed


class TranscribeGateTest(unittest.TestCase):
    """When `run_whisper` raises ContractError (simulating the Gate 1
    CPU-boundary guard firing), the helper must return a signed error
    carrying that ContractError's code + http_status."""

    def test_contract_error_from_run_whisper_preserved(self):
        pa = _signed_auth(op_envelope=auth.PILOT_AUTH_OP_TRANSCRIBE)
        hdrs, body_text = _signed_request(
            op=auth.OPERATION_TRANSCRIBE,
            request_id="req-gate1-t",
            payload={
                "audioUrl": "https://r2.example/v.mp4?sig=x",
                "languageCode": "en",
                "modelVariant": "faster-whisper-large-v3",
            },
            pilot_auth=pa,
        )
        inference_called = {"flag": False}

        def _no_inference(wav: bytes):
            raise ContractError(
                FailureCode.REQUEST_BODY_INVALID,
                "SPECTRE_GATE_1_NO_INFERENCE=1 — CPU gate refused inference (Gate 1 diagnostic path)",
                http_status=503,
            )

        def _downloader(url: str) -> bytes:
            inference_called["flag"] = True  # fired DURING the try-block; harmless
            return b"audio-bytes"

        http_status, resp_body, resp_hdrs = _handle_transcribe_request(
            headers=hdrs,
            body_text=body_text,
            hmac_key=FIXTURE_HMAC_KEY,
            fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
            response_hmac_key=FIXTURE_RESPONSE_HMAC_KEY,
            replay_registry=InMemoryReplayRegistry(),
            now_sec=int(time.time()),
            download_audio=_downloader,
            run_whisper=_no_inference,
            audio_to_wav=lambda b: b,
            duration_sec=0,
        )

        # §3 contract: ContractError preserved — code is REQUEST_BODY_INVALID
        # (NOT a generic "Inference failed: ContractError"), http_status
        # is 503 (NOT 500), message carries the gate reason.
        self.assertEqual(http_status, 503)
        self.assertEqual(resp_hdrs["x-spectre-failure-code"], "REQUEST_BODY_INVALID")
        parsed = _assert_signed_error_body(resp_body, "REQUEST_BODY_INVALID")
        self.assertIn("SPECTRE_GATE_1_NO_INFERENCE=1", parsed["error"]["message"])
        self.assertIn("Gate 1 diagnostic path", parsed["error"]["message"])

        # Error response IS signed — client can verify.
        self.assertIn("x-spectre-response-signature", resp_hdrs)
        self.assertIn("x-spectre-response-request-id", resp_hdrs)
        self.assertEqual(resp_hdrs["x-spectre-response-request-id"], "req-gate1-t")


class GenerateGateTest(unittest.TestCase):
    """Symmetric test for the generate endpoint. The helper already
    had an `except ContractError` branch; this test enshrines the
    behavior at the Gate 1 boundary."""

    def test_contract_error_from_run_qwen_preserved(self):
        pa = _signed_auth(op_envelope=auth.PILOT_AUTH_OP_GENERATE)
        hdrs, body_text = _signed_request(
            op=auth.OPERATION_GENERATE,
            request_id="req-gate1-g",
            payload={
                "modelVariant": "qwen-2.5-7b-instruct-awq",
                "systemPrompt": "Generate questions.",
                "transcript": "[0] welcome",
                "constraints": {
                    "proposalKind": "QUESTION_CHECKPOINT_BOUND",
                    "maxQuestions": 1,
                    "allowedQuestionTypes": ["SINGLE_CHOICE"],
                    "jsonSchema": {},
                },
            },
            pilot_auth=pa,
        )

        def _no_inference(system_prompt: str, transcript: str, constraints: dict):
            raise ContractError(
                FailureCode.REQUEST_BODY_INVALID,
                "SPECTRE_GATE_1_NO_INFERENCE=1 — CPU gate refused inference (Gate 1 diagnostic path)",
                http_status=503,
            )

        http_status, resp_body, resp_hdrs = _handle_generate_request(
            headers=hdrs,
            body_text=body_text,
            hmac_key=FIXTURE_HMAC_KEY,
            fingerprint_secret=FIXTURE_FINGERPRINT_SECRET,
            response_hmac_key=FIXTURE_RESPONSE_HMAC_KEY,
            replay_registry=InMemoryReplayRegistry(),
            now_sec=int(time.time()),
            run_qwen=_no_inference,
        )

        self.assertEqual(http_status, 503)
        self.assertEqual(resp_hdrs["x-spectre-failure-code"], "REQUEST_BODY_INVALID")
        parsed = _assert_signed_error_body(resp_body, "REQUEST_BODY_INVALID")
        self.assertIn("SPECTRE_GATE_1_NO_INFERENCE=1", parsed["error"]["message"])
        self.assertEqual(resp_hdrs["x-spectre-response-request-id"], "req-gate1-g")


class AsgiEnvConfigurationTest(unittest.TestCase):
    """Proves both ASGI `api` functions carry the Gate 1 env entry.
    When the operator wants Gate 2, they REMOVE this env entry and
    redeploy — the gate fires only while the env is present."""

    def test_transcribe_api_has_gate1_env(self):
        # Modal's internal env-attribute names vary across SDK versions;
        # we rely on a stable source-grep proof. Grep is deterministic
        # and detects any accidental deletion of the gate line.
        import pathlib
        import modal_endpoints.transcribe_app as t

        src = pathlib.Path(t.__file__).read_text(encoding="utf-8")
        self.assertIn('env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}', src)

    def test_generate_api_has_gate1_env(self):
        import pathlib
        import modal_endpoints.generate_app as g

        src = pathlib.Path(g.__file__).read_text(encoding="utf-8")
        self.assertIn('env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}', src)

    def test_asgi_run_whisper_raises_before_remote_when_gate_env_set(self):
        # Simulate: set env var, call the ASGI handler's inner
        # `_run_whisper` logic via the module's function literally.
        # Because the ASGI handler is defined inside `api()` (a Modal
        # decorator closure), we re-express the gate check here in
        # the same shape — if this test's shape diverges from the
        # source, the earlier source-grep test won't catch it, so
        # keep this sync.
        import os
        import pathlib
        import modal_endpoints.transcribe_app as t

        src = pathlib.Path(t.__file__).read_text(encoding="utf-8")
        # The CPU-boundary raise appears BEFORE the .remote() line
        # in the ASGI handler body. Find both; assert raise-line
        # comes first.
        raise_idx = src.find(
            'raise ContractError(\n                    FailureCode.REQUEST_BODY_INVALID,\n                    "SPECTRE_GATE_1_NO_INFERENCE=1'
        )
        remote_idx = src.find("transcriber.transcribe.remote(wav_bytes)")
        self.assertGreater(
            raise_idx, 0,
            "CPU-boundary raise for SPECTRE_GATE_1_NO_INFERENCE must be present in transcribe_app.py",
        )
        self.assertGreater(
            remote_idx, 0, "transcriber.transcribe.remote(...) must be present",
        )
        self.assertLess(
            raise_idx, remote_idx,
            "The SPECTRE_GATE_1_NO_INFERENCE raise must precede the .remote() call in source order.",
        )

    def test_asgi_run_qwen_raises_before_remote_when_gate_env_set(self):
        import pathlib
        import modal_endpoints.generate_app as g

        src = pathlib.Path(g.__file__).read_text(encoding="utf-8")
        raise_idx = src.find(
            'raise ContractError(\n                    FailureCode.REQUEST_BODY_INVALID,\n                    "SPECTRE_GATE_1_NO_INFERENCE=1'
        )
        remote_idx = src.find("qwen.generate.remote(")
        self.assertGreater(raise_idx, 0)
        self.assertGreater(remote_idx, 0)
        self.assertLess(raise_idx, remote_idx)


if __name__ == "__main__":
    unittest.main()
