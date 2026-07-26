// Phase 6C — Auditor mode.
//
// External auditors get a time-limited, scoped, read-only access grant.
// A unique invite token lets them accept the grant and start sessions.
// Every viewed report / exported bundle is logged as an audit-side trail.

import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

export const grantSchema = z.object({
  auditorName: z.string().trim().min(1).max(160),
  auditorEmail: z.string().email().max(254),
  firmName: z.string().trim().max(200).optional().nullable(),
  fiscalYearId: z.string().optional().nullable(),
  scope: z.array(z.string()).default([
    "members:read", "ar:read", "ap:read", "gl:read", "coa:read",
    "vendor:view", "ap:invoice:view", "ap:report:view",
    "reports:read", "reports:financial", "reports:export",
    "documents:read", "system:audit:read", "auditor:respond",
  ]),
  expiresInDays: z.number().int().min(1).max(365).default(60),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export async function inviteAuditor(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "auditor:invite");
  const parsed = grantSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const inviteToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + d.expiresInDays * 86400000);
  const grant = await prisma.auditorAccessGrant.create({
    data: {
      clubId,
      auditorName: d.auditorName,
      auditorEmail: d.auditorEmail,
      firmName: d.firmName ?? null,
      invitedByUserId: principal.id,
      scopeJson: JSON.stringify(d.scope),
      fiscalYearId: d.fiscalYearId ?? null,
      startsAt: new Date(),
      expiresAt,
      inviteToken,
      status: "PENDING",
      notes: d.notes ?? null,
    },
  });
  await audit(principal, { action: "auditor.invite", entityType: "AuditorAccessGrant", entityId: grant.id, clubId, after: { auditorEmail: d.auditorEmail, expiresAt: expiresAt.toISOString() } });
  return grant;
}

export async function acceptAuditorInvite(token: string) {
  const grant = await prisma.auditorAccessGrant.findUnique({ where: { inviteToken: token } });
  if (!grant) throw new NotFoundError("AuditorAccessGrant", token);
  if (grant.status === "REVOKED") throw new ConflictError("Invite has been revoked");
  if (grant.expiresAt < new Date()) {
    await prisma.auditorAccessGrant.update({ where: { id: grant.id }, data: { status: "EXPIRED" } });
    throw new ConflictError("Invite has expired");
  }
  const updated = await prisma.auditorAccessGrant.update({
    where: { id: grant.id },
    data: { status: "ACTIVE", acceptedAt: new Date() },
  });
  return updated;
}

export async function revokeAuditorGrant(principal: Principal, grantId: string, reason?: string) {
  const grant = await prisma.auditorAccessGrant.findUnique({ where: { id: grantId } });
  assertTenantOwned(grant, principal);
  requirePermission(principal, grant.clubId, "auditor:revoke");
  if (grant.status === "REVOKED") return grant;
  const updated = await prisma.auditorAccessGrant.update({
    where: { id: grantId },
    data: { status: "REVOKED", revokedAt: new Date(), revokedByUserId: principal.id, notes: reason ?? grant.notes },
  });
  await audit(principal, { action: "auditor.revoke", entityType: "AuditorAccessGrant", entityId: grantId, clubId: grant.clubId, after: { status: "REVOKED", reason } });
  return updated;
}

export async function startAuditorSession(grantId: string, ip: string | null, userAgent: string | null) {
  const grant = await prisma.auditorAccessGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw new NotFoundError("AuditorAccessGrant", grantId);
  if (grant.status !== "ACTIVE") throw new ConflictError(`Grant status is ${grant.status}`);
  if (grant.expiresAt < new Date()) throw new ConflictError("Grant has expired");
  return prisma.auditorSession.create({
    data: {
      clubId: grant.clubId,
      grantId, ip: ip ?? null, userAgent: userAgent ?? null,
      startedAt: new Date(),
    },
  });
}

export async function recordAuditorActivity(sessionId: string) {
  await prisma.auditorSession.update({
    where: { id: sessionId },
    data: { activityCount: { increment: 1 } },
  });
}

export async function endAuditorSession(sessionId: string) {
  await prisma.auditorSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date() },
  });
}

// PBC (provided by client) request workflow.
export const requestSchema = z.object({
  grantId: z.string().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  dueDate: z.string().or(z.date()).optional().nullable(),
  assignedToUserId: z.string().optional().nullable(),
  items: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    entityType: z.string().optional().nullable(),
    entityId: z.string().optional().nullable(),
  })).default([]),
});

export async function createAuditRequest(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "auditor:respond");
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const request = await prisma.auditRequest.create({
    data: {
      clubId,
      grantId: d.grantId ?? null,
      title: d.title,
      description: d.description ?? null,
      dueDate: d.dueDate ? new Date(d.dueDate) : null,
      assignedToUserId: d.assignedToUserId ?? null,
      requestedByUserId: principal.id,
      status: "OPEN",
    },
  });
  for (const item of d.items) {
    await prisma.auditRequestItem.create({
      data: { clubId, requestId: request.id, label: item.label, description: item.description ?? null, entityType: item.entityType ?? null, entityId: item.entityId ?? null, status: "PENDING" },
    });
  }
  await audit(principal, { action: "audit_request.create", entityType: "AuditRequest", entityId: request.id, clubId, after: { title: d.title, items: d.items.length } });
  return request;
}

export async function fulfillRequestItem(principal: Principal, itemId: string, documentId?: string) {
  const item = await prisma.auditRequestItem.findUnique({ where: { id: itemId } });
  assertTenantOwned(item, principal);
  requirePermission(principal, item.clubId, "auditor:respond");
  const updated = await prisma.auditRequestItem.update({
    where: { id: itemId },
    data: { status: "PROVIDED", documentId: documentId ?? null, providedAt: new Date(), providedByUserId: principal.id },
  });
  await audit(principal, { action: "audit_request.item.fulfill", entityType: "AuditRequestItem", entityId: itemId, clubId: item.clubId, after: { documentId } });
  return updated;
}

export async function listGrants(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "auditor:invite");
  return prisma.auditorAccessGrant.findMany({
    where: tenantWhere(principal, clubId),
    orderBy: { createdAt: "desc" },
    include: { sessions: { take: 1, orderBy: { startedAt: "desc" } } },
  });
}

export async function listAuditRequests(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "auditor:respond");
  return prisma.auditRequest.findMany({
    where: tenantWhere(principal, clubId),
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
