"""EP-TRAIN-4Y-B-IMPL — Modal transcribe endpoint reference.

Operator-authored, deployed with `modal deploy`. OFFLINE REFERENCE in
this repo; no deploy from this slice. Preserves the EP-TRAIN-6C-11
faster-whisper architecture; only the HTTP envelope changes.

Operation: spectre.training.transcribe.v1
Expected auth envelope:
  - Modal proxy (Modal-Key + Modal-Secret, workspace-managed).
  - x-spectre-* request-signing headers.
  - PilotAuthorizationV1 with operation=TRANSCRIBE_VIDEO and the
    two placeholder sentinels for post-transcribe fields.
  - Response signed with X-Spectre-Response-Signature.

GPU: L40S (keep 6C-11's declared sizing).
Model: faster-whisper large-v3.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

# Modal imports deferred to deploy time. Keeping the module importable
# as plain Python simplifies unittest-level verification.
try:  # pragma: no cover - import may fail in dev environments
    import modal
except Exception:  # pragma: no cover
    modal = None  # type: ignore[assignment]

from .shared.auth import (
    OPERATION_TRANSCRIBE,
    DEFAULT_TIMESTAMP_SKEW_SEC,
    verify_request_envelope,
    sign_response,
)
from .shared.errors import ContractError, FailureCode
from .shared.replay import ModalDictReplayRegistry, replay_key


# ---------------------------------------------------------------- app skeleton
#
# Operator fills in:
#   - `modal.Image` with ffmpeg + faster-whisper + ctranslate2 + CUDA toolkit.
#   - `modal.Volume` for cached model weights (faster-whisper-large-v3).
#   - `modal.Dict` for the replay registry (shared across both endpoints).
#   - `modal.Secret` bindings for:
#       spectre-training-runtime-hmac
#       spectre-training-pilot-fingerprint-secret
#       (optional) spectre-training-response-hmac-key
#
# This module intentionally does NOT invoke any Modal decorators at
# import time so the file remains unit-testable.


def _extract_request_id_from_headers(headers: dict[str, str]) -> str:
    """EP-TRAIN-4Y-C §3 — early requestId extraction so error responses
    can be signed with the client's actual request-id even when envelope
    verification fails downstream. ASCII-only guard prevents header-
    smuggling into the signed message. Returns `unknown` on any
    anomaly."""
    hdr = {k.lower(): v for k, v in headers.items() if isinstance(v, str)}
    rid = hdr.get("x-spectre-request-id") or ""
    if not rid or len(rid) > 128:
        return "unknown"
    for ch in rid:
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            return "unknown"
    return rid


def _handle_transcribe_request(
    *,
    headers: dict[str, str],
    body_text: str,
    hmac_key: bytes,
    fingerprint_secret: bytes,
    response_hmac_key: bytes,
    replay_registry: ModalDictReplayRegistry,
    now_sec: int,
    download_audio: Any,  # callable(audio_url) -> bytes
    run_whisper: Any,     # callable(wav_bytes) -> (segments, elapsed_ms)
    audio_to_wav: Any,    # callable(bytes) -> bytes
    duration_sec: int,
) -> tuple[int, str, dict[str, str]]:
    """Core request handler, extracted from the Modal `@asgi_app` for
    unit testability. Returns `(http_status, body_text, headers)`.

    On any ContractError: returns `(err.http_status, error_body,
    {x-spectre-failure-code: err.code})`. Responses on the error
    path are ALSO signed (§5: no bypass path for failures).

    EP-TRAIN-4Y-C §3 — the client-facing error response is signed
    with the request-id harvested from the request HEADER at the
    earliest possible moment, so a client that calls
    `verifyResponseSignature` against an error response can
    successfully match request-id and reject tampered error
    payloads.
    """
    early_request_id = _extract_request_id_from_headers(headers)
    try:
        auth, body = verify_request_envelope(
            headers=headers,
            body_text=body_text,
            hmac_key=hmac_key,
            fingerprint_secret=fingerprint_secret,
            expected_operation=OPERATION_TRANSCRIBE,
            now_sec=now_sec,
            skew_sec=DEFAULT_TIMESTAMP_SKEW_SEC,
        )
    except ContractError as err:
        return _signed_error(
            operation=OPERATION_TRANSCRIBE,
            request_id=early_request_id,
            http_status=err.http_status if err.http_status else 400,
            code=err.code,
            message=str(err),
            response_hmac_key=response_hmac_key,
        )

    try:
        replay_registry.record(
            key=replay_key(auth.authorizationId, body["requestId"]),
            ttl_sec=900,
        )
    except ContractError as err:
        return _signed_error(
            operation=OPERATION_TRANSCRIBE,
            request_id=body["requestId"],
            http_status=err.http_status if err.http_status else 500,
            code=err.code,
            message=str(err),
            response_hmac_key=response_hmac_key,
        )

    # Inference.
    try:
        payload = body["payload"]
        audio_bytes = download_audio(payload["audioUrl"])
        wav_bytes = audio_to_wav(audio_bytes)
        audio_sha256 = hashlib.sha256(wav_bytes).hexdigest()
        segments, elapsed_ms = run_whisper(wav_bytes)
    except Exception as exc:  # pragma: no cover - inference layer
        return _signed_error(
            operation=OPERATION_TRANSCRIBE,
            request_id=body["requestId"],
            http_status=500,
            code=FailureCode.REQUEST_BODY_INVALID,  # closest classification
            message=f"Inference failed: {type(exc).__name__}",
            response_hmac_key=response_hmac_key,
        )

    resp_body = {
        "contractVersion": "4yb-v1",
        "operation": OPERATION_TRANSCRIBE,
        "requestId": body["requestId"],
        "modelVariant": payload["modelVariant"],
        "durationSec": duration_sec,
        "audioSha256": audio_sha256,
        "segments": segments,
        "elapsedMs": elapsed_ms,
    }
    resp_text = json.dumps(resp_body, separators=(",", ":"), ensure_ascii=False)
    sig_hdrs = sign_response(
        operation=OPERATION_TRANSCRIBE,
        request_id=body["requestId"],
        http_status=200,
        body_text=resp_text,
        response_hmac_key=response_hmac_key,
    )
    return 200, resp_text, {**sig_hdrs, "Content-Type": "application/json"}


def _signed_error(
    *,
    operation: str,
    request_id: str,
    http_status: int,
    code: FailureCode,
    message: str,
    response_hmac_key: bytes,
) -> tuple[int, str, dict[str, str]]:
    body = {
        "contractVersion": "4yb-v1",
        "operation": operation,
        "requestId": request_id,
        "error": {"code": code.value, "message": message},
    }
    body_text = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    sig_hdrs = sign_response(
        operation=operation,
        request_id=request_id,
        http_status=http_status,
        body_text=body_text,
        response_hmac_key=response_hmac_key,
    )
    return http_status, body_text, {**sig_hdrs, "Content-Type": "application/json", "x-spectre-failure-code": code.value}
