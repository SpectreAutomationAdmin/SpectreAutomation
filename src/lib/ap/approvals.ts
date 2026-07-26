// Reusable approval engine.
//
// Used by AP invoices, vendor approval, vendor banking, and payment batches.
// One ApprovalPolicy per entityType per club; the rule that fires is the
// lowest-`maxAmount` rule whose threshold is >= request.amount, or the
// catch-all rule (maxAmount === null) if none.
//
// Requesters cannot approve their own requests unless they have
// `ap:exception:override` (used sparingly).

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { ApprovalEntityType, ApprovalRule } from "./types";

const ruleSchema = z.object({
  maxAmount: z.number().nullable(),
  requiredApprovals: z.number().int().min(1).max(10),
  eligibleRoleKeys: z.array(z.string()).min(1),
});

const policySchema = z.object({
  entityType: z.string(),
  name: z.string().min(1).max(200),
  rules: z.array(ruleSchema).min(1),
});

export const DEFAULT_AP_INVOICE_POLICY: ApprovalRule[] = [
  { maxAmount: 3000,  requiredApprovals: 1, eligibleRoleKeys: ["CONTROLLER", "FINANCE_ADMIN", "GENERAL_MANAGER"] },
  { maxAmount: 15000, requiredApprovals: 2, eligibleRoleKeys: ["CONTROLLER", "GENERAL_MANAGER"] },
  { maxAmount: null,  requiredApprovals: 3, eligibleRoleKeys: ["CONTROLLER", "GENERAL_MANAGER", "BOARD_READ_ONLY"] },
];

export const DEFAULT_VENDOR_POLICY: ApprovalRule[] = [
  { maxAmount: null, requiredApprovals: 1, eligibleRoleKeys: ["CONTROLLER", "GENERAL_MANAGER", "CLUB_ADMIN"] },
];

export const DEFAULT_VENDOR_BANKING_POLICY: ApprovalRule[] = [
  { maxAmount: null, requiredApprovals: 2, eligibleRoleKeys: ["CONTROLLER", "GENERAL_MANAGER"] },
];

export const DEFAULT_PAYMENT_BATCH_POLICY: ApprovalRule[] = [
  { maxAmount: 10000, requiredApprovals: 1, eligibleRoleKeys: ["CONTROLLER", "FINANCE_ADMIN"] },
  { maxAmount: null,  requiredApprovals: 2, eligibleRoleKeys: ["CONTROLLER", "GENERAL_MANAGER"] },
];

export async function ensureDefaultPolicies(clubId: string) {
  for (const [entityType, rules, name] of [
    ["AP_INVOICE", DEFAULT_AP_INVOICE_POLICY, "AP invoice approval"],
    ["VENDOR", DEFAULT_VENDOR_POLICY, "Vendor approval"],
    ["VENDOR_BANKING", DEFAULT_VENDOR_BANKING_POLICY, "Vendor banking approval"],
    ["PAYMENT_BATCH", DEFAULT_PAYMENT_BATCH_POLICY, "Payment batch approval"],
  ] as const) {
    await prisma.approvalPolicy.upsert({
      where: { clubId_entityType: { clubId, entityType } },
      update: { rulesJson: JSON.stringify(rules) },
      create: { clubId, entityType, name, rulesJson: JSON.stringify(rules) },
    });
  }
}

function pickRule(rules: ApprovalRule[], amount: number): ApprovalRule {
  const sorted = [...rules].sort((a, b) => {
    if (a.maxAmount == null) return 1;
    if (b.maxAmount == null) return -1;
    return a.maxAmount - b.maxAmount;
  });
  for (const r of sorted) {
    if (r.maxAmount == null) return r;
    if (amount <= r.maxAmount) return r;
  }
  return sorted[sorted.length - 1];
}

export async function submitForApproval(
  principal: Principal,
  clubId: string,
  entityType: ApprovalEntityType,
  entityId: string,
  amount: number
) {
  const policy = await prisma.approvalPolicy.findUnique({
    where: { clubId_entityType: { clubId, entityType } },
  });
  if (!policy) throw new ConflictError(`No approval policy configured for ${entityType}`);
  const rules: ApprovalRule[] = JSON.parse(policy.rulesJson);
  const rule = pickRule(rules, amount);

  // If a request already exists for this entity, return it instead of duplicating.
  const existing = await prisma.approvalRequest.findFirst({
    where: { entityType, entityId, status: { in: ["PENDING", "APPROVED"] } },
  });
  if (existing) return existing;

  const req = await prisma.approvalRequest.create({
    data: {
      clubId,
      policyId: policy.id,
      entityType,
      entityId,
      amount,
      requiredApprovals: rule.requiredApprovals,
      eligibleRoleKeys: rule.eligibleRoleKeys.join(","),
      status: "PENDING",
      requestedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "approval.request",
    entityType: "ApprovalRequest",
    entityId: req.id,
    clubId,
    after: { entityType, entityId, amount, requiredApprovals: rule.requiredApprovals, eligibleRoleKeys: rule.eligibleRoleKeys },
  });
  return req;
}

export const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_INFO"]),
  comment: z.string().trim().max(2000).optional().nullable(),
});

