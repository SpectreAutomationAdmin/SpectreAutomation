// EP-TRAIN-4Y-B-IMPL (2026-11-07) — replay-registry interface + two
// test implementations (in-memory + null).
//
// The PRODUCTION replay registry lives on the Modal side (one shared
// `modal.Dict` per workspace scoped by contract version). The Spectre
// client-side code does NOT keep a replay registry — replays are a
// server-side concern. This module exists on the Spectre side for
// two reasons:
//
//   1. Test fixtures: the Vitest contract tests mock a Modal
//      function + need a replay registry. In-memory implementation
//      is enough.
//   2. Type authority: the contract interface lives here so both the
//      Python side (modal/shared/replay.py) and the TS tests agree
//      on the semantics.
//
// §6 rule: a replay-registry outage must fail closed. The
// `NullReplayRegistry` returns `{ ok: false, reason: "unavailable" }`
// on every call — it is the explicit stand-in for "store is down".

import type { Clock } from "./types";
import { SYSTEM_CLOCK } from "./types";

export interface ReplayRegistryRecordInput {
  /** The composite key: `${authorizationId}:${requestId}`. */
  readonly key: string;
  /** TTL for this key, seconds. Must be ≤ server-side window. */
  readonly ttlSec: number;
}

export type ReplayRegistryRecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "duplicate" }
  | { readonly ok: false; readonly reason: "unavailable" };

export interface ReplayRegistry {
  /** Attempt to record `key` as seen. ok:true iff the key is new
   *  AND the store is healthy; duplicate iff the key is in the
   *  live window; unavailable iff the store is down. */
  record(input: ReplayRegistryRecordInput): Promise<ReplayRegistryRecordResult>;
  /** Non-cryptographic health check. ok:true => the next `record`
   *  call is expected to succeed. ok:false => the store is
   *  unhealthy; fail closed. */
  isHealthy(): Promise<boolean>;
}

/** In-memory registry — test-only. Not durable, not distributed. */
export class InMemoryReplayRegistry implements ReplayRegistry {
  readonly #store: Map<string, number> = new Map();
  readonly #clock: Clock;

  constructor(clock: Clock = SYSTEM_CLOCK) {
    this.#clock = clock;
  }

  async record(input: ReplayRegistryRecordInput): Promise<ReplayRegistryRecordResult> {
    const nowMs = this.#clock.nowMs();
    // Evict expired entries lazily.
    for (const [k, expiresAtMs] of this.#store.entries()) {
      if (expiresAtMs <= nowMs) this.#store.delete(k);
    }
    if (this.#store.has(input.key)) {
      return { ok: false, reason: "duplicate" };
    }
    this.#store.set(input.key, nowMs + input.ttlSec * 1000);
    return { ok: true };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  /** Test-only inspection. */
  size(): number {
    return this.#store.size;
  }
}

/** Stand-in for "the registry is down". Every call returns
 *  `{ ok: false, reason: "unavailable" }`. §6 fail-closed: a
 *  server using this registry MUST refuse every request. */
export class NullReplayRegistry implements ReplayRegistry {
  async record(_input: ReplayRegistryRecordInput): Promise<ReplayRegistryRecordResult> {
    return { ok: false, reason: "unavailable" };
  }
  async isHealthy(): Promise<boolean> {
    return false;
  }
}

/** Build the canonical replay key for a given envelope. */
export function replayKey(args: {
  readonly authorizationId: string;
  readonly requestId: string;
}): string {
  return `${args.authorizationId}:${args.requestId}`;
}
