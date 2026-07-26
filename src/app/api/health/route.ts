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
  try {
    const deadLetter = await prisma.backgroundJob.count({ where: { status: "DEAD_LETTER" } });
    if (deadLetter > 100) return { name: "queue", status: "warn", detail: `${deadLetter} dead-letter jobs` };
    return { name: "queue", status: "ok", detail: `${deadLetter} dead-letter jobs` };
  } catch (err) {
    return { name: "queue", status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const checks = await Promise.all([checkDatabase(), checkQueueHealth()]);
  const ok = checks.every((c) => c.status === "ok");
  const warn = checks.some((c) => c.status === "warn");
  const status = ok ? "ok" : warn ? "warn" : "fail";
  return NextResponse.json({
    status,
    version: process.env.SPECTRE_VERSION ?? "dev",
    checks,
    timestamp: new Date().toISOString(),
  }, { status: status === "fail" ? 503 : 200 });
}
