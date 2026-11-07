// Sprint 3 Checkpoint 15D (2026-07-24) — Storage adapter facade for
// the ingested-document layer.
//
// Wraps the existing R2/S3 adapter (src/lib/integrations/storage.ts)
// so the document layer talks in "immutable put / immutable get /
// admin-only delete" terms. The IngestedDocument row records the
// bucket + key that were used at write time — the same key is used
// verbatim for retrieval, no path rewriting.
//
// Test / dev fallback: an in-memory adapter that shares its map
// across a single Node process. Tests wire this explicitly.

import type { DocumentStorageAdapter } from "./types";
import { mailboxAttachmentStorageAdapter } from "../integrations/storage";

const MEMORY_MAP = new Map<string, Buffer>();

export function memoryDocumentStorageAdapter(bucket = "MEMORY"): DocumentStorageAdapter {
  return {
    bucket,
    async put({ storageKey, body }) {
      const key = `${bucket}:${storageKey}`;
      if (MEMORY_MAP.has(key)) {
        // Immutability contract — never overwrite an existing document.
        return;
      }
      MEMORY_MAP.set(key, Buffer.from(body));
    },
    async get({ storageKey }) {
      return MEMORY_MAP.get(`${bucket}:${storageKey}`) ?? null;
    },
    async delete({ storageKey }) {
      MEMORY_MAP.delete(`${bucket}:${storageKey}`);
    },
    async head({ storageKey }) {
      return MEMORY_MAP.has(`${bucket}:${storageKey}`);
    },
  };
}

// Resolves the runtime adapter for a club. Prefers the configured
// R2 bucket (via mailboxAttachmentStorageAdapter) — if the env is
// unset (dev / test), falls back to the process-scoped memory
// adapter. Never throws on missing config; the caller decides how
// to react.
export async function resolveDocumentStorage(args: {
  clubId: string;
}): Promise<DocumentStorageAdapter> {
  const shared = await mailboxAttachmentStorageAdapter();
  if (!shared) {
    return memoryDocumentStorageAdapter("MEMORY");
  }
  const bucket = process.env.S3_BUCKET ?? "R2";
  return {
    bucket,
    async put({ storageKey, body, mimeType }) {
      await shared.put({ clubId: args.clubId, storageKey, body, mimeType });
    },
    async get({ storageKey }) {
      const result = await shared.get({ clubId: args.clubId, storageKey });
      if (result === null) return null;
      if (typeof result === "string") return Buffer.from(result);
      return result;
    },
    async delete({ storageKey }) {
      await shared.delete({ clubId: args.clubId, storageKey });
    },
    async head({ storageKey }) {
      // Not all shared adapters expose a HEAD; fall back to a .get()
      // check in that case.  The S3 adapter now exposes a native head.
      if (typeof (shared as { head?: unknown }).head === "function") {
        return (shared as { head: (a: { clubId: string; storageKey: string }) => Promise<boolean> }).head({ clubId: args.clubId, storageKey });
      }
      const result = await shared.get({ clubId: args.clubId, storageKey });
      return result !== null;
    },
    // EP-TRAIN-4Y-G §5: expose presigned-URL helper when the
    // underlying shared adapter (S3/R2) provides one.
    signUrl: typeof (shared as { signUrl?: unknown }).signUrl === "function"
      ? async (storageKey: string, ttlSec: number) =>
          (shared as {
            signUrl: (a: { clubId: string; storageKey: string; ttlSec: number }) => Promise<string>;
          }).signUrl({ clubId: args.clubId, storageKey, ttlSec })
      : undefined,
  };
}

// Test-only helper — clears every key in the in-memory adapter.
// Used by test setup / teardown so tests don't leak state.
export function _resetMemoryDocumentStorage_TEST_ONLY(): void {
  MEMORY_MAP.clear();
}
