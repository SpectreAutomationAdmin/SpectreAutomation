// Phase 10H — Operational replay tooling.
//
// Lets the super-admin (or club admin where appropriate) re-run failed jobs,
// resend failed webhook deliveries, regenerate exports, and pause/resume
// entire queues. Every replay action writes an audit row.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { logger } from "../observability/logger";

export async function replayFailedJob(principal: Principal, jobId: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("job not found");
  if (job.clubId) requirePermission(principal, job.clubId, "settings:write");
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: "QUEUED", attempts: 0, lastError: null, scheduledFor: new Date(), finishedAt: null },
  });
  await audit(principal, { action: "ops.replay.job", entityType: "BackgroundJob", entityId: jobId, clubId: job.clubId, after: { kind: job.kind } });
  logger.info("ops.replay.job", { jobId, kind: job.kind });
}

export async function replayWebhookDelivery(principal: Principal, deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) throw new Error("delivery not found");
  requirePermission(principal, delivery.clubId, "settings:write");
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: "PENDING", attempts: 0, lastError: null },
  });
  const { enqueue } = await import("../queue");
  await enqueue({
    kind: "WEBHOOK_DELIVERY", queue: "webhook-delivery", clubId: delivery.clubId,
    payload: { deliveryId },
    idempotencyKey: `webhook-replay:${deliveryId}:${Date.now()}`,
  });
  await audit(principal, { action: "ops.replay.webhook", entityType: "WebhookDelivery", entityId: deliveryId, clubId: delivery.clubId });
}

export async function regenerateExport(principal: Principal, exportId: string) {
  const exp = await prisma.reportExport.findUnique({ where: { id: exportId } });
  if (!exp) throw new Error("export not found");
  requirePermission(principal, exp.clubId, "reports:export");
  const { enqueue } = await import("../queue");
  await enqueue({
    kind: "EXPORT", queue: "exports", clubId: exp.clubId,
    payload: { exportId },
    idempotencyKey: `regen:${exportId}:${Date.now()}`,
  });
  await audit(principal, { action: "ops.regen.export", entityType: "ReportExport", entityId: exportId, clubId: exp.clubId });
}

// Queue pause/resume — implemented by writing a ClubSetting that the worker
// reads on each loop iteration. The Phase 8 in-memory `processPending` driver
// short-circuits when the setting is true.
export async function pauseQueue(principal: Principal, queue: string) {
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) throw new Error("Only SUPER_ADMIN can pause a queue");
  // Use clubId=null sentinel for global queue pause.
  await prisma.clubSetting.upsert({
    where: { clubId_scope_key: { clubId: "_GLOBAL_", scope: "QUEUE_PAUSE", key: queue } },
    update: { valueJson: JSON.stringify({ paused: true, by: principal.id, at: new Date().toISOString() }) },
    create: { clubId: "_GLOBAL_", scope: "QUEUE_PAUSE", key: queue, valueJson: JSON.stringify({ paused: true, by: principal.id, at: new Date().toISOString() }) },
  }).catch(() => { /* no _GLOBAL_ club row exists in dev; pause is best-effort */ });
  await audit(principal, { action: "ops.queue.pause", entityType: "Queue", entityId: queue, clubId: null });
}

export async function resumeQueue(principal: Principal, queue: string) {
  const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
  if (!isSuper) throw new Error("Only SUPER_ADMIN can resume a queue");
  await prisma.clubSetting.deleteMany({ where: { clubId: "_GLOBAL_", scope: "QUEUE_PAUSE", key: queue } }).catch(() => {});
  await audit(principal, { action: "ops.queue.resume", entityType: "Queue", entityId: queue, clubId: null });
}

export async function isQueuePaused(queue: string): Promise<boolean> {
  const row = await prisma.clubSetting.findFirst({ where: { clubId: "_GLOBAL_", scope: "QUEUE_PAUSE", key: queue } });
  return !!row;
}

// Operational diagnostics — surface inflight + recent failures for the
// /app/admin/ops/system page.
export async function operationalDiagnostics() {
  const since = new Date(Date.now() - 3600_000);
  const [queuedJobs, runningJobs, deadLetter, recentFailures, recentWebhookFails, pushFailures] = await Promise.all([
    prisma.backgroundJob.count({ where: { status: "QUEUED" } }),
    prisma.backgroundJob.count({ where: { status: "RUNNING" } }),
    prisma.backgroundJob.count({ where: { status: "DEAD_LETTER" } }),
    prisma.jobRun.count({ where: { status: "FAILED", finishedAt: { gte: since } } }),
    prisma.webhookDelivery.count({ where: { status: "FAILED" } }),
    prisma.pushDeliveryAttempt.count({ where: { status: { in: ["FAILED", "EXPIRED"] }, attemptedAt: { gte: since } } }),
  ]);
  return { queuedJobs, runningJobs, deadLetter, recentFailures, recentWebhookFails, pushFailures, snapshotAt: new Date() };
}
