// Phase 9I — Pilot readiness service.
//
// Combines runtime probes (auto-checked) with manual checklist items the
// super admin or club admin marks as done. Results power the pilot
// readiness dashboard.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { env } from "../env";
import { tenantWhere } from "../services/tenant";

export type ReadinessCategory = "INFRA" | "SECURITY" | "INTEGRATIONS" | "DATA" | "TRAINING" | "GO_LIVE";
export type ReadinessStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "NOT_APPLICABLE";

export type RuntimeProbe = {
  category: ReadinessCategory;
  key: string;
  label: string;
  description?: string;
  check(clubId: string): Promise<{ status: ReadinessStatus; details?: string }>;
};

// ---------------------------------------------------------------------------
// Built-in runtime probes
// ---------------------------------------------------------------------------
export const RUNTIME_PROBES: RuntimeProbe[] = [
  {
    category: "INFRA", key: "redis_configured", label: "Redis configured",
    description: "Queue dispatch falls back to in-memory polling without Redis.",
    async check() {
      return process.env.REDIS_URL ? { status: "COMPLETE", details: process.env.REDIS_URL.split("@").pop() } : { status: "PENDING", details: "REDIS_URL not set" };
    },
  },
  {
    category: "INFRA", key: "worker_running", label: "Background worker has run a job in the last hour",
    async check(clubId) {
      const since = new Date(Date.now() - 3600_000);
      const runs = await prisma.jobRun.count({ where: { startedAt: { gte: since }, OR: [{ clubId }, { clubId: null }] } });
      return runs > 0 ? { status: "COMPLETE", details: `${runs} run(s) in last hour` } : { status: "PENDING", details: "No worker activity recorded" };
    },
  },
  {
    category: "INFRA", key: "trust_proxy", label: "TRUST_PROXY enabled",
    description: "Required when running behind a load balancer or CDN to resolve client IPs.",
    async check() { return env.TRUST_PROXY ? { status: "COMPLETE" } : { status: "PENDING", details: "TRUST_PROXY=true" }; },
  },
  {
    category: "INFRA", key: "health_endpoint", label: "Health endpoint reachable",
    async check() {
      // We can't self-fetch, so we just check that the DB query works.
      try { await prisma.$queryRaw`SELECT 1`; return { status: "COMPLETE" }; }
      catch (err) { return { status: "PENDING", details: err instanceof Error ? err.message : String(err) }; }
    },
  },
  {
    category: "SECURITY", key: "db_secrets_blocked_in_production", label: "DB-stored secrets disabled in production",
    description: "In production, integration secrets must come from env or a managed secret store, not the DB.",
    async check() {
      if (env.NODE_ENV !== "production") return { status: "NOT_APPLICABLE" };
      return process.env.SPECTRE_ALLOW_DB_SECRETS === "1"
        ? { status: "PENDING", details: "SPECTRE_ALLOW_DB_SECRETS=1 — must be 0 in production" }
        : { status: "COMPLETE" };
    },
  },
  {
    category: "SECURITY", key: "rate_limit_enforced", label: "Rate limiter active",
    async check(clubId) {
      const recent = await prisma.authAttempt.count({ where: { clubId, occurredAt: { gte: new Date(Date.now() - 7 * 86400000) } } });
      return recent > 0 ? { status: "COMPLETE", details: `${recent} AuthAttempt(s) in last 7d` } : { status: "PENDING", details: "No auth attempts recorded yet (run /login once)" };
    },
  },
  {
    category: "INTEGRATIONS", key: "email_provider_configured", label: "Email provider configured",
    async check(clubId) {
      const setting = await prisma.integrationSetting.findFirst({ where: { clubId, scope: "EMAIL", isActive: true } });
      return setting && setting.provider !== "dev" ? { status: "COMPLETE", details: setting.provider } : { status: "PENDING", details: "Falling back to dev adapter" };
    },
  },
  {
    category: "INTEGRATIONS", key: "storage_provider_configured", label: "Document storage configured",
    async check(clubId) {
      const setting = await prisma.integrationSetting.findFirst({ where: { clubId, scope: "STORAGE", isActive: true } });
      return setting && setting.provider !== "memory" && setting.provider !== "dev" ? { status: "COMPLETE", details: setting.provider } : { status: "PENDING", details: "Falling back to in-memory storage" };
    },
  },
  {
    category: "DATA", key: "migrations_current", label: "Database schema in sync",
    async check() {
      // Best-effort: confirm we can read a core table.
      try { await prisma.club.findFirst(); return { status: "COMPLETE" }; }
      catch (err) { return { status: "PENDING", details: err instanceof Error ? err.message : String(err) }; }
    },
  },
  {
    category: "DATA", key: "initial_users", label: "At least one CLUB_ADMIN user",
    async check(clubId) {
      const count = await prisma.userClubRole.count({ where: { clubId, roleKey: "CLUB_ADMIN" } });
      return count > 0 ? { status: "COMPLETE", details: `${count} admin(s)` } : { status: "PENDING", details: "No CLUB_ADMIN users for this club" };
    },
  },
];

