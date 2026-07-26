// Statement generation.
//
// A Statement is a point-in-time snapshot of the member's account for a
// period. `linesJson` is denormalized so that future void/reversals do NOT
// retroactively change historical statements.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ForbiddenError, ConflictError, ValidationError } from "../errors";
import { calculateAging } from "./aging";

export const generateStatementSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  messageBody: z.string().optional().nullable(),
});

export async function generateStatement(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "ar:statements:issue");
  const parsed = generateStatementSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));

  const start = new Date(parsed.data.periodStart);
  const end = new Date(parsed.data.periodEnd);
  if (!(start < end)) throw new ConflictError("periodEnd must be after periodStart");

  const [chargesAll, paymentsAll, adjustmentsAll] = await Promise.all([
    prisma.charge.findMany({ where: { memberId } }),
    prisma.payment.findMany({ where: { memberId } }),
    prisma.accountAdjustment.findMany({ where: { memberId } }),
  ]);

  // Opening balance: aging snapshot just before periodStart.
  const before = calculateAging({
    charges: chargesAll.filter((c) => c.transactionDate < start).map(toAgingCharge),
    payments: paymentsAll.filter((p) => p.paymentDate < start).map(toAgingPayment),
    adjustments: adjustmentsAll.filter((a) => a.transactionDate < start).map(toAgingAdj),
  }, start);

  const periodCharges = chargesAll.filter((c) => c.transactionDate >= start && c.transactionDate <= end);
  const periodPayments = paymentsAll.filter((p) => p.paymentDate >= start && p.paymentDate <= end);
  const periodAdjustments = adjustmentsAll.filter((a) => a.transactionDate >= start && a.transactionDate <= end);

  // Closing balance & aging at end-of-period.
  const after = calculateAging({
    charges: chargesAll.filter((c) => c.transactionDate <= end).map(toAgingCharge),
    payments: paymentsAll.filter((p) => p.paymentDate <= end).map(toAgingPayment),
    adjustments: adjustmentsAll.filter((a) => a.transactionDate <= end).map(toAgingAdj),
  }, end);

  const totalCharges = round2(periodCharges.filter((c) => c.status === "POSTED").reduce((s, c) => s + c.amount, 0));
  const totalPayments = round2(periodPayments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0));
  const totalAdjustments = round2(
    periodAdjustments
      .filter((a) => a.status === "POSTED")
      .reduce((s, a) => s + (a.type === "DEBIT" ? a.amount : -a.amount), 0)
  );

  // Lines (date-ordered, period-only).
  const lines: Array<{ date: string; type: string; description: string; amount: number; signedAmount: number; runningBalance: number }> = [];
  let running = before.currentBalance;
  const items: Array<{ date: Date; type: string; description: string; signedAmount: number }> = [
    ...periodCharges.filter((c) => c.status !== "VOIDED").map((c) => ({ date: c.transactionDate, type: c.category, description: c.description, signedAmount: c.amount })),
    ...periodPayments.filter((p) => p.status === "SUCCESS").map((p) => ({ date: p.paymentDate, type: "PAYMENT", description: p.method, signedAmount: -p.amount })),
    ...periodAdjustments.filter((a) => a.status === "POSTED").map((a) => ({
      date: a.transactionDate,
      type: a.type,
      description: a.description,
      signedAmount: (a.type === "CREDIT" || a.type === "REFUND" || a.type === "WRITE_OFF") ? -a.amount : a.amount,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const it of items) {
    running = round2(running + it.signedAmount);
    lines.push({
      date: it.date.toISOString().slice(0, 10),
      type: it.type,
      description: it.description,
      amount: round2(Math.abs(it.signedAmount)),
      signedAmount: round2(it.signedAmount),
      runningBalance: running,
    });
  }

  // Upsert (unique on memberId+periodStart+periodEnd) so re-issuing replaces.
  const statement = await prisma.statement.upsert({
    where: { memberId_periodStart_periodEnd: { memberId, periodStart: start, periodEnd: end } },
    update: {
      openingBalance: before.currentBalance,
      closingBalance: after.currentBalance,
      totalCharges,
      totalPayments,
      totalAdjustments,
      agingCurrent: after.buckets.current,
      aging30: after.buckets.d30,
      aging60: after.buckets.d60,
      aging90: after.buckets.d90,
      aging120: after.buckets.d120,
      linesJson: JSON.stringify(lines),
      messageBody: parsed.data.messageBody ?? null,
      status: "ISSUED",
      issuedAt: new Date(),
      issuedByUserId: principal.id,
    },
    create: {
      clubId: member.clubId,
      memberId,
      periodStart: start,
      periodEnd: end,
      openingBalance: before.currentBalance,
      closingBalance: after.currentBalance,
      totalCharges,
      totalPayments,
      totalAdjustments,
      agingCurrent: after.buckets.current,
      aging30: after.buckets.d30,
      aging60: after.buckets.d60,
      aging90: after.buckets.d90,
      aging120: after.buckets.d120,
      linesJson: JSON.stringify(lines),
      messageBody: parsed.data.messageBody ?? null,
      status: "ISSUED",
      issuedAt: new Date(),
      issuedByUserId: principal.id,
    },
  });

  // Also record a MemberDocument pointer so the member can find it in their portal.
  await prisma.memberDocument.upsert({
    where: { id: `stmt-${statement.id}` }, // synthetic id; will throw if collision, so create
    update: {},
    create: {
      id: `stmt-${statement.id}`,
      clubId: member.clubId,
      memberId,
      kind: "STATEMENT",
      name: `Statement ${start.toISOString().slice(0, 10)} – ${end.toISOString().slice(0, 10)}`,
      storageKey: null,
      mimeType: "application/json",
      sizeBytes: lines.length,
      metaJson: JSON.stringify({ statementId: statement.id }),
      visibleToMember: true,
    },
  }).catch(() => { /* idempotent — duplicate is fine */ });

  await audit(principal, {
    action: "ar.statement.issue",
    entityType: "Statement",
    entityId: statement.id,
    clubId: member.clubId,
    after: { ...statement, linesJson: undefined },
    meta: { lineCount: lines.length },
  });
  return statement;
}

export async function readStatement(principal: Principal, statementId: string) {
  const statement = await prisma.statement.findUnique({ where: { id: statementId }, include: { member: true } });
  assertTenantOwned(statement, principal);
  // Either the member themselves (self:statements:read) or an admin with ar:read can view.
  if (
    !hasPermission(principal, statement.clubId, "ar:read") &&
    !(principal.memberId === statement.memberId && hasPermission(principal, statement.clubId, "self:statements:read"))
  ) {
    throw new ForbiddenError("Not permitted to view this statement");
  }
  return statement;
}

// ---------- helpers ---------------------------------------------------------
type C = Awaited<ReturnType<typeof prisma.charge.findMany>>[number];
type P = Awaited<ReturnType<typeof prisma.payment.findMany>>[number];
type A = Awaited<ReturnType<typeof prisma.accountAdjustment.findMany>>[number];
function toAgingCharge(c: C) { return { id: c.id, amount: c.amount, dueDate: c.dueDate, transactionDate: c.transactionDate, status: c.status, reversesId: c.reversesId }; }
function toAgingPayment(p: P) { return { id: p.id, amount: p.amount, paymentDate: p.paymentDate, status: p.status, reversesId: p.reversesId }; }
function toAgingAdj(a: A) { return { id: a.id, amount: a.amount, type: a.type, transactionDate: a.transactionDate, status: a.status }; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
