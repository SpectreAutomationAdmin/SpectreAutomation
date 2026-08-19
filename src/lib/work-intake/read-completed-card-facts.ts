// Sprint 3 · Phase 4R Work Intake Completed-State Immutability
// (2026-08-15) §A5 — narrowing wrapper that decides whether a
// completed WI's card renders from a frozen snapshot or falls
// through to legacy live-projection.
//
// Contract (founder rule §A5):
//   * If a valid cardSnapshot exists on the most recent
//     WorkCompletionEvent for this WI → return `{ source: "frozen", ...}`.
//   * If no snapshot exists (item predates this feature, or non-AP
//     resolve where the API route didn't compose one) → return
//     `{ source: "legacy" }` and the caller falls through to today's
//     live-projection path.
//   * If the WI is not in a completed state at all → return
//     `{ source: "live" }` and the caller uses live-projection
//     (this is the ACTIVE / REOPENED path — never frozen because
//     the current intelligence is authoritative for active work).
//
// This module is tenant-scoped: the caller MUST pass `clubId` and
// this function enforces the WorkCompletionEvent.clubId matches.
// Never reads across tenants.
//
// Reads only — never writes, never invokes analyseIngestedInvoice.

import { prisma } from "@/lib/prisma";
import {
  parseCompletionMetadata,
  readCardSnapshotFromMetadata,
  type CompletionCardSnapshot,
} from "./completion-snapshot";

export type CompletedCardFactsSource =
  /** WorkIntakeItem is not in a terminal state — caller must use live
   *  projection. */
  | { source: "live"; snapshot: null; completionEventId: null }
  /** A cardSnapshot was captured at completion — render this. */
  | { source: "frozen"; snapshot: CompletionCardSnapshot; completionEventId: string; completedAt: Date; completedByUserId: string }
  /** WorkIntakeItem is completed but no snapshot exists (predates the
   *  freeze feature, or a legacy resolve path did not compose one).
   *  Caller falls through to legacy live-projection. */
  | { source: "legacy"; snapshot: null; completionEventId: string | null };

const COMPLETED_STATUSES = ["RESOLVED", "SUPPRESSED"] as const;

/** Return the frozen snapshot, if any, for a completed WI. Tenant-scoped. */
export async function readCompletedCardFacts(args: {
  clubId: string;
  workIntakeItemId: string;
}): Promise<CompletedCardFactsSource> {
  const wi = await prisma.workIntakeItem.findFirst({
    where: { id: args.workIntakeItemId, clubId: args.clubId },
    select: { status: true },
  });
  if (!wi) {
    // Not visible / does not exist → treat as live so the caller's
    // own tenant check triggers a 404 downstream.
    return { source: "live", snapshot: null, completionEventId: null };
  }
  if (!COMPLETED_STATUSES.includes(wi.status as (typeof COMPLETED_STATUSES)[number])) {
    return { source: "live", snapshot: null, completionEventId: null };
  }

  // Most-recent completion event wins. Preserves prior completions in
  // the audit trail while rendering the latest approved snapshot.
  const event = await prisma.workCompletionEvent.findFirst({
    where: { clubId: args.clubId, workIntakeItemId: args.workIntakeItemId },
    orderBy: { completedAt: "desc" },
    select: { id: true, metadataJson: true, completedAt: true, completedByUserId: true },
  });
  if (!event) {
    // Completed but no event row (pre-16H completions — the completion
    // emitter wasn't wired). Legacy fallback.
    return { source: "legacy", snapshot: null, completionEventId: null };
  }
  const meta = parseCompletionMetadata(event.metadataJson);
  const snap = readCardSnapshotFromMetadata(meta);
  if (!snap) {
    // Event exists but no shape-valid cardSnapshot inside — legacy fallback.
    return { source: "legacy", snapshot: null, completionEventId: event.id };
  }
  return {
    source: "frozen",
    snapshot: snap,
    completionEventId: event.id,
    completedAt: event.completedAt,
    completedByUserId: event.completedByUserId,
  };
}
