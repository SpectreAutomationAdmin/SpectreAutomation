// Payroll-3D-3B Slice 3 (2026-09-06) — proactive orchestration for
// the department timesheet-approval Work Intake obligation.
//
// Three recovery layers, mirroring the AP_MATERIALISE_RECOVERY
// pattern (docs/backlog + src/lib/ap-intelligence/materialise-recovery.ts):
//
//   1. Inline (awaited) — right after the domain transaction that
//      changes readiness state (materialise, correction reject,
//      invalidate-on-drift). Best case: card exists before the
//      originating request returns.
//   2. Durable BackgroundJob — if the inline await throws, we log
//      + enqueue ENSURE_TIMESHEET_APPROVAL_WI with a deterministic
//      idempotency key so the worker sweeps it up.
//   3. Periodic worker sweep — bounded calendar-based scan of open
//      pay periods, enqueueing an ensure job per period. Handles the
//      worst case where inline AND enqueue both fail.
//
// The underlying idempotent creator remains
// ensureTimesheetApprovalWorkItems(clubId, payPeriodId) in
// src/lib/timesheets/orchestration.ts — Slice 3 adds the recovery
// scaffolding + the "skip already-approved with current revision"
// guard in that function.
//
// Design constraint from Slice 0 audit: PayrollPayPeriod.status is
// NOT authoritative workflow state (see docs/backlog/*.md and the
// Slice 3 checkpoint audit for details). Only creators write
// "FUTURE"; nothing transitions FUTURE→OPEN as a workflow signal.
// The sweep therefore uses CALENDAR bounds — periodStart <= now + 7d
// AND periodEnd >= now - 90d — not the status column.

import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { enqueue } from "../queue";
import { ensureTimesheetApprovalWorkItems } from "../timesheets/orchestration";

// -------------------------------------------------------------------
// Inline orchestration + durable recovery.
// -------------------------------------------------------------------
export async function orchestrateTimesheetApprovalWorkItem(
  clubId: string, payPeriodId: string, departmentId?: string | null,
): Promise<void> {
  try {
    await ensureTimesheetApprovalWorkItems(clubId, payPeriodId);
  } catch (err) {
    logger.error("payroll.timesheet_approval.orchestrate_failed", {
      clubId, payPeriodId,
      departmentId: departmentId ?? null,
      obligationKind: "PAYROLL_TIMESHEET_APPROVAL",
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await enqueue({
        kind: "ENSURE_TIMESHEET_APPROVAL_WI",
        clubId,
        payload: { clubId, payPeriodId },
        idempotencyKey: `ensure-timesheet-approval-wi:${clubId}:${payPeriodId}`,
        maxAttempts: 5,
      });
    } catch (enqueueErr) {
      // Third layer — the periodic sweep — will still pick this up on
      // its next tick because it's calendar-bounded and does not rely
      // on the enqueue succeeding here.
      logger.error("payroll.timesheet_approval.enqueue_failed", {
        clubId, payPeriodId,
        departmentId: departmentId ?? null,
        obligationKind: "PAYROLL_TIMESHEET_APPROVAL",
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
    }
  }
}

// -------------------------------------------------------------------
// Periodic worker sweep — third recovery layer.
//
// Enumerates pay periods within the "manager-relevant" calendar
// window and enqueues one ENSURE_TIMESHEET_APPROVAL_WI job per
// period. Existing QUEUED/RUNNING jobs with the same idempotency
// key dedupe automatically (queue.enqueue built-in). Historical
// periods outside the window are never touched.
//
// The sweep does NOT run every worker tick — it obeys an interval
// budget (default 5 min) same as tickAutoSync.
// -------------------------------------------------------------------

let lastSweepAt = 0;

export interface SweepArgs {
  now?: Date;
  intervalMs?: number;
  // Widest window the sweep will consider. Read from env for ops
  // knobs but never persisted per-tenant.
  lookbackDays?: number;
  lookAheadDays?: number;
  perTickCap?: number;
}

export interface SweepResult {
  ran: boolean;
  reason?: "not_due" | "ok" | "empty";
  scanned: number;
  enqueued: number;
  errors: number;
}

export async function tickTimesheetApprovalWiSweep(
  args: SweepArgs = {},
): Promise<SweepResult> {
  const now = args.now ?? new Date();
  const intervalMs =
    args.intervalMs ?? Number(process.env.PAYROLL_TIMESHEET_APPROVAL_SWEEP_INTERVAL_MS ?? "300000");
  const lookbackDays =
    args.lookbackDays ?? Number(process.env.PAYROLL_TIMESHEET_APPROVAL_SWEEP_LOOKBACK_DAYS ?? "90");
  const lookAheadDays =
    args.lookAheadDays ?? Number(process.env.PAYROLL_TIMESHEET_APPROVAL_SWEEP_LOOKAHEAD_DAYS ?? "7");
  const perTickCap =
    args.perTickCap ?? Number(process.env.PAYROLL_TIMESHEET_APPROVAL_SWEEP_CAP ?? "500");

  if (now.getTime() - lastSweepAt < intervalMs) {
    return { ran: false, reason: "not_due", scanned: 0, enqueued: 0, errors: 0 };
  }
  lastSweepAt = now.getTime();

  const windowStart = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);
  const windowEnd = new Date(now.getTime() + lookAheadDays * 24 * 3600 * 1000);

  // Calendar-based eligibility: period must overlap the manager-relevant
  // window. Anchoring on periodStart <= windowEnd AND periodEnd >=
  // windowStart is the standard "any-overlap" test for a half-open
  // interval [periodStart, periodEnd).
  const periods = await prisma.payrollPayPeriod.findMany({
    where: {
      periodStart: { lte: windowEnd },
      periodEnd: { gte: windowStart },
    },
    orderBy: [{ clubId: "asc" }, { periodStart: "asc" }],
    take: perTickCap,
    select: { id: true, clubId: true },
  });

  if (periods.length === 0) {
    return { ran: true, reason: "empty", scanned: 0, enqueued: 0, errors: 0 };
  }

  let enqueued = 0;
  let errors = 0;
  for (const p of periods) {
    try {
      await enqueue({
        kind: "ENSURE_TIMESHEET_APPROVAL_WI",
        clubId: p.clubId,
        payload: { clubId: p.clubId, payPeriodId: p.id },
        idempotencyKey: `ensure-timesheet-approval-wi:${p.clubId}:${p.id}`,
        maxAttempts: 5,
      });
      enqueued += 1;
    } catch (err) {
      errors += 1;
      logger.error("payroll.timesheet_approval.sweep_enqueue_failed", {
        clubId: p.clubId, payPeriodId: p.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("payroll.timesheet_approval.sweep_tick", {
    scanned: periods.length, enqueued, errors,
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
  });

  return { ran: true, reason: "ok", scanned: periods.length, enqueued, errors };
}

// -------------------------------------------------------------------
// Test-only reset for the tick's in-memory interval budget.
// Not exported through the barrel — used by Slice 3 test suite only.
// -------------------------------------------------------------------
export function _resetTimesheetApprovalSweepTickForTest(): void {
  lastSweepAt = 0;
}
