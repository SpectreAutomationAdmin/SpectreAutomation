// EP-TRAIN-6D-4B — canonical content-hash helper.
//
// Byte-identical to the canonicaliser used by
// src/lib/training/ai-generation/convert-draft-to-proposal.ts and the
// Modal server-side canonicaliser (modal/common.py :: canonicalise).
// This guarantees `contentHash` on a persisted draft matches the hash
// the generator pipeline + validator produce.

import { createHash } from "node:crypto";
import type { TrainingQuestionDraftLiteV1 } from "@/lib/training/ai-generation";

export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalise).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) =>
    JSON.stringify(k) + ":" + canonicalise((value as Record<string, unknown>)[k])
  ).join(",") + "}";
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Canonical content hash of a Lite draft. Changes to any of:
 *   questionType, questionText, options[].text, options[].isCorrect,
 *   explanation, sourceSegmentIds
 * invalidate the hash. The draft body is serialised with sorted keys
 * so semantically-identical representations collide to one hash.
 */
export function draftContentHash(draft: TrainingQuestionDraftLiteV1): string {
  return sha256Hex(canonicalise(draft));
}

/**
 * Canonical JSON form of a draft — the exact string whose SHA-256 is
 * `draftContentHash`. Persisted to `TrainingQuestionAiDraft.draftJson`
 * so future consumers never have to re-canonicalise to re-check.
 */
export function canonicalDraftJson(draft: TrainingQuestionDraftLiteV1): string {
  return canonicalise(draft);
}
