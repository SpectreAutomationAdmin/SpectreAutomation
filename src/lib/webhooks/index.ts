// Phase 10C — Outbound webhook delivery.
//
// Service contract:
//   1. emit(eventType, payload, clubId) — drops a WebhookDelivery row per
//      matching active subscription and enqueues a WEBHOOK_DELIVERY job.
//   2. The queue worker dispatches via fetch with HMAC-SHA256 signature
//      derived from the per-subscription secret.
//   3. Failures retry via the existing queue exponential backoff. 410/404
//      responses auto-disable the subscription.
//
// Idempotency: each delivery has a stable id; subscribers should de-dup on it.

import { z } from "zod";
import { createHash, createHmac, randomUUID } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { logger } from "../observability/logger";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";
import { enqueue, registerHandler } from "../queue";

export type WebhookEventType =
  | "member.created" | "member.updated"
  | "member.account.charge_created" | "member.payment.received"
  | "event.registration.created"
  | "tee_time.booked"
  | "invoice.posted"
  | "inventory.adjusted"
  | "tournament.score_submitted"
  | "report.generated";

export const ALL_WEBHOOK_EVENTS: WebhookEventType[] = [
  "member.created", "member.updated",
  "member.account.charge_created", "member.payment.received",
  "event.registration.created",
  "tee_time.booked", "invoice.posted", "inventory.adjusted",
  "tournament.score_submitted", "report.generated",
];

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------
export const subscriptionSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().url().max(500),
  events: z.array(z.string()).min(1),
  apiKeyId: z.string().optional().nullable(),
});

export async function createSubscription(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = subscriptionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  // Sanitize: only allow known event keys.
  const valid = d.events.filter((e) => (ALL_WEBHOOK_EVENTS as string[]).includes(e));
  if (valid.length === 0) throw new ConflictError("No valid event types selected");
  // Generate a per-subscription HMAC secret. We keep the raw value so we can
  // sign outbound payloads. Production rotation is Phase 11.
  const secret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const sub = await prisma.webhookSubscription.create({
    data: {
      clubId, apiKeyId: d.apiKeyId ?? null,
      name: d.name, url: d.url,
      secret, events: valid.join(","), status: "ACTIVE",
    },
  });
  await audit(principal, { action: "webhook.subscription.create", entityType: "WebhookSubscription", entityId: sub.id, clubId, after: { name: d.name, events: valid } });
  // Return secret to caller once (echoed in the admin UI flash).
  return { subscription: sub, secret };
}

export async function disableSubscription(principal: Principal, subscriptionId: string) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new ConflictError("subscription not found");
  requirePermission(principal, sub.clubId, "settings:write");
  const updated = await prisma.webhookSubscription.update({
    where: { id: subscriptionId }, data: { status: "DISABLED" },
  });
  await audit(principal, { action: "webhook.subscription.disable", entityType: "WebhookSubscription", entityId: subscriptionId, clubId: sub.clubId });
  return updated;
}

export async function listSubscriptions(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  const rows = await prisma.webhookSubscription.findMany({
    where: tenantWhere(principal, clubId),
    orderBy: { createdAt: "desc" },
  });
  // Never echo the secret back.
  return rows.map((r) => ({ ...r, secret: r.secret.slice(0, 4) + "…" }));
}

export async function listDeliveries(principal: Principal, clubId: string, opts?: { subscriptionId?: string; status?: string }) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.webhookDelivery.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      ...(opts?.subscriptionId ? { subscriptionId: opts.subscriptionId } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { subscription: true },
  });
}

