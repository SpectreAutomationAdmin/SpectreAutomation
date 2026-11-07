"""EP-TRAIN-4Y-B-IMPL — Modal-side replay registry.

Two implementations:
  - `InMemoryReplayRegistry` — test-only.
  - `ModalDictReplayRegistry` — production, backed by `modal.Dict`.

Both honour §6 "atomic replay prevention". Both fail-closed on
backing-store outage (surface `REPLAY_STORE_UNAVAILABLE`).
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any

from .errors import ContractError, FailureCode


class ReplayRegistry(ABC):
    @abstractmethod
    def record(self, key: str, ttl_sec: int) -> None:
        """Record `key`. Raise `ContractError(REPLAY_DETECTED)` if
        already present. Raise `ContractError(REPLAY_STORE_UNAVAILABLE)`
        if the backing store is down."""

    @abstractmethod
    def is_healthy(self) -> bool:
        ...


def replay_key(authorization_id: str, request_id: str) -> str:
    return f"{authorization_id}:{request_id}"


class InMemoryReplayRegistry(ReplayRegistry):
    """Test-only. Not durable, not distributed."""

    def __init__(self) -> None:
        self._store: dict[str, float] = {}
        self._healthy: bool = True

    def record(self, key: str, ttl_sec: int) -> None:
        if not self._healthy:
            raise ContractError(
                FailureCode.REPLAY_STORE_UNAVAILABLE,
                "In-memory replay store marked unhealthy for test.",
                http_status=503,
            )
        now = time.time()
        # Evict expired.
        expired = [k for k, exp in self._store.items() if exp <= now]
        for k in expired:
            del self._store[k]
        if key in self._store:
            raise ContractError(FailureCode.REPLAY_DETECTED, f"Key {key} seen recently.", http_status=409)
        self._store[key] = now + ttl_sec

    def is_healthy(self) -> bool:
        return self._healthy

    # Test-only knobs
    def set_healthy(self, healthy: bool) -> None:
        self._healthy = healthy

    def size(self) -> int:
        return len(self._store)


class ModalDictReplayRegistry(ReplayRegistry):
    """Production. Uses `modal.Dict.put(..., skip_if_exists=True)` for
    atomic put-if-absent.

    EP-TRAIN-4Y-C §1 fix (2026-11-07) — the previous
    `contains` → `put` sequence was a check-then-set race across
    concurrent containers. Replaced with Modal SDK's documented
    atomic primitive: `modal.Dict.put(key, value, skip_if_exists=True)`
    returns `True` iff the key was absent and the value was stored;
    `False` iff the key was already present (no change made). The
    guarantee is provided server-side by the Modal control plane,
    not by this process.

    **SDK version pin:** `modal>=0.65.42` (first release documenting
    `skip_if_exists` on `Dict.put`). Older SDKs do NOT have this
    parameter — the Modal image in `spectre_training_transcribe.py`
    + `spectre_training_generate.py` MUST pin the SDK at or above
    this version (operator deploy-time check in the checklist).

    If the deployed SDK does not provide `skip_if_exists`, the
    operator MUST either upgrade the SDK or substitute a different
    shared atomic store before serving traffic. There is no safe
    non-atomic fallback inside this class — a missing primitive is a
    deployment blocker.
    """

    MIN_SDK_VERSION = "0.65.42"

    def __init__(self, dict_: Any) -> None:
        self._dict = dict_

    def record(self, key: str, ttl_sec: int) -> None:
        try:
            # Atomic put-if-absent. Returns True on fresh insert,
            # False if a live record for this key already exists.
            # No exception is raised by Modal for the duplicate case;
            # we classify the False return as REPLAY_DETECTED.
            inserted = self._dict.put(  # type: ignore[attr-defined]
                key,
                time.time() + ttl_sec,
                skip_if_exists=True,
            )
        except TypeError as exc:
            # `skip_if_exists` parameter is absent on the deployed
            # Modal SDK. Fail closed — DO NOT fall back to a racy
            # check-then-set. Operator must upgrade the SDK.
            raise ContractError(
                FailureCode.REPLAY_STORE_UNAVAILABLE,
                f"Modal SDK does not support atomic put-if-absent "
                f"(skip_if_exists). Pin modal>={self.MIN_SDK_VERSION}.",
                http_status=503,
            ) from exc
        except ContractError:
            raise
        except Exception as exc:
            # Any OTHER Modal-side failure propagates as
            # REPLAY_STORE_UNAVAILABLE. Fail closed.
            raise ContractError(
                FailureCode.REPLAY_STORE_UNAVAILABLE,
                f"Replay store error: {type(exc).__name__}.",
                http_status=503,
            ) from exc

        if not inserted:
            # Duplicate — the key was already present from a prior
            # request. The caller MUST reject this request as a
            # replay.
            raise ContractError(
                FailureCode.REPLAY_DETECTED,
                f"Key {key} seen recently.",
                http_status=409,
            )

    def is_healthy(self) -> bool:
        try:
            # Use a cheap existence check on a sentinel key.
            self._dict.contains("__health__")  # type: ignore[attr-defined]
            return True
        except Exception:
            return False
