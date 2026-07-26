// Member service. Status, access, and read helpers.
//
// Notice generation and access-restriction workflows moved to collections.ts
// in Phase 2D. Keep this file focused on member lifecycle.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission } from "../rbac";
import { assertTenantOwned, tenantWhere } from "./tenant";
import { ValidationError } from "../errors";
import type { Principal } from "../rbac";

const STATUS_VALUES = ["ONBOARDING", "ACTIVE", "SUSPENDED", "INACTIVE", "WAITLIST"] as const;
const ACCESS_VALUES = ["FULL_ACCESS", "CHARGE_ACCOUNT_SUSPENDED", "TEE_SHEET_SUSPENDED", "FULL_SUSPENSION"] as const;

export async function setMemberStatus(principal: Principal, memberId: string, status: string) {
  if (!STATUS_VALUES.includes(status as (typeof STATUS_VALUES)[number])) {
    throw new ValidationError([{ path: "status", message: "Invalid status" }]);
  }
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "members:write");

  const updated = await prisma.member.update({ where: { id: memberId }, data: { status } });
  await audit(principal, {
    action: "member.status_change",
    entityType: "Member",
    entityId: memberId,
    clubId: member.clubId,
    before: { status: member.status },
    after: { status: updated.status },
  });
  return updated;
}

export async function setMemberAccess(principal: Principal, memberId: string, accessStatus: string) {
  if (!ACCESS_VALUES.includes(accessStatus as (typeof ACCESS_VALUES)[number])) {
    throw new ValidationError([{ path: "accessStatus", message: "Invalid access status" }]);
  }
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "members:suspend");

  const updated = await prisma.member.update({ where: { id: memberId }, data: { accessStatus } });
  await audit(principal, {
    action: "member.access_change",
    entityType: "Member",
    entityId: memberId,
    clubId: member.clubId,
    before: { accessStatus: member.accessStatus },
    after: { accessStatus: updated.accessStatus },
  });
  return updated;
}

// Tenant-scoped reads. Centralizing these keeps every list page tenant-safe.
export async function listMembers(principal: Principal, clubId: string) {
  return prisma.member.findMany({
    where: tenantWhere(principal, clubId),
    include: { account: true },
    orderBy: [{ status: "asc" }, { lastName: "asc" }],
  });
}

export async function getMember(principal: Principal, memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      account: true,
      paymentMethods: true,
      charges: { orderBy: { transactionDate: "desc" }, take: 25 },
      payments: { orderBy: { paymentDate: "desc" }, take: 25 },
      financingAgreements: { include: { schedule: { orderBy: { paymentNumber: "asc" } } } },
      collectionNotices: { orderBy: { createdAt: "desc" } },
      preferences: true,
      registrations: { include: { event: true } },
    },
  });
  assertTenantOwned(member, principal);
  return member;
}