// ---------------------------------------------------------------------------
// emit() — fan out an event to all matching subscriptions.
// Service callers invoke this from inside the post-transaction "after" hook.
// ---------------------------------------------------------------------------
export async function emit(args: { clubId: string; eventType: WebhookEventType; payload: unknown }) {
  const matching = await prisma.webhookSubscription.findMany({
    where: { clubId: args.clubId, status: "ACTIVE", events: { contains: args.eventType } },
  });
  if (matching.length === 0) return { dispatched: 0 };
  // Lightly filter the payload — never include passwordHash, secrets, processor tokens.
  const sanitized = redactPayload(args.payload);
  for (const sub of matching) {
    const delivery = await prisma.webhookDelivery.create({
      data: {
        clubId: args.clubId, subscriptionId: sub.id,
        eventType: args.eventType, payloadJson: JSON.stringify(sanitized),
        status: "PENDING",
      },
    });
    await enqueue({
      kind: "WEBHOOK_DELIVERY",
      queue: "webhook-delivery",
      clubId: args.clubId,
      payload: { deliveryId: delivery.id },
      idempotencyKey: `webhook:${delivery.id}`,
    }).catch((err) => logger.warn("webhook.enqueue.failed", { deliveryId: delivery.id, error: err instanceof Error ? err.message : String(err) }));
  }
  return { dispatched: matching.length };
}

function redactPayload(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const REDACT = new Set(["password", "passwordHash", "secret", "apiKey", "accessKeyId", "secretAccessKey", "authToken", "processorToken", "ssn", "sin", "cardNumber", "cvv"]);
  if (Array.isArray(input)) return input.map(redactPayload);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (REDACT.has(k)) { out[k] = "[redacted]"; continue; }
    if (v && typeof v === "object") out[k] = redactPayload(v);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch handler (registered with the queue).
// ---------------------------------------------------------------------------
export async function dispatchDelivery(deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });
  if (!delivery) throw new Error("delivery not found");
  if (delivery.status === "DELIVERED") return { skipped: true, reason: "already delivered" };
  if (delivery.subscription.status !== "ACTIVE") {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: "FAILED", lastError: `subscription ${delivery.subscription.status}` } });
    return { skipped: true, reason: "subscription not active" };
  }
  const attemptNumber = delivery.attempts + 1;
  const timestamp = new Date().toISOString();
  const body = delivery.payloadJson;
  // Phase 11: prefer the ACTIVE WebhookSecretVersion if rotation has been
  // performed; fall back to the legacy single-secret column otherwise.
  const { activeSecretFor } = await import("./rotation");
  const signingSecret = (await activeSecretFor(delivery.subscription.id)) || delivery.subscription.secret;
  // HMAC-SHA256 signature over `${timestamp}.${body}`. Recipients verify by
  // recomputing with the shared secret.
  const signature = createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-spectre-event": delivery.eventType,
    "x-spectre-delivery-id": delivery.id,
    "x-spectre-timestamp": timestamp,
    "x-spectre-signature": `sha256=${signature}`,
    "user-agent": "Spectre-Webhook/1.0",
  };

  try {
    const response = await fetch(delivery.subscription.url, { method: "POST", headers, body });
    const code = response.status;
    if (code === 410 || code === 404) {
      // Auto-disable a permanently-gone endpoint.
      await prisma.webhookSubscription.update({
        where: { id: delivery.subscription.id },
        data: { status: "DISABLED", failureCount: { increment: 1 } },
      });
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "FAILED", attempts: attemptNumber, responseCode: code, lastError: `endpoint gone (${code})` },
      });
      return { status: "FAILED", reason: `endpoint gone (${code})` };
    }
    if (code >= 200 && code < 300) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DELIVERED", attempts: attemptNumber, responseCode: code, deliveredAt: new Date() },
      });
      await prisma.webhookSubscription.update({
        where: { id: delivery.subscription.id },
        data: { failureCount: 0, lastDeliveryAt: new Date() },
      });
      return { status: "DELIVERED", code };
    }
    // Non-2xx → throw so the queue retries.
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "PENDING", attempts: attemptNumber, responseCode: code, lastError: `HTTP ${code}` },
    });
    throw new Error(`HTTP ${code}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "PENDING", attempts: attemptNumber, lastError: message.slice(0, 500) },
    });
    await prisma.webhookSubscription.update({
      where: { id: delivery.subscription.id },
      data: { failureCount: { increment: 1 } },
    });
    throw err;
  }
}

// Dedicated handler for outbound deliveries.
registerHandler<{ deliveryId: string }>("WEBHOOK_DELIVERY", async ({ payload }) => {
  return dispatchDelivery(payload.deliveryId);
});

// Compute the HMAC for verification — exported so tests can confirm signing.
export function computeSignature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

void createHash; // keep import for future use
