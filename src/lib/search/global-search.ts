// Phase 4R rev-4 (2026-08-15) — Global search domain logic.
//
// Extensible result model: every result declares its `entityType`,
// primary label, secondary context label, destination URL, and a
// numeric relevance score used for ranking. The API route
// (src/app/api/search/global/route.ts) wraps this module with
// auth + tenant scoping.
//
// Priorities for this slice (per §4 of founder brief):
//   1. Vendors  (VENDOR)
//   2. AP invoices (AP_INVOICE)
//
// Matching + ranking:
//   • normalise-and-contains for text fields (legalName, operatingName,
//     vendorNumber, taxRegistrationNumber, vendorReference, invoiceNumber);
//   • EXACT match ranks highest, PREFIX next, then substring;
//   • invoices additionally weight by recency (invoiceDate DESC) so
//     the two most recent Microsoft invoices naturally rise to the
//     top of a `Microsoft` query;
//   • all queries are clubId-scoped through the Prisma client;
//   • per-entity result cap (default 8) prevents runaway payloads.

import type { PrismaClient } from "@prisma/client";

export type SearchEntityType = "VENDOR" | "AP_INVOICE";

export interface GlobalSearchResult {
  entityType: SearchEntityType;
  id: string;
  /** Primary label — first line in the dropdown row. */
  primaryLabel: string;
  /** Secondary/context label — second line beneath the primary. */
  secondaryLabel: string;
  /** Canonical destination URL when the row is activated. */
  href: string;
  /** Higher = better match. Used to sort within a group. */
  score: number;
}

export interface GlobalSearchGrouped {
  query: string;
  vendors: GlobalSearchResult[];
  invoices: GlobalSearchResult[];
}

const MAX_PER_GROUP_DEFAULT = 8;
const MIN_QUERY_LEN = 2;

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/**
 * Score a candidate string against the normalised query.
 *   • Exact match:       100
 *   • Starts-with:        70
 *   • Word-boundary hit:  50 (space + query start)
 *   • Contains:           30
 *   • No hit:              0
 */
function scoreField(field: string | null | undefined, q: string): number {
  const f = normalize(field);
  if (!f || !q) return 0;
  if (f === q) return 100;
  if (f.startsWith(q)) return 70;
  if (f.includes(" " + q)) return 50;
  if (f.includes(q)) return 30;
  return 0;
}

/** Highest per-field score for a set of candidate fields. */
function bestFieldScore(fields: Array<string | null | undefined>, q: string): number {
  let best = 0;
  for (const f of fields) {
    const s = scoreField(f, q);
    if (s > best) best = s;
  }
  return best;
}

function formatMoney(amount: unknown, currency: string | null | undefined): string {
  const n = Number(amount ?? 0);
  const c = (currency ?? "CAD").toUpperCase();
  // Match Spectre's operational money convention: "1,234.56 CAD"
  const dollars = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${dollars} ${c}`;
}

function friendlyInvoiceStatus(status: string): string {
  const s = status.toUpperCase();
  if (s === "POSTED" || s === "PAID") {
    return s.charAt(0) + s.slice(1).toLowerCase();
  }
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Search the tenant's vendors + AP invoices.
 *
 * @param opts.prisma  club-scoped Prisma client
 * @param opts.clubId  active club id — used for EVERY query filter
 * @param opts.query   raw user input
 * @param opts.limitPerGroup default 8
 */
export async function runGlobalSearch(opts: {
  prisma: PrismaClient;
  clubId: string;
  query: string;
  limitPerGroup?: number;
}): Promise<GlobalSearchGrouped> {
  const query = opts.query.trim();
  const normQ = normalize(query);
  const cap = opts.limitPerGroup ?? MAX_PER_GROUP_DEFAULT;
  const empty: GlobalSearchGrouped = { query, vendors: [], invoices: [] };
  if (normQ.length < MIN_QUERY_LEN) return empty;

  // Fetch bounded candidate sets, then rank locally. Prisma's
  // `mode: "insensitive"` is only supported on Postgres; staging + dev
  // use SQLite. To stay portable across both engines and preserve the
  // exact-vs-prefix-vs-substring ladder, we let the DB narrow ONLY by
  // clubId + a small take cap, then filter + score in JS. Typical
  // Spectre clubs carry a few hundred vendors and a few thousand AP
  // invoices; the cap keeps memory + latency bounded even for the
  // heaviest tenant.
  const VENDOR_SCAN_CAP = 500;
  const INVOICE_SCAN_CAP = 1000;

  // ---- Vendors -----------------------------------------------------------
  const vendors = await opts.prisma.vendor.findMany({
    where: { clubId: opts.clubId },
    select: {
      id: true,
      legalName: true,
      operatingName: true,
      vendorNumber: true,
      taxRegistrationNumber: true,
      status: true,
    },
    take: VENDOR_SCAN_CAP,
  });

  const vendorResults: GlobalSearchResult[] = vendors.map((v) => {
    const primary = v.operatingName ?? v.legalName;
    const secondary = v.operatingName && v.operatingName !== v.legalName
      ? `${v.legalName} · Vendor profile`
      : `Vendor profile · ${v.vendorNumber}`;
    const score = bestFieldScore(
      [v.legalName, v.operatingName, v.vendorNumber, v.taxRegistrationNumber],
      normQ,
    );
    return {
      entityType: "VENDOR" as const,
      id: v.id,
      primaryLabel: primary,
      secondaryLabel: secondary,
      href: `/app/admin/ap/vendors/${v.id}/timeline`,
      score,
    };
  })
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, cap);

  // ---- AP invoices -------------------------------------------------------
  const invoices = await opts.prisma.aPInvoice.findMany({
    where: { clubId: opts.clubId },
    select: {
      id: true,
      invoiceNumber: true,
      vendorReference: true,
      total: true,
      currency: true,
      status: true,
      invoiceDate: true,
      postedAt: true,
      vendor: { select: { id: true, legalName: true, operatingName: true } },
    },
    orderBy: [{ invoiceDate: "desc" }],
    take: INVOICE_SCAN_CAP,
  });

  // Recency multiplier: newer invoices get a small ranking boost so
  // that, all else equal, the founder-visible "two most recent
  // Microsoft invoices" naturally rise to the top of the group.
  const nowMs = Date.now();
  const recencyBoost = (d: Date | null): number => {
    if (!d) return 0;
    const days = Math.max(0, (nowMs - d.getTime()) / (1000 * 60 * 60 * 24));
    // linearly decays from +12 (today) to 0 (365+ days old)
    return Math.max(0, 12 - (days / 365) * 12);
  };

  const invoiceResults: GlobalSearchResult[] = invoices.map((inv) => {
    const vendorDisplay = inv.vendor.operatingName ?? inv.vendor.legalName;
    const vendorRef = inv.vendorReference ? ` · ${inv.vendorReference}` : "";
    const primary = `${vendorDisplay}${vendorRef}`;
    const money = formatMoney(inv.total, inv.currency);
    const secondary = `${inv.invoiceNumber} · ${money} · ${friendlyInvoiceStatus(inv.status)}`;
    const textScore = bestFieldScore(
      [inv.invoiceNumber, inv.vendorReference, inv.vendor.legalName, inv.vendor.operatingName],
      normQ,
    );
    const score = textScore + recencyBoost(inv.invoiceDate);
    return {
      entityType: "AP_INVOICE" as const,
      id: inv.id,
      primaryLabel: primary,
      secondaryLabel: secondary,
      href: `/app/admin/ap/invoices/${inv.id}`,
      score,
    };
  })
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, cap);

  return { query, vendors: vendorResults, invoices: invoiceResults };
}
