// Phase 12E — Push analytics aggregation.
//
// Reads from `PushDeliveryAttempt` (Phase 10 + 11) and emits structured
// metrics ready for a dashboard:
//   - Delivery success rate by hour / day
//   - Latency p50/p95/p99
//   - Failure categorization
//   - Per-campaign rollup
//
// Also writes a counter into the observability MetricCounter table so the
// /api/metrics Prometheus exposition surfaces push delivery metrics.

import { prisma } from "../../prisma";
import { requirePermission, type Principal } from "../../rbac";
import { getObservability } from "../../observability/adapter";

export type PushAnalyticsWindow = "1h" | "24h" | "7d" | "30d";

const WINDOW_MS: Record<PushAnalyticsWindow, number> = {
  "1h": 3600_000,
  "24h": 86400_000,
  "7d": 7 * 86400_000,
  "30d": 30 * 86400_000,
};

export async function summarize(principal: Principal, clubId: string, window: PushAnalyticsWindow = "24h") {
  requirePermission(principal, clubId, "notifications:read");
  const since = new Date(Date.now() - WINDOW_MS[window]);
  const attempts = await prisma.pushDeliveryAttempt.findMany({
    where: { clubId, attemptedAt: { gte: since } },
    select: { status: true, failureReason: true, durationMs: true, attemptedAt: true, campaignId: true },
  });
  const total = attempts.length;
  const sent = attempts.filter((a) => a.status === "SENT").length;
  const failed = attempts.filter((a) => a.status === "FAILED").length;
  const expired = attempts.filter((a) => a.status === "EXPIRED").length;
  const successRate = total > 0 ? sent / total : 1;

  // Latency stats.
  const sortedDurations = attempts
    .filter((a) => a.status === "SENT" && a.durationMs > 0)
    .map((a) => a.durationMs)
    .sort((a, b) => a - b);
  const p = (q: number) => sortedDurations.length > 0 ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * q))] : 0;
  const latency = { p50: p(0.5), p95: p(0.95), p99: p(0.99) };

  // Failure categorization (free-text bucketing).
  const failureBuckets: Record<string, number> = {};
  for (const a of attempts) {
    if (a.status === "SENT") continue;
    const reason = (a.failureReason ?? "unknown").slice(0, 60);
    failureBuckets[reason] = (failureBuckets[reason] ?? 0) + 1;
  }
  // Per-campaign rollup.
  const byCampaign = new Map<string, { sent: number; failed: number; total: number }>();
  for (const a of attempts) {
    const key = a.campaignId ?? "ad-hoc";
    const row = byCampaign.get(key) ?? { sent: 0, failed: 0, total: 0 };
    row.total++;
    if (a.status === "SENT") row.sent++;
    else row.failed++;
    byCampaign.set(key, row);
  }

  // Emit a Prometheus-ready counter snapshot.
  const obs = getObservability();
  obs.incrCounter("spectre_push_attempts_total", { clubId, status: "sent" }, sent);
  obs.incrCounter("spectre_push_attempts_total", { clubId, status: "failed" }, failed);
  obs.incrCounter("spectre_push_attempts_total", { clubId, status: "expired" }, expired);

  return {
    window, total, sent, failed, expired, successRate,
    latency,
    failureBuckets,
    campaigns: Array.from(byCampaign.entries()).map(([id, stats]) => ({ id, ...stats })),
  };
}

export async function subscriptionHealth(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "notifications:read");
  const total = await prisma.webPushSubscription.count({ where: { clubId } });
  const active = await prisma.webPushSubscription.count({ where: { clubId, isActive: true } });
  const recentlyFailed = await prisma.webPushSubscription.count({ where: { clubId, failureCount: { gte: 3 } } });
  return { total, active, recentlyFailed, inactiveRate: total > 0 ? 1 - (active / total) : 0 };
}
