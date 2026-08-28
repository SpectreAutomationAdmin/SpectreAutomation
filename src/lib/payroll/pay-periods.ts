// Payroll-3B-2 (2026-08-28) — canonical PayrollPayPeriod service.
//
// Deterministically generates the payroll calendar for a Pay Group
// and a payroll tax year. Every date is a civil calendar date
// (year/month/day) stored as a UTC midnight — see the "Civil date
// arithmetic" block below for why. Server timezone, DST transitions,
// and machine locale never affect the result.
//
// Canonical semantics (verified against Payroll-3A schema comments):
//   • PayrollPayPeriod uses half-open [periodStart, periodEnd).
//     Work performed on periodEnd falls in the NEXT period.
//   • payDate = periodEnd + payDateOffsetDays (CALENDAR days).
//   • PayrollPayPeriod.taxYear = year(payDate) — the year in which
//     remuneration is PAID, not merely earned. So a period worked
//     in December 2026 that pays in January 2027 belongs to 2027.
//   • sequenceInYear is 1-based, ordered by payDate ascending.
//
// Generation is idempotent: rerunning `generatePayPeriods(...)` for
// an existing identical schedule returns the same rows and creates
// nothing new. If a non-identical schedule already exists for the
// same (Club, PayGroup, taxYear) the service REFUSES to replace it
// — payroll evidence is historical the moment it exists, and a
// controlled amendment workflow will arrive in a later slice.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";
import type { PayFrequency } from "./club-config";

const ENTITY = "PayrollPayPeriod";

export type PayPeriodStatus = "FUTURE" | "OPEN" | "CLOSED";

