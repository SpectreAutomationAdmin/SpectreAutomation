// MEM-HIST-1 §N (2026-10-03) — Membership history resolver stub.
//
// This resolver is the Chapter III (Chair's Dashboard membership
// breakdown) authoritative read. It answers:
//
//   "What was Member X's classification AS OF date Y?"
//   "How many active memberships of each category existed AS OF date Y?"
//
// MEM-HIST-1 scope — the DB tables backing this resolver land in
// MEM-HIST-2. Today the resolver returns an UNAVAILABLE / empty shape
// so Board reporting consumers can wire up to this interface without
// blocking on the schema change.
//
// Design invariant (§7-8): a resolver READ for a historical as-of
// date must NEVER return the "current" value if the historical value
// is different. The query always filters on the effective-dated
// window, never falls back to a mutable `Member.membershipCategory`.

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

/** Availability tag — same shape as the ratio-registry primitives
 *  (TB-HIST-12B). On live tenants without MembershipHistoryEntry
 *  tables yet, we return SOURCE_NOT_CONNECTED on every call. */
export type MembershipResolverProvenance = {
  availability: "AVAILABLE" | "SOURCE_NOT_CONNECTED" | "UNAVAILABLE";
  reason: string;
};

/** Returns the Member's active classification at `asOf`, or null when
 *  the Member had no active entry at that date. The provenance tag
 *  tells callers whether the resolver is live. */
export async function resolveMembershipAsOf(_opts: {
  clubId: string;
  memberId: string;
  asOf: Date;
}): Promise<{ membership: ResolvedMembership | null; provenance: MembershipResolverProvenance }> {
  return {
    membership: null,
    provenance: {
      availability: "SOURCE_NOT_CONNECTED",
      reason: "MembershipHistoryEntry schema lands in MEM-HIST-2 — architecture published in docs/mem-hist-1-member-master-architecture.md",
    },
  };
}

/** Count of active memberships by category at `asOf`. Returns an empty
 *  array in MEM-HIST-1; MEM-HIST-2 wires the Prisma read.  */
export async function countMembershipsByCategoryAsOf(_opts: {
  clubId: string;
  asOf: Date;
}): Promise<{
  counts: Array<{ classificationCode: string; classificationName: string; count: number }>;
  provenance: MembershipResolverProvenance;
}> {
  return {
    counts: [],
    provenance: {
      availability: "SOURCE_NOT_CONNECTED",
      reason: "MembershipHistoryEntry schema lands in MEM-HIST-2 — see docs/mem-hist-1-member-master-architecture.md §N",
    },
  };
}
