// Phase 13F — Safe support access / impersonation.
//
// Spectre staff need to reach into a club's data to debug, but they cannot
// silently impersonate. The flow:
//
//   1. requestAccess()      — Spectre staff requests access with a reason +
//                             mode (READ_ONLY / ELEVATED) and a ttl.
//   2. approveAccess()      — A club admin OR an out-of-band approver (super
//                             admin in self-service emergencies) approves.
//   3. startSession()       — Opens a SupportSession; this is what the auth
//                             layer / UI badge keys off.
//   4. assertAllowedAction()— Called at the boundary of any write. In
//                             READ_ONLY mode it throws SupportReadOnlyError
//                             and records a SupportActionLog with allowed=false.
//   5. endSession()         — Closes the session; subsequent calls fail
//                             tenant-access checks again.
//
// All transitions are audited. Active sessions are surfaced in the admin UI
// banner so the club always knows when Spectre is in their tenant.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

const DEFAULT_TTL_MIN = 60;
const MAX_TTL_MIN = 8 * 60; // 8h

function requireSuperAdmin(principal: Principal) {
  if (!isSuperAdmin(principal)) throw new ForbiddenError("Support access tooling is SUPER_ADMIN only");
}

// ---------------------------------------------------------------------------
// Request access
// ---------------------------------------------------------------------------
export const requestSchema = z.object({
  clubId: z.string(),
  mode: z.enum(["READ_ONLY", "ELEVATED"]).default("READ_ONLY"),
  reason: z.string().min(10).max(1000),
  ttlMinutes: z.number().int().min(5).max(MAX_TTL_MIN).optional(),
});

export async function requestAccess(principal: Principal, raw: unknown) {
  requireSuperAdmin(principal);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const ttl = (parsed.data.ttlMinutes ?? DEFAULT_TTL_MIN) * 60_000;
  const grant = await prisma.supportAccessGrant.create({
    data: {
      clubId: parsed.data.clubId,
      supportUserId: principal.id,
      requestedByUserId: principal.id,
      reason: parsed.data.reason,
      mode: parsed.data.mode,
      status: "REQUESTED",
      expiresAt: new Date(Date.now() + ttl),
    },
  });
  await audit(principal, { action: "support.access.request", entityType: "SupportAccessGrant", entityId: grant.id, clubId: parsed.data.clubId, after: { mode: grant.mode, reason: parsed.data.reason } });
  return grant;
}

// ---------------------------------------------------------------------------
// Approve / reject (club admin OR super-admin self-approval for break-glass)
// ---------------------------------------------------------------------------
export async function approveAccess(principal: Principal, grantId: string) {
  const grant = await prisma.supportAccessGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw new NotFoundError("SupportAccessGrant", grantId);
  if (grant.status !== "REQUESTED") throw new ConflictError(`Grant is ${grant.status}`);
  // Either a club admin at the target club, or SUPER_ADMIN.
  const ok = isSuperAdmin(principal) || principal.memberships.some((m) => m.clubId === grant.clubId && ["CLUB_ADMIN", "GENERAL_MANAGER"].includes(m.roleKey));
  if (!ok) throw new ForbiddenError("Only the target club's admin or SUPER_ADMIN can approve");
  const updated = await prisma.supportAccessGrant.update({
    where: { id: grant.id },
    data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: principal.id },
  });
  await audit(principal, { action: "support.access.approve", entityType: "SupportAccessGrant", entityId: grant.id, clubId: grant.clubId, after: { approver: principal.id } });
  return updated;
}

export async function rejectAccess(principal: Principal, grantId: string, reason?: string) {
  const grant = await prisma.supportAccessGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw new NotFoundError("SupportAccessGrant", grantId);
  if (grant.status !== "REQUESTED") throw new ConflictError(`Grant is ${grant.status}`);
  const ok = isSuperAdmin(principal) || principal.memberships.some((m) => m.clubId === grant.clubId && ["CLUB_ADMIN", "GENERAL_MANAGER"].includes(m.roleKey));
  if (!ok) throw new ForbiddenError("Only the target club's admin or SUPER_ADMIN can reject");
  const updated = await prisma.supportAccessGrant.update({
    where: { id: grant.id }, data: { status: "REJECTED" },
  });
  await audit(principal, { action: "support.access.reject", entityType: "SupportAccessGrant", entityId: grant.id, clubId: grant.clubId, after: { reason } });
  return updated;
}

