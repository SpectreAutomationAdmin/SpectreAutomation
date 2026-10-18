// WI-SYNC-1d (2026-10-18) — Microsoft Graph change-notification
// subscription lifecycle service.
//
// Spectre subscribes to Inbox-scoped change notifications so new /
// updated / deleted messages drive an EXPEDITED delta sync in
// seconds rather than waiting for the 60-s poll.  Polling is NOT
// disabled — it remains the recovery fallback for missed
// notifications (Graph delivery is at-least-once + lossy under
// outages).
//
// Lifecycle:
//
//   CREATE:  POST /subscriptions with Inbox resource + a 3-day
//            expiration cap (Graph refuses longer for mail).
//            Store the random clientState's SHA-256 hex in
//            `clientStateSecretRef` so the webhook can verify
//            incoming notifications without storing a plaintext
//            secret at rest.
//   RENEW:   PATCH /subscriptions/{id} with a new expiration
//            BEFORE Graph's hard expiry (we target ~24 h before).
//            renewalFailureCount increments on failure; 3 strikes
//            → RECREATING state (delete + create fresh).
//   DELETE:  DELETE /subscriptions/{id}, idempotent on 404.
//   RECREATE: lifecycleState=REVOKED/EXPIRED/FAILED mailboxes get
//            their row DELETE'd + a fresh CREATE on the next
//            scheduler tick.
//
// Tenant isolation: every row carries clubId; every service call
// re-asserts clubId → mailbox match before any Graph write.

import { prisma } from "@/lib/prisma";
import { createHash, randomBytes } from "node:crypto";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "./connect";
import { logger } from "@/lib/observability/logger";

/** Microsoft Graph caps mail subscriptions at a hair under 3 days.
 *  We target 2d 23h so a flaky renewal has one safe retry before
 *  the hard expiry.  Graph refuses expirationDateTime > ~4230 min
 *  from now; see https://learn.microsoft.com/en-us/graph/webhooks. */
const MAX_LIFETIME_MINUTES = 2 * 24 * 60 + 23 * 60; // 2d 23h
const RENEWAL_WINDOW_MINUTES = 24 * 60; // Renew when < 24 h left.
const INBOX_RESOURCE = "/me/mailFolders('inbox')/messages";
const CHANGE_TYPES = "created,updated,deleted";
const RENEWAL_FAILURE_RECREATE_THRESHOLD = 3;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
function newClientState(): string {
  return randomBytes(24).toString("hex");
}
function newExpiration(now: Date = new Date()): Date {
  return new Date(now.getTime() + MAX_LIFETIME_MINUTES * 60_000);
}

export type SubscriptionAction =
  | "CREATED"
  | "RENEWED"
  | "RECREATED"
  | "ALREADY_ACTIVE"
  | "DELETED"
  | "NO_OP";

export interface MaintainSubscriptionArgs {
  mailboxConnectionId: string;
  clubId: string;
  /** Base URL of the deployed app (e.g. "https://staging.spectreautomation.com").
   *  Appended with /api/webhooks/microsoft-graph/notifications. */
  publicBaseUrl: string;
  /** Caller user id for the delegated token refresh audit. */
  callerUserId: string | null;
  /** When true, treats the mailbox's current subscription as
   *  OBSOLETE regardless of lifecycleState — forces a delete +
   *  recreate.  Used by the recovery path. */
  forceRecreate?: boolean;
}

export interface MaintainSubscriptionResult {
  action: SubscriptionAction;
  mailboxConnectionId: string;
  microsoftSubscriptionId?: string;
  expirationDateTime?: Date;
  renewalFailureCount?: number;
  error?: string;
}

