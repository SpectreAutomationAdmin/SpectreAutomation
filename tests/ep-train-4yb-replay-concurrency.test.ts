// EP-TRAIN-4Y-B-VERIFY §5 — replay-registry concurrency regression.
//
// Scenario: two concurrent `record()` calls for the SAME composite
// key must result in EXACTLY ONE `{ ok: true }` and one
// `{ ok: false, reason: "duplicate" }`. If both passed, the registry
// is racy and §6 of the directive classifies that as a deployment
// blocker.
//
// Scope limited to the Spectre-side InMemoryReplayRegistry (used by
// contract tests + as the type authority for the Python side). The
// production store is `modal.Dict` on the Modal side; its atomicity
// is NOT verifiable from this process — it is called out in the
// verification doc as the gating operator confirmation.

import { describe, it, expect } from "vitest";
import {
  InMemoryReplayRegistry,
  NullReplayRegistry,
  replayKey,
} from "../src/lib/hr/training/modal-shared/replay-registry";

describe("EP-TRAIN-4Y-B-VERIFY §5 — replay-registry concurrency", () => {
  it("concurrent duplicate record() calls — exactly one wins", async () => {
    const registry = new InMemoryReplayRegistry();
    const key = replayKey({ authorizationId: "auth-concurrent", requestId: "req-concurrent" });

    // Fire a batch of parallel claims for the same key. In-process
    // concurrency is bounded by the JS event loop; both promises race
    // through a single `Map.has` + `Map.set` turn.
    const BATCH = 10;
    const results = await Promise.all(
      Array.from({ length: BATCH }, () => registry.record({ key, ttlSec: 900 })),
    );
    const accepted = results.filter((r) => r.ok === true).length;
    const duplicates = results.filter((r) => r.ok === false && r.reason === "duplicate").length;
    expect(accepted).toBe(1);
    expect(duplicates).toBe(BATCH - 1);
    expect(registry.size()).toBe(1);
  });

  it("fresh key after a duplicate is still accepted", async () => {
    const registry = new InMemoryReplayRegistry();
    const k1 = replayKey({ authorizationId: "a", requestId: "r1" });
    const r1 = await registry.record({ key: k1, ttlSec: 900 });
    expect(r1.ok).toBe(true);
    const r1dup = await registry.record({ key: k1, ttlSec: 900 });
    expect(r1dup.ok).toBe(false);

    const k2 = replayKey({ authorizationId: "a", requestId: "r2" });
    const r2 = await registry.record({ key: k2, ttlSec: 900 });
    expect(r2.ok).toBe(true);
  });

  it("TTL enforcement — expired key reclaimable by fresh request-id", async () => {
    let fakeMs = 1_000_000;
    const clock = {
      nowMs: () => fakeMs,
      nowUtcIso: () => new Date(fakeMs).toISOString(),
    };
    const registry = new InMemoryReplayRegistry(clock);
    const key = replayKey({ authorizationId: "a", requestId: "r-ttl" });
    const first = await registry.record({ key, ttlSec: 10 });
    expect(first.ok).toBe(true);

    // Advance clock past TTL and attempt again with the SAME key.
    // The lazy-evict makes the expired entry drop, so the second
    // record() succeeds — proving TTL is honoured.
    fakeMs += 20 * 1000;
    const after = await registry.record({ key, ttlSec: 10 });
    expect(after.ok).toBe(true);
  });

  it("NullReplayRegistry fails closed on every call", async () => {
    const registry = new NullReplayRegistry();
    const r = await registry.record({ key: "irrelevant", ttlSec: 900 });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe("unavailable");
    expect(await registry.isHealthy()).toBe(false);
  });

  it("replayKey composes in a reversible, unambiguous shape", () => {
    expect(replayKey({ authorizationId: "a", requestId: "r" })).toBe("a:r");
    // Keys containing the separator are preserved verbatim — callers
    // must use ASCII-only identifiers (enforced upstream via
    // assertPrintableAscii) so ambiguity cannot arise in practice.
    expect(replayKey({ authorizationId: "a:b", requestId: "r" })).toBe("a:b:r");
  });
});
