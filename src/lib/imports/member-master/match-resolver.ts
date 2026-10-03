// MEM-HIST-1 §5 / §F / §K (2026-10-03) — member-master match resolver.
//
// PURE in-memory match resolution. For each parsed row, decide one of:
//   MATCHED   — exactly one Member resolved via external identity
//   UNMATCHED — no Member resolves this identifier
//   AMBIGUOUS — 2+ Members share the identifier (DATA DEFECT)
//   INVALID   — row structure already violates the parser contract
//   NEW       — the operator intends to add this member on commit
//
// The caller supplies an `ExistingIdentityIndex` built from Prisma
// (future MEM-HIST-2) or an in-memory stub (MEM-HIST-1 tests). The
// resolver never performs I/O.
//
// §5 enforcement: fuzzy name matching is FORBIDDEN. The resolver
// matches ONLY on `externalIdentifier`. Even if a row has a
// recognizable name, no attachment happens without an external-id
// match.

import type {
  ExistingIdentityIndex,
  MemberMasterRow,
  MemberMatchResolverResult,
  MemberMatchResult,
} from "./types";

export function resolveMemberMatchOutcomes(opts: {
  rows: MemberMasterRow[];
  existingIdentityIndex: ExistingIdentityIndex;
  /** The operator may mark certain rows as "new on this import" ahead
   *  of resolution (e.g. the preview UI's "Add as new" checkbox). The
   *  resolver treats these as NEW regardless of index content. */
  rowsMarkedNew?: ReadonlySet<string>;
}): MemberMatchResolverResult {
  const results: MemberMatchResult[] = [];
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let invalid = 0;
  let newMembers = 0;

  for (let i = 0; i < opts.rows.length; i++) {
    const r = opts.rows[i];
    const ext = r.externalIdentifier;
    if (ext == null || ext === "") {
      // The parser rejects these upstream; defense-in-depth here.
      results.push({
        rowIndex: i,
        externalIdentifier: ext ?? "",
        outcome: "INVALID",
        resolvedMemberId: null,
        reason: "Missing external identifier",
      });
      invalid++;
      continue;
    }

    if (opts.rowsMarkedNew?.has(ext)) {
      results.push({
        rowIndex: i,
        externalIdentifier: ext,
        outcome: "NEW",
        resolvedMemberId: null,
        reason: null,
      });
      newMembers++;
      continue;
    }

    const resolved = opts.existingIdentityIndex.get(ext) ?? [];
    if (resolved.length === 0) {
      results.push({
        rowIndex: i,
        externalIdentifier: ext,
        outcome: "UNMATCHED",
        resolvedMemberId: null,
        reason: "No existing Member carries this external identifier",
      });
      unmatched++;
      continue;
    }
    if (resolved.length > 1) {
      results.push({
        rowIndex: i,
        externalIdentifier: ext,
        outcome: "AMBIGUOUS",
        resolvedMemberId: null,
        reason: `Multiple Members resolve this identifier: ${resolved.join(", ")}`,
      });
      ambiguous++;
      continue;
    }
    results.push({
      rowIndex: i,
      externalIdentifier: ext,
      outcome: "MATCHED",
      resolvedMemberId: resolved[0],
      reason: null,
    });
    matched++;
  }

  return {
    results,
    summary: { matched, unmatched, ambiguous, invalid, newMembers },
  };
}
