// EP-TRAIN-4Y-AA §5 — map persisted drafts to their generation-plan
// destination (CHECKPOINT vs FINAL_ASSESSMENT) without a schema change.
//
// Problem: TrainingQuestionAiDraft has no direct `destinationKind`
// column. The destination is known at generation time (worker-handler
// pushes {group, kind, contentHash} into its in-memory `generatedDrafts`
// + `dedupLog` arrays) but historically was only persisted on the
// post-promotion sidecar. The Manager Review surface needs to filter
// drafts by destination BEFORE promotion.
//
// Solution: `TrainingQuestionAiGenerationRun.shortfallReasonJson` is
// already populated by the worker with the full per-candidate dedup
// decision log (schemaVersion "shortfall-v1"). Every kept draft has a
// `{group, candidateContentHash, kept: true}` row there. We match the
// draft row's `contentHash` against the dedup log's
// `candidateContentHash` to recover the group — and from the group's
// `cg-*` vs `final` naming we recover the destination kind.
//
// This module is pure + offline: it takes the shortfallReasonJson
// string and a list of drafts and returns the mapping. No DB, no I/O.

export type DestinationKind = "CHECKPOINT" | "FINAL_ASSESSMENT" | "UNKNOWN";

export interface DraftLike {
  readonly id: string;
  readonly contentHash: string;
}

export interface DraftWithDestination<D extends DraftLike = DraftLike> {
  readonly draft: D;
  readonly destination: DestinationKind;
  /** Plan group id (e.g. "cg-1", "final"). UNKNOWN when unresolvable. */
  readonly planGroupKey: string | null;
}

interface DedupDecisionRow {
  readonly group?: unknown;
  readonly candidateContentHash?: unknown;
  readonly kept?: unknown;
}

/** Parse the shortfallReasonJson into a `contentHash → group` map,
 *  keeping only `kept: true` rows (duplicates were dropped and have
 *  no persisted draft). Unknown JSON shapes degrade to an empty map
 *  — the caller fans out every draft as UNKNOWN in that case. */
export function parseShortfallGroupMap(
  shortfallReasonJson: string | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!shortfallReasonJson || typeof shortfallReasonJson !== "string") return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(shortfallReasonJson);
  } catch {
    return map;
  }
  if (!parsed || typeof parsed !== "object") return map;
  const decisions = (parsed as { dedupDecisions?: unknown }).dedupDecisions;
  if (!Array.isArray(decisions)) return map;
  for (const raw of decisions) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as DedupDecisionRow;
    if (row.kept !== true) continue;
    if (typeof row.group !== "string") continue;
    if (typeof row.candidateContentHash !== "string") continue;
    // Deliberately do not overwrite: the FIRST kept row for a hash
    // wins. Content hashes are unique by @@unique([clubId,
    // courseVersionId, contentHash]) so this collision cannot happen
    // within a single run, but double-registration is a stable
    // tie-break.
    if (!map.has(row.candidateContentHash)) {
      map.set(row.candidateContentHash, row.group);
    }
  }
  return map;
}

/** Map a plan group id (`cg-*` / `final`) to a destination kind.
 *  Pure, name-based. The convention is set by worker-handler.ts
 *  where `plan.proposedCheckpointGroups` are referenced by their
 *  `g.id` (always distinct non-"final" names) and the final
 *  assessment group uses the literal id `"final"`. */
export function destinationKindForGroup(group: string | null | undefined): DestinationKind {
  if (!group) return "UNKNOWN";
  if (group === "final") return "FINAL_ASSESSMENT";
  // Any non-"final" group id represents a per-checkpoint bucket.
  // `cg-1`, `cg-2`, … is the worker's default naming; any future
  // scheme (e.g. `ck-<cuid>`) is still CHECKPOINT-shaped as long as
  // it is not literally `"final"`.
  return "CHECKPOINT";
}

/** Annotate each draft with its destination using the run's
 *  shortfallReasonJson as the authoritative source. A draft whose
 *  contentHash does not appear in the dedup log is marked UNKNOWN —
 *  the review surface MUST render it in both tabs so no draft is
 *  hidden from the reviewer, and the acceptance report must flag
 *  any such entries as a §5 defect. */
export function annotateDraftsWithDestination<D extends DraftLike>(args: {
  readonly drafts: readonly D[];
  readonly shortfallReasonJson: string | null | undefined;
}): DraftWithDestination<D>[] {
  const hashToGroup = parseShortfallGroupMap(args.shortfallReasonJson);
  return args.drafts.map((draft) => {
    const group = hashToGroup.get(draft.contentHash) ?? null;
    return {
      draft,
      destination: destinationKindForGroup(group),
      planGroupKey: group,
    };
  });
}
