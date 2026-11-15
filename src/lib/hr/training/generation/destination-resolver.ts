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

/** Draft states that count as a question having been produced for its
 *  plan group (as opposed to discarded, failed or still being built). */
export const PRODUCED_DRAFT_STATES: ReadonlySet<string> = new Set([
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "PROMOTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_PENDING",
]);

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

interface PerGroupDiagnosticRow {
  readonly group?: unknown;
  readonly recoveryHistory?: unknown;
}

interface RecoveryHistoryEntry {
  readonly contentHash?: unknown;
  readonly savedAsDraftId?: unknown;
}

/** Parse the shortfallReasonJson into a `contentHash → group` map
 *  across both sources that persist a draft in the DB:
 *    1. `dedupDecisions[]` with `kept: true` — the normal GPU-sourced
 *       draft produced by the worker.
 *    2. `perGroupDiagnostics[g].recoveryHistory[]` — the AS manager
 *       editorial recovery draft produced by the recovery service.
 *  Both paths write a `TrainingQuestionAiDraft` row whose
 *  `contentHash` the Manager Review surface must resolve to the
 *  owning plan group so the destination (CHECKPOINT vs
 *  FINAL_ASSESSMENT) is known. Unknown JSON shapes degrade to an
 *  empty map — the caller fans out every draft as UNKNOWN in that
 *  case. */
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

  // (1) dedupDecisions — the GPU-generation-side path.
  const decisions = (parsed as { dedupDecisions?: unknown }).dedupDecisions;
  if (Array.isArray(decisions)) {
    for (const raw of decisions) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as DedupDecisionRow;
      if (row.kept !== true) continue;
      if (typeof row.group !== "string") continue;
      if (typeof row.candidateContentHash !== "string") continue;
      // Deliberately do not overwrite: the FIRST kept row for a hash
      // wins. Content hashes are unique by @@unique([clubId,
      // courseVersionId, contentHash]) so this collision cannot
      // happen within a single run, but double-registration is a
      // stable tie-break.
      if (!map.has(row.candidateContentHash)) {
        map.set(row.candidateContentHash, row.group);
      }
    }
  }

  // (2) perGroupDiagnostics[g].recoveryHistory — the AS manager-
  // editorial recovery path. EP-TRAIN-4Y-AT (2026-11-11). Every
  // history entry already carries the group id implicitly via its
  // containing `perGroupDiagnostics[g].group`, so we stamp the
  // same group onto the recovered draft's contentHash. This fixes
  // the Q7 "destination unknown" defect where an AS-recovered
  // draft had no `kept: true` dedup row to anchor against.
  const perGroupDiagnostics = (parsed as { perGroupDiagnostics?: unknown }).perGroupDiagnostics;
  if (Array.isArray(perGroupDiagnostics)) {
    for (const rawGroup of perGroupDiagnostics) {
      if (!rawGroup || typeof rawGroup !== "object") continue;
      const grow = rawGroup as PerGroupDiagnosticRow;
      if (typeof grow.group !== "string") continue;
      if (!Array.isArray(grow.recoveryHistory)) continue;
      for (const rh of grow.recoveryHistory) {
        if (!rh || typeof rh !== "object") continue;
        const entry = rh as RecoveryHistoryEntry;
        if (typeof entry.contentHash !== "string") continue;
        if (typeof entry.savedAsDraftId !== "string") continue;
        // First mapping wins per `candidateContentHash` so a prior
        // dedup-kept row is NOT overwritten by a later recovery.
        if (!map.has(entry.contentHash)) {
          map.set(entry.contentHash, grow.group);
        }
      }
    }
  }
  return map;
}

/** Map a plan group id (`cg-*` / `final` / `fa-*`) to a destination
 *  kind. Pure, name-based. Naming conventions:
 *    - `cg-*`  → CHECKPOINT (worker-handler default)
 *    - `final` → FINAL_ASSESSMENT (legacy single-call FA path)
 *    - `fa-*`  → FINAL_ASSESSMENT (EP-TRAIN-4Y-AF chunked FA path)
 *  Any non-`final` / non-`fa-*` id is treated as a per-checkpoint
 *  bucket to stay compatible with future `ck-<cuid>` schemes. */
export function destinationKindForGroup(group: string | null | undefined): DestinationKind {
  if (!group) return "UNKNOWN";
  if (group === "final") return "FINAL_ASSESSMENT";
  if (/^fa-\d+$/.test(group)) return "FINAL_ASSESSMENT";
  return "CHECKPOINT";
}

/** EP-TRAIN-4Y-AF §6 — union shortfall-group maps across every
 *  completed generation run for a (clubId, courseVersionId). The FA
 *  recovery lifecycle creates a NEW run; its drafts live beside the
 *  original run's checkpoint drafts, and the review page must resolve
 *  destinations across BOTH runs. Pure/offline: takes a list of
 *  shortfallReasonJson strings and returns one composed map. FIRST
 *  mapping wins per `candidateContentHash` (stable tie-break). */
