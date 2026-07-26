// Phase 6D — Notifications & communications.
//
// Architecture:
//   notify()         — enqueues a Notification + dispatches via the configured
//                      adapter. The adapter is a seam — the default writes a
//                      CommunicationLog and marks delivery as SENT (no real
//                      email/SMS network call). Wire SES/Twilio in production.
//   templates        — rendered via simple {{var}} substitution.
//   preferences      — per-user/member, per-topic, per-channel opt-in.
//   communication_log — append-only audit-grade record of every outbound msg.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";

export type NotificationChannel = "EMAIL" | "SMS" | "IN_APP" | "PUSH";

// ---------------------------------------------------------------------------
// Delivery adapter — replaceable seam. Defaults to a logging adapter.
// ---------------------------------------------------------------------------
export interface NotificationDeliveryAdapter {
  send(args: {
    clubId: string; channel: NotificationChannel;
    to: { userId?: string | null; memberId?: string | null; email?: string | null };
    subject: string; body: string;
  }): Promise<{ status: "SENT" | "FAILED"; providerMessageId?: string; failureReason?: string }>;
}

export const loggingDeliveryAdapter: NotificationDeliveryAdapter = {
  async send() {
    // No-op adapter: simulate a successful delivery. Production wiring replaces
    // this with SES/Twilio/etc., reusing the same return shape.
    return { status: "SENT", providerMessageId: `local-${Date.now()}` };
  },
};

let activeAdapter: NotificationDeliveryAdapter = loggingDeliveryAdapter;
export function setDeliveryAdapter(adapter: NotificationDeliveryAdapter) {
  activeAdapter = adapter;
}

// Resolve the adapter for a (club, channel) pair. EMAIL → selectEmailAdapter,
// SMS → selectSmsAdapter; falls back to `activeAdapter` for IN_APP and PUSH.
async function resolveAdapter(clubId: string, channel: NotificationChannel): Promise<NotificationDeliveryAdapter> {
  if (channel === "EMAIL") {
    const { selectEmailAdapter } = await import("../integrations/email");
    return selectEmailAdapter(clubId);
  }
  if (channel === "SMS") {
    const { selectSmsAdapter } = await import("../integrations/sms");
    return selectSmsAdapter(clubId);
  }
  return activeAdapter;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export const templateSchema = z.object({
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  channel: z.enum(["EMAIL", "SMS", "IN_APP", "PUSH"]).default("EMAIL"),
  subjectTemplate: z.string().trim().min(1).max(400),
  bodyTemplate: z.string().trim().min(1).max(20000),
});

export async function upsertTemplate(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "notifications:write");
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const tpl = await prisma.notificationTemplate.upsert({
    where: { clubId_key: { clubId, key: d.key } },
    update: { name: d.name, description: d.description ?? null, channel: d.channel, subjectTemplate: d.subjectTemplate, bodyTemplate: d.bodyTemplate },
    create: { clubId, key: d.key, name: d.name, description: d.description ?? null, channel: d.channel, subjectTemplate: d.subjectTemplate, bodyTemplate: d.bodyTemplate, isSystem: false, isActive: true },
  });
  await audit(principal, { action: "notification.template.upsert", entityType: "NotificationTemplate", entityId: tpl.id, clubId, after: { key: d.key } });
  return tpl;
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = key.split(".").reduce((acc: unknown, part: string) => {
      if (acc && typeof acc === "object" && part in (acc as object)) return (acc as Record<string, unknown>)[part];
      return undefined;
    }, vars as unknown);
    return v == null ? "" : String(v);
  });
}

// ---------------------------------------------------------------------------
// Send / enqueue
// ---------------------------------------------------------------------------
export const notifySchema = z.object({
  channel: z.enum(["EMAIL", "SMS", "IN_APP", "PUSH"]).default("IN_APP"),
  toUserId: z.string().optional().nullable(),
  toMemberId: z.string().optional().nullable(),
  toEmail: z.string().email().optional().nullable(),
  templateKey: z.string().optional().nullable(),
  subject: z.string().trim().min(1).max(400).optional(),
  body: z.string().trim().min(1).max(20000).optional(),
  vars: z.record(z.string(), z.unknown()).default({}),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  topic: z.string().trim().optional().nullable(),
  triggeredEntityType: z.string().optional().nullable(),
  triggeredEntityId: z.string().optional().nullable(),
  meta: z.record(z.string(), z.unknown()).optional().nullable(),
});

