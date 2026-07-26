// Phase 11B — Webhook secret rotation.
//
// State machine:
//   1. createSubscription() at Phase 10 inserts v1 with state=ACTIVE.
//   2. rotate() creates v(n+1) with state=PENDING and a new random secret.
//   3. activate() marks v(n+1) as ACTIVE and the previous v(n) as EXPIRED
//      with a grace `expiresAt` (default 7 days). During the grace window,
//      outbound payloads sign with the new secret but receiving systems can
//      still verify against the old secret in their own logic.
//   4. expirePrevious() forcibly revokes the previous ACTIVE secret.
//   5. rollback() reverts a still-PENDING rotation (returns to v(n) ACTIVE,
//      revokes the PENDING v(n+1)).
//
// Each transition writes a WebhookSecretRotation audit row.

import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
// Phase 12A — Encrypt the WebhookSecretVersion.secret column at rest. Existing
// cleartext rows continue to work via the isEncryptedBlob() check.
import { encryptSecret, decryptSecret, isEncryptedBlob } from "../kms";
import { assertSensitiveActionAllowed } from "../posting-guard";

const DEFAULT_GRACE_DAYS = 7;

function generateSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function logRotation(args: { subscriptionId: string; clubId: string; action: string; byUserId?: string; versionId?: string | null; reason?: string | null }) {
  return prisma.webhookSecretRotation.create({
    data: {
      clubId: args.clubId, subscriptionId: args.subscriptionId,
      versionId: args.versionId ?? null, action: args.action,
      byUserId: args.byUserId ?? null, reason: args.reason ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Initialize: backfill a v1 row for an existing subscription that doesn't
// have a version row yet. Idempotent.
// ---------------------------------------------------------------------------
export async function ensureInitialVersion(subscriptionId: string) {
  const existing = await prisma.webhookSecretVersion.findFirst({ where: { subscriptionId } });
  if (existing) return existing;
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  return prisma.webhookSecretVersion.create({
    data: {
      clubId: sub.clubId, subscriptionId,
      versionNumber: 1, state: "ACTIVE", secret: sub.secret,
      activatedAt: sub.createdAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Resolve the secret to sign with. Prefer ACTIVE version; fall back to the
// inline `WebhookSubscription.secret` (legacy single-secret column).
// Phase 12A: decrypts the at-rest envelope-encrypted secret transparently.
// ---------------------------------------------------------------------------
export async function activeSecretFor(subscriptionId: string): Promise<string> {
  const active = await prisma.webhookSecretVersion.findFirst({
    where: { subscriptionId, state: "ACTIVE" },
    orderBy: { versionNumber: "desc" },
  });
  if (active) {
    if (isEncryptedBlob(active.secret)) {
      return decryptSecret({ scope: "WEBHOOK", secretReference: `webhook:${subscriptionId}:v${active.versionNumber}`, ciphertext: active.secret, clubId: active.clubId });
    }
    return active.secret;
  }
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return "";
  if (isEncryptedBlob(sub.secret)) {
    return decryptSecret({ scope: "WEBHOOK", secretReference: `webhook:${subscriptionId}:legacy`, ciphertext: sub.secret, clubId: sub.clubId });
  }
  return sub.secret;
}

// ---------------------------------------------------------------------------
// Rotation flow
// ---------------------------------------------------------------------------
export const rotateSchema = z.object({
  subscriptionId: z.string(),
  graceDays: z.number().int().min(0).max(90).optional(),
});

export async function rotate(principal: Principal, raw: unknown) {
  const parsed = rotateSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const { subscriptionId, graceDays } = parsed.data;
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  requirePermission(principal, sub.clubId, "settings:write");
  await assertSensitiveActionAllowed(principal, sub.clubId, "webhook.secret.rotate.create", "WebhookSubscription", subscriptionId);
  // Block if a pending rotation is in flight.
  const pending = await prisma.webhookSecretVersion.findFirst({ where: { subscriptionId, state: "PENDING" } });
  if (pending) throw new ConflictError("A rotation is already pending; activate or roll it back first");
  await ensureInitialVersion(subscriptionId);
  const latest = await prisma.webhookSecretVersion.findFirst({
    where: { subscriptionId }, orderBy: { versionNumber: "desc" },
  });
  const newSecret = generateSecret();
  // Phase 12A: store the encrypted blob; runtime decrypts on demand.
  const encryptedSecret = await encryptSecret({
    scope: "WEBHOOK",
    secretReference: `webhook:${subscriptionId}:v${(latest?.versionNumber ?? 0) + 1}`,
    plaintext: newSecret,
    clubId: sub.clubId,
    actorUserId: principal.id,
  });
  const version = await prisma.webhookSecretVersion.create({
    data: {
      clubId: sub.clubId, subscriptionId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      state: "PENDING", secret: encryptedSecret,
      createdByUserId: principal.id,
    },
  });
  await logRotation({ subscriptionId, clubId: sub.clubId, action: "CREATED", versionId: version.id, byUserId: principal.id });
  await audit(principal, { action: "webhook.secret.rotate.create", entityType: "WebhookSecretVersion", entityId: version.id, clubId: sub.clubId, after: { versionNumber: version.versionNumber } });
  // Return the raw secret ONCE so the admin can copy it.
  return { version, secret: newSecret, graceDays: graceDays ?? DEFAULT_GRACE_DAYS };
}

export async function activate(principal: Principal, subscriptionId: string, graceDays = DEFAULT_GRACE_DAYS) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  requirePermission(principal, sub.clubId, "settings:write");
  await assertSensitiveActionAllowed(principal, sub.clubId, "webhook.secret.rotate.activate", "WebhookSubscription", subscriptionId);
  const pending = await prisma.webhookSecretVersion.findFirst({
    where: { subscriptionId, state: "PENDING" },
    orderBy: { versionNumber: "desc" },
  });
  if (!pending) throw new ConflictError("No pending rotation to activate");
  const expiresAt = new Date(Date.now() + graceDays * 86400000);
  await prisma.$transaction([
    // Expire the current ACTIVE — grace window: receivers can still verify.
    prisma.webhookSecretVersion.updateMany({
      where: { subscriptionId, state: "ACTIVE" },
      data: { state: "EXPIRED", expiresAt },
    }),
    // Promote the pending version.
    prisma.webhookSecretVersion.update({
      where: { id: pending.id },
      data: { state: "ACTIVE", activatedAt: new Date() },
    }),
    // Update the WebhookSubscription.secret cache. Phase 12A: the cached
    // value mirrors the encrypted blob — outbound signing transparently
    // decrypts via activeSecretFor().
    prisma.webhookSubscription.update({
      where: { id: subscriptionId }, data: { secret: pending.secret },
    }),
  ]);
  await logRotation({ subscriptionId, clubId: sub.clubId, action: "ACTIVATED", versionId: pending.id, byUserId: principal.id });
  await audit(principal, { action: "webhook.secret.rotate.activate", entityType: "WebhookSecretVersion", entityId: pending.id, clubId: sub.clubId, after: { versionNumber: pending.versionNumber, expiresAt: expiresAt.toISOString() } });
  return { activatedVersion: pending, graceExpiresAt: expiresAt };
}

export async function rollback(principal: Principal, subscriptionId: string, reason?: string) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  requirePermission(principal, sub.clubId, "settings:write");
  const pending = await prisma.webhookSecretVersion.findFirst({ where: { subscriptionId, state: "PENDING" } });
  if (!pending) throw new ConflictError("No pending rotation to roll back");
  const revoked = await prisma.webhookSecretVersion.update({
    where: { id: pending.id }, data: { state: "REVOKED", revokedAt: new Date() },
  });
  await logRotation({ subscriptionId, clubId: sub.clubId, action: "ROLLED_BACK", versionId: pending.id, byUserId: principal.id, reason });
  await audit(principal, { action: "webhook.secret.rotate.rollback", entityType: "WebhookSecretVersion", entityId: pending.id, clubId: sub.clubId, after: { reason } });
  return revoked;
}

export async function expirePrevious(principal: Principal, subscriptionId: string) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  requirePermission(principal, sub.clubId, "settings:write");
  const expired = await prisma.webhookSecretVersion.updateMany({
    where: { subscriptionId, state: "EXPIRED" },
    data: { state: "REVOKED", revokedAt: new Date() },
  });
  await logRotation({ subscriptionId, clubId: sub.clubId, action: "EXPIRED", byUserId: principal.id });
  await audit(principal, { action: "webhook.secret.rotate.expire", entityType: "WebhookSubscription", entityId: subscriptionId, clubId: sub.clubId, after: { count: expired.count } });
  return { revokedCount: expired.count };
}

export async function listVersions(principal: Principal, subscriptionId: string) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  requirePermission(principal, sub.clubId, "settings:read");
  const rows = await prisma.webhookSecretVersion.findMany({
    where: { subscriptionId },
    orderBy: { versionNumber: "desc" },
  });
  // Mask the secret value in the API response.
  return rows.map((r) => ({ ...r, secret: r.secret.slice(0, 4) + "…" }));
}

export async function listRotationHistory(principal: Principal, subscriptionId: string) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw new NotFoundError("WebhookSubscription", subscriptionId);
  requirePermission(principal, sub.clubId, "settings:read");
  return prisma.webhookSecretRotation.findMany({
    where: { subscriptionId },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });
}
