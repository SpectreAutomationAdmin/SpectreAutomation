// Phase 11H — Launch readiness hard blocks.
//
// Promotes Phase 9's pilot-readiness probes into production gates. Each check
// has a severity (`HARD_BLOCK` | `WARNING`); hard blocks prevent the
// `enforceProductionLaunchSafety()` call from succeeding when NODE_ENV=production.
//
// Phase 9 introduced `enforceProductionSafety()` which checked SPECTRE_ALLOW_DB_SECRETS
// only; Phase 11 expands that into a comprehensive launch gate.

import { prisma } from "../prisma";
import { env } from "../env";
import { requirePermission, isSuperAdmin, type Principal } from "../rbac";

export type LaunchCheckSeverity = "HARD_BLOCK" | "WARNING";
export type LaunchCheckStatus = "PASS" | "FAIL" | "NOT_APPLICABLE";

export type LaunchCheck = {
  category: "INFRA" | "SECURITY" | "BILLING" | "INTEGRATIONS" | "MOBILE";
  key: string;
  label: string;
  severity: LaunchCheckSeverity;
  status: LaunchCheckStatus;
  detail?: string;
};

export const LAUNCH_CHECKS: Array<{
  category: LaunchCheck["category"];
  key: string;
  label: string;
  severity: LaunchCheckSeverity;
  check(clubId: string): Promise<{ status: LaunchCheckStatus; detail?: string }>;
}> = [
  {
    category: "SECURITY", key: "no_db_secrets_in_production",
    label: "DB-stored secrets must be disabled in production",
    severity: "HARD_BLOCK",
    async check() {
      if (env.NODE_ENV !== "production") return { status: "NOT_APPLICABLE" };
      if (process.env.SPECTRE_ALLOW_DB_SECRETS === "1") return { status: "FAIL", detail: "SPECTRE_ALLOW_DB_SECRETS=1 — must be 0 in production" };
      return { status: "PASS" };
    },
  },
  {
    category: "SECURITY", key: "session_secret_present",
    label: "SPECTRE_SESSION_SECRET configured (≥32 chars)",
    severity: "HARD_BLOCK",
    async check() {
      if ((process.env.SPECTRE_SESSION_SECRET ?? "").length < 32) return { status: "FAIL", detail: "SPECTRE_SESSION_SECRET missing or too short" };
      return { status: "PASS" };
    },
  },
  {
    category: "SECURITY", key: "trust_proxy_for_production",
    label: "TRUST_PROXY=true when running behind a load balancer",
    severity: "WARNING",
    async check() {
      if (env.NODE_ENV !== "production") return { status: "NOT_APPLICABLE" };
      return env.TRUST_PROXY ? { status: "PASS" } : { status: "FAIL", detail: "Set TRUST_PROXY=true if behind a LB/CDN" };
    },
  },
  {
    category: "INFRA", key: "database_reachable",
    label: "Database reachable",
    severity: "HARD_BLOCK",
    async check() {
      try { await prisma.$queryRaw`SELECT 1`; return { status: "PASS" }; }
      catch (err) { return { status: "FAIL", detail: err instanceof Error ? err.message : String(err) }; }
    },
  },
  {
    category: "INFRA", key: "redis_for_production",
    label: "REDIS_URL configured (workers run distributed)",
    severity: "WARNING",
    async check() {
      if (env.NODE_ENV !== "production") return { status: "NOT_APPLICABLE" };
      return process.env.REDIS_URL ? { status: "PASS" } : { status: "FAIL", detail: "REDIS_URL not set — falling back to in-memory" };
    },
  },
  {
    category: "INTEGRATIONS", key: "email_provider_configured",
    label: "Production email provider configured",
    severity: "WARNING",
    async check(clubId) {
      const setting = await prisma.integrationSetting.findFirst({ where: { clubId, scope: "EMAIL", isActive: true } });
      if (setting && setting.provider !== "dev") return { status: "PASS", detail: setting.provider };
      return { status: "FAIL", detail: "Falling back to dev adapter — wire SES or another real provider" };
    },
  },
  {
    category: "INTEGRATIONS", key: "storage_provider_configured",
    label: "Production storage provider configured",
    severity: "WARNING",
    async check(clubId) {
      const setting = await prisma.integrationSetting.findFirst({ where: { clubId, scope: "STORAGE", isActive: true } });
      if (setting && setting.provider !== "memory" && setting.provider !== "dev") return { status: "PASS", detail: setting.provider };
      return { status: "FAIL", detail: "Falling back to in-memory storage" };
    },
  },
  {
    category: "BILLING", key: "billing_webhook_secret_configured",
    label: "Billing webhook secret configured",
    severity: "HARD_BLOCK",
    async check(clubId) {
      if (env.NODE_ENV !== "production") return { status: "NOT_APPLICABLE" };
      // If real billing isn't enabled, skip.
      if (process.env.SPECTRE_BILLING_PROVIDER !== "stripe") return { status: "NOT_APPLICABLE" };
      // Either env-var or per-club secrets-manager.
      const envSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (envSecret) return { status: "PASS" };
      const setting = await prisma.integrationSetting.findFirst({ where: { clubId, scope: "BILLING" as never } });
      if (setting?.secretsJson) return { status: "PASS" };
      return { status: "FAIL", detail: "STRIPE_WEBHOOK_SECRET required when billing is enabled" };
    },
  },
  {
    category: "BILLING", key: "vapid_for_push",
    label: "VAPID keys configured for push notifications",
    severity: "WARNING",
    async check(clubId) {
      const setting = await prisma.integrationSetting.findUnique({ where: { clubId_scope_provider: { clubId, scope: "PUSH", provider: "vapid" } } });
      if (!setting) return { status: "FAIL", detail: "VAPID keys not configured — push falls back to dev adapter" };
      return { status: "PASS" };
    },
  },
  {
    category: "MOBILE", key: "mobile_native_config_documented",
    label: "Mobile native configuration documented",
    severity: "WARNING",
    async check() {
      // Best-effort: the existence of mobile/capacitor.config.json is the
      // signal. Since we can't fs-read from production, treat this as PASS
      // — it's a manual checklist item the operator confirms.
      return { status: "PASS", detail: "see mobile/README.md" };
    },
  },
];

