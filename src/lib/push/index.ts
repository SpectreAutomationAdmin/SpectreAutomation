// Phase 9D — Web push notifications.
//
// Flow:
//   1. Browser asks for permission, then registers a subscription via the
//      service worker (PushManager.subscribe).
//   2. The browser POSTs { endpoint, p256dh, auth } to /api/push/subscribe.
//   3. Our service queues a job to send a push. The job pulls active
//      subscriptions for the recipient and dispatches via webPushAdapter.
//   4. Failed deliveries (404 / 410 = subscription expired) auto-deactivate
//      the row.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, ValidationError } from "../errors";
import { logger } from "../observability/logger";
import { optionalImport } from "../integrations/optional-import";
import { getSecret } from "../secrets";
import { enqueue } from "../queue";

// ---------------------------------------------------------------------------
// Adapter interface (parallels NotificationDeliveryAdapter)
// ---------------------------------------------------------------------------
export interface PushAdapter {
  name: string;
  send(args: {
    endpoint: string; p256dh: string; auth: string;
    title: string; body: string; url?: string; data?: Record<string, unknown>;
  }): Promise<{ status: "SENT" | "EXPIRED" | "FAILED"; providerMessageId?: string; failureReason?: string }>;
}

export const devPushAdapter: PushAdapter = {
  name: "dev",
  async send({ endpoint, title, body }) {
    logger.info("push.dev.send", { endpoint: endpoint.slice(0, 60), title, body: body.slice(0, 80) });
    return { status: "SENT", providerMessageId: `dev-${Date.now()}` };
  },
};

