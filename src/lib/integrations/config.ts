// Phase 7 — Integration configuration loader.
//
// Each club may have integration settings rows for each scope+provider pair.
// At runtime the service layer asks getIntegrationConfig(clubId, scope) for
// the currently active provider; if none is configured the dev / local
// adapter is returned. Secrets never leave the service layer (no API echoes).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { z } from "zod";
import { ConflictError, ValidationError } from "../errors";

export type IntegrationScope = "EMAIL" | "SMS" | "STORAGE" | "LLM" | "POS" | "EXPORT";

export const integrationSchema = z.object({
  scope: z.enum(["EMAIL", "SMS", "STORAGE", "LLM", "POS", "EXPORT"]),
  provider: z.string().trim().min(1).max(60),
  isActive: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.unknown()).optional().nullable(),
});

export async function upsertIntegration(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = integrationSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const existing = await prisma.integrationSetting.findUnique({
    where: { clubId_scope_provider: { clubId, scope: d.scope, provider: d.provider } },
  });
  const setting = await prisma.integrationSetting.upsert({
    where: { clubId_scope_provider: { clubId, scope: d.scope, provider: d.provider } },
    update: {
      isActive: d.isActive,
      configJson: JSON.stringify(d.config ?? {}),
      // Only overwrite secretsJson if new secrets were supplied.
      ...(d.secrets ? { secretsJson: JSON.stringify(d.secrets) } : {}),
      updatedByUserId: principal.id,
    },
    create: {
      clubId, scope: d.scope, provider: d.provider, isActive: d.isActive,
      configJson: JSON.stringify(d.config ?? {}),
      secretsJson: d.secrets ? JSON.stringify(d.secrets) : null,
      updatedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "integration.upsert",
    entityType: "IntegrationSetting", entityId: setting.id, clubId,
    before: existing ? { provider: existing.provider, isActive: existing.isActive } : null,
    after: { provider: d.provider, isActive: d.isActive, hasSecrets: !!d.secrets },
    // Never log secrets — audit() redacts known sensitive keys but be explicit.
  });
  return { ...setting, secretsJson: null }; // never echo secrets
}

export async function getActiveIntegration(clubId: string, scope: IntegrationScope) {
  return prisma.integrationSetting.findFirst({
    where: { clubId, scope, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function listIntegrations(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  const rows = await prisma.integrationSetting.findMany({
    where: { clubId }, orderBy: [{ scope: "asc" }, { provider: "asc" }],
  });
  return rows.map((r) => ({ ...r, secretsJson: null })); // mask secrets in list view
}

export function readConfig<T = Record<string, unknown>>(setting: { configJson: string }): T {
  try { return JSON.parse(setting.configJson) as T; } catch { return {} as T; }
}

export function readSecrets<T = Record<string, unknown>>(setting: { secretsJson: string | null }): T {
  if (!setting.secretsJson) return {} as T;
  try { return JSON.parse(setting.secretsJson) as T; } catch { return {} as T; }
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------
export async function recordIntegrationCheck(args: {
  clubId: string; settingId?: string | null; scope: IntegrationScope; provider: string;
  status: "OK" | "FAIL" | "SKIPPED"; message?: string; durationMs?: number; checkedByUserId?: string | null;
}) {
  const check = await prisma.integrationCheck.create({
    data: {
      clubId: args.clubId, settingId: args.settingId ?? null,
      scope: args.scope, provider: args.provider, status: args.status,
      message: args.message ?? null, durationMs: args.durationMs ?? 0,
      checkedByUserId: args.checkedByUserId ?? null,
    },
  });
  if (args.settingId) {
    await prisma.integrationSetting.update({
      where: { id: args.settingId },
      data: { lastTestedAt: new Date(), lastTestStatus: args.status, lastTestError: args.status === "FAIL" ? (args.message ?? null) : null },
    });
  }
  return check;
}

export async function listChecks(principal: Principal, clubId: string, scope?: IntegrationScope) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.integrationCheck.findMany({
    where: { clubId, ...(scope ? { scope } : {}) },
    orderBy: { checkedAt: "desc" },
    take: 50,
  });
}

export async function deleteIntegration(principal: Principal, clubId: string, scope: IntegrationScope, provider: string) {
  requirePermission(principal, clubId, "settings:write");
  await prisma.integrationSetting.deleteMany({ where: { clubId, scope, provider } });
  await audit(principal, { action: "integration.delete", entityType: "IntegrationSetting", clubId, after: { scope, provider } });
}

// Convenience: detect whether a scope has *any* active configuration.
export async function isScopeConfigured(clubId: string, scope: IntegrationScope): Promise<boolean> {
  const count = await prisma.integrationSetting.count({ where: { clubId, scope, isActive: true } });
  return count > 0;
}

// Configured-or-default summary for the integrations admin UI.
export async function integrationStatusSummary(clubId: string) {
  const scopes: IntegrationScope[] = ["EMAIL", "SMS", "STORAGE", "LLM", "POS", "EXPORT"];
  const rows = await prisma.integrationSetting.findMany({ where: { clubId } });
  const byScope = new Map<IntegrationScope, typeof rows>();
  for (const r of rows) {
    const arr = byScope.get(r.scope as IntegrationScope) ?? [];
    arr.push(r);
    byScope.set(r.scope as IntegrationScope, arr);
  }
  return scopes.map((scope) => {
    const list = byScope.get(scope) ?? [];
    const active = list.find((r) => r.isActive);
    return {
      scope,
      configured: list.length > 0,
      activeProvider: active?.provider ?? null,
      lastTestedAt: active?.lastTestedAt ?? null,
      lastTestStatus: active?.lastTestStatus ?? null,
    };
  });
}