export function composeGroupMapsFromRuns(
  shortfallReasonJsons: readonly (string | null | undefined)[],
): Map<string, string> {
  const composed = new Map<string, string>();
  for (const json of shortfallReasonJsons) {
    const m = parseShortfallGroupMap(json);
    for (const [hash, group] of m) {
      if (!composed.has(hash)) composed.set(hash, group);
    }
  }
  return composed;
}

export interface DraftPlacement {
  /** Plan group id inside the run that produced the draft. */
  readonly group: string;
  /** That group's timestamp in the SAME run's plan; null when the
   *  group is not a checkpoint group of that plan. */
  readonly atSec: number | null;
}

export interface RunPlacementSource {
  readonly shortfallReasonJson: string | null | undefined;
  readonly assessmentPlanJson: string | null | undefined;
}

/** `groupId → atSec` for the checkpoint groups of one plan. Malformed
 *  JSON and non-finite timestamps degrade to an empty / partial map. */
export function parsePlanCheckpointGroupAtSec(
  assessmentPlanJson: string | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!assessmentPlanJson || typeof assessmentPlanJson !== "string") return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(assessmentPlanJson);
  } catch {
    return map;
  }
  if (!parsed || typeof parsed !== "object") return map;
  const groups = (parsed as { proposedCheckpointGroups?: unknown }).proposedCheckpointGroups;
  if (!Array.isArray(groups)) return map;
  for (const raw of groups) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as { id?: unknown; atSec?: unknown };
    if (typeof g.id !== "string") continue;
    if (typeof g.atSec !== "number" || !Number.isFinite(g.atSec)) continue;
    if (!map.has(g.id)) map.set(g.id, g.atSec);
  }
  return map;
}

/** `contentHash → { group, atSec }` across every run, FIRST mapping
 *  wins per hash (same tie-break as `composeGroupMapsFromRuns`, so the
 *  group always agrees with it for the same run order). The timestamp
 *  is read from the plan of the run that produced the draft: group ids
 *  such as "cg-1" repeat across runs and can sit at different times. */
export function composeDraftPlacementsFromRuns(
  runs: readonly RunPlacementSource[],
): Map<string, DraftPlacement> {
  const composed = new Map<string, DraftPlacement>();
  for (const run of runs) {
    const groupByHash = parseShortfallGroupMap(run.shortfallReasonJson);
    if (groupByHash.size === 0) continue;
    const atSecByGroup = parsePlanCheckpointGroupAtSec(run.assessmentPlanJson);
    for (const [hash, group] of groupByHash) {
      if (composed.has(hash)) continue;
      composed.set(hash, { group, atSec: atSecByGroup.get(group) ?? null });
    }
  }
  return composed;
}

export interface DraftLineageNode {
  readonly id: string;
  readonly contentHash: string;
  readonly supersedesDraftId: string | null;
  /** Present once the draft was accepted into the course. Nothing is
   *  inherited through such an ancestor: it is bound to the place it
   *  was accepted into, which need not be the planned one. */
  readonly promotion?: unknown;
}

export const DRAFT_LINEAGE_MAX_DEPTH = 5;

/** Look a draft up in a `contentHash → value` map (a group map or a
 *  placement map), falling back to the drafts it superseded. A manager
 *  edit replaces a draft under a new content hash that no run names, so
 *  a lookup by the draft's own hash alone loses every edited question.
 *  `draftById` must hold every draft of the version, archived included. */
export function resolveByDraftLineage<T>(
  draft: DraftLineageNode,
  draftById: ReadonlyMap<string, DraftLineageNode>,
  valueByContentHash: ReadonlyMap<string, T>,
): T | null {
  const own = valueByContentHash.get(draft.contentHash);
  if (own !== undefined) return own;
  let cursor = draft.supersedesDraftId;
  for (let depth = 0; depth < DRAFT_LINEAGE_MAX_DEPTH && cursor; depth++) {
    const ancestor = draftById.get(cursor);
    if (!ancestor) return null;
    const inherited = valueByContentHash.get(ancestor.contentHash);
    if (inherited !== undefined) return inherited;
    if (ancestor.promotion) return null;
    cursor = ancestor.supersedesDraftId;
  }
  return null;
}

/** EP-TRAIN-4Y-AF §6 — annotate drafts using a PRE-COMPOSED
 *  contentHash → group map (from `composeGroupMapsFromRuns`). The
 *  single-run variant above is preserved for backwards compatibility
 *  and for the existing contract tests. */
export function annotateDraftsWithComposedDestination<D extends DraftLike>(args: {
  readonly drafts: readonly D[];
  readonly composedGroupMap: ReadonlyMap<string, string>;
}): DraftWithDestination<D>[] {
  return args.drafts.map((draft) => {
    const group = args.composedGroupMap.get(draft.contentHash) ?? null;
    return {
      draft,
      destination: destinationKindForGroup(group),
      planGroupKey: group,
    };
  });
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