export async function notify(principal: Principal | null, clubId: string, raw: unknown) {
  // System events (no principal) bypass the permission check — the service
  // layer routes them. UI-driven sends require notifications:send.
  if (principal) requirePermission(principal, clubId, "notifications:send");
  const parsed = notifySchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;

  // Resolve subject/body via template if templateKey supplied.
  let subject = d.subject ?? "";
  let body = d.body ?? "";
  if (d.templateKey) {
    const tpl = await prisma.notificationTemplate.findUnique({ where: { clubId_key: { clubId, key: d.templateKey } } });
    if (tpl) {
      subject = renderTemplate(tpl.subjectTemplate, d.vars);
      body = renderTemplate(tpl.bodyTemplate, d.vars);
    }
  }
  if (!subject || !body) throw new ConflictError("Notification requires subject + body (directly or via template)");

  // Check preference opt-out for known topic.
  if (d.topic && (d.toUserId || d.toMemberId)) {
    const pref = await prisma.notificationPreference.findFirst({
      where: { clubId, topic: d.topic, OR: [{ userId: d.toUserId ?? undefined }, { memberId: d.toMemberId ?? undefined }] },
    });
    if (pref && !pref.enabled) {
      // Suppressed by preference — record but do not dispatch.
      const supp = await prisma.notification.create({
        data: {
          clubId, channel: d.channel,
          toUserId: d.toUserId ?? null, toMemberId: d.toMemberId ?? null, toEmail: d.toEmail ?? null,
          templateKey: d.templateKey ?? null,
          subject, body, priority: d.priority,
          metaJson: d.meta ? JSON.stringify(d.meta) : null,
          triggeredEntityType: d.triggeredEntityType ?? null, triggeredEntityId: d.triggeredEntityId ?? null,
          status: "FAILED",
        },
      });
      await prisma.notificationDelivery.create({
        data: { clubId, notificationId: supp.id, channel: d.channel, status: "FAILED", failureReason: "Suppressed by user preference" },
      });
      return supp;
    }
  }

  const notification = await prisma.notification.create({
    data: {
      clubId, channel: d.channel,
      toUserId: d.toUserId ?? null, toMemberId: d.toMemberId ?? null, toEmail: d.toEmail ?? null,
      templateKey: d.templateKey ?? null,
      subject, body, priority: d.priority,
      metaJson: d.meta ? JSON.stringify(d.meta) : null,
      triggeredEntityType: d.triggeredEntityType ?? null, triggeredEntityId: d.triggeredEntityId ?? null,
      status: "QUEUED",
    },
  });

  // Dispatch via adapter (for EMAIL/SMS/PUSH; IN_APP is "delivered" by virtue of the row existing).
  let finalStatus = "SENT";
  if (d.channel !== "IN_APP") {
    const adapter = await resolveAdapter(clubId, d.channel);
    const result = await adapter.send({
      clubId, channel: d.channel,
      to: { userId: d.toUserId ?? null, memberId: d.toMemberId ?? null, email: d.toEmail ?? null },
      subject, body,
    });
    await prisma.notificationDelivery.create({
      data: {
        clubId, notificationId: notification.id, channel: d.channel,
        status: result.status, providerMessageId: result.providerMessageId ?? null, failureReason: result.failureReason ?? null,
      },
    });
    finalStatus = result.status;
  } else {
    await prisma.notificationDelivery.create({
      data: { clubId, notificationId: notification.id, channel: "IN_APP", status: "SENT" },
    });
  }
  const updated = await prisma.notification.update({ where: { id: notification.id }, data: { status: finalStatus } });

  // Communication-log (compliance-grade record).
  await prisma.communicationLog.create({
    data: {
      clubId, channel: d.channel,
      toAddress: d.toEmail ?? null, toUserId: d.toUserId ?? null, toMemberId: d.toMemberId ?? null,
      subject, bodySnippet: body.slice(0, 200),
      status: finalStatus,
      triggeredEntityType: d.triggeredEntityType ?? null, triggeredEntityId: d.triggeredEntityId ?? null,
      notificationId: notification.id,
    },
  });

  return updated;
}

export async function markNotificationRead(principal: Principal, notificationId: string) {
  const n = await prisma.notification.findUnique({ where: { id: notificationId } });
  assertTenantOwned(n, principal);
  if (n.toUserId && n.toUserId !== principal.id && n.toMemberId !== principal.memberId) {
    throw new ConflictError("Not your notification");
  }
  return prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date(), status: "READ" } });
}

