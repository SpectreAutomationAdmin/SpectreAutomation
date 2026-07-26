// Phase 11C — POS mapping management.
//
// Allows admins to manage POSMapping rows (MEMBER / ITEM / LOCATION /
// TERMINAL / TAX_CODE) for external POS providers. Each mutation writes a
// POSMappingHistory row for audit. Reprocessing a failed import re-runs the
// stored webhook event through the importer using the new mapping.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

export const mappingSchema = z.object({
  providerKey: z.string().trim().min(1),
  kind: z.enum(["MEMBER", "ITEM", "LOCATION", "TERMINAL", "TAX_CODE", "DEPARTMENT", "DISCOUNT", "TENDER"]),
  externalId: z.string().trim().min(1),
  spectreId: z.string().trim().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function createOrUpdateMapping(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = mappingSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const before = await prisma.pOSMapping.findUnique({
    where: { clubId_providerKey_kind_externalId: { clubId, providerKey: d.providerKey, kind: d.kind, externalId: d.externalId } },
  });
  const mapping = before
    ? await prisma.pOSMapping.update({
        where: { id: before.id },
        data: { spectreId: d.spectreId, metaJson: d.meta ? JSON.stringify(d.meta) : null },
      })
    : await prisma.pOSMapping.create({
        data: {
          clubId, providerKey: d.providerKey, kind: d.kind, externalId: d.externalId, spectreId: d.spectreId,
          metaJson: d.meta ? JSON.stringify(d.meta) : null,
        },
      });
  await prisma.pOSMappingHistory.create({
    data: {
      clubId, providerKey: d.providerKey, kind: d.kind, externalId: d.externalId,
      beforeJson: before ? JSON.stringify({ spectreId: before.spectreId }) : null,
      afterJson: JSON.stringify({ spectreId: d.spectreId }),
      action: before ? "UPDATE" : "CREATE",
      byUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "pos.mapping.upsert", entityType: "POSMapping", entityId: mapping.id, clubId,
    after: { providerKey: d.providerKey, kind: d.kind, externalId: d.externalId, spectreId: d.spectreId },
  });
  return mapping;
}

export async function deleteMapping(principal: Principal, mappingId: string) {
  const mapping = await prisma.pOSMapping.findUnique({ where: { id: mappingId } });
  if (!mapping) throw new NotFoundError("POSMapping", mappingId);
  requirePermission(principal, mapping.clubId, "settings:write");
  await prisma.$transaction([
    prisma.pOSMappingHistory.create({
      data: {
        clubId: mapping.clubId, providerKey: mapping.providerKey, kind: mapping.kind, externalId: mapping.externalId,
        beforeJson: JSON.stringify({ spectreId: mapping.spectreId }), afterJson: null,
        action: "DELETE", byUserId: principal.id,
      },
    }),
    prisma.pOSMapping.delete({ where: { id: mappingId } }),
  ]);
  await audit(principal, { action: "pos.mapping.delete", entityType: "POSMapping", entityId: mappingId, clubId: mapping.clubId });
}

export async function bulkCreate(principal: Principal, clubId: string, args: { providerKey: string; kind: string; rows: Array<{ externalId: string; spectreId: string }> }) {
  requirePermission(principal, clubId, "settings:write");
  let created = 0;
  let updated = 0;
  for (const row of args.rows) {
    const before = await prisma.pOSMapping.findUnique({
      where: { clubId_providerKey_kind_externalId: { clubId, providerKey: args.providerKey, kind: args.kind, externalId: row.externalId } },
    });
    if (before) {
      await prisma.pOSMapping.update({ where: { id: before.id }, data: { spectreId: row.spectreId } });
      updated++;
    } else {
      await prisma.pOSMapping.create({ data: { clubId, providerKey: args.providerKey, kind: args.kind, externalId: row.externalId, spectreId: row.spectreId } });
      created++;
    }
  }
  await audit(principal, { action: "pos.mapping.bulk", entityType: "Club", entityId: clubId, clubId, after: { providerKey: args.providerKey, kind: args.kind, created, updated } });
  return { created, updated };
}

// Surface unmapped external IDs from recent webhook events / import errors.
export async function unmappedQueue(principal: Principal, clubId: string, opts?: { providerKey?: string }) {
  requirePermission(principal, clubId, "settings:read");
  const since = new Date(Date.now() - 30 * 86400000);
  const errors = await prisma.pOSImportError.findMany({
    where: { clubId, occurredAt: { gte: since }, ...(opts?.providerKey ? { providerKey: opts.providerKey } : {}) },
    orderBy: { occurredAt: "desc" }, take: 200,
  });
  return errors;
}

// Reprocess a failed webhook event using the latest mapping configuration.
// Idempotent: the inbound POSWebhookEvent is unique on (clubId, provider, externalEventId)
// so duplicate processing is prevented by the upstream code paths.
export async function reprocessFailedEvent(principal: Principal, webhookEventId: string) {
  const event = await prisma.pOSWebhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event) throw new NotFoundError("POSWebhookEvent", webhookEventId);
  requirePermission(principal, event.clubId, "settings:write");
  if (event.status === "COMPLETED") throw new ConflictError("Event already processed successfully");
  // Reset status + enqueue dispatch.
  await prisma.pOSWebhookEvent.update({
    where: { id: webhookEventId },
    data: { status: "PROCESSING", failureReason: null, attempts: 0 },
  });
  const { enqueue } = await import("../queue");
  await enqueue({
    kind: "POS_WEBHOOK", queue: "pos-webhooks", clubId: event.clubId,
    payload: { eventId: event.id },
    idempotencyKey: `pos:${event.providerKey}:${event.externalEventId}:reprocess:${Date.now()}`,
  });
  await audit(principal, { action: "pos.event.reprocess", entityType: "POSWebhookEvent", entityId: webhookEventId, clubId: event.clubId });
  return event;
}

export async function listMappings(principal: Principal, clubId: string, opts?: { providerKey?: string; kind?: string }) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.pOSMapping.findMany({
    where: { clubId, ...(opts?.providerKey ? { providerKey: opts.providerKey } : {}), ...(opts?.kind ? { kind: opts.kind } : {}) },
    orderBy: [{ providerKey: "asc" }, { kind: "asc" }, { externalId: "asc" }],
  });
}

export async function listHistory(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.pOSMappingHistory.findMany({
    where: { clubId }, orderBy: { occurredAt: "desc" }, take: 100,
  });
}
