"""EP-TRAIN-4Y-B-IMPL — Modal-side auth module.

Mirrors `src/lib/hr/training/modal-shared/*.ts`. Byte-identical
canonicalisation + HMAC + fingerprint verification.

No Modal dependency — importable + testable as plain Python so the
auth logic is unit-testable without a Modal deploy.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any, Iterable

from .errors import ContractError, FailureCode


CONTRACT_VERSION = "4yb-v1"
SIG_VERSION = "v1"
RESPONSE_SIG_VERSION = "response-sig-v1"

OPERATION_TRANSCRIBE = "spectre.training.transcribe.v1"
OPERATION_GENERATE = "spectre.training.generate.v1"
KNOWN_OPERATIONS = frozenset([OPERATION_TRANSCRIBE, OPERATION_GENERATE])

PILOT_AUTH_SCHEMA = "pilot-generation-authorization-v1"
PILOT_AUTH_OP_TRANSCRIBE = "TRANSCRIBE_VIDEO"
PILOT_AUTH_OP_GENERATE = "GENERATE_DRAFT_QUESTIONS"

# Must match src/lib/hr/training/modal-shared/types.ts constants.
TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID = "0" * 64
TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA = "0" * 64

DEFAULT_TIMESTAMP_SKEW_SEC = 300
DEFAULT_REPLAY_WINDOW_SEC = 900


# ---------------------------------------------------------------- canonical


def _normalise_whole_floats(value: Any) -> Any:
    """EP-TRAIN-4Y-K (2026-11-08) — bridge the JS/Python int-vs-float
    asymmetry that broke the live Whisper pilot's response HMAC.

    JavaScript's `JSON.stringify` cannot preserve the "whole-number
    float" shape — `JSON.parse("2.0")` yields the primitive `2`, and
    `JSON.stringify(2)` emits `"2"`. Python's `json.dumps` instead
    emits `"2.0"` for the Python float `2.0`. For any value Whisper
    emits where a segment boundary falls on an exact second (or
    `avg_logprob` saturates at the clamp endpoints), the two sides
    canonicalise differently and their HMAC-SHA256 digests disagree.

    The LIVE 2026-11-08 pilot pinned this at byte index 18 of the
    response body (Python `642.0` → TS `642`); see
    `docs/training/ai-generation/PHASE-4Y-K-ACCEPTANCE.md` §3.

    This pre-processor recursively descends the value tree and
    rewrites every Python `float` whose fractional part is zero AND
    whose magnitude is within the JS safe-integer range
    (±2**53 − 1) as an `int`. Floats outside that range stay as
    floats (JS and Python already disagree on their stringification
    at that scale, and no Whisper field ever reaches it — durations
    are seconds, elapsedMs is bounded to hours). Non-finite numbers
    propagate to `json.dumps(allow_nan=False)` which rejects them
    consistently with TS's `TypeError` on `NaN` / `±Infinity`.
    """
    if isinstance(value, float):
        # bool is a subclass of int in Python — NOT float, so booleans
        # never land here. Must be an honest float.
        if value.is_integer() and -_JS_SAFE_INT <= value <= _JS_SAFE_INT:
            return int(value)
        return value
    if isinstance(value, list):
        return [_normalise_whole_floats(x) for x in value]
    if isinstance(value, tuple):
        return tuple(_normalise_whole_floats(x) for x in value)
    if isinstance(value, dict):
        return {k: _normalise_whole_floats(v) for k, v in value.items()}
    return value


# JS Number.MAX_SAFE_INTEGER (2**53 − 1). Floats within this range
# are exactly representable AND stringify identically across Python
# and JavaScript once converted to int.
_JS_SAFE_INT = (1 << 53) - 1


def canonicalise(value: Any) -> str:
    """Deterministic JSON serialisation. Byte-identical to the
    TypeScript `canonicalise` output.

    - Object keys sorted (lexicographic ASCII).
    - No whitespace around separators.
    - Arrays preserve element order.
    - Whole-number floats within the JS safe-integer range are
      normalised to ints so Python emits `2` where TS emits `2`
      (see `_normalise_whole_floats`).
    - Non-finite numbers raise ValueError (matching TS TypeError).
    """
    return json.dumps(
        _normalise_whole_floats(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def sha256_hex_of_canonical(value: Any) -> str:
    return sha256_hex(canonicalise(value))


def b64url_nopad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def assert_printable_ascii(field: str, value: str) -> None:
    if not isinstance(value, str):
        raise ContractError(FailureCode.ASCII_SCOPE_REQUIRED, f"{field} is not a string.")
    for i, ch in enumerate(value):
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            raise ContractError(
                FailureCode.ASCII_SCOPE_REQUIRED,
                f"{field} contains non-ASCII character at index {i} (code {code}).",
            )


# ---------------------------------------------------------------- request HMAC


def verify_request_signature(
    *,
    headers: dict[str, str],
    body_text: str,
    hmac_key: bytes,
    now_sec: int,
    skew_sec: int = DEFAULT_TIMESTAMP_SKEW_SEC,
) -> dict[str, str]:
    """Verify the Spectre request signature.

    Returns the parsed header map on success. Raises `ContractError`
    on any failure. All comparisons are constant-time.
    """
    hdr = {k.lower(): v for k, v in headers.items()}
    sig_version = hdr.get("x-spectre-sig-version")
    operation = hdr.get("x-spectre-operation")
    request_id = hdr.get("x-spectre-request-id")
    timestamp = hdr.get("x-spectre-timestamp")
    body_digest = hdr.get("x-spectre-body-digest")
    signature = hdr.get("x-spectre-signature")
    contract_version = hdr.get("x-spectre-contract-version")

    for k, v in [
        ("x-spectre-sig-version", sig_version),
        ("x-spectre-operation", operation),
        ("x-spectre-request-id", request_id),
        ("x-spectre-timestamp", timestamp),
        ("x-spectre-body-digest", body_digest),
        ("x-spectre-signature", signature),
        ("x-spectre-contract-version", contract_version),
    ]:
        if not v:
            raise ContractError(FailureCode.REQUEST_HMAC_INVALID, f"Missing header {k}.")

    assert sig_version is not None and operation is not None and request_id is not None
    assert timestamp is not None and body_digest is not None and signature is not None
    assert contract_version is not None

    if sig_version != SIG_VERSION:
        raise ContractError(FailureCode.REQUEST_HMAC_INVALID, f"Unknown sig-version: {sig_version}.")
    if contract_version != CONTRACT_VERSION:
        raise ContractError(FailureCode.CONTRACT_VERSION_MISMATCH, f"Unknown contract: {contract_version}.")
    if operation not in KNOWN_OPERATIONS:
        raise ContractError(FailureCode.UNKNOWN_OPERATION, f"Unknown operation: {operation}.")

    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise ContractError(FailureCode.REQUEST_HMAC_INVALID, "Non-numeric timestamp.") from exc
    if abs(now_sec - ts) > skew_sec:
        raise ContractError(
            FailureCode.TIMESTAMP_SKEW_EXCEEDED,
            f"Timestamp {ts} is outside ±{skew_sec}s of {now_sec}.",
        )

    actual_digest = sha256_hex(body_text)
    if not hmac.compare_digest(actual_digest, body_digest):
        raise ContractError(
            FailureCode.REQUEST_HMAC_INVALID,
            "x-spectre-body-digest does not match canonical body SHA-256.",
        )

    signed_message = f"{SIG_VERSION}.{operation}.{request_id}.{timestamp}.{body_digest}".encode("utf-8")
    expected = b64url_nopad(hmac.new(hmac_key, signed_message, hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        raise ContractError(FailureCode.REQUEST_HMAC_INVALID, "x-spectre-signature did not verify.")

    return {
        "operation": operation,
        "request_id": request_id,
        "timestamp": timestamp,
        "contract_version": contract_version,
    }


# ---------------------------------------------------------------- pilot auth


@dataclass(frozen=True)
class PilotAuthorizationV1:
    schemaVersion: str
    authorizationId: str
    tenantId: str
    courseId: str
    versionId: str
    sourceVideoSha256: str
    resolvedTranscriptBuildId: str
    approvedGroundingProjectionSha256: str
    operation: str
    maxRequestedQuestions: int
    pilotRestrictions: dict[str, Any]
    issuedAtUtc: str
    expiresAtUtc: str
    issuedBy: str
    fingerprint: str


def parse_pilot_authorization(raw: Any) -> PilotAuthorizationV1:
    if not isinstance(raw, dict):
        raise ContractError(FailureCode.PILOT_AUTH_SCHEMA_MISMATCH, "PilotAuthorization is not an object.")
    required = (
        "schemaVersion",
        "authorizationId",
        "tenantId",
        "courseId",
        "versionId",
        "sourceVideoSha256",
        "resolvedTranscriptBuildId",
        "approvedGroundingProjectionSha256",
        "operation",
        "maxRequestedQuestions",
        "pilotRestrictions",
        "issuedAtUtc",
        "expiresAtUtc",
        "issuedBy",
        "fingerprint",
    )
    for f in required:
        if f not in raw:
            raise ContractError(FailureCode.PILOT_AUTH_SCHEMA_MISMATCH, f"Missing field {f}.")
    try:
        return PilotAuthorizationV1(**{k: raw[k] for k in required})  # type: ignore[arg-type]
    except TypeError as exc:
        raise ContractError(FailureCode.PILOT_AUTH_SCHEMA_MISMATCH, str(exc)) from exc


def verify_pilot_authorization(
    auth: PilotAuthorizationV1,
    *,
    fingerprint_secret: bytes,
    operation: str,
    now_sec: int,
) -> None:
    """Verify fingerprint + TTL + operation-pin + schema."""
    if auth.schemaVersion != PILOT_AUTH_SCHEMA:
        raise ContractError(
            FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
            f"Unknown schemaVersion: {auth.schemaVersion}.",
        )
    # ASCII guard on identity fields.
    for f, v in [
        ("authorizationId", auth.authorizationId),
        ("tenantId", auth.tenantId),
        ("courseId", auth.courseId),
        ("versionId", auth.versionId),
        ("sourceVideoSha256", auth.sourceVideoSha256),
        ("resolvedTranscriptBuildId", auth.resolvedTranscriptBuildId),
        ("approvedGroundingProjectionSha256", auth.approvedGroundingProjectionSha256),
        ("operation", auth.operation),
        ("issuedBy", auth.issuedBy),
    ]:
        assert_printable_ascii(f, v)
    scope = auth.pilotRestrictions.get("scope")
    if scope is not None:
        assert_printable_ascii("pilotRestrictions.scope", scope)

    # Operation pinning.
    if operation == OPERATION_TRANSCRIBE and auth.operation != PILOT_AUTH_OP_TRANSCRIBE:
        raise ContractError(
            FailureCode.PILOT_AUTH_OPERATION_MISMATCH,
            f"Expected auth.operation = {PILOT_AUTH_OP_TRANSCRIBE} for transcribe.",
        )
    if operation == OPERATION_GENERATE and auth.operation != PILOT_AUTH_OP_GENERATE:
        raise ContractError(
            FailureCode.PILOT_AUTH_OPERATION_MISMATCH,
            f"Expected auth.operation = {PILOT_AUTH_OP_GENERATE} for generate.",
        )

    # TRANSCRIBE placeholders enforced here.
    if operation == OPERATION_TRANSCRIBE:
        if auth.resolvedTranscriptBuildId != TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID:
            raise ContractError(
                FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
                "TRANSCRIBE requires placeholder transcript-build id.",
            )
        if auth.approvedGroundingProjectionSha256 != TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA:
            raise ContractError(
                FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
                "TRANSCRIBE requires placeholder grounding sha.",
            )
    if operation == OPERATION_GENERATE:
        if auth.resolvedTranscriptBuildId == TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID:
            raise ContractError(
                FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
                "GENERATE rejects placeholder transcript-build id.",
            )
        if auth.approvedGroundingProjectionSha256 == TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA:
            raise ContractError(
                FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
                "GENERATE rejects placeholder grounding sha.",
            )

    # Hex regex check (defence in depth; tests on the TS side cover
    # the regex).
    import re

    HEX64 = re.compile(r"^[a-f0-9]{64}$")
    for f, v in [
        ("sourceVideoSha256", auth.sourceVideoSha256),
        ("resolvedTranscriptBuildId", auth.resolvedTranscriptBuildId),
        ("approvedGroundingProjectionSha256", auth.approvedGroundingProjectionSha256),
    ]:
        if not HEX64.match(v):
            raise ContractError(FailureCode.PILOT_AUTH_SCHEMA_MISMATCH, f"{f} is not 64-char hex.")

    if not isinstance(auth.maxRequestedQuestions, int) or auth.maxRequestedQuestions < 1:
        raise ContractError(
            FailureCode.PILOT_AUTH_SCHEMA_MISMATCH,
            f"maxRequestedQuestions must be a positive integer (got {auth.maxRequestedQuestions}).",
        )

    # Expiry check.
    try:
        from datetime import datetime, timezone

        expires_at = datetime.fromisoformat(auth.expiresAtUtc.replace("Z", "+00:00"))
    except Exception as exc:
        raise ContractError(FailureCode.PILOT_AUTH_SCHEMA_MISMATCH, "Invalid expiresAtUtc.") from exc
    if int(expires_at.timestamp()) <= now_sec:
        raise ContractError(FailureCode.PILOT_AUTH_EXPIRED, "PilotAuthorization has expired.")

    # Fingerprint verification.
    body_without_fp = {
        "schemaVersion": auth.schemaVersion,
        "authorizationId": auth.authorizationId,
        "tenantId": auth.tenantId,
        "courseId": auth.courseId,
        "versionId": auth.versionId,
        "sourceVideoSha256": auth.sourceVideoSha256,
        "resolvedTranscriptBuildId": auth.resolvedTranscriptBuildId,
        "approvedGroundingProjectionSha256": auth.approvedGroundingProjectionSha256,
        "operation": auth.operation,
        "maxRequestedQuestions": auth.maxRequestedQuestions,
        "pilotRestrictions": auth.pilotRestrictions,
        "issuedAtUtc": auth.issuedAtUtc,
        "expiresAtUtc": auth.expiresAtUtc,
        "issuedBy": auth.issuedBy,
    }
    expected_fp = b64url_nopad(
        hmac.new(fingerprint_secret, canonicalise(body_without_fp).encode("utf-8"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected_fp, auth.fingerprint):
        raise ContractError(
            FailureCode.PILOT_AUTH_FINGERPRINT_MISMATCH,
            "PilotAuthorization fingerprint did not verify.",
        )


# ---------------------------------------------------------------- response signing


def sign_response(
    *,
    operation: str,
    request_id: str,
    http_status: int,
    body_text: str,
    response_hmac_key: bytes,
) -> dict[str, str]:
    """Produce the response-side signature headers."""
    try:
        parsed = json.loads(body_text)
    except Exception as exc:
        raise ContractError(FailureCode.REQUEST_BODY_INVALID, "signResponse: body not JSON.") from exc
    body_digest = sha256_hex_of_canonical(parsed)
    signed_message = (
        f"{RESPONSE_SIG_VERSION}.{CONTRACT_VERSION}.{operation}.{request_id}.{http_status}.{body_digest}"
    ).encode("utf-8")
    signature = b64url_nopad(hmac.new(response_hmac_key, signed_message, hashlib.sha256).digest())
    return {
        "x-spectre-response-signature": signature,
        "x-spectre-response-operation": operation,
        "x-spectre-response-request-id": request_id,
        "x-spectre-contract-version": CONTRACT_VERSION,
    }


# ---------------------------------------------------------------- envelope check


def verify_request_envelope(
    *,
    headers: dict[str, str],
    body_text: str,
    hmac_key: bytes,
    fingerprint_secret: bytes,
    expected_operation: str,
    now_sec: int,
    skew_sec: int = DEFAULT_TIMESTAMP_SKEW_SEC,
) -> tuple[PilotAuthorizationV1, dict[str, Any]]:
    """Full gate: request HMAC + body parse + auth fingerprint +
    operation pin + tenant/version bindings."""
    header_parsed = verify_request_signature(
        headers=headers,
        body_text=body_text,
        hmac_key=hmac_key,
        now_sec=now_sec,
        skew_sec=skew_sec,
    )
    if header_parsed["operation"] != expected_operation:
        raise ContractError(
            FailureCode.OPERATION_MISMATCH,
            f"Header operation {header_parsed['operation']} does not match expected {expected_operation}.",
        )

    try:
        body = json.loads(body_text)
    except Exception as exc:
        raise ContractError(FailureCode.REQUEST_BODY_INVALID, "Body is not JSON.") from exc
    if not isinstance(body, dict):
        raise ContractError(FailureCode.REQUEST_BODY_INVALID, "Body is not an object.")
    if body.get("contractVersion") != CONTRACT_VERSION:
        raise ContractError(FailureCode.CONTRACT_VERSION_MISMATCH, "Body contractVersion mismatch.")
    if body.get("operation") != expected_operation:
        raise ContractError(FailureCode.OPERATION_MISMATCH, "Body operation mismatch.")
    if body.get("requestId") != header_parsed["request_id"]:
        raise ContractError(FailureCode.REQUEST_BODY_INVALID, "Body requestId mismatch.")
    if body.get("timestamp") != header_parsed["timestamp"]:
        raise ContractError(FailureCode.REQUEST_BODY_INVALID, "Body timestamp mismatch.")
    if "pilotAuthorization" not in body:
        raise ContractError(FailureCode.PILOT_AUTH_SCHEMA_MISMATCH, "Missing pilotAuthorization.")

    auth = parse_pilot_authorization(body["pilotAuthorization"])
    verify_pilot_authorization(
        auth,
        fingerprint_secret=fingerprint_secret,
        operation=expected_operation,
        now_sec=now_sec,
    )
    return auth, body
