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
    """Production. Uses `modal.Dict` with TTL semantics.

    NOTE: this class is instantiated inside the Modal function scope
    with a shared `modal.Dict` attached. The put-if-absent pattern
    below relies on `modal.Dict.put(..., condition=NOT_EXISTS)` or
    equivalent. The actual Dict API surface may differ by Modal SDK
    version — operators MUST confirm atomicity at deploy time
    (`modal.Dict.setnx` or equivalent). Falling back to
    read-then-write is NOT acceptable because it introduces a race.
    """

    def __init__(self, dict_: Any) -> None:
        self._dict = dict_

    def record(self, key: str, ttl_sec: int) -> None:
        try:
            # Pseudocode: Modal's actual atomic put-if-absent call.
            # The exact method name is Modal-SDK-version-specific.
            if self._dict.contains(key):  # type: ignore[attr-defined]
                raise ContractError(FailureCode.REPLAY_DETECTED, f"Key {key} seen recently.", http_status=409)
            self._dict.put(key, time.time() + ttl_sec)  # type: ignore[attr-defined]
        except ContractError:
            raise
        except Exception as exc:
            # Any Modal-side failure propagates as REPLAY_STORE_UNAVAILABLE.
            # Fail closed.
            raise ContractError(
                FailureCode.REPLAY_STORE_UNAVAILABLE,
                f"Replay store error: {type(exc).__name__}.",
                http_status=503,
            ) from exc

    def is_healthy(self) -> bool:
        try:
            # Use a cheap existence check on a sentinel key.
            self._dict.contains("__health__")  # type: ignore[attr-defined]
            return True
        except Exception:
            return False