// Real web-push adapter using the `web-push` npm package (Node-native, no SDK).
export async function webPushAdapter(args: { vapidPublic: string; vapidPrivate: string; contactEmail: string }): Promise<PushAdapter> {
  const lib = await optionalImport("web-push");
  if (!lib) {
    logger.warn("push.webpush.missing", { hint: "`web-push` npm package not installed; falling back to dev adapter" });
    return devPushAdapter;
  }
  const webpush = (lib.default ?? lib) as {
    setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
    sendNotification: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ statusCode: number }>;
  };
  try { webpush.setVapidDetails(`mailto:${args.contactEmail}`, args.vapidPublic, args.vapidPrivate); }
  catch (err) { logger.warn("push.webpush.vapid_init_failed", { error: err instanceof Error ? err.message : String(err) }); }
  return {
    name: "web-push",
    async send({ endpoint, p256dh, auth, title, body, url, data }) {
      try {
        const payload = JSON.stringify({ title, body, data: { url, ...(data ?? {}) } });
        const result = await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload);
        if (result.statusCode === 410 || result.statusCode === 404) return { status: "EXPIRED", failureReason: `Subscription gone (${result.statusCode})` };
        if (result.statusCode >= 200 && result.statusCode < 300) return { status: "SENT" };
        return { status: "FAILED", failureReason: `HTTP ${result.statusCode}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /410|404/.test(message) ? "EXPIRED" as const : "FAILED" as const;
        return { status, failureReason: message };
      }
    },
  };
}

async function selectAdapter(clubId: string): Promise<PushAdapter> {
  const vapidPublic = await getSecret({ clubId, scope: "PUSH" as never, provider: "vapid", keyName: "publicKey" });
  const vapidPrivate = await getSecret({ clubId, scope: "PUSH" as never, provider: "vapid", keyName: "privateKey" });
  const contactEmail = (await getSecret({ clubId, scope: "PUSH" as never, provider: "vapid", keyName: "contactEmail" })) ?? "ops@spectre.app";
  if (!vapidPublic || !vapidPrivate) return devPushAdapter;
  return webPushAdapter({ vapidPublic, vapidPrivate, contactEmail });
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------
export const subscribeSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  userAgent: z.string().optional().nullable(),
});

export async function subscribe(principal: Principal, clubId: string, raw: unknown) {
  const parsed = subscribeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const existing = await prisma.webPushSubscription.findUnique({ where: { endpoint: d.endpoint } });
  if (existing) {
    return prisma.webPushSubscription.update({
      where: { id: existing.id },
      data: { p256dh: d.p256dh, authSecret: d.auth, userAgent: d.userAgent ?? null, isActive: true, failureCount: 0 },
    });
  }
  const sub = await prisma.webPushSubscription.create({
    data: {
      clubId,
      userId: principal.id, memberId: principal.memberId ?? null,
      endpoint: d.endpoint, p256dh: d.p256dh, authSecret: d.auth,
      userAgent: d.userAgent ?? null, isActive: true,
    },
  });
  await audit(principal, { action: "push.subscribe", entityType: "WebPushSubscription", entityId: sub.id, clubId });
  return sub;
}

export async function unsubscribe(principal: Principal, endpoint: string) {
  await prisma.webPushSubscription.updateMany({
    where: { endpoint, OR: [{ userId: principal.id }, { memberId: principal.memberId ?? "_" }] },
    data: { isActive: false },
  });
}

// ---------------------------------------------------------------------------
// Push delivery — queue-driven. The `sendPush()` helper enqueues a job; the
// queue handler `PUSH_SEND` (registered below) does the dispatch + cleanup.
// ---------------------------------------------------------------------------
export async function sendPushToUser(args: { clubId: string; userId?: string; memberId?: string; title: string; body: string; url?: string; topic?: string }) {
  if (!args.userId && !args.memberId) throw new ConflictError("userId or memberId required");

  // Preference opt-out check (re-uses NotificationPreference from Phase 6).
  if (args.topic) {
    const pref = await prisma.notificationPreference.findFirst({
      where: { clubId: args.clubId, topic: args.topic, OR: [{ userId: args.userId ?? undefined }, { memberId: args.memberId ?? undefined }] },
    });
    if (pref && !pref.enabled) {
      logger.info("push.suppressed_by_preference", { topic: args.topic, userId: args.userId, memberId: args.memberId });
      return { suppressed: true };
    }
  }

  await enqueue({
    kind: "NOTIFICATION",
    queue: "notifications",
    clubId: args.clubId,
    payload: { kind: "PUSH", ...args },
    idempotencyKey: `push:${args.userId ?? args.memberId}:${args.title}:${Date.now()}`,
  });
  return { queued: true };
}

export async function dispatchPushJob(args: { clubId: string; userId?: string; memberId?: string; title: string; body: string; url?: string; campaignId?: string }) {
  const subs = await prisma.webPushSubscription.findMany({
    where: {
      clubId: args.clubId, isActive: true,
      ...(args.userId ? { userId: args.userId } : {}),
      ...(args.memberId ? { memberId: args.memberId } : {}),
    },
  });
  if (subs.length === 0) return { sent: 0, expired: 0, failed: 0, skipped: "no subscriptions" };
  const adapter = await selectAdapter(args.clubId);
  let sent = 0, expired = 0, failed = 0;
  for (const sub of subs) {
    const start = Date.now();
    const result = await adapter.send({
      endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.authSecret,
      title: args.title, body: args.body, url: args.url,
    });
    // Phase 10A — audit-grade attempt row.
    await prisma.pushDeliveryAttempt.create({
      data: {
        clubId: args.clubId, subscriptionId: sub.id, campaignId: args.campaignId ?? null,
        attemptNumber: 1, status: result.status, providerMessageId: result.providerMessageId ?? null,
        failureReason: result.failureReason ?? null, durationMs: Date.now() - start,
      },
    });
    if (result.status === "SENT") {
      sent++;
      await prisma.webPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: 0, lastSentAt: new Date() },
      });
      await prisma.communicationLog.create({
        data: {
          clubId: args.clubId, channel: "PUSH",
          toUserId: sub.userId, toMemberId: sub.memberId,
          subject: args.title, bodySnippet: args.body.slice(0, 200),
          status: "SENT",
        },
      });
    } else if (result.status === "EXPIRED") {
      expired++;
      await prisma.webPushSubscription.update({
        where: { id: sub.id },
        data: { isActive: false, failureCount: { increment: 1 } },
      });
    } else {
      failed++;
      await prisma.webPushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
      });
    }
  }
  return { sent, expired, failed };
}

// Queue handler registration — runs in process at import time. The Phase 8
// queue dispatcher routes PUSH-kind notifications via the same NOTIFICATION
// queue, with `payload.kind` switching the dispatch.
import { registerHandler } from "../queue";
registerHandler<{ kind?: string; clubId: string; userId?: string; memberId?: string; title: string; body: string; url?: string }>("NOTIFICATION", async ({ payload }) => {
  if (payload && (payload as { kind?: string }).kind === "PUSH") {
    return dispatchPushJob({ clubId: payload.clubId, userId: payload.userId, memberId: payload.memberId, title: payload.title, body: payload.body, url: payload.url });
  }
  // For email / SMS, the original Phase 6 notify() call already dispatched
  // inline; we just record a touch.
  return { skipped: true, reason: "non-push payload" };
});
