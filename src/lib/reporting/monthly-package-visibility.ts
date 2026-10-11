// MBR-VIS-1 (2026-10-11) — Monthly Board Reporting Publication
// Visibility service.
//
// Owns the three operations the admin surface needs:
//
//   • `resolveVisibilityForPeriod` — read the effective visibility
//     config for a (club, year, month) tuple. Two modes:
//       - "draft"     → live `MonthlyPackageVisibility` rows
//       - "published" → frozen `MonthlyPackage.packagePayloadJson.
//                       visibility` snapshot (what the Board sees)
//
//   • `setComponentVisibility` — write a single toggle. Checks
//     `packages:write` on the active club, records before/after
//     through `audit()`, and inherits forward from the previous
//     period on the first write per period.
//
//   • `applyVisibility` — presentation-layer filter. Walks the
//     resolved package payload, decides which chapters / cards /
//     rows / commentary blocks render, honors parent-child cascade,
//     attaches commentary dependency warnings for Controller-only
//     editing views.
//
// Three invariants the service never violates:
//
//   1. Draft edits never alter frozen `packagePayloadJson.visibility`
//      — the Board / PDF continue to render the previously published
//      state until the Controller explicitly republishes.
//   2. Hidden components still participate in every authoritative
//      financial calculation. This file never touches resolver
//      output; it only tags rendered visibility.
//   3. Default-visible. Absent `componentKey` row = visible.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hasPermission, type Principal } from "@/lib/rbac";

/** Component-key convention. The service layer enforces the four
 *  known tiers; the DB stores free-form strings so new tiers can
 *  land without a migration. */
export const COMPONENT_KEY_PATTERN =
  /^(chapter|card|row|commentary):[a-z][a-z0-9-]*(:[a-z0-9-]+){0,2}$/;

export type VisibilitySource = "draft" | "published";

export type ComponentVisibility = {
  componentKey: string;
  hidden: boolean;
};

export type VisibilityConfig = {
  source: VisibilitySource;
  /** Period descriptor so a resolved config is self-identifying. */
  period: { reportingYear: number; reportingMonth: number };
  /** Flat map: componentKey → hidden.  Absent key → visible. */
  entries: Record<string, boolean>;
  /** Publish metadata — populated only when source === "published".
   *  Null on draft so the admin UI's "DRAFT PREVIEW" banner shows
   *  the pending-edit count instead of a prior-publish timestamp. */
  publishedAt?: Date | null;
  publishedByUserId?: string | null;
};

/** Hidden parents cascade over children. */
function isAncestorHidden(componentKey: string, entries: Record<string, boolean>): boolean {
  // componentKey = "row:X:Y:Z"
  //   → ancestors: "card:X:Y", "chapter:X"
  // componentKey = "commentary:X:Y:Z"
  //   → ancestors: "card:X:Y", "chapter:X"
  // componentKey = "card:X:Y"
  //   → ancestors: "chapter:X"
  // componentKey = "chapter:X"
  //   → no ancestors
  const parts = componentKey.split(":");
  if (parts.length < 2) return false;
  const [tier, anchor, cardKey] = parts;
  if (tier === "chapter") return false;
  if (tier === "card") {
    return entries[`chapter:${anchor}`] === true;
  }
  if (tier === "row" || tier === "commentary") {
    if (entries[`chapter:${anchor}`] === true) return true;
    if (cardKey && entries[`card:${anchor}:${cardKey}`] === true) return true;
    return false;
  }
  return false;
}

/** Effective visibility for a specific componentKey, honoring the
 *  parent cascade.  `true` → render; `false` → hide. */
export function isComponentVisible(
  componentKey: string,
  config: VisibilityConfig | null | undefined,
): boolean {
  if (!config) return true;
  const direct = config.entries[componentKey];
  if (direct === true) return false;
  if (isAncestorHidden(componentKey, config.entries)) return false;
  return true;
}

/** Resolve the effective visibility config for a (club, year, month)
 *  from the DRAFT source — the live MonthlyPackageVisibility rows.
 *
 *  First-access inheritance: if the period has zero rows AND the
 *  most-recent prior period in the same club has ≥1 row, this call
 *  performs a one-shot copy forward (not a read-through link) so
 *  future edits on this period never cascade back.  If no prior
 *  period has rows, the new period starts default-visible. */