export async function listNotificationsForUser(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "notifications:read");
  return prisma.notification.findMany({
    where: {
      clubId,
      OR: [
        { toUserId: principal.id },
        ...(principal.memberId ? [{ toMemberId: principal.memberId }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
export async function setPreference(
  principal: Principal,
  args: { clubId: string; userId?: string | null; memberId?: string | null; topic: string; channels: NotificationChannel[]; enabled: boolean }
) {
  requirePermission(principal, args.clubId, "notifications:write");
  // Compound-unique with nullable userId/memberId is awkward to express in
  // Prisma's typed where input — emulate upsert by hand.
  const existing = await prisma.notificationPreference.findFirst({
    where: {
      clubId: args.clubId, topic: args.topic,
      userId: args.userId ?? null, memberId: args.memberId ?? null,
    },
  });
  if (existing) {
    return prisma.notificationPreference.update({
      where: { id: existing.id },
      data: { channels: args.channels.join(","), enabled: args.enabled },
    });
  }
  return prisma.notificationPreference.create({
    data: {
      clubId: args.clubId, userId: args.userId ?? null, memberId: args.memberId ?? null,
      topic: args.topic, channels: args.channels.join(","), enabled: args.enabled,
    },
  });
}

export async function listTemplates(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "notifications:read");
  return prisma.notificationTemplate.findMany({ where: tenantWhere(principal, clubId), orderBy: { name: "asc" } });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}

// ---------------------------------------------------------------------------
// Default system templates (seeded in seed.ts via ensureSystemTemplates).
// ---------------------------------------------------------------------------
export const DEFAULT_TEMPLATES = [
  {
    key: "application_received",
    name: "Application received",
    channel: "EMAIL",
    subjectTemplate: "Your membership application has been received",
    bodyTemplate: "Dear {{firstName}},\n\nThank you for your membership application. We have received it and a member of our team will be in touch within the next several business days.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "application_approved",
    name: "Application approved",
    channel: "EMAIL",
    subjectTemplate: "Welcome to {{clubName}}",
    bodyTemplate: "Dear {{firstName}},\n\nWe are delighted to welcome you to {{clubName}}. Your application has been approved and you will receive onboarding details shortly.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "payment_failed",
    name: "Payment failed",
    channel: "EMAIL",
    subjectTemplate: "We were unable to process your recent payment",
    bodyTemplate: "Dear {{firstName}},\n\nA recent attempt to process payment on your account was declined. Please log in to your member portal to review or update your payment method.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "statement_available",
    name: "Statement available",
    channel: "EMAIL",
    subjectTemplate: "Your {{periodLabel}} statement is available",
    bodyTemplate: "Dear {{firstName}},\n\nYour statement for {{periodLabel}} is now available in your member portal.\n\nWith warm regards,\nMember Services",
  },
  {
    key: "invoice_awaiting_approval",
    name: "Invoice awaiting approval",
    channel: "IN_APP",
    subjectTemplate: "Invoice {{invoiceNumber}} requires your approval",
    bodyTemplate: "An AP invoice from {{vendorName}} for {{amount}} is awaiting your approval.",
  },
  {
    key: "budget_approval_request",
    name: "Budget approval requested",
    channel: "IN_APP",
    subjectTemplate: "Budget {{budgetName}} v{{version}} ready for approval",
    bodyTemplate: "{{budgetName}} (v{{version}}) is ready for your approval review.",
  },
  {
    key: "audit_request_assigned",
    name: "Audit request assigned",
    channel: "IN_APP",
    subjectTemplate: "Audit request: {{title}}",
    bodyTemplate: "An audit request has been assigned to you: {{title}}.",
  },
  {
    key: "kpi_alert",
    name: "KPI alert",
    channel: "IN_APP",
    subjectTemplate: "KPI alert: {{kpiName}}",
    bodyTemplate: "{{kpiName}} crossed its {{kind}} threshold (value {{value}}).",
  },
] as const;

export async function ensureSystemTemplates(clubId: string) {
  for (const t of DEFAULT_TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: { clubId_key: { clubId, key: t.key } },
      update: { name: t.name, channel: t.channel, subjectTemplate: t.subjectTemplate, bodyTemplate: t.bodyTemplate, isSystem: true, isActive: true },
      create: { clubId, key: t.key, name: t.name, channel: t.channel, subjectTemplate: t.subjectTemplate, bodyTemplate: t.bodyTemplate, isSystem: true, isActive: true },
    });
  }
}
