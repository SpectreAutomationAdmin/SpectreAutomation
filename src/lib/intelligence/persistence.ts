// Sprint 3 Checkpoint 15B (2026-07-24) — Finding persistence with
// deterministic supersession + user-rejection preservation.
//
// Contract:
//   * A rerun with identical inputs adds ZERO new active findings.
//     Identity is defined semantically (findingIdentityKey) — not by
//     row id or timestamp.
//   * A finding that no longer appears in the desired set transitions
//     CONFIRMED/OBSERVED → SUPERSEDED. Never physically deleted.
//   * A USER_REJECTED finding survives regeneration. Its analyser
//     rule will not silently re-emit the same finding as CONFIRMED.
//     If the same rule later produces a DIFFERENT statement/severity/
//     evidence-refs, a new row is created (history preserved).
//   * Every write is tenant-guarded: the intake must belong to the
//     stated clubId; every evidence reference must resolve on that
//     same club.
//   * `lastAnalysedAt` on the intake is advanced only when the
//     analysis materially changes (findings added, superseded, or
//     rejection-adjusted). A pure no-op run leaves it unchanged.

import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import {
  findingIdentityKey,
  IntelligenceError,
  type EvidenceReference,
  type FindingInput,
  type FindingState,
  type FindingSeverity,
  type PersistedFinding,
} from "./types";
import { resolveEvidenceReferences } from "./origins";

/** Assert the intake belongs to the stated club. Throws otherwise. */
async function assertIntakeInClub(
  workIntakeItemId: string,
  clubId: string,
): Promise<void> {
  const count = await prisma.workIntakeItem.count({
    where: { id: workIntakeItemId, clubId },
  });
  if (count !== 1) {
    throw new IntelligenceError(
      "TENANT_MISMATCH",
      `Intake ${workIntakeItemId} does not belong to club ${clubId}`,
    );
  }
}

/** Upsert one run's worth of findings. Returns per-row disposition. */
export async function upsertAnalysisFindings(args: {
  clubId: string;
  workIntakeItemId: string;
  desired: FindingInput[];
  analysisRunId?: string;
}): Promise<{
  analysisRunId: string;
  created: number;
  preserved: number;
  superseded: number;
  rejectedPreserved: number;
  active: PersistedFinding[];
}> {
  const { clubId, workIntakeItemId } = args;
  const analysisRunId = args.analysisRunId ?? randomUUID();

  await assertIntakeInClub(workIntakeItemId, clubId);

  // Cross-check every evidence reference before writing anything.
  for (const d of args.desired) {
    await resolveEvidenceReferences({ clubId, refs: d.evidenceRefs });
  }
  // Bounded findings per run
  if (args.desired.length > 32) {
    throw new IntelligenceError(
      "PERSISTENCE_CONFLICT",
      `Analysis emitted ${args.desired.length} findings (max 32).`,
    );
  }

  // Load all findings for the intake — includes SUPERSEDED and
  // USER_REJECTED so we can decide semantics correctly.
  const existing = await prisma.workIntakeFinding.findMany({
    where: { workIntakeItemId },
  });

  // Index desired findings by their semantic identity.
  const desiredByIdentity = new Map<string, FindingInput>();
  for (const d of args.desired) {
    desiredByIdentity.set(findingIdentityKey(d), d);
  }

  // Index existing ACTIVE findings by semantic identity — an active
  // row exactly matching a desired row means "preserve unchanged."
  const activeExistingByIdentity = new Map<
    string,
    (typeof existing)[number]
  >();
  const activeExistingByKey = new Map<string, (typeof existing)[number][]>();
  const rejectedByKey = new Map<string, (typeof existing)[number][]>();
  for (const e of existing) {
    if (e.state === "CONFIRMED" || e.state === "OBSERVED") {
      activeExistingByIdentity.set(existingIdentityKey(e), e);
      let bucket = activeExistingByKey.get(e.key);
      if (!bucket) {
        bucket = [];
        activeExistingByKey.set(e.key, bucket);
      }
      bucket.push(e);
    } else if (e.state === "USER_REJECTED") {
      let bucket = rejectedByKey.get(e.key);
      if (!bucket) {
        bucket = [];
        rejectedByKey.set(e.key, bucket);
      }
      bucket.push(e);
    }
  }

  let created = 0;
  let preserved = 0;
  let superseded = 0;
  let rejectedPreserved = rejectedByKey.size;

  // Insert / preserve.
  for (const [identity, d] of desiredByIdentity.entries()) {
    // Skip if a USER_REJECTED row exists for this key AND identical
    // to what we'd emit. Rule: rejections survive; do not silently
    // re-activate.
    const rejectedSameShape = (rejectedByKey.get(d.key) ?? []).some(
      (r) => existingIdentityKey(r) === identity,
    );
    if (rejectedSameShape) {
      // The rejection stands. Do nothing.
      continue;
    }
    if (activeExistingByIdentity.has(identity)) {
      preserved += 1;
      continue;
    }
    await prisma.workIntakeFinding.create({
      data: {
        clubId,
        workIntakeItemId,
        key: d.key,
        statement: d.statement,
        state: d.state,
        severity: d.severity,
        materialityCents: d.materialityCents ?? null,
        ruleKey: d.ruleKey,
        ruleVersion: d.ruleVersion,
        evidenceRefsJson: JSON.stringify(
          d.evidenceRefs.map((r) => ({ kind: r.kind, referenceId: r.referenceId })),
        ),
        analysisRunId,
      },
    });
    created += 1;
  }

  // Supersede — every active existing row that has no desired
  // counterpart flips to SUPERSEDED. Preserves history: the row is
  // NOT deleted.
  const desiredKeys = new Set(args.desired.map((d) => d.key));
  for (const [identity, e] of activeExistingByIdentity.entries()) {
    // Same identity re-emitted → preserved by the branch above.
    if (desiredByIdentity.has(identity)) continue;
    // Same key, different shape → the old row is superseded.
    // (A rule may still be emitting the same key but with different
    // evidence or severity — that's a material change worth history.)
    if (desiredKeys.has(e.key)) {
      await prisma.workIntakeFinding.update({
        where: { id: e.id },
        data: { state: "SUPERSEDED" },
      });
      superseded += 1;
      continue;
    }
    // Key no longer emitted → superseded.
    await prisma.workIntakeFinding.update({
      where: { id: e.id },
      data: { state: "SUPERSEDED" },
    });
    superseded += 1;
  }

  const materialChange = created > 0 || superseded > 0;
  if (materialChange) {
    await prisma.workIntakeItem.update({
      where: { id: workIntakeItemId },
      data: { lastAnalysedAt: new Date() },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId,
        action: "ANALYSIS_REFRESHED",
        note: `analysisRunId:${analysisRunId} · +${created}/~${preserved}/-${superseded}`,
      },
    });
  }

  const active = await readActiveFindings(workIntakeItemId);

  return {
    analysisRunId,
    created,
    preserved,
    superseded,
    rejectedPreserved,
    active,
  };
}

