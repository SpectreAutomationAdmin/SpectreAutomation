// Phase 14F — Pilot retrospective rollup.
//
// Three retrospectives are planned per pilot (GO_LIVE_DAY, WEEK_1, MONTH_1),
// each with categorized items, prioritized action follow-ups, and a metric
// snapshot for before/after comparison.
//
// `captureMetricSnapshot()` is the single rollup that goes into a
// PilotMetricSnapshot row — open tickets, resolved tickets, failed jobs,
// invite activation rate, import error rate, AP/AR pace, smoke results.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, isSuperAdmin, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

function ensureAccess(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  // Implementation staff + finance leadership need to see retros.
  if (principal.memberships.some((m) => m.clubId === clubId)) return;
  throw new ForbiddenError("Cross-club retrospective access is SUPER_ADMIN only");
}

function ensureWrite(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "settings:write");
}

// ---------------------------------------------------------------------------
// Retrospectives
// ---------------------------------------------------------------------------
export const createSchema = z.object({
  clubId: z.string(),
  projectId: z.string().optional(),
  timing: z.enum(["GO_LIVE_DAY", "WEEK_1", "MONTH_1", "CUSTOM"]),
  title: z.string().min(1).max(200),
});

export async function createRetrospective(principal: Principal, raw: unknown) {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureWrite(principal, parsed.data.clubId);
  const retro = await prisma.pilotRetrospective.create({
    data: {
      clubId: parsed.data.clubId,
      projectId: parsed.data.projectId ?? null,
      timing: parsed.data.timing,
      title: parsed.data.title,
      status: "OPEN",
      conductedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "pilot.retrospective.create",
    entityType: "PilotRetrospective",
    entityId: retro.id,
    clubId: parsed.data.clubId,
    after: { timing: retro.timing },
  });
  return retro;
}

export const itemSchema = z.object({
  retrospectiveId: z.string(),
  category: z.enum(["ISSUE", "FEATURE_REQUEST", "WORKFLOW_FRICTION", "ACCOUNTING_ISSUE", "TRAINING_GAP", "MEMBER_FEEDBACK", "OTHER"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  linkedIncidentId: z.string().optional(),
  linkedTicketId: z.string().optional(),
});

export async function addItem(principal: Principal, raw: unknown) {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const retro = await prisma.pilotRetrospective.findUnique({ where: { id: parsed.data.retrospectiveId } });
  if (!retro) throw new NotFoundError("PilotRetrospective", parsed.data.retrospectiveId);
  ensureWrite(principal, retro.clubId);
  if (retro.status === "CLOSED") throw new ConflictError("Retrospective is CLOSED");
  return prisma.retrospectiveItem.create({
    data: {
      clubId: retro.clubId,
      retrospectiveId: retro.id,
      category: parsed.data.category,
      severity: parsed.data.severity,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      linkedIncidentId: parsed.data.linkedIncidentId ?? null,
      linkedTicketId: parsed.data.linkedTicketId ?? null,
    },
  });
}

export const actionSchema = z.object({
  retrospectiveId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  ownerUserId: z.string().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  dueDate: z.string().datetime().optional(),
});

export async function addAction(principal: Principal, raw: unknown) {
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const retro = await prisma.pilotRetrospective.findUnique({ where: { id: parsed.data.retrospectiveId } });
  if (!retro) throw new NotFoundError("PilotRetrospective", parsed.data.retrospectiveId);
  ensureWrite(principal, retro.clubId);
  return prisma.retrospectiveAction.create({
    data: {
      clubId: retro.clubId,
      retrospectiveId: retro.id,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      ownerUserId: parsed.data.ownerUserId ?? null,
      priority: parsed.data.priority,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    },
  });
}

export async function setActionStatus(principal: Principal, args: { actionId: string; status: "OPEN" | "IN_PROGRESS" | "DONE" | "DROPPED" }) {
  const action = await prisma.retrospectiveAction.findUnique({ where: { id: args.actionId } });
  if (!action) throw new NotFoundError("RetrospectiveAction", args.actionId);
  ensureWrite(principal, action.clubId);
  return prisma.retrospectiveAction.update({
    where: { id: action.id },
    data: { status: args.status, completedAt: args.status === "DONE" ? new Date() : null },
  });
}

export async function closeRetrospective(principal: Principal, retrospectiveId: string) {
  const retro = await prisma.pilotRetrospective.findUnique({ where: { id: retrospectiveId } });
  if (!retro) throw new NotFoundError("PilotRetrospective", retrospectiveId);
  ensureWrite(principal, retro.clubId);
  const openActions = await prisma.retrospectiveAction.count({
    where: { retrospectiveId, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });
  if (openActions > 0) throw new ConflictError(`Cannot close — ${openActions} action(s) still open`);
  return prisma.pilotRetrospective.update({
    where: { id: retro.id }, data: { status: "CLOSED" },
  });
}

// ---------------------------------------------------------------------------
// Metric snapshot — single rollup of pilot health indicators.
// ---------------------------------------------------------------------------
export async function captureMetricSnapshot(principal: Principal, args: { clubId: string; label: string; notes?: string }) {
  ensureWrite(principal, args.clubId);
  const since7 = new Date(Date.now() - 7 * 86400_000);
  const [
    openTickets, resolvedTickets, openIncidents, failedJobs,
    inviteSent, inviteActivated,
    importBatches, importErrorRows,
    memberLogins7d, apApprovedLast7d, arPostedLast7d,
  ] = await Promise.all([
    prisma.supportTicket.count({ where: { clubId: args.clubId, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    prisma.supportTicket.count({ where: { clubId: args.clubId, status: "RESOLVED" } }),
    prisma.incident.count({ where: { clubId: args.clubId, status: { in: ["OPEN", "TRIAGING", "IN_PROGRESS"] } } }),
    prisma.jobFailure.count({ where: { occurredAt: { gte: since7 } } }),
    prisma.memberPortalInvite.count({ where: { clubId: args.clubId, status: { in: ["SENT", "OPENED", "ACTIVATED"] } } }),
    prisma.memberPortalInvite.count({ where: { clubId: args.clubId, status: "ACTIVATED" } }),
    prisma.importBatch.count({ where: { clubId: args.clubId } }),
    prisma.importError.count({ where: { clubId: args.clubId } }),
    prisma.authAttempt.count({ where: { clubId: args.clubId, outcome: "SUCCESS", occurredAt: { gte: since7 } } }),
    prisma.aPInvoice.count({ where: { clubId: args.clubId, status: "POSTED", postedAt: { gte: since7 } } }),
    prisma.charge.count({ where: { clubId: args.clubId, status: "POSTED", transactionDate: { gte: since7 } } }),
  ]);

  const activationRate = inviteSent > 0 ? inviteActivated / inviteSent : 0;

  // Smoke: run lazily, swallow failures so the snapshot still records.
  let smokePass = 0; let smokeFail = 0;
  try {
    const { runSmokeTests, summarizeResults } = await import("../smoke");
    const results = await runSmokeTests();
    const summary = summarizeResults(results);
    smokePass = summary.pass; smokeFail = summary.fail;
  } catch { /* ignore */ }

  const snapshot = await prisma.pilotMetricSnapshot.create({
    data: {
      clubId: args.clubId,
      label: args.label,
      openTickets, resolvedTickets, openIncidents, failedJobs,
      inviteSent, inviteActivated, inviteActivationRate: activationRate,
      importBatches, importErrorRows,
      memberLogins7d, apApprovedLast7d, arPostedLast7d,
      smokePass, smokeFail,
      notes: args.notes ?? null,
    },
  });
  await audit(principal, {
    action: "pilot.retrospective.metrics",
    entityType: "PilotMetricSnapshot",
    entityId: snapshot.id,
    clubId: args.clubId,
    after: { label: args.label, activationRate },
  });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------------
export async function listRetrospectives(principal: Principal, clubId: string) {
  ensureAccess(principal, clubId);
  return prisma.pilotRetrospective.findMany({
    where: { clubId },
    orderBy: { conductedAt: "desc" },
    include: { _count: { select: { items: true, actions: true } } },
  });
}

export async function retroDetail(principal: Principal, retrospectiveId: string) {
  const retro = await prisma.pilotRetrospective.findUnique({
    where: { id: retrospectiveId },
    include: {
      items: { orderBy: { createdAt: "desc" } },
      actions: { orderBy: [{ status: "asc" }, { priority: "desc" }] },
    },
  });
  if (!retro) throw new NotFoundError("PilotRetrospective", retrospectiveId);
  ensureAccess(principal, retro.clubId);
  return retro;
}

export async function recentSnapshots(principal: Principal, clubId: string) {
  ensureAccess(principal, clubId);
  return prisma.pilotMetricSnapshot.findMany({
    where: { clubId },
    orderBy: { capturedAt: "desc" },
    take: 20,
  });
}
