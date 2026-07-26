// Phase 8J — Feature flag service.
//
// Flags resolve in two levels:
//   1. Club-scoped row (clubId set) — wins if found.
//   2. Global default row (clubId=null) — fallback.
// `rolloutPercent` allows gradual enable: a hash of (clubId, key) is mapped
// to 0-99; the flag is on if hash < rolloutPercent. This is deterministic
// per club so a club always sees the same answer between requests.

import { createHash } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError } from "../errors";

export type FeatureFlagKey = string;

const cache = new Map<string, { value: boolean; expires: number }>();
const CACHE_TTL_MS = 30_000;

export async function isFeatureEnabled(clubId: string | null, key: FeatureFlagKey): Promise<boolean> {
  const cacheKey = `${clubId ?? "global"}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  let row = clubId ? await prisma.featureFlag.findFirst({ where: { clubId, key } }) : null;
  if (!row) row = await prisma.featureFlag.findFirst({ where: { clubId: null, key } });
  let value = false;
  if (row) {
    if (row.isEnabled) {
      if (row.rolloutPercent >= 100) value = true;
      else if (row.rolloutPercent <= 0) value = false;
      else {
        // Hash-based deterministic gradual rollout.
        const hash = createHash("md5").update(`${row.id}:${clubId ?? "global"}`).digest("hex");
        const bucket = parseInt(hash.slice(0, 8), 16) % 100;
        value = bucket < row.rolloutPercent;
      }
    }
  }
  cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function setFlag(principal: Principal, args: { clubId: string | null; key: string; name: string; description?: string | null; isEnabled: boolean; rolloutPercent?: number; scope?: "PHASE" | "MODULE" | "EXPERIMENT" }) {
  if (args.clubId) {
    requirePermission(principal, args.clubId, "settings:write");
  } else {
    // Global flags require SUPER_ADMIN.
    const isSuper = principal.memberships.some((m) => m.clubId === null && m.roleKey === "SUPER_ADMIN");
    if (!isSuper) throw new ConflictError("Only SUPER_ADMIN can set global flags");
  }
  // Compound unique on (clubId, key) where clubId is nullable — emulate upsert
  // because Prisma's typed where for nullable composite keys is awkward.
  const existing = await prisma.featureFlag.findFirst({ where: { clubId: args.clubId, key: args.key } });
  const flag = existing
    ? await prisma.featureFlag.update({
        where: { id: existing.id },
        data: { name: args.name, description: args.description ?? null, isEnabled: args.isEnabled, rolloutPercent: args.rolloutPercent ?? (args.isEnabled ? 100 : 0), scope: args.scope ?? "MODULE" },
      })
    : await prisma.featureFlag.create({
        data: { clubId: args.clubId, key: args.key, name: args.name, description: args.description ?? null, isEnabled: args.isEnabled, rolloutPercent: args.rolloutPercent ?? (args.isEnabled ? 100 : 0), scope: args.scope ?? "MODULE" },
      });
  await audit(principal, { action: "flag.set", entityType: "FeatureFlag", entityId: flag.id, clubId: args.clubId, after: { key: args.key, isEnabled: args.isEnabled, rolloutPercent: flag.rolloutPercent } });
  // Bust cache.
  for (const k of cache.keys()) if (k.endsWith(`:${args.key}`)) cache.delete(k);
  return flag;
}

export async function listFlags(principal: Principal, clubId: string | null) {
  if (clubId) requirePermission(principal, clubId, "settings:read");
  return prisma.featureFlag.findMany({
    where: { OR: [{ clubId }, { clubId: null }] },
    orderBy: [{ scope: "asc" }, { key: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Canonical flag keys (sync with admin UI hint).
// ---------------------------------------------------------------------------
export const FEATURE_FLAGS = {
  TEE_SHEET: "tee_sheet",
  POS_WEBHOOKS: "pos_webhooks",
  LLM_COMMENTARY: "llm_commentary",
  PWA_PUSH: "pwa_push",
  HARDWARE_DEVICES: "hardware_devices",
  BETA_INSIGHTS: "beta_insights",
  AUDITOR_PORTAL: "auditor_portal",
} as const;
