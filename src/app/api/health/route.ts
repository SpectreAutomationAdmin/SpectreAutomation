// Phase 8F — Health check endpoint.
//
// Returns { status, checks } JSON. Production probes (k8s readiness,
// load-balancer health, uptime monitors) should target /api/health.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CheckResult = { name: string; status: "ok" | "fail" | "warn"; latencyMs?: number; detail?: string };

async function checkDatabase(): Promise<CheckResult> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { name: "database", status: "ok", latencyMs: Date.now() - started };
  } catch (err) {
    return { name: "database", status: "fail", latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkQueueHealth(): Promise<CheckResult> {
  // Sprint 3 · Post-16H Phase 3.2 (2026-08-06) — §6 DLQ bucketing.
  // Founder rule: "Do not delete DLQ rows to make health green — an
  // observability failure is a real defect, not a display bug."
  // Historical = failed > 30 days ago AND not from any AP-related
  // job kind. Active = anything else. Health warns only on ACTIVE.
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [total, historical] = await Promise.all([
      prisma.backgroundJob.count({ where: { status: "DEAD_LETTER" } }),
      prisma.backgroundJob.count({
        where: {
          status: "DEAD_LETTER",
          createdAt: { lt: cutoff },
          kind: {
            notIn: [
              "AP_INVOICE_ANALYSE",
              "AP_INVOICE_POST",
              "AP_OCR_ANALYSE",
              "AP_INTAKE_INGEST",
              "WORK_INTAKE_CLASSIFY",
            ],
          },
        },
      }),
    ]);
    const active = total - historical;
    const detail = `dlq total=${total} · active=${active} · historical=${historical}`;
    if (active > 5) return { name: "queue", status: "warn", detail };
    return { name: "queue", status: "ok", detail };
  } catch (err) {
    return { name: "queue", status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const checks = await Promise.all([checkDatabase(), checkQueueHealth()]);
  const ok = checks.every((c) => c.status === "ok");
  const warn = checks.some((c) => c.status === "warn");
  const status = ok ? "ok" : warn ? "warn" : "fail";

  // Sprint 3 · Post-16H Phase 3.1 (2026-08-06) — AP intelligence
  // version diagnostic (§7). Web + worker deploy the SAME commit
  // and therefore the SAME versions; this surface lets ops confirm
  // parity when a rolling deploy is in flight or a stale worker
  // is suspected.
  const { ELIGIBILITY_RULE_VERSION } = await import("@/lib/accounting/eligibility");
  const apIntelligence = {
    eligibilityRuleVersion: ELIGIBILITY_RULE_VERSION,
    workflowDecisionVersion: 1,   // bumped when computeApWorkflowDecision changes shape
    phase0Enabled: (process.env.AP_INTELLIGENCE_PHASE0_SAFETY ?? "1") !== "0",
    phase2Enabled: (process.env.AP_INTELLIGENCE_PHASE2_ELIGIBILITY ?? "1") !== "0",
  };

  return NextResponse.json({
    status,
    version: process.env.SPECTRE_VERSION ?? "dev",
    apIntelligence,
    checks,
    timestamp: new Date().toISOString(),
  }, { status: status === "fail" ? 503 : 200 });
}