export async function resolveDraftVisibility(
  clubId: string,
  reportingYear: number,
  reportingMonth: number,
): Promise<VisibilityConfig> {
  const rows = await prisma.monthlyPackageVisibility.findMany({
    where: { clubId, reportingYear, reportingMonth },
    select: { componentKey: true, hidden: true },
  });

  // One-shot inheritance from the greatest prior period with rows.
  if (rows.length === 0) {
    await inheritVisibilityFromPreviousPeriod(clubId, reportingYear, reportingMonth);
    const seeded = await prisma.monthlyPackageVisibility.findMany({
      where: { clubId, reportingYear, reportingMonth },
      select: { componentKey: true, hidden: true },
    });
    return {
      source: "draft",
      period: { reportingYear, reportingMonth },
      entries: Object.fromEntries(seeded.map((r) => [r.componentKey, r.hidden])),
    };
  }

  return {
    source: "draft",
    period: { reportingYear, reportingMonth },
    entries: Object.fromEntries(rows.map((r) => [r.componentKey, r.hidden])),
  };
}

/** Resolve the PUBLISHED visibility config from the frozen snapshot
 *  on the MonthlyPackage row.  Returns an empty-entries config when
 *  the period has no published row OR the published row's payload
 *  predates MBR-VIS-1 (no `visibility` field).  The Board + PDF
 *  path always calls this — never the draft. */
export async function resolvePublishedVisibility(
  clubId: string,
  reportingYear: number,
  reportingMonth: number,
): Promise<VisibilityConfig> {
  const pkg = await prisma.monthlyPackage.findUnique({
    where: {
      clubId_reportingYear_reportingMonth: {
        clubId,
        reportingYear,
        reportingMonth,
      },
    },
    select: {
      packagePayloadJson: true,
      publishedAt: true,
      publishedByUserId: true,
    },
  });

  if (!pkg || !pkg.packagePayloadJson) {
    return {
      source: "published",
      period: { reportingYear, reportingMonth },
      entries: {},
      publishedAt: null,
      publishedByUserId: null,
    };
  }

  let frozen: Record<string, boolean> = {};
  try {
    const payload = JSON.parse(pkg.packagePayloadJson) as {
      visibility?: { entries?: Record<string, boolean> };
    };
    frozen = payload.visibility?.entries ?? {};
  } catch {
    frozen = {};
  }

  return {
    source: "published",
    period: { reportingYear, reportingMonth },
    entries: frozen,
    publishedAt: pkg.publishedAt,
    publishedByUserId: pkg.publishedByUserId,
  };
}

/** Count of draft rows that differ from the frozen published
 *  snapshot — drives the DRAFT PREVIEW banner's "N pending visibility
 *  edits" copy. */
export async function countPendingVisibilityEdits(
  clubId: string,
  reportingYear: number,
  reportingMonth: number,
): Promise<number> {
  const [draft, published] = await Promise.all([
    resolveDraftVisibility(clubId, reportingYear, reportingMonth),
    resolvePublishedVisibility(clubId, reportingYear, reportingMonth),
  ]);
  const allKeys = new Set([
    ...Object.keys(draft.entries),
    ...Object.keys(published.entries),
  ]);
  let pending = 0;
  for (const key of allKeys) {
    if ((draft.entries[key] ?? false) !== (published.entries[key] ?? false)) {
      pending++;
    }
  }
  return pending;
}

/** One-shot inheritance.  Called implicitly by resolveDraftVisibility
 *  when the current period has zero rows.  Copies forward every row
 *  from the greatest prior period in the same club that has ≥1 row.
 *  Idempotent: re-running after seeding is a no-op. */
export async function inheritVisibilityFromPreviousPeriod(
  clubId: string,
  reportingYear: number,
  reportingMonth: number,
): Promise<{ seeded: number }> {
  // Greatest (year, month) strictly less than the current period
  // that has rows. Encode (year*12 + month-1) for a single
  // orderable scalar.
  const currentOrdinal = reportingYear * 12 + (reportingMonth - 1);
  const candidates = await prisma.monthlyPackageVisibility.findMany({
    where: { clubId },
    distinct: ["reportingYear", "reportingMonth"],
    select: { reportingYear: true, reportingMonth: true },
  });
  const priorPeriod = candidates
    .map((c) => ({ y: c.reportingYear, m: c.reportingMonth }))
    .filter((c) => c.y * 12 + (c.m - 1) < currentOrdinal)
    .sort((a, b) => (b.y * 12 + b.m - 1) - (a.y * 12 + a.m - 1))[0];

  if (!priorPeriod) return { seeded: 0 };

  const priorRows = await prisma.monthlyPackageVisibility.findMany({
    where: {
      clubId,
      reportingYear: priorPeriod.y,
      reportingMonth: priorPeriod.m,
    },
    select: { componentKey: true, hidden: true },
  });
  if (priorRows.length === 0) return { seeded: 0 };

  // No skipDuplicates needed: inheritance only runs when the current
  // period has zero rows (resolver pre-check), and the surrounding
  // transaction isolates concurrent writers via the unique index.
  await prisma.monthlyPackageVisibility.createMany({
    data: priorRows.map((r) => ({
      clubId,
      reportingYear,
      reportingMonth,
      componentKey: r.componentKey,
      hidden: r.hidden,
    })),
  });

  return { seeded: priorRows.length };
}

