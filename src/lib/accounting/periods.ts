// Fiscal year & period management. Posting code calls `resolvePostingPeriod`
// before any JE write to verify the period is open.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError } from "../errors";
import type { PeriodStatus } from "./types";

// ---------------------------------------------------------------------------
// Fiscal year creation + period generation
// ---------------------------------------------------------------------------
export async function ensureFiscalYear(
  clubId: string,
  opts: { startYear: number; startMonth?: number; label?: string }
) {
  const startMonth = opts.startMonth ?? 1; // 1 = January
  const startDate = new Date(Date.UTC(opts.startYear, startMonth - 1, 1));
  const endDate = new Date(Date.UTC(opts.startYear + (startMonth === 1 ? 0 : 1), startMonth === 1 ? 11 : startMonth - 2, 28));
  // Round end to last day of the month — month-arithmetic-safe.
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  endDate.setUTCHours(23, 59, 59, 999);

  const label = opts.label ?? `FY${opts.startYear}`;
  const fy = await prisma.fiscalYear.upsert({
    where: { clubId_label: { clubId, label } },
    update: { startDate, endDate },
    create: { clubId, label, startDate, endDate, status: "OPEN" },
  });

  // Generate 12 monthly periods. Idempotent — re-running won't duplicate.
  for (let i = 0; i < 12; i++) {
    const pStart = new Date(startDate);
    pStart.setUTCMonth(pStart.getUTCMonth() + i);
    const pEnd = new Date(pStart);
    pEnd.setUTCMonth(pEnd.getUTCMonth() + 1);
    pEnd.setUTCDate(0);
    pEnd.setUTCHours(23, 59, 59, 999);
    const periodLabel = `${label}-M${String(i + 1).padStart(2, "0")}`;
    await prisma.fiscalPeriod.upsert({
      where: { clubId_label: { clubId, label: periodLabel } },
      update: { startDate: pStart, endDate: pEnd, fiscalYearId: fy.id, sequence: i + 1 },
      create: {
        clubId, fiscalYearId: fy.id, label: periodLabel,
        startDate: pStart, endDate: pEnd, sequence: i + 1, status: "OPEN",
      },
    });
  }
  return fy;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
export async function findPeriodForDate(clubId: string, when: Date) {
  return prisma.fiscalPeriod.findFirst({
    where: {
      clubId,
      startDate: { lte: when },
      endDate: { gte: when },
    },
  });
}

// Called by the posting engine. Returns the period; throws if no open period
// covers the requested date, or if the period is locked and the principal
// does not hold an override permission.
//
// `allowSoftLockOverride`: true for adapter-generated entries (AR→GL). False
// for manual user-entered journals — manual postings respect soft lock.
export async function resolvePostingPeriod(
  principal: Principal,
  clubId: string,
  when: Date,
  opts?: { allowSoftLockOverride?: boolean }
) {
  const period = await findPeriodForDate(clubId, when);
  if (!period) {
    throw new ConflictError(`No fiscal period covers ${when.toISOString().slice(0, 10)}`);
  }
  const status = period.status as PeriodStatus;
  if (status === "OPEN") return period;
  if (status === "SOFT_LOCKED") {
    if (opts?.allowSoftLockOverride) return period;
    throw new ConflictError(`Period ${period.label} is soft-locked. Manual postings are not permitted.`);
  }
  // HARD_LOCKED or CLOSED — only SUPER_ADMIN with explicit reopen can post.
  if (!hasPermission(principal, clubId, "gl:close_period")) {
    throw new ConflictError(`Period ${period.label} is locked.`);
  }
  // Even with gl:close_period, refuse — the caller must reopen first.
  throw new ConflictError(`Period ${period.label} is locked. Reopen it before posting.`);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
const NEXT: Record<PeriodStatus, PeriodStatus[]> = {
  OPEN:         ["SOFT_LOCKED", "HARD_LOCKED", "CLOSED"],
  SOFT_LOCKED:  ["OPEN", "HARD_LOCKED", "CLOSED"],
  HARD_LOCKED:  ["OPEN", "SOFT_LOCKED", "CLOSED"],
  CLOSED:       ["OPEN", "SOFT_LOCKED", "HARD_LOCKED"], // reopen requires gl:close_period
};

function canMove(from: PeriodStatus, to: PeriodStatus): boolean {
  return from === to || (NEXT[from]?.includes(to) ?? false);
}

export async function setPeriodStatus(
  principal: Principal,
  periodId: string,
  next: PeriodStatus,
  opts?: { closingNote?: string }
) {
  const period = await prisma.fiscalPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new NotFoundError("FiscalPeriod", periodId);
  requirePermission(principal, period.clubId, "gl:close_period");
  const from = period.status as PeriodStatus;
  if (!canMove(from, next)) throw new ConflictError(`Cannot move period from ${from} to ${next}`);

  const updated = await prisma.fiscalPeriod.update({
    where: { id: periodId },
    data: {
      status: next,
      closedAt: (next === "HARD_LOCKED" || next === "CLOSED") ? new Date() : period.closedAt,
      closedByUserId: (next === "HARD_LOCKED" || next === "CLOSED") ? principal.id : period.closedByUserId,
      closingNote: opts?.closingNote ?? period.closingNote,
    },
  });
  await audit(principal, {
    action: `period.${next.toLowerCase()}`,
    entityType: "FiscalPeriod",
    entityId: periodId,
    clubId: period.clubId,
    before: { status: from },
    after: { status: next },
    meta: { note: opts?.closingNote },
  });
  return updated;
}
