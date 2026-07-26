// PaymentMethod service.
//
// Members can manage their own payment methods (self:payment_methods:write).
// Admins can manage payment methods on behalf of members (payment_methods:write).
// Both write paths funnel through here so audit/perm logic is shared.
//
// IMPORTANT: We never store PAN / bank account / CVV. Only tokenized-ready
// metadata. The form sends "last four" placeholder. FUTURE: a Stripe customer
// id / bank token field will be added when the processor adapter lands.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ForbiddenError, ValidationError } from "../errors";

const TYPE = ["CREDIT_CARD", "EFT"] as const;
const STATUS = ["ACTIVE", "EXPIRED", "FAILED", "REMOVED"] as const;

export const paymentMethodCreateSchema = z.object({
  type: z.enum(TYPE),
  nickname: z.string().max(60).optional().nullable(),
  lastFour: z
    .string()
    .max(4)
    .regex(/^\d{0,4}$/, "Last four must be up to 4 digits")
    .optional()
    .nullable(),
  isPrimary: z.boolean().default(false),
  isBackup: z.boolean().default(false),
});
export type PaymentMethodCreateInput = z.infer<typeof paymentMethodCreateSchema>;

// Authorization: a principal may write a payment method for a member if either
//   (a) they hold payment_methods:write at the member's club, or
//   (b) they are the member themselves AND hold self:payment_methods:write.
function ensureCanWriteMember(principal: Principal, member: { id: string; clubId: string }) {
  if (hasPermission(principal, member.clubId, "payment_methods:write")) return;
  if (
    principal.memberId &&
    principal.memberId === member.id &&
    hasPermission(principal, member.clubId, "self:payment_methods:write")
  ) {
    return;
  }
  throw new ForbiddenError("Not permitted to manage this member's payment methods");
}

export async function addPaymentMethod(principal: Principal, memberId: string, raw: unknown) {
  const parsed = paymentMethodCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureCanWriteMember(principal, member);

  const created = await prisma.paymentMethod.create({
    data: {
      clubId: member.clubId,
      memberId,
      type: parsed.data.type,
      nickname: parsed.data.nickname ?? null,
      lastFour: parsed.data.lastFour ?? null,
      isPrimary: parsed.data.isPrimary,
      isBackup: parsed.data.isBackup,
      status: "ACTIVE",
    },
  });
  if (created.isPrimary) await unsetOtherPrimary(memberId, created.id);
  if (created.isBackup) await unsetOtherBackup(memberId, created.id);
  await recomputePaymentMethodStatus(memberId);

  await audit(principal, {
    action: "payment_method.add",
    entityType: "PaymentMethod",
    entityId: created.id,
    clubId: member.clubId,
    after: created,
  });
  return created;
}

export async function setPrimary(principal: Principal, memberId: string, methodId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureCanWriteMember(principal, member);
  const pm = await prisma.paymentMethod.findUnique({ where: { id: methodId } });
  assertTenantOwned(pm, principal);

  await unsetOtherPrimary(memberId, methodId);
  const updated = await prisma.paymentMethod.update({
    where: { id: methodId },
    data: { isPrimary: true, isBackup: false },
  });
  await recomputePaymentMethodStatus(memberId);
  await audit(principal, {
    action: "payment_method.set_primary",
    entityType: "PaymentMethod",
    entityId: methodId,
    clubId: member.clubId,
    before: pm,
    after: updated,
  });
  return updated;
}

export async function setBackup(principal: Principal, memberId: string, methodId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureCanWriteMember(principal, member);
  const pm = await prisma.paymentMethod.findUnique({ where: { id: methodId } });
  assertTenantOwned(pm, principal);

  await unsetOtherBackup(memberId, methodId);
  const updated = await prisma.paymentMethod.update({
    where: { id: methodId },
    data: { isBackup: true, isPrimary: false },
  });
  await recomputePaymentMethodStatus(memberId);
  await audit(principal, {
    action: "payment_method.set_backup",
    entityType: "PaymentMethod",
    entityId: methodId,
    clubId: member.clubId,
    before: pm,
    after: updated,
  });
  return updated;
}

export async function removePaymentMethod(principal: Principal, memberId: string, methodId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureCanWriteMember(principal, member);
  const pm = await prisma.paymentMethod.findUnique({ where: { id: methodId } });
  assertTenantOwned(pm, principal);

  // Soft-remove only — preserve history for audit.
  const updated = await prisma.paymentMethod.update({
    where: { id: methodId },
    data: { status: "REMOVED", isPrimary: false, isBackup: false },
  });
  await recomputePaymentMethodStatus(memberId);
  await audit(principal, {
    action: "payment_method.remove",
    entityType: "PaymentMethod",
    entityId: methodId,
    clubId: member.clubId,
    before: pm,
    after: updated,
  });
  return updated;
}

async function unsetOtherPrimary(memberId: string, exceptId: string) {
  await prisma.paymentMethod.updateMany({
    where: { memberId, id: { not: exceptId }, isPrimary: true },
    data: { isPrimary: false },
  });
}
async function unsetOtherBackup(memberId: string, exceptId: string) {
  await prisma.paymentMethod.updateMany({
    where: { memberId, id: { not: exceptId }, isBackup: true },
    data: { isBackup: false },
  });
}
async function recomputePaymentMethodStatus(memberId: string) {
  const methods = await prisma.paymentMethod.findMany({ where: { memberId, status: "ACTIVE" } });
  const hasPrimary = methods.some((m) => m.isPrimary);
  const hasBackup = methods.some((m) => m.isBackup);
  const status = hasPrimary && hasBackup ? "PRIMARY_AND_BACKUP" : hasPrimary ? "PRIMARY_ON_FILE" : "NONE";
  await prisma.member.update({ where: { id: memberId }, data: { paymentMethodStatus: status } });
}
