"""EP-TRAIN-4Y-X §4 (2026-11-09) — dedicated Modal metadata endpoint.

Replaces 4Y-V's repurposed `proposals` schema with a real
`{title, description, sourceSegmentIds}` response. Reuses the same
Qwen 2.5 7B Instruct AWQ + A10G deployment — only the request/
response contract changes.

Operation: spectre.training.metadata.v1
Pilot authorization operation: GENERATE_DRAFT_QUESTIONS (same as
the question-generation path; see shared/auth.py for rationale).

Response body shape (byte-identical to the TS validator in
src/lib/hr/training/modal-shared/types-metadata.ts):

    {
        "contractVersion": "4yb-v1",
        "operation": "spectre.training.metadata.v1",
        "requestId": "...",
        "modelVariant": "qwen-2.5-7b-instruct-awq",
        "title": "...",
        "description": "...",
        "sourceSegmentIds": [ints],
        "elapsedMs": { "coldBoot": int, "generate": int },
        "tokenCounts": { "prompt": int, "output": int }
    }

Response is signed with X-Spectre-Response-Signature using
RESPONSE_SIG_VERSION over the same canonical body-digest the TS
client verifies.
"""

from __future__ import annotations

import json
from typing import Any

try:  # pragma: no cover - import may fail in dev environments
    import modal
except Exception:  # pragma: no cover
    modal = None  # type: ignore[assignment]

from .shared.auth import (
    OPERATION_METADATA,
    DEFAULT_TIMESTAMP_SKEW_SEC,
    verify_request_envelope,
    sign_response,
)
from .shared.errors import ContractError, FailureCode
from .shared.replay import ModalDictReplayRegistry, replay_key


def _extract_request_id_from_headers(headers: dict[str, str]) -> str:
    """Mirror of the generate helper. Harvest the client's requestId
    from the HEADER so error responses can be signed with the same
    request-id even when envelope verification fails."""
    hdr = {k.lower(): v for k, v in headers.items() if isinstance(v, str)}
    rid = hdr.get("x-spectre-request-id") or ""
    if not rid or len(rid) > 128:
        return "unknown"
    for ch in rid:
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            return "unknown"
    return rid


def _handle_metadata_request(
    *,
    headers: dict[str, str],
    body_text: str,
    hmac_key: bytes,
    fingerprint_secret: bytes,
    response_hmac_key: bytes,
    replay_registry: ModalDictReplayRegistry,
    now_sec: int,
    run_qwen_metadata: Any,  # callable(system_prompt, transcript, constraints) -> dict
) -> tuple[int, str, dict[str, str]]:
    """Core request handler. Returns `(http_status, body_text, headers)`."""
    early_request_id = _extract_request_id_from_headers(headers)
    try:
        auth, body = verify_request_envelope(
            headers=headers,
            body_text=body_text,
            hmac_key=hmac_key,
            fingerprint_secret=fingerprint_secret,
            expected_operation=OPERATION_METADATA,
            now_sec=now_sec,
            skew_sec=DEFAULT_TIMESTAMP_SKEW_SEC,
        )
    except ContractError as err:
        return _signed_error(
            operation=OPERATION_METADATA,
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
            operation=OPERATION_METADATA,
            request_id=body["requestId"],
            http_status=err.http_status if err.http_status else 500,
            code=err.code,
            message=str(err),
            response_hmac_key=response_hmac_key,
        )

    # Dispatch to the Qwen metadata method.
    try:
        payload = body["payload"]
        constraints = payload["constraints"]
        # Caller-side limits mirror the TS METADATA_LIMITS constant.
        # The GPU method will clamp within these so a bug on either
        # side can't produce an unboundedly long title/description.
        max_title_len = int(constraints.get("maxTitleLength", 80))
        max_desc_len = int(constraints.get("maxDescriptionLength", 320))
        max_output_tokens = int(constraints.get("maxOutputTokens", 512))
        if max_title_len <= 0 or max_title_len > 160:
            raise ContractError(
                FailureCode.REQUEST_BODY_INVALID,
                f"maxTitleLength {max_title_len} outside allowed range 1..160.",
            )
        if max_desc_len <= 0 or max_desc_len > 640:
            raise ContractError(
                FailureCode.REQUEST_BODY_INVALID,
                f"maxDescriptionLength {max_desc_len} outside allowed range 1..640.",
            )
        if max_output_tokens <= 0 or max_output_tokens > 1024:
            raise ContractError(
                FailureCode.REQUEST_BODY_INVALID,
                f"maxOutputTokens {max_output_tokens} outside allowed range 1..1024.",
            )
        result = run_qwen_metadata(
            payload["systemPrompt"],
            payload["transcript"],
            {
                "maxTitleLength": max_title_len,
                "maxDescriptionLength": max_desc_len,
                "maxOutputTokens": max_output_tokens,
                "clubName": constraints.get("clubName"),
            },
        )
    except ContractError as err:
        return _signed_error(
            operation=OPERATION_METADATA,
            request_id=body["requestId"],
            http_status=err.http_status if err.http_status else 400,
            code=err.code,
            message=str(err),
            response_hmac_key=response_hmac_key,
        )
    except Exception as exc:  # pragma: no cover - inference layer
        return _signed_error(
            operation=OPERATION_METADATA,
            request_id=body["requestId"],
            http_status=500,
            code=FailureCode.REQUEST_BODY_INVALID,
            message=f"Metadata inference failed: {type(exc).__name__}",
            response_hmac_key=response_hmac_key,
        )

    # Build + sign the response. Title/description/sourceSegmentIds
    # already clamped by the GPU method.
    resp_body = {
        "contractVersion": "4yb-v1",
        "operation": OPERATION_METADATA,
        "requestId": body["requestId"],
        "modelVariant": payload["modelVariant"],
        "title": result["title"],
        "description": result["description"],
        "sourceSegmentIds": list(result.get("sourceSegmentIds", [])),
        "elapsedMs": result["elapsedMs"],
        "tokenCounts": result["tokenCounts"],
    }
    resp_text = json.dumps(resp_body, separators=(",", ":"), ensure_ascii=False)
    sig_hdrs = sign_response(
        operation=OPERATION_METADATA,
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
