// Phase 12D — Customer (member) billing self-service portal.
//
// Read-mostly surface that lets a member view their own statements, current
// balance, recent activity, and saved payment methods. Write operations are
// limited to: open a dispute (Phase 9 flow), and request a payment via the
// existing pay-now service (already implemented in services/payments).
//
// Permissions: gated on the member's own `self:*` permissions; the principal
// must be the member who owns the account. Cross-member access is refused.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function resolveOwnedMemberId(principal: Principal, requestedMemberId?: string): Promise<string> {
  // A member principal can only see their own account. Staff with
  // `members:read` could call this on someone else's behalf, but for the
  // portal we require self-service.
  if (!principal.memberId) throw new ForbiddenError("Principal is not associated with a member account");
  if (requestedMemberId && requestedMemberId !== principal.memberId) {
    throw new ForbiddenError("Cannot access another member's billing data");
  }
  return principal.memberId;
}

// ---------------------------------------------------------------------------
// Overview — single payload powering the portal landing page.
// ---------------------------------------------------------------------------
export async function getOverview(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "self:account:read");
  const memberId = await resolveOwnedMemberId(principal);
  const account = await prisma.memberAccount.findUnique({ where: { memberId } });
  if (!account || account.clubId !== clubId) throw new NotFoundError("MemberAccount", memberId);
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  const lastStatement = await prisma.statement.findFirst({
    where: { memberId, clubId },
    orderBy: { issuedAt: "desc" },
  });
  const recentCharges = await prisma.charge.findMany({
    where: { accountId: account.id, status: { not: "VOIDED" } },
    orderBy: { transactionDate: "desc" },
    take: 10,
  });
  const recentPayments = await prisma.payment.findMany({
    where: { accountId: account.id },
    orderBy: { paymentDate: "desc" },
    take: 10,
  });
  const methodCount = await prisma.paymentMethod.count({ where: { memberId, status: "ACTIVE" } });
  return {
    member: member ? { id: member.id, name: `${member.firstName} ${member.lastName}`, email: member.email } : null,
    balances: {
      current: account.currentBalance,
      thirtyDay: account.thirtyDayBalance,
      sixtyDay: account.sixtyDayBalance,
      ninetyDay: account.ninetyDayBalance,
      oneTwentyDay: account.oneTwentyDayBalance,
      credit: account.creditBalance,
      lastPaymentDate: account.lastPaymentDate,
    },
    lastStatement: lastStatement ? {
      id: lastStatement.id,
      periodStart: lastStatement.periodStart, periodEnd: lastStatement.periodEnd,
      closingBalance: lastStatement.closingBalance, issuedAt: lastStatement.issuedAt,
    } : null,
    recentCharges: recentCharges.map((c) => ({ id: c.id, date: c.transactionDate, category: c.category, description: c.description, amount: c.amount, status: c.status })),
    recentPayments: recentPayments.map((p) => ({ id: p.id, date: p.paymentDate, method: p.method, amount: p.amount, status: p.status })),
    paymentMethodCount: methodCount,
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------
export async function listStatements(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "self:statements:read");
  const memberId = await resolveOwnedMemberId(principal);
  return prisma.statement.findMany({
    where: { memberId, clubId },
    orderBy: { issuedAt: "desc" },
    take: 24,
    select: { id: true, periodStart: true, periodEnd: true, closingBalance: true, status: true, issuedAt: true },
  });
}

export async function getStatement(principal: Principal, clubId: string, statementId: string) {
  requirePermission(principal, clubId, "self:statements:read");
  const memberId = await resolveOwnedMemberId(principal);
  const stmt = await prisma.statement.findUnique({ where: { id: statementId } });
  if (!stmt || stmt.memberId !== memberId || stmt.clubId !== clubId) throw new NotFoundError("Statement", statementId);
  await audit(principal, { action: "portal.statement.view", entityType: "Statement", entityId: stmt.id, clubId });
  return stmt;
}

