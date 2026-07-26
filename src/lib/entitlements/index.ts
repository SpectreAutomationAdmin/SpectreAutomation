// Phase 10I — Commercial SaaS entitlements.
//
// `requireEntitlement(clubId, featureKey)` is the single feature-gate.
// - PILOT clubs (no `ClubSubscription` row, or status=PILOT) get everything.
// - Active subscriptions check `featuresJson` on the plan.
// - Paused/cancelled subscriptions reject all entitlement checks.
//
// Usage metering is a side effect of the request path — `recordUsage()` is
// called by service layer hooks (API requests, exports, push deliveries,
// webhook deliveries) without changing call sites' return values.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ForbiddenError, ValidationError } from "../errors";

export type EntitlementKey =
  | "tournament" | "push" | "external_api" | "webhooks"
  | "ai_commentary" | "hardware" | "advanced_reports"
  | "multi_club" | "white_label";

// ---------------------------------------------------------------------------
// Plan management
// ---------------------------------------------------------------------------
export const planSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(160),
  tier: z.enum(["PILOT", "STARTER", "PROFESSIONAL", "ENTERPRISE", "UNLIMITED"]),
  description: z.string().trim().max(2000).optional().nullable(),
  monthlyPrice: z.number().nonnegative().default(0),
  annualPrice: z.number().nonnegative().default(0),
  features: z.array(z.string()).default([]),
  seatLimit: z.number().int().positive().optional().nullable(),
  storageGb: z.number().int().positive().optional().nullable(),
  apiCallsPerMonth: z.number().int().positive().optional().nullable(),
});

export async function upsertPlan(principal: Principal, raw: unknown) {
  // Only SUPER_ADMIN can mutate plan catalog.
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) throw new ForbiddenError("Only SUPER_ADMIN can manage subscription plans");
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  return prisma.subscriptionPlan.upsert({
    where: { key: d.key },
    update: {
      name: d.name, tier: d.tier, description: d.description ?? null,
      monthlyPrice: d.monthlyPrice, annualPrice: d.annualPrice,
      featuresJson: JSON.stringify(d.features),
      seatLimit: d.seatLimit ?? null, storageGb: d.storageGb ?? null, apiCallsPerMonth: d.apiCallsPerMonth ?? null,
    },
    create: {
      key: d.key, name: d.name, tier: d.tier, description: d.description ?? null,
      monthlyPrice: d.monthlyPrice, annualPrice: d.annualPrice,
      featuresJson: JSON.stringify(d.features),
      seatLimit: d.seatLimit ?? null, storageGb: d.storageGb ?? null, apiCallsPerMonth: d.apiCallsPerMonth ?? null,
    },
  });
}

export async function listPlans() {
  return prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: { tier: "asc" } });
}

// ---------------------------------------------------------------------------
// Club subscription
// ---------------------------------------------------------------------------
export async function assignPlan(principal: Principal, clubId: string, args: { planKey: string; status?: "PILOT" | "ACTIVE" | "TRIAL" | "PAUSED" | "CANCELLED"; seatCount?: number; trialDays?: number }) {
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) requirePermission(principal, clubId, "settings:write");
  const plan = await prisma.subscriptionPlan.findUnique({ where: { key: args.planKey } });
  if (!plan) throw new ValidationError([{ path: "planKey", message: "Unknown plan" }]);
  const trialEndsAt = args.trialDays ? new Date(Date.now() + args.trialDays * 86400000) : null;
  const sub = await prisma.clubSubscription.upsert({
    where: { clubId },
    update: { planId: plan.id, status: args.status ?? "ACTIVE", seatCount: args.seatCount ?? 0, trialEndsAt, activatedAt: new Date() },
    create: { clubId, planId: plan.id, status: args.status ?? "ACTIVE", seatCount: args.seatCount ?? 0, trialEndsAt, activatedAt: new Date() },
  });
  await audit(principal, { action: "subscription.assign", entityType: "ClubSubscription", entityId: sub.id, clubId, after: { plan: args.planKey, status: sub.status } });
  return sub;
}

