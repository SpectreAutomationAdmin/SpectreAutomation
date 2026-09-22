// Payroll-3C-5 (2026-09-09) — Payroll Component-level YTD aggregator.
//
// The coarse YTD aggregator (src/lib/payroll/ytd.ts) covers gross /
// taxable / pensionable / insurable + statutory (CPP / CPP2 / EI /
// federal / provincial). It does NOT decompose those totals by
// Payroll Component.
//
// This service adds per-Component YTD for pay-statement display,
// following the same strict source-of-truth contract:
//
//   YTD = PayrollOpeningBalanceComponent (parent ACTIVE + PRIOR_SYSTEM_SAME_EMPLOYER or PRIOR_ADJUSTMENT)
//       + Σ PayrollBatchComponentSnapshot.resolvedAmount from POSTED PayrollBatches
//              (parent throughPayDate < batch.payDate < asOfPayDate,
//               batch.payPeriod.taxYear === asOf tax year)
//
// PRIOR_EMPLOYER opening balances contribute ZERO (§3B-5B-1b) —
// component YTD from another employer's payroll is not this
// employer's YTD.
//
// Component identity is `sourceComponentId` when both current and
// historical rows carry it, falling back to `componentCode` when
// legacy history predates the id linkage. Both keys are exposed on
// the result so callers can decide.

