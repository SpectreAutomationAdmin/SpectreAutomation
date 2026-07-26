// Sprint 3 Checkpoint 15D (2026-07-24) — Deterministic SHA-256
// fingerprint for the ingested-document layer.
//
// One function on purpose: hex lowercase, 64 chars. No streaming
// API — the ingest cap is 25 MB so Buffer-in-memory is the right
// trade for determinism + testability.

import { createHash } from "node:crypto";

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Storage key convention (relative — the storage adapter prepends
// `clubs/{clubId}/`):
//
//   ingested-documents/{yyyy}/{mm}/{sha256}
//
// The sha256 doubles as the object name; the (clubId, sha256Hash)
// tuple is the canonical identity — the Prisma unique constraint
// enforces it.
export function storageKeyFor(args: { sha256Hash: string; receivedAt: Date }): string {
  const y = args.receivedAt.getUTCFullYear();
  const m = String(args.receivedAt.getUTCMonth() + 1).padStart(2, "0");
  return `ingested-documents/${y}/${m}/${args.sha256Hash}`;
}