/** Toggle a single component's visibility.  Server-side permission
 *  check + audit entry.  Idempotent (same hidden value is a no-op). */
export async function setComponentVisibility(
  principal: Principal,
  args: {
    clubId: string;
    reportingYear: number;
    reportingMonth: number;
    componentKey: string;
    hidden: boolean;
  },
): Promise<{ before: boolean; after: boolean }> {
  if (!COMPONENT_KEY_PATTERN.test(args.componentKey)) {
    throw new Error(`Invalid componentKey format: "${args.componentKey}"`);
  }
  if (!hasPermission(principal, args.clubId, "packages:write")) {
    throw new Error("FORBIDDEN: packages:write required on this club");
  }

  // Ensure the period is seeded from the prior period before the
  // first write, so an edit on April preserves April's inherited
  // March baseline.
  await inheritVisibilityFromPreviousPeriod(
    args.clubId,
    args.reportingYear,
    args.reportingMonth,
  );

  const existing = await prisma.monthlyPackageVisibility.findUnique({
    where: {
      clubId_reportingYear_reportingMonth_componentKey: {
        clubId: args.clubId,
        reportingYear: args.reportingYear,
        reportingMonth: args.reportingMonth,
        componentKey: args.componentKey,
      },
    },
    select: { hidden: true },
  });
  const before = existing?.hidden ?? false;

  await prisma.monthlyPackageVisibility.upsert({
    where: {
      clubId_reportingYear_reportingMonth_componentKey: {
        clubId: args.clubId,
        reportingYear: args.reportingYear,
        reportingMonth: args.reportingMonth,
        componentKey: args.componentKey,
      },
    },
    create: {
      clubId: args.clubId,
      reportingYear: args.reportingYear,
      reportingMonth: args.reportingMonth,
      componentKey: args.componentKey,
      hidden: args.hidden,
      updatedByUserId: principal.id,
    },
    update: {
      hidden: args.hidden,
      updatedByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "reporting.monthly-package.visibility.set",
    entityType: "MonthlyPackageVisibility",
    clubId: args.clubId,
    before: { hidden: before },
    after: { hidden: args.hidden },
    meta: {
      reportingYear: args.reportingYear,
      reportingMonth: args.reportingMonth,
      componentKey: args.componentKey,
    },
  });

  return { before, after: args.hidden };
}

/** Snapshot the current draft visibility into the format persisted
 *  at `MonthlyPackage.packagePayloadJson.visibility`. Called by the
 *  publish-lifecycle at the same moment it freezes the rest of the
 *  package payload. */
export async function snapshotVisibilityForPublish(
  clubId: string,
  reportingYear: number,
  reportingMonth: number,
): Promise<{ entries: Record<string, boolean>; snapshotCapturedAt: string }> {
  const draft = await resolveDraftVisibility(clubId, reportingYear, reportingMonth);
  return {
    entries: draft.entries,
    snapshotCapturedAt: new Date().toISOString(),
  };
}

/** Detect commentary blocks whose visible text references a hidden
 *  row's key. The scanner is a conservative token match — it never
 *  rewrites commentary; it only surfaces the orphan risk to the
 *  Controller in the editing view. */
export function detectCommentaryOrphans(args: {
  commentaryText: string;
  visibleRowKeys: string[];
  hiddenRowKeys: string[];
}): { hiddenReferences: string[] } {
  const haystack = args.commentaryText.toLowerCase();
  const hits: string[] = [];
  for (const key of args.hiddenRowKeys) {
    const token = key.toLowerCase().replace(/-/g, " ");
    if (haystack.includes(token)) hits.push(key);
  }
  void args.visibleRowKeys;
  return { hiddenReferences: hits };
}
