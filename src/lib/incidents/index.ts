// Phase 13K — Support / incident tooling.
//
// Three flavors of operational record:
//   - Incident       — internal Spectre-side or club-side outage / sev-stamped.
//   - SupportTicket  — a customer-raised question or workflow help request.
//   - KnownIssue     — global, cross-tenant published notice (status page).
//
// Incident timeline events double as a lightweight audit narrative —
// timestamps + free-text + optional refType/refId pointing at audit logs or
// observability events.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------
export const openIncidentSchema = z.object({
  clubId: z.string().optional(),
  severity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]).default("SEV3"),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  ownerUserId: z.string().optional(),
});

function ensureReadable(principal: Principal, clubId: string | null | undefined) {
  if (isSuperAdmin(principal)) return;
  if (!clubId) throw new ForbiddenError("Cross-club incident access is SUPER_ADMIN only");
  requirePermission(principal, clubId, "system:audit:read");
}

function ensureWritable(principal: Principal, clubId: string | null | undefined) {
  if (isSuperAdmin(principal)) return;
  if (!clubId) throw new ForbiddenError("Cross-club incident writes are SUPER_ADMIN only");
  requirePermission(principal, clubId, "settings:write");
}

export async function openIncident(principal: Principal, raw: unknown) {
  const parsed = openIncidentSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureWritable(principal, parsed.data.clubId ?? null);
  const incident = await prisma.incident.create({
    data: {
      clubId: parsed.data.clubId ?? null,
      severity: parsed.data.severity, title: parsed.data.title,
      description: parsed.data.description ?? null,
      ownerUserId: parsed.data.ownerUserId ?? null,
      status: "OPEN",
      createdByUserId: principal.id,
    },
  });
  await prisma.incidentTimelineEvent.create({
    data: {
      clubId: incident.clubId, incidentId: incident.id,
      kind: "STATUS_CHANGE", message: "Incident opened",
      byUserId: principal.id,
    },
  });
  await audit(principal, { action: "incident.open", entityType: "Incident", entityId: incident.id, clubId: incident.clubId ?? undefined, after: { severity: incident.severity, title: incident.title } });
  return incident;
}

export const incidentTransitionSchema = z.object({
  incidentId: z.string(),
  status: z.enum(["OPEN", "TRIAGING", "IN_PROGRESS", "MITIGATED", "RESOLVED", "CLOSED"]),
  note: z.string().max(2000).optional(),
});

export async function transitionIncident(principal: Principal, raw: unknown) {
  const parsed = incidentTransitionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const incident = await prisma.incident.findUnique({ where: { id: parsed.data.incidentId } });
  if (!incident) throw new NotFoundError("Incident", parsed.data.incidentId);
  ensureWritable(principal, incident.clubId);
  if (incident.status === "CLOSED") throw new ConflictError("Cannot transition a CLOSED incident");
  const updated = await prisma.$transaction(async (tx) => {
    const i = await tx.incident.update({
      where: { id: incident.id },
      data: {
        status: parsed.data.status,
        mitigatedAt: parsed.data.status === "MITIGATED" ? new Date() : incident.mitigatedAt,
        resolvedAt: (parsed.data.status === "RESOLVED" || parsed.data.status === "CLOSED") ? new Date() : incident.resolvedAt,
      },
    });
    await tx.incidentTimelineEvent.create({
      data: {
        clubId: i.clubId, incidentId: i.id,
        kind: "STATUS_CHANGE",
        message: `${incident.status} → ${parsed.data.status}${parsed.data.note ? ` — ${parsed.data.note}` : ""}`,
        byUserId: principal.id,
      },
    });
    return i;
  });
  await audit(principal, { action: "incident.transition", entityType: "Incident", entityId: incident.id, clubId: incident.clubId ?? undefined, after: { from: incident.status, to: parsed.data.status } });
  return updated;
}

export async function appendNote(principal: Principal, incidentId: string, message: string, refType?: string, refId?: string) {
  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!incident) throw new NotFoundError("Incident", incidentId);
  ensureWritable(principal, incident.clubId);
  return prisma.incidentTimelineEvent.create({
    data: {
      clubId: incident.clubId, incidentId,
      kind: refType ? "LINK" : "NOTE",
      message: message.trim().slice(0, 4000),
      refType: refType ?? null, refId: refId ?? null,
      byUserId: principal.id,
    },
  });
}