// ---------------------------------------------------------------------------
// Payment methods — list + soft delete. (Add/update is handled by the
// existing payment-methods service which is shared between staff and portal.)
// ---------------------------------------------------------------------------
export async function listPaymentMethods(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "self:account:read");
  const memberId = await resolveOwnedMemberId(principal);
  const methods = await prisma.paymentMethod.findMany({
    where: { memberId, clubId, status: { in: ["ACTIVE", "PENDING_VERIFICATION"] } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
  });
  // Strip processor token from response — only sentinel masked fields.
  return methods.map((m) => ({
    id: m.id, type: m.type, brand: m.brand, nickname: m.nickname,
    lastFour: m.lastFour, expiryMonth: m.expiryMonth, expiryYear: m.expiryYear,
    isPrimary: m.isPrimary, isBackup: m.isBackup, status: m.status,
  }));
}

export const setPrimarySchema = z.object({
  paymentMethodId: z.string(),
});

export async function setPrimaryPaymentMethod(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "self:payment_methods:write");
  const parsed = setPrimarySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const memberId = await resolveOwnedMemberId(principal);
  const method = await prisma.paymentMethod.findUnique({ where: { id: parsed.data.paymentMethodId } });
  if (!method || method.memberId !== memberId || method.clubId !== clubId) {
    throw new NotFoundError("PaymentMethod", parsed.data.paymentMethodId);
  }
  if (method.status !== "ACTIVE") throw new ValidationError([{ path: "paymentMethodId", message: "method is not ACTIVE" }]);
  await prisma.$transaction([
    prisma.paymentMethod.updateMany({
      where: { memberId, clubId, isPrimary: true, id: { not: method.id } },
      data: { isPrimary: false },
    }),
    prisma.paymentMethod.update({ where: { id: method.id }, data: { isPrimary: true } }),
  ]);
  await audit(principal, { action: "portal.payment_method.set_primary", entityType: "PaymentMethod", entityId: method.id, clubId });
  return { ok: true };
}

export async function removePaymentMethod(principal: Principal, clubId: string, paymentMethodId: string) {
  requirePermission(principal, clubId, "self:payment_methods:write");
  const memberId = await resolveOwnedMemberId(principal);
  const method = await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } });
  if (!method || method.memberId !== memberId || method.clubId !== clubId) {
    throw new NotFoundError("PaymentMethod", paymentMethodId);
  }
  if (method.isPrimary) {
    throw new ValidationError([{ path: "paymentMethodId", message: "Cannot remove the primary payment method" }]);
  }
  // Soft delete — never destroy financial-adjacent records.
  await prisma.paymentMethod.update({
    where: { id: method.id },
    data: { status: "REMOVED" },
  });
  await audit(principal, { action: "portal.payment_method.remove", entityType: "PaymentMethod", entityId: method.id, clubId });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Disputes — quick-launch surface for the existing dispute service.
// ---------------------------------------------------------------------------
export const openDisputeSchema = z.object({
  chargeId: z.string(),
  reason: z.string().min(3).max(2000),
});

export async function openDispute(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "self:disputes:open");
  const parsed = openDisputeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const memberId = await resolveOwnedMemberId(principal);
  const charge = await prisma.charge.findUnique({ where: { id: parsed.data.chargeId } });
  if (!charge || charge.clubId !== clubId) throw new NotFoundError("Charge", parsed.data.chargeId);
  // Ensure the charge belongs to *this* member.
  const account = await prisma.memberAccount.findUnique({ where: { id: charge.accountId } });
  if (!account || account.memberId !== memberId) throw new ForbiddenError("Charge does not belong to this member");
  const dispute = await prisma.dispute.create({
    data: {
      clubId, memberId, chargeId: charge.id,
      amount: charge.amount, description: parsed.data.reason,
      status: "OPEN",
    },
  });
  await audit(principal, { action: "portal.dispute.open", entityType: "Dispute", entityId: dispute.id, clubId, after: { chargeId: charge.id, amount: charge.amount } });
  return dispute;
}