export interface PayPeriodView {
  id: string;
  clubId: string;
  payGroupId: string;
  sequenceInYear: number;
  taxYear: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  status: PayPeriodStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface PayPeriodRow {
  id: string;
  clubId: string;
  payGroupId: string;
  sequenceInYear: number;
  taxYear: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(row: PayPeriodRow): PayPeriodView {
  const st = (row.status === "OPEN" || row.status === "CLOSED"
    ? row.status
    : "FUTURE") as PayPeriodStatus;
  return {
    id: row.id,
    clubId: row.clubId,
    payGroupId: row.payGroupId,
    sequenceInYear: row.sequenceInYear,
    taxYear: row.taxYear,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    status: st,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Civil date arithmetic — every payroll date is stored as UTC midnight
// so it represents the CALENDAR day, not a moment in local time. This
// keeps January 1 as January 1 in every server timezone, and DST
// transitions never move a period boundary.
// ---------------------------------------------------------------------------

/** Snap any Date to UTC midnight of the same y/m/d as read in UTC.
 *  Used defensively when a caller may hand us a non-midnight anchor. */
function toCivilMidnightUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Add N whole days to a civil date, returning a new civil date. */
function addDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

/** Add N whole months, preserving day-of-month or clamping to the
 *  last day of the target month (e.g. Jan 31 + 1 month → Feb 28/29). */
function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetY = y + Math.trunc((m + months) / 12) + (m + months < 0 ? -1 : 0);
  const targetM = ((m + months) % 12 + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetY, targetM, clampedDay));
}

/** Return the last calendar day of the month containing d. */
function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

// ---------------------------------------------------------------------------
// Deterministic in-memory calendar generation (pure functions — no DB)
// ---------------------------------------------------------------------------

interface GeneratedPeriod {
  sequenceInYear: number;
  taxYear: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
}

interface CalendarSpec {
  payFrequency: PayFrequency;
  payDateOffsetDays: number;
  calendarAnchorDate: Date | null;
  taxYear: number;
}

/**
 * Build the deterministic list of Pay Periods whose payDates fall in
 * `taxYear`. Purely functional — takes only the calendar spec and
 * returns dated tuples, no DB touch.
 *
 * • WEEKLY  — every 7 days from the anchor. Anchor required.
 * • BIWEEKLY — every 14 days from the anchor. Anchor required.
 * • SEMI_MONTHLY — 1st→16th (exclusive) and 16th→next-month-1st
 *   (exclusive). Anchor ignored.
 * • MONTHLY — 1st→next-month-1st (exclusive). Anchor ignored.
 *
 * Weekly and biweekly generation projects forward and backward from
 * the anchor: we compute the first period whose payDate falls in
 * `taxYear`, then step forward until payDate leaves `taxYear`. This
 * lets a year contain the "extra" pay date that occurs when the
 * calendar aligns (e.g. 27-pay-date biweekly years).
 */
export function buildCalendar(spec: CalendarSpec): GeneratedPeriod[] {
  const { payFrequency, payDateOffsetDays, calendarAnchorDate, taxYear } = spec;

  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearAfter = new Date(Date.UTC(taxYear + 1, 0, 1));

  if (payFrequency === "WEEKLY" || payFrequency === "BIWEEKLY") {
    if (!calendarAnchorDate) {
      throw new ValidationError([
        {
          path: "calendarAnchorDate",
          message: "A calendar anchor date is required before generating weekly or biweekly pay periods.",
        },
      ]);
    }
    const step = payFrequency === "WEEKLY" ? 7 : 14;
    const anchor = toCivilMidnightUTC(calendarAnchorDate);
    // Walk backward from the anchor until we find a periodStart whose
    // payDate < yearStart (i.e. one step before the first payDate in
    // the requested year). Then walk forward.
    let start = anchor;
    // Compute periodEnd + payDate for `start` and use to decide.
    const payDateOf = (s: Date) => addDays(s, step + payDateOffsetDays);
    // Fast rewind: jump directly to the first period whose payDate
    // could plausibly fall in this year. Distance in whole steps.
    if (payDateOf(start).getTime() > yearAfter.getTime()) {
      const gapDays = Math.ceil((payDateOf(start).getTime() - yearAfter.getTime()) / 86400000);
      const gapSteps = Math.ceil(gapDays / step);
      start = addDays(start, -gapSteps * step);
    } else if (payDateOf(start).getTime() < yearStart.getTime()) {
      const gapDays = Math.ceil((yearStart.getTime() - payDateOf(start).getTime()) / 86400000);
      const gapSteps = Math.floor(gapDays / step);
      start = addDays(start, gapSteps * step);
    }
    // Rewind a few steps to be safe, then walk forward.
    start = addDays(start, -step * 3);
    const out: GeneratedPeriod[] = [];
    // Absolute walk safety limit — 400 payments in a year cannot
    // occur; if we exceed that, something is deeply wrong.
    for (let i = 0; i < 400; i++) {
      const periodStart = start;
      const periodEnd = addDays(periodStart, step);
      const payDate = addDays(periodEnd, payDateOffsetDays);
      if (payDate.getUTCFullYear() > taxYear) break;
      if (payDate.getUTCFullYear() === taxYear) {
        out.push({ sequenceInYear: 0, taxYear, periodStart, periodEnd, payDate });
      }
      start = addDays(start, step);
    }
    // Assign 1-based sequence in payDate order.
    out.sort((a, b) => a.payDate.getTime() - b.payDate.getTime());
    for (let i = 0; i < out.length; i++) out[i]!.sequenceInYear = i + 1;
    return out;
  }

  if (payFrequency === "SEMI_MONTHLY") {
    const out: GeneratedPeriod[] = [];
    for (let m = 0; m < 12; m++) {
      // First half: [Y-m-01, Y-m-16)  — periodEnd 16 exclusive
      const s1 = new Date(Date.UTC(taxYear, m, 1));
      const e1 = new Date(Date.UTC(taxYear, m, 16));
      // Second half: [Y-m-16, Y-(m+1)-01) — periodEnd = 1st of next month exclusive
      const s2 = new Date(Date.UTC(taxYear, m, 16));
      const e2 = new Date(Date.UTC(taxYear, m + 1, 1));
      const pay1 = addDays(e1, payDateOffsetDays);
      const pay2 = addDays(e2, payDateOffsetDays);
      // Only include periods whose payDate is in the requested year.
      if (pay1.getUTCFullYear() === taxYear) {
        out.push({ sequenceInYear: 0, taxYear, periodStart: s1, periodEnd: e1, payDate: pay1 });
      }
      if (pay2.getUTCFullYear() === taxYear) {
        out.push({ sequenceInYear: 0, taxYear, periodStart: s2, periodEnd: e2, payDate: pay2 });
      }
    }
    // Also pick up December-half periods from taxYear-1 that PAY in taxYear.
    for (const m of [11]) {
      const s2Prev = new Date(Date.UTC(taxYear - 1, m, 16));
      const e2Prev = new Date(Date.UTC(taxYear, 0, 1));
      const pay2Prev = addDays(e2Prev, payDateOffsetDays);
      if (pay2Prev.getUTCFullYear() === taxYear) {
        out.unshift({
          sequenceInYear: 0,
          taxYear,
          periodStart: s2Prev,
          periodEnd: e2Prev,
          payDate: pay2Prev,
        });
      }
      const s1Prev = new Date(Date.UTC(taxYear - 1, m, 1));
      const e1Prev = new Date(Date.UTC(taxYear - 1, m, 16));
      const pay1Prev = addDays(e1Prev, payDateOffsetDays);
      if (pay1Prev.getUTCFullYear() === taxYear) {
        out.unshift({
          sequenceInYear: 0,
          taxYear,
          periodStart: s1Prev,
          periodEnd: e1Prev,
          payDate: pay1Prev,
        });
      }
    }
    out.sort((a, b) => a.payDate.getTime() - b.payDate.getTime());
    for (let i = 0; i < out.length; i++) out[i]!.sequenceInYear = i + 1;
    return out;
  }

  if (payFrequency === "MONTHLY") {
    const out: GeneratedPeriod[] = [];
    // Include Dec-taxYear-1 (payDate in taxYear possible) and Jan..Dec of taxYear
    for (let m = -1; m < 12; m++) {
      const y = m < 0 ? taxYear - 1 : taxYear;
      const month = m < 0 ? 11 : m;
      const start = new Date(Date.UTC(y, month, 1));
      const end = new Date(Date.UTC(y, month + 1, 1));
      const pay = addDays(end, payDateOffsetDays);
      if (pay.getUTCFullYear() === taxYear) {
        out.push({ sequenceInYear: 0, taxYear, periodStart: start, periodEnd: end, payDate: pay });
      }
    }
    out.sort((a, b) => a.payDate.getTime() - b.payDate.getTime());
    for (let i = 0; i < out.length; i++) out[i]!.sequenceInYear = i + 1;
    return out;
  }

  throw new ValidationError([
    { path: "payFrequency", message: `Unsupported payFrequency ${payFrequency}` },
  ]);
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function listPayPeriods(
  principal: Principal,
  clubId: string,
  filter: { payGroupId?: string; taxYear?: number } = {},
): Promise<PayPeriodView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollPayPeriod.findMany({
    where: {
      clubId,
      ...(filter.payGroupId ? { payGroupId: filter.payGroupId } : {}),
      ...(filter.taxYear !== undefined ? { taxYear: filter.taxYear } : {}),
    },
    orderBy: [{ payGroupId: "asc" }, { taxYear: "asc" }, { sequenceInYear: "asc" }],
  });
  return rows.map(projectRow);
}

export async function getPayPeriod(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<PayPeriodView | null> {
  requirePermission(principal, clubId, "payroll:read");
  const row = await prisma.payrollPayPeriod.findFirst({ where: { id, clubId } });
  return row ? projectRow(row) : null;
}

/** Pure preview — computes what generation WOULD create without any
 *  DB writes. Handy for UI confirmation before the admin commits. */
export async function previewPayPeriods(
  principal: Principal,
  clubId: string,
  payGroupId: string,
  taxYear: number,
): Promise<GeneratedPeriod[]> {
  requirePermission(principal, clubId, "payroll:read");
  const grp = await prisma.payrollPayGroup.findFirst({ where: { id: payGroupId, clubId } });
  if (!grp) throw new NotFoundError("PayrollPayGroup", payGroupId);
  return buildCalendar({
    payFrequency: grp.payFrequency as PayFrequency,
    payDateOffsetDays: grp.payDateOffsetDays,
    calendarAnchorDate: grp.calendarAnchorDate ?? null,
    taxYear,
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface GenerationResult {
  status: "created" | "existing-matches";
  periods: PayPeriodView[];
  count: number;
  firstPayDate: Date | null;
  lastPayDate: Date | null;
}

/**
 * Generate (or, if identical schedule already exists, no-op) the Pay
 * Periods for a Pay Group and payroll tax year.
 *
 * Idempotency rules:
 *   • If NO rows exist for (clubId, payGroupId, taxYear), create the
 *     computed schedule inside a $transaction and audit.
 *   • If rows exist AND every row's (periodStart, periodEnd, payDate,
 *     sequenceInYear) matches the computed schedule exactly, return
 *     "existing-matches" without writing.
 *   • If rows exist and DIFFER from the computed schedule, throw a
 *     structured ValidationError — Spectre never silently replaces
 *     historical payroll evidence.
 */
export async function generatePayPeriods(
  principal: Principal,
  clubId: string,
  payGroupId: string,
  taxYear: number,
): Promise<GenerationResult> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(
    principal, clubId, "payroll.pay-period.generate", ENTITY, payGroupId,
  );

  const grp = await prisma.payrollPayGroup.findFirst({ where: { id: payGroupId, clubId } });
  if (!grp) throw new NotFoundError("PayrollPayGroup", payGroupId);
  if (!grp.active) {
    throw new ValidationError([
      { path: "payGroupId", message: "Pay group is inactive; reactivate before generating pay periods" },
    ]);
  }
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) {
    throw new ValidationError([{ path: "taxYear", message: "taxYear must be a plausible calendar year" }]);
  }
  if (!Number.isInteger(grp.payDateOffsetDays) || grp.payDateOffsetDays < 0 || grp.payDateOffsetDays > 30) {
    throw new ValidationError([
      { path: "payDateOffsetDays", message: "Pay-date offset must be between 0 and 30 calendar days" },
    ]);
  }

  const computed = buildCalendar({
    payFrequency: grp.payFrequency as PayFrequency,
    payDateOffsetDays: grp.payDateOffsetDays,
    calendarAnchorDate: grp.calendarAnchorDate ?? null,
    taxYear,
  });

  const existing = await prisma.payrollPayPeriod.findMany({
    where: { clubId, payGroupId, taxYear },
    orderBy: [{ sequenceInYear: "asc" }],
  });

  if (existing.length > 0) {
    const identical = existing.length === computed.length && computed.every((c, i) => {
      const e = existing[i]!;
      return (
        e.sequenceInYear === c.sequenceInYear &&
        e.periodStart.getTime() === c.periodStart.getTime() &&
        e.periodEnd.getTime() === c.periodEnd.getTime() &&
        e.payDate.getTime() === c.payDate.getTime()
      );
    });
    if (identical) {
      return {
        status: "existing-matches",
        periods: existing.map(projectRow),
        count: existing.length,
        firstPayDate: existing[0]?.payDate ?? null,
        lastPayDate: existing[existing.length - 1]?.payDate ?? null,
      };
    }
    throw new ValidationError([
      {
        path: "calendar",
        message:
          `Pay periods already exist for this Pay Group and year and do not match the current ` +
          `calendar configuration. Existing payroll calendars cannot be replaced automatically.`,
      },
    ]);
  }

  // Non-existent → create atomically. Every row's unique constraints
  // are respected by construction; if a concurrent generator wins the
  // race a P2002 will surface as a plain error (rare admin action).
  const createdRows = await prisma.$transaction(async (tx) => {
    const rows: PayPeriodRow[] = [];
    for (const c of computed) {
      const row = await tx.payrollPayPeriod.create({
        data: {
          clubId,
          payGroupId,
          sequenceInYear: c.sequenceInYear,
          taxYear: c.taxYear,
          periodStart: c.periodStart,
          periodEnd: c.periodEnd,
          payDate: c.payDate,
          status: "FUTURE",
        },
      });
      rows.push(row);
    }
    return rows;
  });

  await audit(principal, {
    action: "payroll.pay-period.generate",
    entityType: ENTITY,
    entityId: payGroupId,
    clubId,
    after: {
      payGroupId,
      taxYear,
      count: createdRows.length,
      firstPayDate: createdRows[0]?.payDate.toISOString() ?? null,
      lastPayDate: createdRows[createdRows.length - 1]?.payDate.toISOString() ?? null,
    },
  });

  return {
    status: "created",
    periods: createdRows.map(projectRow),
    count: createdRows.length,
    firstPayDate: createdRows[0]?.payDate ?? null,
    lastPayDate: createdRows[createdRows.length - 1]?.payDate ?? null,
  };
}