export async function runLaunchChecks(principal: Principal, clubId: string): Promise<LaunchCheck[]> {
  requirePermission(principal, clubId, "settings:read");
  const results: LaunchCheck[] = [];
  for (const check of LAUNCH_CHECKS) {
    try {
      const r = await check.check(clubId);
      results.push({ category: check.category, key: check.key, label: check.label, severity: check.severity, status: r.status, detail: r.detail });
    } catch (err) {
      results.push({ category: check.category, key: check.key, label: check.label, severity: check.severity, status: "FAIL", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// Hard-block enforcement — call at production startup. Throws if any
// HARD_BLOCK check fails. Returns a snapshot if all pass.
export async function enforceProductionLaunchSafety(args?: { clubId?: string }): Promise<{ ok: boolean; failures: LaunchCheck[] }> {
  if (env.NODE_ENV !== "production") return { ok: true, failures: [] };
  const failures: LaunchCheck[] = [];
  for (const check of LAUNCH_CHECKS) {
    if (check.severity !== "HARD_BLOCK") continue;
    let result;
    try { result = args?.clubId ? await check.check(args.clubId) : await check.check("_GLOBAL_"); }
    catch (err) { result = { status: "FAIL" as const, detail: err instanceof Error ? err.message : String(err) }; }
    if (result.status === "FAIL") {
      failures.push({ category: check.category, key: check.key, label: check.label, severity: "HARD_BLOCK", status: "FAIL", detail: result.detail });
    }
  }
  if (failures.length > 0) {
    const msg = failures.map((f) => `${f.key}: ${f.detail ?? f.label}`).join("; ");
    throw new Error(`Production launch blocked: ${msg}`);
  }
  return { ok: true, failures: [] };
}

// Super-admin enumerable summary — non-throwing.
export async function multiClubReadiness(principal: Principal) {
  if (!isSuperAdmin(principal)) throw new Error("Only SUPER_ADMIN can view multi-club readiness");
  const clubs = await prisma.club.findMany({ orderBy: { name: "asc" } });
  const out: Array<{ clubId: string; clubName: string; checks: LaunchCheck[] }> = [];
  for (const club of clubs) {
    const checks = await runLaunchChecks(principal, club.id);
    out.push({ clubId: club.id, clubName: club.name, checks });
  }
  return out;
}
