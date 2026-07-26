// Phase 9H — External API: key issuance + authentication.
//
// Lifecycle:
//   1. Admin creates an ApiKey (server returns the raw value ONCE; only the
//      sha256 hash is persisted).
//   2. Caller sends Authorization: Bearer <key> on every API request.
//   3. authenticate() resolves the key by prefix → hash check, returns the
//      ApiKey + scoped permission set or null.
//   4. Each request logs to ApiRequestLog (correlation IDs, durations).

import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";

const KEY_PREFIX_LEN = 8;

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export const createKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  permissions: z.array(z.string()).default([]),
  ipAllowlist: z.array(z.string()).optional(),
  expiresAt: z.string().optional().nullable(),
});

export async function createApiKey(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = createKeySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  // Format: "sk_<clubSlugFragment>_<random>". The full key is shown only here.
  const random = randomBytes(24).toString("base64url");
  const rawKey = `sk_${clubId.slice(0, 6)}_${random}`;
  const keyPrefix = rawKey.slice(0, KEY_PREFIX_LEN);
  const keyHash = hashKey(rawKey);

  const apiKey = await prisma.apiKey.create({
    data: {
      clubId, name: d.name, keyPrefix, keyHash, status: "ACTIVE",
      ipAllowlist: d.ipAllowlist?.join(",") ?? null,
      expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
      createdByUserId: principal.id,
    },
  });
  for (const perm of d.permissions) {
    await prisma.apiKeyPermission.create({ data: { clubId, apiKeyId: apiKey.id, permission: perm } });
  }
  await audit(principal, { action: "apikey.create", entityType: "ApiKey", entityId: apiKey.id, clubId, after: { name: d.name, permissions: d.permissions, prefix: keyPrefix } });
  return { apiKey, rawKey }; // rawKey shown ONCE in the response and never persisted.
}

export async function revokeApiKey(principal: Principal, keyId: string) {
  const key = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!key) throw new ConflictError("api key not found");
  requirePermission(principal, key.clubId, "settings:write");
  const updated = await prisma.apiKey.update({
    where: { id: keyId },
    data: { status: "REVOKED", revokedAt: new Date(), revokedByUserId: principal.id },
  });
  await audit(principal, { action: "apikey.revoke", entityType: "ApiKey", entityId: keyId, clubId: key.clubId });
  return updated;
}

export async function listApiKeys(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.apiKey.findMany({
    where: tenantWhere(principal, clubId),
    include: { permissions: true },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Authenticate an inbound API request
// ---------------------------------------------------------------------------
export async function authenticate(args: { authorization: string | null; ip?: string }): Promise<{
  apiKey: { id: string; clubId: string };
  permissions: string[];
} | { error: "missing" | "malformed" | "unknown" | "revoked" | "expired" | "ip" }> {
  if (!args.authorization) return { error: "missing" };
  const match = /^Bearer\s+(\S+)$/i.exec(args.authorization.trim());
  if (!match) return { error: "malformed" };
  const rawKey = match[1];
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN);
  const found = await prisma.apiKey.findFirst({
    where: { keyPrefix: prefix },
    include: { permissions: true },
  });
  if (!found) return { error: "unknown" };
  if (found.keyHash !== hashKey(rawKey)) return { error: "unknown" };
  if (found.status === "REVOKED") return { error: "revoked" };
  if (found.expiresAt && found.expiresAt < new Date()) return { error: "expired" };
  if (found.ipAllowlist && args.ip) {
    const allow = found.ipAllowlist.split(",").map((s) => s.trim()).filter(Boolean);
    if (allow.length > 0 && !allow.includes(args.ip)) return { error: "ip" };
  }
  // Best-effort lastUsedAt update.
  void prisma.apiKey.update({ where: { id: found.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { apiKey: { id: found.id, clubId: found.clubId }, permissions: found.permissions.map((p) => p.permission) };
}

export async function logApiRequest(args: { clubId: string; apiKeyId?: string | null; method: string; path: string; status: "SUCCESS" | "DENIED" | "RATE_LIMITED" | "ERROR"; responseCode: number; durationMs: number; ip?: string; userAgent?: string; errorMessage?: string }) {
  await prisma.apiRequestLog.create({
    data: {
      clubId: args.clubId, apiKeyId: args.apiKeyId ?? null,
      method: args.method, path: args.path,
      status: args.status, responseCode: args.responseCode, durationMs: args.durationMs,
      ip: args.ip ?? null, userAgent: args.userAgent ?? null,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

// Curated set of resources the external API exposes — keep narrow.
export const API_PERMISSIONS = [
  "members:read", "ar:read", "ap:read",
  "events:read", "events:private:read",
  "inventory:read", "vendor:view",
  "lessons:view", "kpi:read",
  "reports:read",
] as const;
