"""EP-TRAIN-4Y-B-VERIFY §5 — replay-registry concurrency regression.

Scenario: N threads call `record()` on the SAME composite key at the
same time. Exactly ONE must succeed, N-1 must raise REPLAY_DETECTED.

This exercises the Python InMemoryReplayRegistry under GIL
scheduling. It does NOT prove atomicity of the production
`ModalDictReplayRegistry` — Modal's own `modal.Dict` atomicity is
operator-confirmed at deploy time. The verification doc flags it.
"""

from __future__ import annotations

import threading
import unittest

from ..shared.errors import ContractError, FailureCode
from ..shared.replay import InMemoryReplayRegistry, replay_key


class ReplayConcurrencyTest(unittest.TestCase):
    def test_concurrent_duplicate_record_exactly_one_wins(self):
        registry = InMemoryReplayRegistry()
        key = replay_key("auth-concurrent", "req-concurrent")

        # Pre-arm a barrier so all threads fire record() as close to
        # simultaneously as possible. With CPython's GIL, only one
        # thread holds the lock at a time inside the `record` call;
        # this is what makes the implementation functionally atomic
        # in-process. (Cross-process atomicity is a modal.Dict
        # concern.)
        BATCH = 10
        barrier = threading.Barrier(BATCH)
        results: list[object] = [None] * BATCH

        def worker(i: int) -> None:
            barrier.wait()
            try:
                registry.record(key, ttl_sec=900)
                results[i] = "ok"
            except ContractError as err:
                results[i] = err.code

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(BATCH)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        accepted = [r for r in results if r == "ok"]
        duplicates = [r for r in results if r == FailureCode.REPLAY_DETECTED]
        self.assertEqual(len(accepted), 1, f"expected exactly one success; got {accepted!r}")
        self.assertEqual(len(duplicates), BATCH - 1)
        self.assertEqual(registry.size(), 1)

    def test_unhealthy_store_fails_closed(self):
        registry = InMemoryReplayRegistry()
        registry.set_healthy(False)
        with self.assertRaises(ContractError) as ctx:
            registry.record("any-key", ttl_sec=900)
        self.assertEqual(ctx.exception.code, FailureCode.REPLAY_STORE_UNAVAILABLE)

    def test_separator_in_authorization_id_preserved(self):
        # Callers MUST use ASCII-only ids — upstream guard enforces
        # that. Here we document the current replay_key shape.
        self.assertEqual(replay_key("a:b", "r"), "a:b:r")


if __name__ == "__main__":
    unittest.main()