export async function suspendClub(principal: Principal, clubId: string, reason: string) {
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) throw new ForbiddenError("Only SUPER_ADMIN can suspend a club");
  const sub = await prisma.clubSubscription.findUnique({ where: { clubId } });
  if (!sub) throw new ValidationError([{ path: "clubId", message: "No subscription" }]);
  const updated = await prisma.clubSubscription.update({ where: { clubId }, data: { status: "PAUSED", cancelReason: reason } });
  await audit(principal, { action: "subscription.suspend", entityType: "ClubSubscription", entityId: sub.id, clubId, after: { reason } });
  return updated;
}

export async function reactivateClub(principal: Principal, clubId: string) {
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) throw new ForbiddenError("Only SUPER_ADMIN can reactivate a club");
  const sub = await prisma.clubSubscription.findUnique({ where: { clubId } });
  if (!sub) throw new ValidationError([{ path: "clubId", message: "No subscription" }]);
  return prisma.clubSubscription.update({ where: { clubId }, data: { status: "ACTIVE", cancelReason: null } });
}

// ---------------------------------------------------------------------------
// Entitlement check
// ---------------------------------------------------------------------------
export async function hasEntitlement(clubId: string, feature: EntitlementKey): Promise<boolean> {
  const sub = await prisma.clubSubscription.findUnique({ where: { clubId }, include: { plan: true } });
  // PILOT default: no subscription = unlimited pilot access.
  if (!sub) return true;
  if (sub.status === "PILOT") return true;
  if (sub.status === "PAUSED" || sub.status === "CANCELLED") return false;
  if (!sub.plan) return false;
  try {
    const features = JSON.parse(sub.plan.featuresJson) as string[];
    return features.includes(feature) || features.includes("*");
  } catch { return false; }
}

export async function requireEntitlement(clubId: string, feature: EntitlementKey): Promise<void> {
  const ok = await hasEntitlement(clubId, feature);
  if (!ok) throw new ForbiddenError(`Feature ${feature} is not included in your plan`);
}

// ---------------------------------------------------------------------------
// Usage metering
// ---------------------------------------------------------------------------
export type UsageKind = "API_CALLS" | "STORAGE_GB" | "PUSH_DELIVERIES" | "EXPORTS_GENERATED" | "WEBHOOK_DELIVERIES";

export async function recordUsage(clubId: string, kind: UsageKind, increment = 1) {
  const periodLabel = new Date().toISOString().slice(0, 7); // YYYY-MM
  await prisma.usageMetric.upsert({
    where: { clubId_periodLabel_kind: { clubId, periodLabel, kind } },
    update: { value: { increment } },
    create: { clubId, periodLabel, kind, value: increment },
  });
}

export async function summarizeUsage(clubId: string, periodLabel?: string) {
  const label = periodLabel ?? new Date().toISOString().slice(0, 7);
  return prisma.usageMetric.findMany({ where: { clubId, periodLabel: label } });
}

// ---------------------------------------------------------------------------
// Default plan catalog — seeded once on first run.
// ---------------------------------------------------------------------------
export const DEFAULT_PLANS = [
  { key: "pilot", name: "Pilot", tier: "PILOT", monthlyPrice: 0, features: ["*"] },
  { key: "starter", name: "Starter", tier: "STARTER", monthlyPrice: 499, features: ["tournament", "push"] },
  { key: "professional", name: "Professional", tier: "PROFESSIONAL", monthlyPrice: 1499, features: ["tournament", "push", "external_api", "webhooks", "advanced_reports"] },
  { key: "enterprise", name: "Enterprise", tier: "ENTERPRISE", monthlyPrice: 3999, features: ["tournament", "push", "external_api", "webhooks", "advanced_reports", "ai_commentary", "hardware", "multi_club"] },
  { key: "unlimited", name: "Unlimited", tier: "UNLIMITED", monthlyPrice: 0, features: ["*"] },
] as const;

export async function ensureDefaultPlans() {
  for (const p of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { key: p.key },
      update: { name: p.name, tier: p.tier, monthlyPrice: p.monthlyPrice, featuresJson: JSON.stringify(p.features), isActive: true },
      create: { key: p.key, name: p.name, tier: p.tier, monthlyPrice: p.monthlyPrice, featuresJson: JSON.stringify(p.features) },
    });
  }
}