import type { Decimal as PrismaDecimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { getActiveOpeningBalance } from "./opening-balance";

// FPP-8B.1 (2026-09-22) — payroll-safe Decimal arithmetic. Never use
// JS floating-point (Number / parseFloat / + on strings) for YTD math.
type Decimal = PrismaDecimal;
const D = (v: string | number | PrismaDecimal | null | undefined): Prisma.Decimal =>
  v == null ? new Prisma.Decimal(0)
    : v instanceof Prisma.Decimal ? v
    : new Prisma.Decimal(typeof v === "number" ? v.toString() : String(v));

export interface ComponentYtdRow {
  /** Stable identity — componentCode is the domain-unique key on
   *  PayrollComponent (@@unique([clubId, code])). sourceComponentId is
   *  informational only. */
  sourceComponentId: string | null;
  componentCode:     string;
  displayName:       string;
  category:          string;
  side:              "EMPLOYEE" | "EMPLOYER";
  cashEffect:        "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  /** Sum of opening YTD + all POSTED batch-snapshot resolvedAmounts. */
  ytdAmount:         string;
  /** FPP-8B (§33) — provenance for audit / debugging. */
  provenance: {
    openingAmount:   string;  // contribution from opening balance
    postedAmount:    string;  // contribution from POSTED history
    openingSourceId: string | null;
    postedBatchIds:  string[];
  };
}

export interface EmployeeComponentYtd {
  clubId:      string;
  employeeId:  string;
  taxYear:     number;
  asOfPayDate: Date;
  /** Keyed by stable identity (sourceComponentId when present, else componentCode). */
  byKey:       Map<string, ComponentYtdRow>;
  sources: {
    openingBalanceId: string | null;
    postedBatchIds:   string[];
  };
}

function toStr(d: Decimal | number | string | null | undefined): string {
  if (d == null) return "0";
  if (typeof d === "string") return d;
  if (typeof d === "number") return d.toString();
  return d.toString();
}
// FPP-8B.1 (§2-§4) — Decimal-safe addition. Never floating-point.
function addStr(a: string, b: string | number | Decimal | null | undefined): string {
  return D(a).plus(D(b)).toFixed(4);
}

// FPP-8B (2026-09-22, §6) — component identity is `componentCode`.
// PayrollComponent enforces @@unique([clubId, code]) so a componentCode
// unambiguously identifies a component within a club. Every historical
// evidence row (opening + batch snapshot) freezes the code.
//
// The previous keying strategy `sourceComponentId ?? \`code:${componentCode}\``
// produced DIFFERENT keys when opening rows had a null sourceComponentId
// (imported before the club's PayrollComponent registry was built) and
// batch snapshots later carried a resolved id — silently splitting the
// employee's YTD between two keys and hiding opening YTD on the pay
// statement. FPP-8B keys by componentCode alone.
function keyFor(_sourceComponentId: string | null | undefined, componentCode: string): string {
  return componentCode;
}

/**
 * Aggregate an Employee's per-Component payroll YTD as of the given
 * pay date.
 *
 * Contract mirrors src/lib/payroll/ytd.ts exactly:
 *   • ACTIVE PayrollOpeningBalance is the only opening source
 *     (throughPayDate MUST be set; caller has already validated).
 *   • PRIOR_EMPLOYER opening balance contributes ZERO.
 *   • Only POSTED PayrollBatch rows with payDate strictly between the
 *     cutover and asOf, in the same taxYear, contribute.
 *   • DRAFT / PREPARED / CALCULATED / SUBMITTED_FOR_APPROVAL /
 *     APPROVED / VOIDED / FAILED batches are EXCLUDED.
 *
 * The caller feeds asOfPayDate — for the pay statement being rendered
 * this is the CURRENT batch's payDate. That batch's own snapshots are
 * added separately as "current"; they never appear in YTD (Payroll
 * YTD is history through the prior POSTED batch, per §33 of the brief).
 *
 * A YTD row that INCLUDES the current pay is produced by
 * `withCurrent()` below.
 */
export async function getEmployeeComponentYtd(
  clubId: string,
  employeeId: string,
  asOfPayDate: Date,
): Promise<EmployeeComponentYtd> {
  const taxYear = asOfPayDate.getUTCFullYear();

  const opening = await getActiveOpeningBalance(clubId, employeeId, taxYear);
  const openingId = opening?.id ?? null;
  const includeOpening = opening !== null &&
    (opening.priorPayrollKind === "PRIOR_SYSTEM_SAME_EMPLOYER" ||
     opening.priorPayrollKind === "PRIOR_ADJUSTMENT");

  const byKey = new Map<string, ComponentYtdRow>();

  // Layer 1 — opening YTD components (only when the parent is ACTIVE
  // and its kind actually contributes to this employer's YTD).
  if (includeOpening && openingId) {
    const openingRows = await prisma.payrollOpeningBalanceComponent.findMany({
      where: { clubId, openingBalanceId: openingId },
    });
    for (const r of openingRows) {
      const k = keyFor(r.sourceComponentId, r.componentCode);
      byKey.set(k, {
        sourceComponentId: r.sourceComponentId,
        componentCode:     r.componentCode,
        displayName:       r.displayName,
        category:          r.category,
        side:              r.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect:        r.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount:         toStr(r.ytdAmount),
        provenance: {
          openingAmount:   toStr(r.ytdAmount),
          postedAmount:    "0",
          openingSourceId: openingId,
          postedBatchIds:  [],
        },
      });
    }
  }

  // Layer 2 — POSTED batch component snapshots strictly before asOf.
  const cutover = opening?.throughPayDate ?? null;
  const postedRows = await prisma.payrollBatchComponentSnapshot.findMany({
    where: {
      clubId,
      employeeId,
      batch: {
        status: "POSTED",
        payPeriod: {
          taxYear,
          payDate: cutover
            ? { lt: asOfPayDate, gt: cutover }
            : { lt: asOfPayDate },
        },
      },
    },
    select: {
      batchId: true, sourceComponentId: true, componentCode: true,
      displayName: true, category: true, side: true, cashEffect: true,
      resolvedAmount: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const postedBatchIds = new Set<string>();
  for (const r of postedRows) {
    postedBatchIds.add(r.batchId);
    if (r.resolvedAmount == null) continue;
    const k = keyFor(r.sourceComponentId, r.componentCode);
    const existing = byKey.get(k);
    if (existing) {
      existing.ytdAmount = addStr(existing.ytdAmount, r.resolvedAmount);
      existing.provenance.postedAmount = addStr(existing.provenance.postedAmount, r.resolvedAmount);
      if (!existing.provenance.postedBatchIds.includes(r.batchId)) {
        existing.provenance.postedBatchIds.push(r.batchId);
      }
      // If the opening carried a null sourceComponentId, and the POSTED
      // history now carries a resolved id, adopt the resolved id on the
      // combined row so downstream consumers can navigate to the component.
      if (existing.sourceComponentId == null && r.sourceComponentId != null) {
        existing.sourceComponentId = r.sourceComponentId;
      }
    } else {
      byKey.set(k, {
        sourceComponentId: r.sourceComponentId,
        componentCode:     r.componentCode,
        displayName:       r.displayName,
        category:          r.category,
        side:              r.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect:        r.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount:         toStr(r.resolvedAmount),
        provenance: {
          openingAmount:   "0",
          postedAmount:    toStr(r.resolvedAmount),
          openingSourceId: openingId,
          postedBatchIds:  [r.batchId],
        },
      });
    }
  }

  // Normalize numeric strings to fixed-2 for display convenience but
  // preserve fixed-4 accumulation until the last step.
  for (const [, row] of byKey) {
    row.ytdAmount = D(row.ytdAmount).toFixed(2);
    row.provenance.openingAmount = D(row.provenance.openingAmount).toFixed(2);
    row.provenance.postedAmount  = D(row.provenance.postedAmount).toFixed(2);
  }

  return {
    clubId, employeeId, taxYear, asOfPayDate,
    byKey,
    sources: { openingBalanceId: openingId, postedBatchIds: [...postedBatchIds] },
  };
}

// FPP-8B.1 (2026-09-22, §10-§13) — deterministic ordering priority for
// same-pay-date transaction chains. STANDARD (0) is the original event,
// REVERSAL (1) is the accounting inverse, CORRECTION (2) is the
// replacement. This matches the actual FPP-9 chain construction order
// (Reverse & Correct always creates STANDARD, then REVERSAL, then CORRECTION)
// and gives an authoritative tie-breaker when two batches share a payDate.
const TX_ORDER: Record<string, number> = {
  STANDARD: 0, REVERSAL: 1, CORRECTION: 2,
};
function txOrder(t: string | null | undefined): number {
  return t ? (TX_ORDER[t] ?? 99) : 99;
}

/**
 * FPP-8B.1 (§11) — resolve component YTD "through and including" a specific
 * historical POSTED payroll batch. Answers the transaction-scoped
 * question: "what was the authoritative component YTD immediately after
 * this exact batch posted?"
 *
 * Ordering is deterministic: (payDate ASC, transactionType priority ASC,
 * postedAt ASC nulls last, id ASC). Ties on payDate resolve
 * STANDARD -> REVERSAL -> CORRECTION. This lets a same-pay-date chain
 * unambiguously answer "after STANDARD = O + X", "after REVERSAL = O",
 * "after CORRECTION = O + Y".
 */
export async function getEmployeeComponentYtdThroughBatch(
  clubId: string,
  employeeId: string,
  batchId: string,
): Promise<EmployeeComponentYtd> {
  const target = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    select: {
      id: true, transactionType: true, status: true, postedAt: true,
      payPeriod: { select: { payDate: true, taxYear: true } },
    },
  });
  if (!target) throw new Error(`Batch ${batchId} not found for club ${clubId}`);
  const taxYear = target.payPeriod.taxYear;

  const opening = await getActiveOpeningBalance(clubId, employeeId, taxYear);
  const openingId = opening?.id ?? null;
  const includeOpening = opening !== null &&
    (opening.priorPayrollKind === "PRIOR_SYSTEM_SAME_EMPLOYER" ||
     opening.priorPayrollKind === "PRIOR_ADJUSTMENT");
  const byKey = new Map<string, ComponentYtdRow>();

  if (includeOpening && openingId) {
    const openingRows = await prisma.payrollOpeningBalanceComponent.findMany({
      where: { clubId, openingBalanceId: openingId },
    });
    for (const r of openingRows) {
      byKey.set(r.componentCode, {
        sourceComponentId: r.sourceComponentId,
        componentCode:     r.componentCode,
        displayName:       r.displayName,
        category:          r.category,
        side:              r.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect:        r.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount:         toStr(r.ytdAmount),
        provenance: { openingAmount: toStr(r.ytdAmount), postedAmount: "0", openingSourceId: openingId, postedBatchIds: [] },
      });
    }
  }

  // Load every candidate POSTED batch in the tax year on this employee
  // whose payDate <= target.payDate; then filter deterministically to
  // "through and including" the target batch by the (payDate, txOrder,
  // postedAt, id) tuple.
  const cutover = opening?.throughPayDate ?? null;
  const rangeStart = cutover;
  const candidates = await prisma.payrollBatchComponentSnapshot.findMany({
    where: {
      clubId, employeeId,
      batch: {
        status: "POSTED",
        payPeriod: {
          taxYear,
          payDate: rangeStart ? { lte: target.payPeriod.payDate, gt: rangeStart } : { lte: target.payPeriod.payDate },
        },
      },
    },
    select: {
      batchId: true, sourceComponentId: true, componentCode: true,
      displayName: true, category: true, side: true, cashEffect: true, resolvedAmount: true,
      batch: { select: {
        id: true, transactionType: true, postedAt: true,
        payPeriod: { select: { payDate: true } },
      } },
    },
  });

  const targetTuple: [number, number, number, string] = [
    target.payPeriod.payDate.getTime(),
    txOrder(target.transactionType),
    target.postedAt ? target.postedAt.getTime() : Number.MAX_SAFE_INTEGER,
    target.id,
  ];
  const cmpTuple = (a: typeof targetTuple, b: typeof targetTuple) =>
    (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]) || a[3].localeCompare(b[3]);

  const postedBatchIds = new Set<string>();
  for (const r of candidates) {
    if (r.resolvedAmount == null || !r.batch) continue;
    const tuple: typeof targetTuple = [
      r.batch.payPeriod.payDate.getTime(),
      txOrder(r.batch.transactionType),
      r.batch.postedAt ? r.batch.postedAt.getTime() : Number.MAX_SAFE_INTEGER,
      r.batch.id,
    ];
    if (cmpTuple(tuple, targetTuple) > 0) continue;   // strictly after target — skip
    postedBatchIds.add(r.batchId);
    const k = r.componentCode;
    const existing = byKey.get(k);
    if (existing) {
      existing.ytdAmount = addStr(existing.ytdAmount, r.resolvedAmount);
      existing.provenance.postedAmount = addStr(existing.provenance.postedAmount, r.resolvedAmount);
      if (!existing.provenance.postedBatchIds.includes(r.batchId)) existing.provenance.postedBatchIds.push(r.batchId);
      if (existing.sourceComponentId == null && r.sourceComponentId != null) existing.sourceComponentId = r.sourceComponentId;
    } else {
      byKey.set(k, {
        sourceComponentId: r.sourceComponentId,
        componentCode:     r.componentCode,
        displayName:       r.displayName,
        category:          r.category,
        side:              r.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect:        r.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount:         toStr(r.resolvedAmount),
        provenance: { openingAmount: "0", postedAmount: toStr(r.resolvedAmount), openingSourceId: openingId, postedBatchIds: [r.batchId] },
      });
    }
  }
  for (const [, row] of byKey) {
    row.ytdAmount = D(row.ytdAmount).toFixed(2);
    row.provenance.openingAmount = D(row.provenance.openingAmount).toFixed(2);
    row.provenance.postedAmount  = D(row.provenance.postedAmount).toFixed(2);
  }
  return {
    clubId, employeeId, taxYear, asOfPayDate: target.payPeriod.payDate,
    byKey,
    sources: { openingBalanceId: openingId, postedBatchIds: [...postedBatchIds] },
  };
}

/**
 * Combine a prior-history YTD with the current batch's snapshots so a
 * single "YTD including this pay" number can be shown per component
 * on the pay statement. Consumed by the statement builder.
 */
export function includeCurrentInYtd(
  prior: EmployeeComponentYtd,
  currentSnapshots: Array<{
    sourceComponentId: string | null; componentCode: string;
    displayName: string; category: string;
    side: string; cashEffect: string;
    resolvedAmount: string | number | Decimal | null;
  }>,
): Map<string, ComponentYtdRow> {
  const combined = new Map<string, ComponentYtdRow>();
  for (const [k, v] of prior.byKey) combined.set(k, { ...v, provenance: { ...v.provenance, postedBatchIds: [...v.provenance.postedBatchIds] }, ytdAmount: v.ytdAmount });
  for (const s of currentSnapshots) {
    if (s.resolvedAmount == null) continue;
    const k = keyFor(s.sourceComponentId, s.componentCode);
    const existing = combined.get(k);
    if (existing) {
      existing.ytdAmount = D(addStr(existing.ytdAmount, s.resolvedAmount)).toFixed(2);
    } else {
      combined.set(k, {
        sourceComponentId: s.sourceComponentId,
        componentCode: s.componentCode,
        displayName: s.displayName,
        category: s.category,
        side: s.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect: s.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount: D(toStr(s.resolvedAmount)).toFixed(2),
        provenance: {
          openingAmount: "0.00",
          postedAmount:  "0.00",
          openingSourceId: null,
          postedBatchIds: [],
        },
      });
    }
  }
  return combined;
}