/** Read active + observed findings on the intake. Excludes
 *  SUPERSEDED and USER_REJECTED unless explicitly requested. */
export async function readActiveFindings(
  workIntakeItemId: string,
): Promise<PersistedFinding[]> {
  const rows = await prisma.workIntakeFinding.findMany({
    where: {
      workIntakeItemId,
      state: { in: ["CONFIRMED", "OBSERVED"] },
    },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(rowToPersistedFinding);
}

/** Read all findings on the intake (including SUPERSEDED + USER_REJECTED).
 *  Used by the audit surface. */
export async function readAllFindings(
  workIntakeItemId: string,
): Promise<PersistedFinding[]> {
  const rows = await prisma.workIntakeFinding.findMany({
    where: { workIntakeItemId },
    orderBy: [{ createdAt: "asc" }],
  });
  return rows.map(rowToPersistedFinding);
}

/** Mark a specific finding as USER_REJECTED. Tenant-guarded. */
export async function rejectFinding(args: {
  clubId: string;
  workIntakeItemId: string;
  findingId: string;
  userId: string;
  reason: string;
}): Promise<PersistedFinding> {
  await assertIntakeInClub(args.workIntakeItemId, args.clubId);
  const finding = await prisma.workIntakeFinding.findFirst({
    where: {
      id: args.findingId,
      workIntakeItemId: args.workIntakeItemId,
      clubId: args.clubId,
    },
  });
  if (!finding) {
    throw new IntelligenceError(
      "DATA_MISSING",
      `Finding ${args.findingId} not found on intake ${args.workIntakeItemId}`,
    );
  }
  const updated = await prisma.workIntakeFinding.update({
    where: { id: args.findingId },
    data: {
      state: "USER_REJECTED",
      overriddenByUserId: args.userId,
      overriddenAt: new Date(),
      overrideReason: args.reason,
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: args.workIntakeItemId,
      actorUserId: args.userId,
      action: "FINDING_OVERRIDDEN",
      note: `finding:${args.findingId} · reason:${args.reason.slice(0, 120)}`,
    },
  });
  return rowToPersistedFinding(updated);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function existingIdentityKey(row: {
  key: string;
  state: string;
  severity: string;
  materialityCents: bigint | null;
  ruleKey: string;
  ruleVersion: number;
  statement: string;
  evidenceRefsJson: string;
}): string {
  const refs = safeParseRefs(row.evidenceRefsJson)
    .sort((a, b) => (a.kind + a.referenceId).localeCompare(b.kind + b.referenceId))
    .map((r) => `${r.kind}:${r.referenceId}`)
    .join("|");
  return [
    row.key,
    row.state,
    row.severity,
    row.materialityCents?.toString() ?? "-",
    row.ruleKey,
    row.ruleVersion,
    row.statement,
    refs,
  ].join("§");
}

function safeParseRefs(json: string): EvidenceReference[] {
  try {
    const parsed = JSON.parse(json) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is { kind: string; referenceId: string } => {
        return (
          typeof r === "object" &&
          r !== null &&
          typeof (r as { kind?: unknown }).kind === "string" &&
          typeof (r as { referenceId?: unknown }).referenceId === "string"
        );
      })
      .map((r) => ({
        kind: r.kind as EvidenceReference["kind"],
        referenceId: r.referenceId,
      }));
  } catch {
    return [];
  }
}

function rowToPersistedFinding(row: {
  id: string;
  key: string;
  statement: string;
  state: string;
  severity: string;
  materialityCents: bigint | null;
  ruleKey: string;
  ruleVersion: number;
  evidenceRefsJson: string;
  analysisRunId: string | null;
  overriddenByUserId: string | null;
  overriddenAt: Date | null;
  overrideReason: string | null;
  createdAt: Date;
}): PersistedFinding {
  return {
    id: row.id,
    key: row.key,
    statement: row.statement,
    state: row.state as FindingState,
    severity: row.severity as FindingSeverity,
    materialityCents: row.materialityCents,
    ruleKey: row.ruleKey,
    ruleVersion: row.ruleVersion,
    evidenceRefs: safeParseRefs(row.evidenceRefsJson),
    analysisRunId: row.analysisRunId,
    overriddenByUserId: row.overriddenByUserId,
    overriddenAt: row.overriddenAt?.toISOString() ?? null,
    overrideReason: row.overrideReason,
    createdAt: row.createdAt.toISOString(),
  };
}