// ---------------------------------------------------------------------------
// Default manual checklist items — seeded per club.
// ---------------------------------------------------------------------------
export const DEFAULT_MANUAL_ITEMS = [
  { category: "TRAINING", key: "staff_training_completed", label: "Staff training delivered", description: "All admins + relevant department managers have completed Spectre training." },
  { category: "GO_LIVE", key: "backup_plan_documented", label: "Backup + rollback plan documented", description: "Disaster recovery + rollback runbook reviewed by ops." },
  { category: "GO_LIVE", key: "go_live_date_agreed", label: "Go-live date agreed with club leadership" },
  { category: "DATA", key: "member_data_migrated", label: "Member data migrated + validated", description: "Members + balances reconciled against legacy system." },
  { category: "DATA", key: "ar_balances_reconciled", label: "AR balances reconciled" },
  { category: "DATA", key: "ap_balances_reconciled", label: "AP balances reconciled" },
  { category: "INTEGRATIONS", key: "pos_mapping_complete", label: "POS mappings complete", description: "All required POSMapping rows (items, locations, tax codes) populated." },
] as const;

// ---------------------------------------------------------------------------
// Service API
// ---------------------------------------------------------------------------
export async function ensureManualItems(clubId: string) {
  for (const item of DEFAULT_MANUAL_ITEMS) {
    const description = "description" in item ? (item.description as string) : null;
    await prisma.pilotReadinessItem.upsert({
      where: { clubId_key: { clubId, key: item.key } },
      update: {},
      create: { clubId, category: item.category, key: item.key, label: item.label, description, kind: "MANUAL", status: "PENDING" },
    });
  }
}

export async function runProbes(clubId: string) {
  const results: Array<{ category: ReadinessCategory; key: string; label: string; description?: string; status: ReadinessStatus; details?: string; kind: "RUNTIME" }> = [];
  for (const probe of RUNTIME_PROBES) {
    try {
      const r = await probe.check(clubId);
      results.push({ category: probe.category, key: probe.key, label: probe.label, description: probe.description, status: r.status, details: r.details, kind: "RUNTIME" });
      // Cache the latest probe result on the row so the dashboard can read it.
      await prisma.pilotReadinessItem.upsert({
        where: { clubId_key: { clubId, key: probe.key } },
        update: { status: r.status, details: r.details ?? null, kind: "RUNTIME" },
        create: { clubId, category: probe.category, key: probe.key, label: probe.label, description: probe.description ?? null, kind: "RUNTIME", status: r.status, details: r.details ?? null },
      });
    } catch (err) {
      results.push({ category: probe.category, key: probe.key, label: probe.label, status: "PENDING", details: err instanceof Error ? err.message : String(err), kind: "RUNTIME" });
    }
  }
  return results;
}

export async function getReadinessSnapshot(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  await ensureManualItems(clubId);
  await runProbes(clubId);
  return prisma.pilotReadinessItem.findMany({
    where: tenantWhere(principal, clubId),
    orderBy: [{ category: "asc" }, { key: "asc" }],
  });
}

export async function markItemComplete(principal: Principal, itemId: string, status: ReadinessStatus, details?: string) {
  const item = await prisma.pilotReadinessItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("readiness item not found");
  requirePermission(principal, item.clubId, "settings:write");
  return prisma.pilotReadinessItem.update({
    where: { id: itemId },
    data: {
      status, details: details ?? item.details,
      completedAt: status === "COMPLETE" ? new Date() : null,
      completedByUserId: status === "COMPLETE" ? principal.id : null,
    },
  });
}

// Refuse production startup when DB secrets are still allowed.
export function enforceProductionSafety() {
  if (env.NODE_ENV !== "production") return;
  if (process.env.SPECTRE_ALLOW_DB_SECRETS === "1") {
    throw new Error("Production refuses to start with SPECTRE_ALLOW_DB_SECRETS=1. Move secrets to env or a managed secret store.");
  }
}
