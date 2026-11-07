"""EP-TRAIN-4Y-B-IMPL — replay-registry unit tests."""

import time
import unittest

from ..shared.errors import ContractError, FailureCode
from ..shared.replay import InMemoryReplayRegistry, replay_key


class ReplayKeyTest(unittest.TestCase):
    def test_key_shape(self):
        self.assertEqual(replay_key("auth-1", "req-1"), "auth-1:req-1")


class InMemoryReplayRegistryTest(unittest.TestCase):
    def test_first_record_succeeds(self):
        r = InMemoryReplayRegistry()
        r.record("auth-1:req-1", ttl_sec=60)
        self.assertEqual(r.size(), 1)

    def test_duplicate_record_rejected(self):
        r = InMemoryReplayRegistry()
        r.record("auth-1:req-1", ttl_sec=60)
        with self.assertRaises(ContractError) as ctx:
            r.record("auth-1:req-1", ttl_sec=60)
        self.assertEqual(ctx.exception.code, FailureCode.REPLAY_DETECTED)

    def test_different_request_id_allowed(self):
        r = InMemoryReplayRegistry()
        r.record("auth-1:req-1", ttl_sec=60)
        r.record("auth-1:req-2", ttl_sec=60)
        self.assertEqual(r.size(), 2)

    def test_unhealthy_store_fails_closed(self):
        r = InMemoryReplayRegistry()
        r.set_healthy(False)
        with self.assertRaises(ContractError) as ctx:
            r.record("auth-1:req-1", ttl_sec=60)
        self.assertEqual(ctx.exception.code, FailureCode.REPLAY_STORE_UNAVAILABLE)


if __name__ == "__main__":
    unittest.main()
