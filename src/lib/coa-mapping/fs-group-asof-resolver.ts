// COA-MAP-1 (2026-10-06) — effective-dated FS Group resolver.
//
// Resolves an account's Financial Statement Group AS OF a reporting
// date. Picks the `AccountFinancialStatementAssignment` row where
//
//   effectiveFrom <= asOf < (effectiveTo ?? +infinity)
//
// This is the canonical "what group did this account belong to on
// that date?" lookup — the FOUNDATION of future reporting-consumer
// migration. For COA-MAP-1 the compatibility layer keeps existing
// consumers reading `Account.fsGroupId`; new mapping functionality +
// future consumer slices use this resolver.
//
// Batch variant resolves many accounts at once with a single query
// to avoid N+1 behaviour on reporting-package renders.

import { prisma } from "@/lib/prisma";

export type AsOfGroupMetadata = {
  fsGroupId: string;
  fsGroupKey: string;
  fsGroupName: string;
  statement: string;
  // COA-MAP-1A (2026-10-06) — sortOrder exposed so canonical
  // consumers (fs-group-projection) can preserve presentation
  // ordering without a second DB round-trip.
  sortOrder: number;
  reportingRole: string | null;
};

export type AsOfResolution = AsOfGroupMetadata | null;

export type ResolveAsOfInput = {
  clubId: string;
  accountId: string;
  asOf: Date;
};

/**
 * Resolve ONE account's FS Group AS OF a date. Returns null when
 * the account has no assignment covering the date (e.g. account
 * was created after the date, or the backfill hasn't run yet).
 */
export async function resolveFinancialStatementGroupAsOf(
  input: ResolveAsOfInput,
): Promise<AsOfResolution> {
  const { clubId, accountId, asOf } = input;
  const row = await prisma.accountFinancialStatementAssignment.findFirst({
    where: {
      clubId,
      accountId,
      effectiveFrom: { lte: asOf },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gt: asOf } },
      ],
    },
    orderBy: { effectiveFrom: "desc" },
    include: {
      fsGroup: {
        select: {
          id: true,
          key: true,
          name: true,
          statement: true,
          sortOrder: true,
          reportingRole: true,
        },
      },
    },
  });
  if (!row) return null;
  return {
    fsGroupId: row.fsGroup.id,
    fsGroupKey: row.fsGroup.key,
    fsGroupName: row.fsGroup.name,
    statement: row.fsGroup.statement,
    sortOrder: row.fsGroup.sortOrder,
    reportingRole: row.fsGroup.reportingRole,
  };
}

export type ResolveAsOfBatchInput = {
  clubId: string;
  accountIds: ReadonlyArray<string>;
  asOf: Date;
};

/**
 * Batch resolver — ONE round-trip, used by reporting-package renders.
 * Returns a Map<accountId, AsOfGroupMetadata | null> with every
 * requested accountId present (null when unresolved).
 */
export async function resolveFinancialStatementGroupAsOfBatch(
  input: ResolveAsOfBatchInput,
): Promise<Map<string, AsOfResolution>> {
  const { clubId, accountIds, asOf } = input;
  const result = new Map<string, AsOfResolution>();
  for (const id of accountIds) result.set(id, null);
  if (accountIds.length === 0) return result;

  const rows = await prisma.accountFinancialStatementAssignment.findMany({
    where: {
      clubId,
      accountId: { in: Array.from(new Set(accountIds)) },
      effectiveFrom: { lte: asOf },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gt: asOf } },
      ],
    },
    orderBy: { effectiveFrom: "desc" },
    include: {
      fsGroup: {
        select: {
          id: true,
          key: true,
          name: true,
          statement: true,
          sortOrder: true,
          reportingRole: true,
        },
      },
    },
  });

  // Collapse to the latest-effectiveFrom row per account (orderBy
  // above already sorts; `rows` is already in that order so the
  // first row we see per accountId wins).
  for (const r of rows) {
    if (result.get(r.accountId) != null) continue;
    result.set(r.accountId, {
      fsGroupId: r.fsGroup.id,
      fsGroupKey: r.fsGroup.key,
      fsGroupName: r.fsGroup.name,
      statement: r.fsGroup.statement,
      sortOrder: r.fsGroup.sortOrder,
      reportingRole: r.fsGroup.reportingRole,
    });
  }

  return result;
}

/**
 * The CURRENT assignment for an account (effectiveTo == null).
 * Service-layer convenience: the reassignment service calls this
 * to find the row it needs to close.
 */
export async function findCurrentAssignment(input: {
  clubId: string;
  accountId: string;
}): Promise<{ id: string; fsGroupId: string; effectiveFrom: Date } | null> {
  const row = await prisma.accountFinancialStatementAssignment.findFirst({
    where: {
      clubId: input.clubId,
      accountId: input.accountId,
      effectiveTo: null,
    },
    select: { id: true, fsGroupId: true, effectiveFrom: true },
    orderBy: { effectiveFrom: "desc" },
  });
  return row;
}