export async function decide(principal: Principal, requestId: string, raw: unknown) {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const req = await prisma.approvalRequest.findUnique({
    where: { id: requestId },
    include: { decisions: true },
  });
  assertTenantOwned(req, principal);
  if (req.status !== "PENDING") throw new ConflictError(`Request is ${req.status}`);

  const eligibleRoles = req.eligibleRoleKeys.split(",");
  const userRoles = principal.memberships
    .filter((m) => m.clubId === req.clubId || m.clubId === null)
    .map((m) => m.roleKey);
  const isEligible = userRoles.some((r) => eligibleRoles.includes(r));
  if (!isEligible) {
    throw new ForbiddenError(`Role(s) ${userRoles.join(",")} cannot approve this request`);
  }

  // Self-approval guard: a requester may never APPROVE their own request,
  // regardless of permission level. Segregation of duties is non-negotiable —
  // even SUPER_ADMIN must have a second pair of eyes. (Rejections by the
  // requester are allowed since they're equivalent to withdrawing.)
  if (req.requestedByUserId === principal.id && parsed.data.decision === "APPROVE") {
    throw new ForbiddenError("You cannot approve your own request");
  }

  // Idempotent: one decision per user per request.
  const existing = req.decisions.find((d) => d.userId === principal.id);
  if (existing) throw new ConflictError("You have already decided on this request");

  const created = await prisma.approvalDecision.create({
    data: {
      clubId: req.clubId,
      requestId,
      userId: principal.id,
      decision: parsed.data.decision,
      comment: parsed.data.comment ?? null,
    },
  });

  // Compute new status.
  let nextStatus = req.status;
  if (parsed.data.decision === "REJECT") {
    nextStatus = "REJECTED";
  } else if (parsed.data.decision === "APPROVE") {
    const approvals = req.decisions.filter((d) => d.decision === "APPROVE").length + 1;
    if (approvals >= req.requiredApprovals) nextStatus = "APPROVED";
  }
  if (nextStatus !== req.status) {
    await prisma.approvalRequest.update({
      where: { id: requestId },
      data: { status: nextStatus, resolvedAt: new Date() },
    });
  }

  await audit(principal, {
    action: `approval.${parsed.data.decision.toLowerCase()}`,
    entityType: "ApprovalRequest",
    entityId: requestId,
    clubId: req.clubId,
    before: { status: req.status },
    after: { status: nextStatus },
    meta: { decisionId: created.id, comment: parsed.data.comment ?? null },
  });
  return { decision: created, requestStatus: nextStatus };
}

export async function cancelRequest(principal: Principal, requestId: string, reason: string) {
  const req = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
  assertTenantOwned(req, principal);
  if (req.status !== "PENDING") throw new ConflictError(`Request is ${req.status}`);
  const updated = await prisma.approvalRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED", resolvedAt: new Date(), resolutionNote: reason },
  });
  await audit(principal, {
    action: "approval.cancel",
    entityType: "ApprovalRequest",
    entityId: requestId,
    clubId: req.clubId,
    before: { status: req.status },
    after: { status: "CANCELLED" },
    meta: { reason },
  });
  return updated;
}

export async function getRequestForEntity(clubId: string, entityType: ApprovalEntityType, entityId: string) {
  return prisma.approvalRequest.findFirst({
    where: { clubId, entityType, entityId },
    include: { decisions: { include: { /* user: false */ } }, policy: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function listPendingForUser(principal: Principal, clubId: string) {
  const userRoles = principal.memberships
    .filter((m) => m.clubId === clubId || m.clubId === null)
    .map((m) => m.roleKey);
  const requests = await prisma.approvalRequest.findMany({
    where: { ...tenantWhere(principal, clubId), status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { decisions: true },
  });
  return requests.filter((r) => {
    const eligible = r.eligibleRoleKeys.split(",");
    if (!userRoles.some((ur) => eligible.includes(ur))) return false;
    // Hide own requests from the approval queue — SoD invariant.
    if (r.requestedByUserId === principal.id) return false;
    if (r.decisions.some((d) => d.userId === principal.id)) return false;
    return true;
  });
}

// Update an existing policy's rules. Validate first.
export const updatePolicySchema = policySchema;
export async function updatePolicyRules(principal: Principal, clubId: string, entityType: ApprovalEntityType, rules: ApprovalRule[], name?: string) {
  const validated = policySchema.parse({ entityType, name: name ?? `${entityType} policy`, rules });
  if (!hasPermission(principal, clubId, "vendor:approve")) throw new ForbiddenError("Cannot edit approval policy");
  const policy = await prisma.approvalPolicy.upsert({
    where: { clubId_entityType: { clubId, entityType } },
    update: { rulesJson: JSON.stringify(validated.rules), name: validated.name },
    create: { clubId, entityType, rulesJson: JSON.stringify(validated.rules), name: validated.name },
  });
  await audit(principal, {
    action: "approval.policy.update",
    entityType: "ApprovalPolicy",
    entityId: policy.id,
    clubId,
    after: validated,
  });
  return policy;
}

// Helper for adapter code: was this request fully approved?
export function isApproved(req: { status: string } | null | undefined): boolean {
  return req?.status === "APPROVED";
}

// Helper for currency boundary on submit (Decimal-friendly).
export function toAmountNumber(v: Prisma.Decimal | number | string): number {
  if (typeof v === "number") return v;
  return Number(v.toString());
}
