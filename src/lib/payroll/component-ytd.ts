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

import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { getActiveOpeningBalance } from "./opening-balance";

export interface ComponentYtdRow {
  /** Stable identity — prefer sourceComponentId, else componentCode. */
  sourceComponentId: string | null;
  componentCode:     string;
  displayName:       string;
  category:          string;
  side:              "EMPLOYEE" | "EMPLOYER";
  cashEffect:        "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  /** Sum of opening YTD + all POSTED batch-snapshot resolvedAmounts. */
  ytdAmount:         string;
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
function addStr(a: string, b: string | number | Decimal | null | undefined): string {
  return (Number(a) + Number(toStr(b))).toFixed(4);
}

function keyFor(sourceComponentId: string | null | undefined, componentCode: string): string {
  return sourceComponentId ?? `code:${componentCode}`;
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
    } else {
      byKey.set(k, {
        sourceComponentId: r.sourceComponentId,
        componentCode:     r.componentCode,
        displayName:       r.displayName,
        category:          r.category,
        side:              r.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect:        r.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount:         toStr(r.resolvedAmount),
      });
    }
  }

  // Normalize numeric strings to fixed-2 for display convenience but
  // preserve fixed-4 accumulation until the last step.
  for (const [, row] of byKey) {
    row.ytdAmount = Number(row.ytdAmount).toFixed(2);
  }

  return {
    clubId, employeeId, taxYear, asOfPayDate,
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
  for (const [k, v] of prior.byKey) combined.set(k, { ...v, ytdAmount: v.ytdAmount });
  for (const s of currentSnapshots) {
    if (s.resolvedAmount == null) continue;
    const k = keyFor(s.sourceComponentId, s.componentCode);
    const existing = combined.get(k);
    if (existing) {
      existing.ytdAmount = Number(addStr(existing.ytdAmount, s.resolvedAmount)).toFixed(2);
    } else {
      combined.set(k, {
        sourceComponentId: s.sourceComponentId,
        componentCode: s.componentCode,
        displayName: s.displayName,
        category: s.category,
        side: s.side as "EMPLOYEE" | "EMPLOYER",
        cashEffect: s.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
        ytdAmount: Number(toStr(s.resolvedAmount)).toFixed(2),
      });
    }
  }
  return combined;
}