export async function listIncidents(principal: Principal, clubId?: string) {
  if (clubId) ensureReadable(principal, clubId);
  else if (!isSuperAdmin(principal)) throw new ForbiddenError("Cross-club incident list is SUPER_ADMIN only");
  return prisma.incident.findMany({
    where: clubId ? { clubId } : {},
    orderBy: [{ status: "asc" }, { detectedAt: "desc" }],
    take: 100,
  });
}

export async function incidentDetail(principal: Principal, incidentId: string) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: { timeline: { orderBy: { occurredAt: "desc" }, take: 200 } },
  });
  if (!incident) throw new NotFoundError("Incident", incidentId);
  ensureReadable(principal, incident.clubId);
  return incident;
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------
export const ticketSchema = z.object({
  clubId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  severity: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  category: z.string().max(80).optional(),
  assignedToUserId: z.string().optional(),
});

export async function openTicket(principal: Principal, raw: unknown) {
  const parsed = ticketSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureWritable(principal, parsed.data.clubId);
  const ticket = await prisma.supportTicket.create({
    data: {
      clubId: parsed.data.clubId, title: parsed.data.title,
      description: parsed.data.description ?? null,
      severity: parsed.data.severity,
      category: parsed.data.category ?? null,
      assignedToUserId: parsed.data.assignedToUserId ?? null,
      openedByUserId: principal.id,
      status: "OPEN",
    },
  });
  await audit(principal, { action: "support.ticket.open", entityType: "SupportTicket", entityId: ticket.id, clubId: parsed.data.clubId, after: { severity: ticket.severity, title: ticket.title } });
  return ticket;
}

export async function assignTicket(principal: Principal, ticketId: string, userId: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new NotFoundError("SupportTicket", ticketId);
  ensureWritable(principal, ticket.clubId);
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { assignedToUserId: userId, status: ticket.status === "OPEN" ? "IN_PROGRESS" : ticket.status },
  });
  await audit(principal, { action: "support.ticket.assign", entityType: "SupportTicket", entityId: ticket.id, clubId: ticket.clubId, after: { assignedToUserId: userId } });
  return updated;
}

export async function resolveTicket(principal: Principal, ticketId: string, notes: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new NotFoundError("SupportTicket", ticketId);
  ensureWritable(principal, ticket.clubId);
  if (ticket.status === "CLOSED" || ticket.status === "RESOLVED") throw new ConflictError(`Ticket is ${ticket.status}`);
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNotes: notes },
  });
  await audit(principal, { action: "support.ticket.resolve", entityType: "SupportTicket", entityId: ticket.id, clubId: ticket.clubId });
  return updated;
}

export async function listTickets(principal: Principal, clubId: string, filter?: { status?: string }) {
  ensureReadable(principal, clubId);
  return prisma.supportTicket.findMany({
    where: { clubId, ...(filter?.status ? { status: filter.status } : {}) },
    orderBy: [{ status: "asc" }, { openedAt: "desc" }],
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Known issues (cross-tenant, SUPER_ADMIN-managed)
// ---------------------------------------------------------------------------
export const knownIssueSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(8000),
  severity: z.enum(["INFO", "WARNING", "OUTAGE"]).default("WARNING"),
  workaround: z.string().max(4000).optional(),
});

export async function publishKnownIssue(principal: Principal, raw: unknown) {
  if (!isSuperAdmin(principal)) throw new ForbiddenError("Only SUPER_ADMIN can publish known issues");
  const parsed = knownIssueSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return prisma.knownIssue.create({
    data: { ...parsed.data, status: "INVESTIGATING" },
  });
}

export async function resolveKnownIssue(principal: Principal, id: string) {
  if (!isSuperAdmin(principal)) throw new ForbiddenError("Only SUPER_ADMIN can resolve known issues");
  return prisma.knownIssue.update({
    where: { id }, data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

export async function listKnownIssues() {
  return prisma.knownIssue.findMany({
    orderBy: [{ status: "asc" }, { publishedAt: "desc" }],
    take: 50,
  });
}
