// Phase 14D — Email delivery events + suppression list.
//
// Two things happen here:
//   1. `recordEvent()` is called by the provider-webhook adapter when a
//      delivery state change arrives (delivered, bounce, complaint, …).
//      It writes an EmailDeliveryEvent row, then updates the linked record
//      (MemberPortalInvite, NotificationDelivery, etc.).
//   2. `isSuppressed()` is the boundary check the mail send helper calls
//      *before* handing the message to the provider. Suppressed addresses
//      (hard bounce / spam complaint / unsubscribe) are never re-tried.
//
// The provider-agnostic webhook handler in src/lib/integrations/email.ts
// translates SES / Postmark / SendGrid payloads into the canonical shape
// recordEvent() expects.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

export type EmailEventKind =
  | "DELIVERED"
  | "OPENED"
  | "CLICKED"
  | "HARD_BOUNCE"
  | "SOFT_BOUNCE"
  | "SPAM_COMPLAINT"
  | "UNSUBSCRIBE"
  | "DELAYED"
  | "FAILED";

const HARD_FAILURE_KINDS = new Set<EmailEventKind>(["HARD_BOUNCE", "SPAM_COMPLAINT", "UNSUBSCRIBE"]);

// ---------------------------------------------------------------------------
// Boundary check — call before any outbound send.
// ---------------------------------------------------------------------------
export async function isSuppressed(email: string, clubId?: string | null): Promise<{ suppressed: boolean; reason?: string }> {
  const normalized = email.trim().toLowerCase();
  const suppression = await prisma.emailSuppression.findFirst({
    where: {
      email: normalized,
      OR: [{ clubId: clubId ?? null }, { clubId: null }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
  });
  if (suppression) return { suppressed: true, reason: suppression.reason };
  return { suppressed: false };
}

// ---------------------------------------------------------------------------
// Record a delivery event from a provider webhook.
// ---------------------------------------------------------------------------
export const recordEventSchema = z.object({
  clubId: z.string().optional(),
  email: z.string().email(),
  kind: z.enum(["DELIVERED", "OPENED", "CLICKED", "HARD_BOUNCE", "SOFT_BOUNCE", "SPAM_COMPLAINT", "UNSUBSCRIBE", "DELAYED", "FAILED"]),
  provider: z.string().max(80).default("unknown"),
  messageId: z.string().max(200).optional(),
  reason: z.string().max(2000).optional(),
  rawPayload: z.string().max(20000).optional(),
  inviteId: z.string().optional(),
  notificationDeliveryId: z.string().optional(),
});

export async function recordEvent(raw: unknown) {
  const parsed = recordEventSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const event = await prisma.emailDeliveryEvent.create({
    data: {
      clubId: parsed.data.clubId ?? null,
      email: normalizedEmail,
      kind: parsed.data.kind,
      provider: parsed.data.provider,
      messageId: parsed.data.messageId ?? null,
      reason: parsed.data.reason ?? null,
      rawPayload: parsed.data.rawPayload ?? null,
      inviteId: parsed.data.inviteId ?? null,
      notificationDeliveryId: parsed.data.notificationDeliveryId ?? null,
    },
  });

  // Cascade into the suppression list for hard failure kinds. Compound-unique
  // semantics with a nullable column are awkward in Prisma, so we use
  // findFirst + create/update instead of upsert.
  if (HARD_FAILURE_KINDS.has(parsed.data.kind as EmailEventKind)) {
    const reason = parsed.data.kind === "HARD_BOUNCE" ? "HARD_BOUNCE"
      : parsed.data.kind === "SPAM_COMPLAINT" ? "SPAM"
      : "UNSUBSCRIBE";
    const existing = await prisma.emailSuppression.findFirst({
      where: { clubId: parsed.data.clubId ?? null, email: normalizedEmail },
    });
    if (existing) {
      await prisma.emailSuppression.update({ where: { id: existing.id }, data: { reason } });
    } else {
      await prisma.emailSuppression.create({
        data: { clubId: parsed.data.clubId ?? null, email: normalizedEmail, reason },
      });
    }
  }

  // Cascade into linked invite (FAILED for hard bounce; SENT remains for soft).
  if (parsed.data.inviteId) {
    const invite = await prisma.memberPortalInvite.findUnique({ where: { id: parsed.data.inviteId } });
    if (invite) {
      if (parsed.data.kind === "HARD_BOUNCE" || parsed.data.kind === "FAILED") {
        await prisma.memberPortalInvite.update({
          where: { id: invite.id },
          data: { status: "FAILED", lastError: parsed.data.reason ?? parsed.data.kind },
        });
      } else if (parsed.data.kind === "SOFT_BOUNCE" || parsed.data.kind === "DELAYED") {
        await prisma.memberPortalInvite.update({
          where: { id: invite.id },
          data: { lastError: `Delayed: ${parsed.data.reason ?? parsed.data.kind}` },
        });
      } else if (parsed.data.kind === "DELIVERED") {
        // Reset any soft-bounce error.
        await prisma.memberPortalInvite.update({
          where: { id: invite.id },
          data: { lastError: null },
        });
      }
    }
  }

  return event;
}

// ---------------------------------------------------------------------------
// Suppression list management
// ---------------------------------------------------------------------------
export const addSuppressionSchema = z.object({
  clubId: z.string().optional(),
  email: z.string().email(),
  reason: z.enum(["HARD_BOUNCE", "SPAM", "UNSUBSCRIBE", "MANUAL"]).default("MANUAL"),
  expiresAt: z.string().datetime().optional(),
});

export async function addSuppression(principal: Principal, raw: unknown) {
  const parsed = addSuppressionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  // Either SUPER_ADMIN (for global) or club admin (for tenant-scoped) can add.
  if (!parsed.data.clubId && !isSuperAdmin(principal)) {
    throw new ForbiddenError("Only SUPER_ADMIN may add global suppressions");
  }
  const existing = await prisma.emailSuppression.findFirst({
    where: { clubId: parsed.data.clubId ?? null, email: normalizedEmail },
  });
  const suppression = existing
    ? await prisma.emailSuppression.update({
        where: { id: existing.id },
        data: {
          reason: parsed.data.reason,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        },
      })
    : await prisma.emailSuppression.create({
        data: {
          clubId: parsed.data.clubId ?? null,
          email: normalizedEmail,
          reason: parsed.data.reason,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
          addedByUserId: principal.id,
        },
      });
  await audit(principal, {
    action: "email.suppression.add",
    entityType: "EmailSuppression",
    entityId: suppression.id,
    clubId: parsed.data.clubId ?? null,
    after: { email: normalizedEmail, reason: parsed.data.reason },
  });
  return suppression;
}

export async function removeSuppression(principal: Principal, suppressionId: string) {
  const s = await prisma.emailSuppression.findUnique({ where: { id: suppressionId } });
  if (!s) throw new NotFoundError("EmailSuppression", suppressionId);
  if (!s.clubId && !isSuperAdmin(principal)) {
    throw new ForbiddenError("Only SUPER_ADMIN may remove global suppressions");
  }
  await prisma.emailSuppression.delete({ where: { id: suppressionId } });
  await audit(principal, {
    action: "email.suppression.remove",
    entityType: "EmailSuppression",
    entityId: suppressionId,
    clubId: s.clubId ?? null,
  });
}

export async function listSuppressions(args: { clubId?: string } = {}) {
  return prisma.emailSuppression.findMany({
    where: { OR: [{ clubId: args.clubId ?? null }, { clubId: null }] },
    orderBy: { addedAt: "desc" },
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Bounce / failure dashboard summaries
// ---------------------------------------------------------------------------
export async function bounceSummary(clubId: string, windowDays = 14) {
  const since = new Date(Date.now() - windowDays * 86400_000);
  const events = await prisma.emailDeliveryEvent.groupBy({
    by: ["kind"],
    where: { clubId, occurredAt: { gte: since } },
    _count: true,
  });
  return Object.fromEntries(events.map((e) => [e.kind, e._count]));
}

export async function recentFailedInvites(clubId: string) {
  return prisma.memberPortalInvite.findMany({
    where: { clubId, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

// ---------------------------------------------------------------------------
// Resend with a corrected email address (atomic — old invite FAILED stays
// in history, new invite is issued for the corrected address).
// ---------------------------------------------------------------------------
export const resendCorrectedSchema = z.object({
  inviteId: z.string(),
  newEmail: z.string().email(),
});

export async function resendWithCorrectedEmail(principal: Principal, raw: unknown) {
  const parsed = resendCorrectedSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const invite = await prisma.memberPortalInvite.findUnique({ where: { id: parsed.data.inviteId } });
  if (!invite) throw new NotFoundError("MemberPortalInvite", parsed.data.inviteId);
  // Check the new email isn't already suppressed.
  const suppressed = await isSuppressed(parsed.data.newEmail, invite.clubId);
  if (suppressed.suppressed) throw new ConflictError(`New email is on the suppression list (${suppressed.reason})`);
  // Defer to the existing createInvite helper.
  const { createInvite } = await import("../member-invites");
  return createInvite(principal, { clubId: invite.clubId, memberId: invite.memberId, email: parsed.data.newEmail });
}
