// Phase 12G — Compliance + access review.
//
// SOC 2 evidence-collection primitives:
//   - Periodic access reviews: gather all subjects of a given scope (users,
//     roles, API keys, installed apps, SSO providers) and let an admin
//     APPROVE or REVOKE each one.
//   - Compliance evidence generator: snapshots auditLog / authAttempt / etc.
//     over a time window into a ComplianceEvidence row that can be exported.
//   - Policy acknowledgement tracking.
//
// The decisions made here are *recorded* — actually revoking a subject is the
// caller's job (e.g. UI calls users:roles:write). This keeps the review
// service narrow and auditable.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, isSuperAdmin, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

export type AccessReviewScope = "USERS" | "ROLES" | "API_KEYS" | "INSTALLED_APPS" | "SSO_PROVIDERS";

// ---------------------------------------------------------------------------
// Snapshot the current state of a given scope into AccessReviewItem rows.
// ---------------------------------------------------------------------------
async function snapshotItems(
  tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  reviewId: string, clubId: string, scope: AccessReviewScope,
): Promise<number> {
  const t = tx as typeof prisma;
  if (scope === "USERS") {
    const users = await t.user.findMany({
      where: { OR: [{ clubId }, { clubRoles: { some: { clubId } } }] },
      include: { clubRoles: { where: { clubId } } },
    });
    if (users.length === 0) return 0;
    await t.accessReviewItem.createMany({
      data: users.map((u: typeof users[number]) => ({
        clubId, reviewId, subjectType: "USER", subjectId: u.id,
        subjectLabel: `${u.name} <${u.email}>`,
        currentJson: JSON.stringify({ status: u.status, mfa: u.mfaEnabled, roles: u.clubRoles.map((r) => r.roleKey) }),
      })),
    });
    return users.length;
  }
  if (scope === "ROLES") {
    const grants = await t.userClubRole.findMany({
      where: { clubId }, include: { user: true },
    });
    if (grants.length === 0) return 0;
    await t.accessReviewItem.createMany({
      data: grants.map((g) => ({
        clubId, reviewId, subjectType: "ROLE_GRANT", subjectId: g.id,
        subjectLabel: `${g.user.email} → ${g.roleKey}`,
        currentJson: JSON.stringify({ roleKey: g.roleKey, userId: g.userId }),
      })),
    });
    return grants.length;
  }
  if (scope === "API_KEYS") {
    const keys = await t.apiKey.findMany({ where: { clubId, status: "ACTIVE" } });
    if (keys.length === 0) return 0;
    await t.accessReviewItem.createMany({
      data: keys.map((k) => ({
        clubId, reviewId, subjectType: "API_KEY", subjectId: k.id,
        subjectLabel: `${k.name} (${k.keyPrefix}…)`,
        currentJson: JSON.stringify({ status: k.status, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt }),
      })),
    });
    return keys.length;
  }
  if (scope === "INSTALLED_APPS") {
    const installs = await t.installedApp.findMany({
      where: { clubId, status: "ACTIVE" },
      include: { app: true },
    });
    if (installs.length === 0) return 0;
    await t.accessReviewItem.createMany({
      data: installs.map((i) => ({
        clubId, reviewId, subjectType: "INSTALLED_APP", subjectId: i.id,
        subjectLabel: `${i.app.name} (${i.app.key})`,
        currentJson: JSON.stringify({ scopes: i.scopesJson, installedAt: i.installedAt }),
      })),
    });
    return installs.length;
  }
  if (scope === "SSO_PROVIDERS") {
    const providers = await t.ssoProvider.findMany({ where: { clubId, status: "ACTIVE" } });
    if (providers.length === 0) return 0;
    await t.accessReviewItem.createMany({
      data: providers.map((p) => ({
        clubId, reviewId, subjectType: "SSO_PROVIDER", subjectId: p.id,
        subjectLabel: `${p.name} (${p.kind})`,
        currentJson: JSON.stringify({ kind: p.kind, issuer: p.issuer, defaultRoleKey: p.defaultRoleKey }),
      })),
    });
    return providers.length;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Access reviews
// ---------------------------------------------------------------------------
export const startReviewSchema = z.object({
  clubId: z.string(),
  scope: z.enum(["USERS", "ROLES", "API_KEYS", "INSTALLED_APPS", "SSO_PROVIDERS"]),
  title: z.string().min(1).max(200),
  dueDate: z.string().datetime().optional(),
});

export async function startReview(principal: Principal, raw: unknown) {
  const parsed = startReviewSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  requirePermission(principal, parsed.data.clubId, "users:roles:write");
  const review = await prisma.$transaction(async (tx) => {
    const r = await tx.accessReview.create({
      data: {
        clubId: parsed.data.clubId, scope: parsed.data.scope, title: parsed.data.title,
        status: "IN_PROGRESS", startedAt: new Date(),
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        createdByUserId: principal.id,
      },
    });
    const itemCount = await snapshotItems(tx as typeof prisma, r.id, parsed.data.clubId, parsed.data.scope);
    return { ...r, itemCount };
  });
  await audit(principal, { action: "compliance.review.start", entityType: "AccessReview", entityId: review.id, clubId: parsed.data.clubId, after: { scope: parsed.data.scope, itemCount: review.itemCount } });
  return review;
}

export const decideItemSchema = z.object({
  itemId: z.string(),
  decision: z.enum(["APPROVED", "REVOKED"]),
  notes: z.string().max(2000).optional(),
});

export async function decideReviewItem(principal: Principal, raw: unknown) {
  const parsed = decideItemSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const item = await prisma.accessReviewItem.findUnique({ where: { id: parsed.data.itemId }, include: { review: true } });
  if (!item) throw new NotFoundError("AccessReviewItem", parsed.data.itemId);
  requirePermission(principal, item.clubId, "users:roles:write");
  if (item.review.createdByUserId && item.review.createdByUserId === principal.id) {
    // Segregation of duties: whoever started the review cannot also decide
    // individual items. (Super-admin escape hatch for the platform owner.)
    if (!isSuperAdmin(principal)) {
      throw new ConflictError("Reviewer cannot decide on items in a review they started");
    }
  }
  const updated = await prisma.accessReviewItem.update({
    where: { id: item.id },
    data: { decision: parsed.data.decision, decidedAt: new Date(), decidedByUserId: principal.id, notes: parsed.data.notes ?? null },
  });
  await audit(principal, { action: "compliance.review.decide", entityType: "AccessReviewItem", entityId: item.id, clubId: item.clubId, after: { decision: parsed.data.decision, subjectType: item.subjectType, subjectId: item.subjectId } });
  return updated;
}

export async function completeReview(principal: Principal, reviewId: string) {
  const review = await prisma.accessReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new NotFoundError("AccessReview", reviewId);
  requirePermission(principal, review.clubId, "users:roles:write");
  const pending = await prisma.accessReviewItem.count({ where: { reviewId, decision: "PENDING" } });
  if (pending > 0) throw new ConflictError(`Cannot complete review with ${pending} pending items`);
  const updated = await prisma.accessReview.update({
    where: { id: review.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  await audit(principal, { action: "compliance.review.complete", entityType: "AccessReview", entityId: review.id, clubId: review.clubId });
  return updated;
}

export async function listReviews(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "users:roles:write");
  return prisma.accessReview.findMany({
    where: { clubId },
    include: { _count: { select: { items: true } } },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
}

export async function reviewDetail(principal: Principal, reviewId: string) {
  const review = await prisma.accessReview.findUnique({
    where: { id: reviewId },
    include: { items: { orderBy: { subjectLabel: "asc" } } },
  });
  if (!review) throw new NotFoundError("AccessReview", reviewId);
  requirePermission(principal, review.clubId, "users:roles:write");
  return review;
}

// ---------------------------------------------------------------------------
// Compliance evidence — point-in-time snapshots.
// ---------------------------------------------------------------------------
export const evidenceSchema = z.object({
  clubId: z.string(),
  kind: z.enum(["AUDIT_LOG", "AUTH_ATTEMPT", "ACCESS_REVIEW", "WEBHOOK_DELIVERY", "EXPORT"]),
  label: z.string().min(1).max(200),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

export async function generateEvidence(principal: Principal, raw: unknown) {
  const parsed = evidenceSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  requirePermission(principal, parsed.data.clubId, "system:audit:read");
  const start = new Date(parsed.data.periodStart);
  const end = new Date(parsed.data.periodEnd);
  if (end.getTime() <= start.getTime()) throw new ValidationError([{ path: "periodEnd", message: "must be after periodStart" }]);
  let rowCount = 0;
  if (parsed.data.kind === "AUDIT_LOG") {
    rowCount = await prisma.auditLog.count({ where: { clubId: parsed.data.clubId, createdAt: { gte: start, lte: end } } });
  } else if (parsed.data.kind === "AUTH_ATTEMPT") {
    rowCount = await prisma.authAttempt.count({ where: { clubId: parsed.data.clubId, occurredAt: { gte: start, lte: end } } });
  } else if (parsed.data.kind === "ACCESS_REVIEW") {
    rowCount = await prisma.accessReview.count({ where: { clubId: parsed.data.clubId, completedAt: { gte: start, lte: end } } });
  } else if (parsed.data.kind === "WEBHOOK_DELIVERY") {
    rowCount = await prisma.webhookDelivery.count({ where: { clubId: parsed.data.clubId, createdAt: { gte: start, lte: end } } });
  } else if (parsed.data.kind === "EXPORT") {
    // Generic placeholder; caller wires the actual extraction.
    rowCount = 0;
  }
  const evidence = await prisma.complianceEvidence.create({
    data: {
      clubId: parsed.data.clubId, kind: parsed.data.kind, label: parsed.data.label,
      periodStart: start, periodEnd: end, rowCount,
      status: "GENERATED", generatedByUserId: principal.id,
    },
  });
  await audit(principal, { action: "compliance.evidence.generate", entityType: "ComplianceEvidence", entityId: evidence.id, clubId: parsed.data.clubId, after: { kind: parsed.data.kind, rowCount } });
  return evidence;
}

export async function listEvidence(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "system:audit:read");
  return prisma.complianceEvidence.findMany({
    where: { clubId },
    orderBy: { generatedAt: "desc" },
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Policy acknowledgements (e.g. acceptable-use, data-handling policies).
// ---------------------------------------------------------------------------
export const requestAckSchema = z.object({
  clubId: z.string(),
  userId: z.string(),
  policyKey: z.string().min(1).max(120),
  policyVersion: z.string().min(1).max(40),
});

export async function requestPolicyAck(principal: Principal, raw: unknown) {
  const parsed = requestAckSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  requirePermission(principal, parsed.data.clubId, "users:roles:write");
  const upserted = await prisma.policyAcknowledgement.upsert({
    where: { userId_policyKey_policyVersion: { userId: parsed.data.userId, policyKey: parsed.data.policyKey, policyVersion: parsed.data.policyVersion } },
    update: {},
    create: {
      clubId: parsed.data.clubId, userId: parsed.data.userId,
      policyKey: parsed.data.policyKey, policyVersion: parsed.data.policyVersion,
      status: "PENDING",
    },
  });
  return upserted;
}

export async function acknowledgePolicy(principal: Principal, args: { policyKey: string; policyVersion: string; ip?: string; userAgent?: string }) {
  // Users acknowledge their own policies — no extra permission gate.
  const ack = await prisma.policyAcknowledgement.findUnique({
    where: { userId_policyKey_policyVersion: { userId: principal.id, policyKey: args.policyKey, policyVersion: args.policyVersion } },
  });
  if (!ack) throw new NotFoundError("PolicyAcknowledgement", `${args.policyKey}@${args.policyVersion}`);
  return prisma.policyAcknowledgement.update({
    where: { id: ack.id },
    data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), ip: args.ip ?? null, userAgent: args.userAgent ?? null },
  });
}

export async function listPendingAcks(principal: Principal, userId: string) {
  if (principal.id !== userId && !isSuperAdmin(principal)) {
    throw new ConflictError("Cannot list other users' pending acknowledgements");
  }
  return prisma.policyAcknowledgement.findMany({
    where: { userId, status: "PENDING" },
    orderBy: { policyKey: "asc" },
  });
}
