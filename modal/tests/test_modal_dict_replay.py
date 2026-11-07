"""EP-TRAIN-4Y-C §1 — ModalDictReplayRegistry atomicity regression.

Exercises `ModalDictReplayRegistry` against a fake `modal.Dict` stub
that models Modal's documented atomic `put(key, value,
skip_if_exists=True)` semantics. The stub's `put` is lock-protected so
concurrent calls from multiple threads cannot both succeed.

Scenarios:
  1. Fresh key succeeds.
  2. Duplicate key raises REPLAY_DETECTED.
  3. N concurrent calls on the same key — exactly one wins.
  4. SDK missing `skip_if_exists` → REPLAY_STORE_UNAVAILABLE (503).
  5. Modal-side exception → REPLAY_STORE_UNAVAILABLE (503).

The point is to prove the NEW code path (`skip_if_exists=True`) is
safe against the race that the OLD path (contains → put) exhibited.
Modal.Dict's live atomicity is server-side; this harness mimics it.
"""

from __future__ import annotations

import threading
import time
import unittest
from typing import Any

from ..shared.errors import ContractError, FailureCode
from ..shared.replay import ModalDictReplayRegistry


class AtomicDictStub:
    """Models Modal's documented `Dict.put(key, value,
    skip_if_exists=True)` return semantics with thread-safe locking.
    Returns True on fresh insert, False on existing key."""

    def __init__(self) -> None:
        self._store: dict[str, Any] = {}
        self._lock = threading.Lock()

    def put(self, key: str, value: Any, *, skip_if_exists: bool = False) -> bool:
        if not skip_if_exists:
            # Non-atomic path — the production code should NEVER use this.
            with self._lock:
                self._store[key] = value
            return True
        with self._lock:
            if key in self._store:
                return False
            self._store[key] = value
            return True

    def contains(self, key: str) -> bool:
        with self._lock:
            return key in self._store


class LegacyDictStubNoSkipIfExists:
    """Models an OLD Modal SDK whose `put` does NOT accept
    `skip_if_exists`. Raises TypeError if the kwarg is passed."""

    def __init__(self) -> None:
        self._store: dict[str, Any] = {}

    def put(self, key: str, value: Any) -> bool:
        self._store[key] = value
        return True

    def contains(self, key: str) -> bool:
        return key in self._store


class FlakyDictStub:
    """Raises on every call to `put`. Models a Modal-side outage."""

    def put(self, key: str, value: Any, *, skip_if_exists: bool = False) -> bool:
        raise RuntimeError("Modal control plane timeout")

    def contains(self, key: str) -> bool:
        raise RuntimeError("Modal control plane timeout")


class ModalDictReplayRegistryTest(unittest.TestCase):
    def test_fresh_key_succeeds(self):
        stub = AtomicDictStub()
        reg = ModalDictReplayRegistry(stub)
        reg.record("a:r1", ttl_sec=900)
        self.assertTrue(stub.contains("a:r1"))

    def test_duplicate_key_rejected(self):
        stub = AtomicDictStub()
        reg = ModalDictReplayRegistry(stub)
        reg.record("a:r1", ttl_sec=900)
        with self.assertRaises(ContractError) as ctx:
            reg.record("a:r1", ttl_sec=900)
        self.assertEqual(ctx.exception.code, FailureCode.REPLAY_DETECTED)
        self.assertEqual(ctx.exception.http_status, 409)

    def test_concurrent_record_calls_exactly_one_wins(self):
        """CRITICAL — this is the race the old `contains → put`
        implementation lost. With the new `skip_if_exists=True`
        primitive, only one thread can succeed."""
        stub = AtomicDictStub()
        reg = ModalDictReplayRegistry(stub)
        key = "a:r-concurrent"
        BATCH = 20
        barrier = threading.Barrier(BATCH)
        outcomes: list[Any] = [None] * BATCH

        def worker(i: int) -> None:
            barrier.wait()
            try:
                reg.record(key, ttl_sec=900)
                outcomes[i] = "ok"
            except ContractError as err:
                outcomes[i] = err.code

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(BATCH)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        accepted = [o for o in outcomes if o == "ok"]
        duplicates = [o for o in outcomes if o == FailureCode.REPLAY_DETECTED]
        self.assertEqual(len(accepted), 1, f"expected exactly one success; got {accepted!r}")
        self.assertEqual(len(duplicates), BATCH - 1)

    def test_legacy_sdk_fails_closed(self):
        """When the deployed Modal SDK does NOT support
        `skip_if_exists`, the registry must refuse rather than fall
        back to a racy path."""
        stub = LegacyDictStubNoSkipIfExists()
        reg = ModalDictReplayRegistry(stub)
        with self.assertRaises(ContractError) as ctx:
            reg.record("a:r1", ttl_sec=900)
        self.assertEqual(ctx.exception.code, FailureCode.REPLAY_STORE_UNAVAILABLE)
        self.assertEqual(ctx.exception.http_status, 503)
        # The error message must name the required SDK version so
        # operators have an actionable path.
        self.assertIn(ModalDictReplayRegistry.MIN_SDK_VERSION, str(ctx.exception))

    def test_flaky_store_fails_closed(self):
        stub = FlakyDictStub()
        reg = ModalDictReplayRegistry(stub)
        with self.assertRaises(ContractError) as ctx:
            reg.record("a:r1", ttl_sec=900)
        self.assertEqual(ctx.exception.code, FailureCode.REPLAY_STORE_UNAVAILABLE)
        self.assertEqual(ctx.exception.http_status, 503)


if __name__ == "__main__":
    unittest.main()