// ---------------------------------------------------------------------------
// Start / end session
// ---------------------------------------------------------------------------
export async function startSession(principal: Principal, args: { grantId: string; ip?: string; userAgent?: string }) {
  requireSuperAdmin(principal);
  const grant = await prisma.supportAccessGrant.findUnique({ where: { id: args.grantId } });
  if (!grant) throw new NotFoundError("SupportAccessGrant", args.grantId);
  if (grant.status !== "APPROVED") throw new ConflictError(`Cannot start session for grant in ${grant.status}`);
  if (grant.expiresAt.getTime() < Date.now()) {
    await prisma.supportAccessGrant.update({ where: { id: grant.id }, data: { status: "EXPIRED" } });
    throw new ConflictError("Grant has expired");
  }
  if (grant.supportUserId !== principal.id) throw new ForbiddenError("Grant belongs to another support user");
  const session = await prisma.supportSession.create({
    data: {
      clubId: grant.clubId, grantId: grant.id,
      supportUserId: principal.id, mode: grant.mode,
      ip: args.ip ?? null, userAgent: args.userAgent ?? null,
    },
  });
  await audit(principal, { action: "support.session.start", entityType: "SupportSession", entityId: session.id, clubId: grant.clubId, after: { mode: grant.mode } });
  return session;
}

export async function endSession(principal: Principal, sessionId: string) {
  const s = await prisma.supportSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new NotFoundError("SupportSession", sessionId);
  if (s.supportUserId !== principal.id && !isSuperAdmin(principal)) {
    throw new ForbiddenError("Cannot end another support user's session");
  }
  if (s.endedAt) return s;
  const updated = await prisma.supportSession.update({
    where: { id: s.id }, data: { endedAt: new Date() },
  });
  await audit(principal, { action: "support.session.end", entityType: "SupportSession", entityId: s.id, clubId: s.clubId });
  return updated;
}

// ---------------------------------------------------------------------------
// Action gate
// ---------------------------------------------------------------------------
export class SupportReadOnlyError extends Error {
  constructor(action: string) {
    super(`Action ${action} is blocked while support session is READ_ONLY`);
    this.name = "SupportReadOnlyError";
  }
}

export async function getActiveSession(supportUserId: string, clubId: string) {
  return prisma.supportSession.findFirst({
    where: { supportUserId, clubId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
}

const WRITE_INDICATORS = ["create", "update", "delete", "post", "approve", "void", "issue", "send"];

export async function assertAllowedAction(args: {
  supportUserId: string; clubId: string;
  action: string; entityType?: string; entityId?: string;
}) {
  const session = await getActiveSession(args.supportUserId, args.clubId);
  if (!session) return; // Not in a support session, normal RBAC applies.
  const isWrite = WRITE_INDICATORS.some((w) => args.action.toLowerCase().includes(w));
  const allowed = !isWrite || session.mode === "ELEVATED";
  await prisma.supportActionLog.create({
    data: {
      clubId: args.clubId, sessionId: session.id, action: args.action,
      entityType: args.entityType ?? null, entityId: args.entityId ?? null,
      allowed, reason: !allowed ? "READ_ONLY support session" : null,
    },
  });
  if (!allowed) throw new SupportReadOnlyError(args.action);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------
export async function listGrants(principal: Principal, clubId?: string) {
  // SUPER_ADMIN sees everything; club admins see their own grants.
  const where: { clubId?: string } = {};
  if (clubId) {
    const ok = isSuperAdmin(principal) || principal.memberships.some((m) => m.clubId === clubId);
    if (!ok) throw new ForbiddenError("Cannot read another club's support grants");
    where.clubId = clubId;
  } else if (!isSuperAdmin(principal)) {
    throw new ForbiddenError("Cross-club grant list is SUPER_ADMIN only");
  }
  return prisma.supportAccessGrant.findMany({
    where,
    orderBy: { requestedAt: "desc" },
    take: 100,
  });
}

export async function listActiveSessions(principal: Principal) {
  requireSuperAdmin(principal);
  return prisma.supportSession.findMany({
    where: { endedAt: null },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
}

export async function sessionActionLog(principal: Principal, sessionId: string) {
  const session = await prisma.supportSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError("SupportSession", sessionId);
  const ok = isSuperAdmin(principal) || principal.memberships.some((m) => m.clubId === session.clubId);
  if (!ok) throw new ForbiddenError("Cannot read another club's support session log");
  return prisma.supportActionLog.findMany({
    where: { sessionId },
    orderBy: { occurredAt: "desc" },
    take: 500,
  });
}
