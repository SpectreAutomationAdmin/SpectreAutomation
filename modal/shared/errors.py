"""EP-TRAIN-4Y-B-IMPL — Modal-side failure codes.

Byte-identical set to `src/lib/hr/training/modal-shared/errors.ts`.
Every value emitted by the Modal function appears here. The HTTP
response's `x-spectre-failure-code` header carries one of these
on any non-2xx.
"""

from enum import Enum


class FailureCode(str, Enum):
    # Transport / credential
    CREDENTIAL_ABSENT = "CREDENTIAL_ABSENT"

    # Request-side integrity
    REQUEST_HMAC_INVALID = "REQUEST_HMAC_INVALID"
    REQUEST_BODY_INVALID = "REQUEST_BODY_INVALID"
    TIMESTAMP_SKEW_EXCEEDED = "TIMESTAMP_SKEW_EXCEEDED"
    UNKNOWN_OPERATION = "UNKNOWN_OPERATION"
    OPERATION_MISMATCH = "OPERATION_MISMATCH"
    CONTRACT_VERSION_MISMATCH = "CONTRACT_VERSION_MISMATCH"
    ASCII_SCOPE_REQUIRED = "ASCII_SCOPE_REQUIRED"

    # Authorization envelope
    PILOT_AUTH_FINGERPRINT_MISMATCH = "PILOT_AUTH_FINGERPRINT_MISMATCH"
    PILOT_AUTH_EXPIRED = "PILOT_AUTH_EXPIRED"
    PILOT_AUTH_OPERATION_MISMATCH = "PILOT_AUTH_OPERATION_MISMATCH"
    PILOT_AUTH_SCHEMA_MISMATCH = "PILOT_AUTH_SCHEMA_MISMATCH"
    TENANT_MISMATCH = "TENANT_MISMATCH"
    COURSE_VERSION_MISMATCH = "COURSE_VERSION_MISMATCH"
    VIDEO_SHA_MISMATCH_AT_BOUNDARY = "VIDEO_SHA_MISMATCH_AT_BOUNDARY"

    # Replay
    REPLAY_DETECTED = "REPLAY_DETECTED"
    REPLAY_STORE_UNAVAILABLE = "REPLAY_STORE_UNAVAILABLE"


class ContractError(Exception):
    """Raised by auth.verify_* when any gate refuses the request."""

    def __init__(
        self,
        code: FailureCode,
        message: str,
        http_status: int = 400,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