/** The webhook URL Graph POSTs notifications to. */
export function notificationUrlFor(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/api/webhooks/microsoft-graph/notifications`;
}

/**
 * Maintains the subscription for one mailbox.  Idempotent per
 * (mailboxConnectionId): running multiple times leaves the DB in
 * a consistent state.
 */
export async function maintainSubscriptionForMailbox(
  args: MaintainSubscriptionArgs,
): Promise<MaintainSubscriptionResult> {
  const mailbox = await prisma.mailboxConnection.findUnique({
    where: { id: args.mailboxConnectionId },
    select: {
      id: true, clubId: true, userId: true, status: true,
      refreshTokenSecretRef: true, deltaLink: true,
    },
  });
  if (!mailbox) {
    return { action: "NO_OP", mailboxConnectionId: args.mailboxConnectionId, error: "mailbox_not_found" };
  }
  if (mailbox.clubId !== args.clubId) {
    return { action: "NO_OP", mailboxConnectionId: args.mailboxConnectionId, error: "cross_tenant" };
  }
  if (mailbox.status !== "CONNECTED") {
    return { action: "NO_OP", mailboxConnectionId: args.mailboxConnectionId, error: `mailbox_${mailbox.status}` };
  }

  const existing = await prisma.graphSubscription.findFirst({
    where: { mailboxConnectionId: args.mailboxConnectionId },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();
  const needsCreate =
    !existing || args.forceRecreate ||
    existing.lifecycleState === "REVOKED" ||
    existing.lifecycleState === "EXPIRED" ||
    existing.lifecycleState === "FAILED";
  const needsRenew =
    !needsCreate && existing &&
    existing.lifecycleState === "ACTIVE" &&
    existing.expirationDateTime.getTime() - now.getTime() < RENEWAL_WINDOW_MINUTES * 60_000;

  if (!needsCreate && !needsRenew) {
    return {
      action: "ALREADY_ACTIVE",
      mailboxConnectionId: args.mailboxConnectionId,
      microsoftSubscriptionId: existing?.microsoftSubscriptionId,
      expirationDateTime: existing?.expirationDateTime,
      renewalFailureCount: existing?.renewalFailureCount,
    };
  }

  const { accessToken } = await getFreshDelegatedAccessToken({
    mailboxConnectionId: args.mailboxConnectionId,
    callerClubId: args.clubId,
    callerUserId: args.callerUserId ?? mailbox.userId,
  });
  const provider = getMicrosoftDelegatedProvider();

  if (needsCreate) {
    // Delete any existing row (and the Graph-side subscription) if
    // present but obsolete.  Idempotent on Graph 404.
    if (existing) {
      try {
        await provider.deleteSubscription({
          accessToken,
          microsoftSubscriptionId: existing.microsoftSubscriptionId,
        });
      } catch (e) {
        logger.warn("mailbox.subscription.delete-before-create.ignored", {
          mailboxConnectionIdTail: args.mailboxConnectionId.slice(-6),
          error: e instanceof Error ? e.message : String(e),
        });
      }
      await prisma.graphSubscription.delete({ where: { id: existing.id } });
    }
    const clientState = newClientState();
    const expiration = newExpiration(now);
    try {
      const result = await provider.createSubscription({
        accessToken,
        notificationUrl: notificationUrlFor(args.publicBaseUrl),
        clientState,
        resource: INBOX_RESOURCE,
        changeTypes: CHANGE_TYPES,
        expirationDateTime: expiration.toISOString(),
      });
      const row = await prisma.graphSubscription.create({
        data: {
          mailboxConnectionId: args.mailboxConnectionId,
          clubId: args.clubId,
          microsoftSubscriptionId: result.microsoftSubscriptionId,
          resource: result.resource,
          changeTypes: CHANGE_TYPES,
          clientStateSecretRef: sha256(clientState),
          expirationDateTime: new Date(result.expirationDateTime),
          lifecycleState: "ACTIVE",
          renewalFailureCount: 0,
          lastRenewalError: null,
        },
      });
      return {
        action: existing ? "RECREATED" : "CREATED",
        mailboxConnectionId: args.mailboxConnectionId,
        microsoftSubscriptionId: row.microsoftSubscriptionId,
        expirationDateTime: row.expirationDateTime,
        renewalFailureCount: 0,
      };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      logger.error("mailbox.subscription.create.failed", {
        mailboxConnectionIdTail: args.mailboxConnectionId.slice(-6),
        error: err,
      });
      // Record the failure on a FAILED placeholder so the scheduler
      // can see it and retry on the next tick.
      await prisma.graphSubscription.create({
        data: {
          mailboxConnectionId: args.mailboxConnectionId,
          clubId: args.clubId,
          microsoftSubscriptionId: `failed-${Date.now()}`,
          resource: INBOX_RESOURCE,
          changeTypes: CHANGE_TYPES,
          clientStateSecretRef: "FAILED",
          expirationDateTime: now,
          lifecycleState: "FAILED",
          renewalFailureCount: 1,
          lastRenewalError: err.slice(0, 500),
        },
      });
      return {
        action: "NO_OP",
        mailboxConnectionId: args.mailboxConnectionId,
        error: err,
      };
    }
  }

  // RENEW path
  if (existing && needsRenew) {
    const expiration = newExpiration(now);
    try {
      const result = await provider.renewSubscription({
        accessToken,
        microsoftSubscriptionId: existing.microsoftSubscriptionId,
        expirationDateTime: expiration.toISOString(),
      });
      const row = await prisma.graphSubscription.update({
        where: { id: existing.id },
        data: {
          expirationDateTime: new Date(result.expirationDateTime),
          lastRenewalAt: now,
          renewalFailureCount: 0,
          lastRenewalError: null,
        },
      });
      return {
        action: "RENEWED",
        mailboxConnectionId: args.mailboxConnectionId,
        microsoftSubscriptionId: row.microsoftSubscriptionId,
        expirationDateTime: row.expirationDateTime,
        renewalFailureCount: 0,
      };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const nextCount = existing.renewalFailureCount + 1;
      const nextLifecycle =
        nextCount >= RENEWAL_FAILURE_RECREATE_THRESHOLD ? "FAILED" : existing.lifecycleState;
      await prisma.graphSubscription.update({
        where: { id: existing.id },
        data: {
          renewalFailureCount: nextCount,
          lastRenewalError: err.slice(0, 500),
          lifecycleState: nextLifecycle,
        },
      });
      logger.warn("mailbox.subscription.renew.failed", {
        mailboxConnectionIdTail: args.mailboxConnectionId.slice(-6),
        renewalFailureCount: nextCount,
        error: err,
      });
      return {
        action: "NO_OP",
        mailboxConnectionId: args.mailboxConnectionId,
        error: err,
        renewalFailureCount: nextCount,
      };
    }
  }

  return { action: "NO_OP", mailboxConnectionId: args.mailboxConnectionId };
}

/** Hash a plaintext clientState (used by the webhook validator). */
export function hashClientState(input: string): string {
  return sha256(input);
}
