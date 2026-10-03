// MEM-HIST-1 §N / MEM-HIST-2 §22-23 (2026-10-03) — Membership history
// resolver.
//
// Reads `MembershipHistoryEntry` with half-open effective windows.
// `resolveMembershipAsOf` guarantees §7-8 historical reproducibility:
// a later classification change NEVER rewrites an earlier as-of
// result because the WHERE clause always filters on effectiveFrom <=
// asOf AND (effectiveTo IS NULL OR asOf < effectiveTo).
//
// §22 — current-membership resolver returns an availability
// provenance so Board reporting consumers can distinguish:
//   AVAILABLE          — resolver resolved rows for the asOf
//   SOURCE_NOT_LOADED  — asOf predates the earliest MembershipHistory
//                        entry (e.g. asking Jan 31 before the Jan TB
//                        snapshot has a corresponding member-master
//                        import)
//
// §23 — the Chapter III Board resolver MUST NOT inject October
// counts into January. The provenance tag + the SOURCE_NOT_LOADED
// state are what prevents that. Reporting callers check availability
// before rendering.

/** The resolved membership state for one Member at a date. */
export type ResolvedMembership = {
  memberId: string;
  classificationCode: string;
  classificationName: string;
  status: string;
  isShareholder: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceSystem: string;
  sourceEffectiveDate: Date;
};

/** Availability tag. */
export type MembershipResolverProvenance = {
  availability: "AVAILABLE" | "SOURCE_NOT_CONNECTED" | "SOURCE_NOT_LOADED" | "UNAVAILABLE";
  reason: string;
};

/** Returns the Member's active classification at `asOf`, or null when
 *  the Member had no active entry at that date. */
export async function resolveMembershipAsOf(opts: {
  clubId: string;
  memberId: string;
  asOf: Date;
}): Promise<{ membership: ResolvedMembership | null; provenance: MembershipResolverProvenance }> {
  const { prisma } = await import("@/lib/prisma");
  // Find the active entry at asOf:
  //   effectiveFrom <= asOf AND (effectiveTo IS NULL OR asOf < effectiveTo)
  // Order by effectiveFrom DESC — the latest-dated row that satisfies
  // the window is authoritative. §7 guarantees that a later entry
  // dated AFTER asOf cannot win because its effectiveFrom > asOf.
  const entry = await prisma.membershipHistoryEntry.findFirst({
    where: {
      clubId: opts.clubId,
      memberId: opts.memberId,
      effectiveFrom: { lte: opts.asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: opts.asOf } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!entry) {
    return {
      membership: null,
      provenance: {
        availability: "SOURCE_NOT_LOADED",
        reason: `No MembershipHistoryEntry active for member ${opts.memberId} at ${opts.asOf.toISOString().slice(0, 10)} — the asOf date predates the loaded source(s)`,
      },
    };
  }
  return {
    membership: {
      memberId: entry.memberId,
      classificationCode: entry.sourceCategory1 ?? entry.sourceStatus,
      classificationName: entry.sourceMembershipDescription ?? entry.sourceStatus,
      status: entry.interpretedStatus,
      isShareholder: entry.isShareholder,
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      sourceSystem: entry.sourceSystem,
      sourceEffectiveDate: entry.sourceEffectiveDate,
    },
    provenance: {
      availability: "AVAILABLE",
      reason: `MembershipHistoryEntry effective ${entry.effectiveFrom.toISOString().slice(0, 10)} (source ${entry.sourceSystem} as-of ${entry.sourceEffectiveDate.toISOString().slice(0, 10)})`,
    },
  };
}

/** Count of active memberships by category at `asOf`. */
export async function countMembershipsByCategoryAsOf(opts: {
  clubId: string;
  asOf: Date;
}): Promise<{
  counts: Array<{ classificationCode: string; classificationName: string; count: number }>;
  provenance: MembershipResolverProvenance;
}> {
  const { prisma } = await import("@/lib/prisma");
  const entries = await prisma.membershipHistoryEntry.findMany({
    where: {
      clubId: opts.clubId,
      effectiveFrom: { lte: opts.asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: opts.asOf } }],
    },
    select: {
      memberId: true,
      sourceStatus: true,
      sourceMembershipDescription: true,
      effectiveFrom: true,
    },
    orderBy: { effectiveFrom: "desc" },
  });
  if (entries.length === 0) {
    return {
      counts: [],
      provenance: {
        availability: "SOURCE_NOT_LOADED",
        reason: `No MembershipHistoryEntry rows active at ${opts.asOf.toISOString().slice(0, 10)} — the asOf date predates every loaded source`,
      },
    };
  }
  // Dedupe by memberId — pick the latest effective-dated row per member.
  const latestByMember = new Map<string, { sourceStatus: string; desc: string | null }>();
  for (const e of entries) {
    if (!latestByMember.has(e.memberId)) {
      latestByMember.set(e.memberId, { sourceStatus: e.sourceStatus, desc: e.sourceMembershipDescription });
    }
  }
  const buckets = new Map<string, { name: string; count: number }>();
  for (const [, v] of latestByMember) {
    const key = v.sourceStatus;
    const name = v.desc ?? v.sourceStatus;
    const b = buckets.get(key) ?? { name, count: 0 };
    b.count++;
    buckets.set(key, b);
  }
  return {
    counts: Array.from(buckets.entries())
      .map(([classificationCode, { name, count }]) => ({ classificationCode, classificationName: name, count }))
      .sort((a, b) => b.count - a.count),
    provenance: {
      availability: "AVAILABLE",
      reason: `Resolved from ${latestByMember.size} active MembershipHistoryEntry rows at ${opts.asOf.toISOString().slice(0, 10)}`,
    },
  };
}
