// Member onboarding service.
//
// Onboarding is a per-member checklist (OnboardingChecklistItem) created when
// a member is first approved. Each completion is audited so admins can see
// who walked the member through each step.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { assertTenantOwned } from "./tenant";
import { hasPermission, requirePermission, type Principal } from "../rbac";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";

// Canonical checklist for new members. Clubs can extend by configuring extra
// items per-member in Phase 3; for now we ship a sensible default.
export const DEFAULT_CHECKLIST: ReadonlyArray<{
  itemKey: string;
  title: string;
  description: string;
  required: boolean;
}> = [
  { itemKey: "WELCOME",         title: "Welcome message",       description: "Read the welcome note from the General Manager.", required: false },
  { itemKey: "TIMELINE",        title: "Club history timeline", description: "Walk through the club's history and milestones.", required: false },
  { itemKey: "ORIENTATION",     title: "Membership orientation", description: "Familiarize yourself with rules, etiquette, and amenities.", required: true },
  { itemKey: "PAYMENT_METHOD",  title: "Payment setup",          description: "Add a primary payment method to your account.", required: true },
  { itemKey: "PREFERENCES",     title: "Interests & preferences", description: "Tell us what you care about so we can tailor your hub.", required: true },
  { itemKey: "DASHBOARD",       title: "Dashboard tour",         description: "Set up the widgets that will live on your Member Hub.", required: false },
  { itemKey: "INCENTIVES",      title: "Joining incentives",     description: "Review any joining credits and how they apply to your account.", required: false },
  { itemKey: "COMPLETED",       title: "Welcome complete",       description: "Final step. Marks onboarding as complete.", required: true },
];

export async function ensureChecklistForMember(memberId: string): Promise<void> {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new NotFoundError("Member", memberId);
  const existing = await prisma.onboardingChecklistItem.findMany({ where: { memberId } });
  if (existing.length) return;
  await prisma.onboardingChecklistItem.createMany({
    data: DEFAULT_CHECKLIST.map((it, idx) => ({
      clubId: member.clubId,
      memberId,
      itemKey: it.itemKey,
      title: it.title,
      description: it.description,
      required: it.required,
      sortOrder: idx,
    })),
  });
}

export async function getChecklist(memberId: string) {
  return prisma.onboardingChecklistItem.findMany({
    where: { memberId },
    orderBy: { sortOrder: "asc" },
  });
}

// Marking an item complete is permissive: the member themselves, or any admin
// with members:write, may complete an item. The audit log records who did it.
export async function completeItem(principal: Principal, memberId: string, itemKey: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureCanProgressMember(principal, member);

  const item = await prisma.onboardingChecklistItem.findUnique({
    where: { memberId_itemKey: { memberId, itemKey } },
  });
  if (!item) throw new NotFoundError("OnboardingChecklistItem", itemKey);
  if (item.completedAt) return item;

  // COMPLETED is special: enforce the prerequisite invariant BEFORE writing
  // its completedAt, otherwise a rejected attempt would still mark the item
  // and break subsequent retries.
  if (itemKey === "COMPLETED") {
    const all = await prisma.onboardingChecklistItem.findMany({ where: { memberId } });
    const allOthersRequiredDone = all.every((i) => i.itemKey === "COMPLETED" || !i.required || i.completedAt);
    if (!allOthersRequiredDone) {
      throw new ValidationError(
        [{ path: "checklist", message: "Complete the required steps first." }],
        "Some required onboarding steps are not yet complete."
      );
    }
  }

  const updated = await prisma.onboardingChecklistItem.update({
    where: { id: item.id },
    data: { completedAt: new Date() },
  });

  if (itemKey === "COMPLETED") {
    await prisma.member.update({
      where: { id: memberId },
      data: { status: member.status === "ONBOARDING" ? "ACTIVE" : member.status, onboardingCompletedAt: new Date() },
    });
  }

  await audit(principal, {
    action: "onboarding.item.complete",
    entityType: "OnboardingChecklistItem",
    entityId: item.id,
    clubId: member.clubId,
    meta: { memberId, itemKey },
  });
  return updated;
}

function ensureCanProgressMember(principal: Principal, member: { id: string; clubId: string }) {
  if (hasPermission(principal, member.clubId, "members:write")) return;
  if (principal.memberId && principal.memberId === member.id) return;
  throw new ForbiddenError("Cannot progress this member's onboarding");
}

// --------------------------------------------------------------------------
// Incentive credits (joining incentive, referral credits, etc.)
// --------------------------------------------------------------------------
export const incentiveCreditSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  amount: z.number().positive(),
  appliedTo: z.enum(["AR_ACCOUNT", "FINANCING", "NONE_YET"]).default("NONE_YET"),
  expiresAt: z.string().optional().or(z.literal("")).transform((v) => v && v.length ? new Date(v) : null),
});

export async function grantIncentiveCredit(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "ar:adjust");
  const parsed = incentiveCreditSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const credit = await prisma.incentiveCredit.create({
    data: {
      clubId: member.clubId,
      memberId,
      reason: parsed.data.reason,
      amount: parsed.data.amount,
      appliedTo: parsed.data.appliedTo,
      expiresAt: parsed.data.expiresAt,
      status: "PENDING",
    },
  });
  await audit(principal, {
    action: "incentive.grant",
    entityType: "IncentiveCredit",
    entityId: credit.id,
    clubId: member.clubId,
    after: credit,
  });
  return credit;
}
