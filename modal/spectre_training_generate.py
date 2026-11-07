"""EP-TRAIN-4Y-B-IMPL — Modal generate endpoint reference.

Operator-authored, deployed with `modal deploy`. OFFLINE REFERENCE in
this repo; no deploy from this slice. Preserves the EP-TRAIN-6C-11
Qwen architecture (Qwen 2.5 7B Instruct AWQ + LM Format Enforcer);
only the HTTP envelope changes.

Operation: spectre.training.generate.v1
Expected auth envelope:
  - Modal proxy (Modal-Key + Modal-Secret).
  - x-spectre-* request-signing headers.
  - PilotAuthorizationV1 with operation=GENERATE_DRAFT_QUESTIONS and
    real transcript-build + grounding-projection fields (not the
    TRANSCRIBE placeholders).
  - Response signed with X-Spectre-Response-Signature.

GPU: A10 (matches 6C-11 deployment).
Model: Qwen 2.5 7B Instruct AWQ.
"""

from __future__ import annotations

import json
from typing import Any

try:  # pragma: no cover - import may fail in dev environments
    import modal
except Exception:  # pragma: no cover
    modal = None  # type: ignore[assignment]

from .shared.auth import (
    OPERATION_GENERATE,
    DEFAULT_TIMESTAMP_SKEW_SEC,
    verify_request_envelope,
    sign_response,
)
from .shared.errors import ContractError, FailureCode
from .shared.replay import ModalDictReplayRegistry, replay_key


def _handle_generate_request(
    *,
    headers: dict[str, str],
    body_text: str,
    hmac_key: bytes,
    fingerprint_secret: bytes,
    response_hmac_key: bytes,
    replay_registry: ModalDictReplayRegistry,
    now_sec: int,
    run_qwen: Any,  # callable(system_prompt, transcript, constraints) -> (proposals, elapsed, tokens)
) -> tuple[int, str, dict[str, str]]:
    """Core request handler. Returns `(http_status, body_text, headers)`."""
    try:
        auth, body = verify_request_envelope(
            headers=headers,
            body_text=body_text,
            hmac_key=hmac_key,
            fingerprint_secret=fingerprint_secret,
            expected_operation=OPERATION_GENERATE,
            now_sec=now_sec,
            skew_sec=DEFAULT_TIMESTAMP_SKEW_SEC,
        )
    except ContractError as err:
        return _signed_error(
            operation=OPERATION_GENERATE,
            request_id="unknown",
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
            operation=OPERATION_GENERATE,
            request_id=body["requestId"],
            http_status=err.http_status if err.http_status else 500,
            code=err.code,
            message=str(err),
            response_hmac_key=response_hmac_key,
        )

    # Qwen inference.
    try:
        payload = body["payload"]
        constraints = payload["constraints"]
        if constraints.get("maxQuestions", 0) > auth.maxRequestedQuestions:
            raise ContractError(
                FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
                "payload.constraints.maxQuestions exceeds auth.maxRequestedQuestions.",
                http_status=400,
            )
        proposals, elapsed_ms, token_counts = run_qwen(
            payload["systemPrompt"], payload["transcript"], constraints
        )
    except ContractError as err:
        return _signed_error(
            operation=OPERATION_GENERATE,
            request_id=body["requestId"],
            http_status=err.http_status if err.http_status else 400,
            code=err.code,
            message=str(err),
            response_hmac_key=response_hmac_key,
        )
    except Exception as exc:  # pragma: no cover - inference layer
        return _signed_error(
            operation=OPERATION_GENERATE,
            request_id=body["requestId"],
            http_status=500,
            code=FailureCode.REQUEST_BODY_INVALID,
            message=f"Inference failed: {type(exc).__name__}",
            response_hmac_key=response_hmac_key,
        )

    resp_body = {
        "contractVersion": "4yb-v1",
        "operation": OPERATION_GENERATE,
        "requestId": body["requestId"],
        "modelVariant": payload["modelVariant"],
        "proposals": proposals,
        "elapsedMs": elapsed_ms,
        "tokenCounts": token_counts,
    }
    resp_text = json.dumps(resp_body, separators=(",", ":"), ensure_ascii=False)
    sig_hdrs = sign_response(
        operation=OPERATION_GENERATE,
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
