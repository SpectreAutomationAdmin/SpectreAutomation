// Deterministic hash of a snapshot's value-bearing payload.
//
// Used by the storage backend to short-circuit bit-identical
// re-imports: when an importer re-runs and the new payload hashes
// to the same value as the most recent committed snapshot for the
// same logical identity, `upsertSnapshot` returns `replaced: false`
// without writing a new physical row.
//
// Requirements:
//   • Deterministic: the same payload produces the same hash every
//     time, including across runs and processes.
//   • Order-insensitive on object keys (a snapshot serialised with
//     keys in a different order must hash identically).
//   • Excludes metadata fields that vary between writes for the
//     same logical snapshot (`snapshotId`, `capturedAt`,
//     `importBatchId`) — those don't represent value drift.
//   • Does NOT need cryptographic strength; collision resistance
//     between actual snapshot values is the only requirement.
//     SHA-256 is overkill but available in node:crypto so we use
//     it for simplicity + zero deps.

import { createHash } from "node:crypto";

import type { LedgerSnapshot } from "@/lib/reporting/ledger/contracts";

/**
 * Fields excluded from the hash because they vary across legitimate
 * re-imports of the same logical snapshot. The hash represents
 * "is the value-bearing content of this snapshot identical to the
 * previous one?" — metadata that changes on every write must NOT
 * affect the answer.
 */
const EXCLUDED_METADATA_FIELDS = new Set<string>([
  "snapshotId",
  "capturedAt",
  "importBatchId",
  "notes",
]);

/**
 * Compute the deterministic hash of a snapshot's value-bearing
 * payload. Equal hashes mean bit-identical value content; unequal
 * hashes mean the snapshot has drifted and a replacement row must
 * be written.
 */
export function computePayloadHash(snapshot: LedgerSnapshot): string {
  const canonical = canonicalize(snapshot);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Canonical JSON serialisation:
 *   - Object keys sorted alphabetically so order doesn't matter.
 *   - `Date` values rendered as ISO 8601 strings (deterministic).
 *   - `undefined` fields omitted (equivalent to absent).
 *   - Excluded metadata fields omitted at the top level.
 *
 * The result is a string ready for hashing.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(value, replacer, 0)
    // The replacer below emits placeholder tokens; sort the keys
    // by reserialising through a deterministic object walker.
    ;
}

function replacer(key: string, value: unknown): unknown {
  // Top-level exclusions — metadata that doesn't drive value
  // identity.
  if (EXCLUDED_METADATA_FIELDS.has(key)) return undefined;
  if (value instanceof Date) return value.toISOString();
  // Sort object keys so serialisation is order-independent.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const sorted: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Two snapshots have identical value content iff their payload
 * hashes match. Used by the storage backend's idempotency check.
 */
export function snapshotsHaveSameValue(
  a: LedgerSnapshot,
  b: LedgerSnapshot,
): boolean {
  return computePayloadHash(a) === computePayloadHash(b);
}
