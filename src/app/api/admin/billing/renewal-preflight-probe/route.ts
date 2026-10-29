// SIGNUP-2 M4-INT §5 (2026-10-29) -- Renewal preflight scheduling +
// recovery observability probe.
//
// GET: returns {
//   totalPreflights, scheduledPreflights, dueButUnexecuted,
//   executedToday, missedRecoveryCandidates, statHolidayCoverage: {
//     latestCoveredYear, totalEntries,
//   }
// } so an operator can see whether the preflight pipeline is
// healthy without needing SSH.
//
// POST: invokes `recoverMissedPreflightsForCycle` across all cycles
// with an open (SCHEDULED subscriptionStatus or ACTIVE) subscription.
// Idempotent -- `executeRenewalPreflight` short-circuits already-
// executed rows.  Gated by SPECTRE_SIGNUP_2M4_RENEWAL_LIVE: when the
// flag is OFF the function returns a dry-run shape.
//
// Access: SUPER_ADMIN only via `platform:signups:release`.
// Audit:   every invocation writes an audit entry.
//
// Does NOT create preflights.  Does NOT contact Stripe.  Does NOT
// collect payment.  Pure read + recovery sweep.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { getStatHolidayCalendarCoverage } from "@/lib/billing/signup-2m4-retries-service";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const now = new Date();
  const [totalPreflights, scheduledPreflights, dueButUnexecuted, executedToday] = await Promise.all([
    prisma.billingRenewalPreflight.count({}),
    prisma.billingRenewalPreflight.count({ where: { executedAt: null } }),
    prisma.billingRenewalPreflight.count({
      where: { executedAt: null, scheduledFor: { lte: now } },
    }),
    prisma.billingRenewalPreflight.count({
      where: { executedAt: { gte: new Date(now.getTime() - DAY_MS) } },
    }),
  ]);

  const coverage = getStatHolidayCalendarCoverage();
  const flagLive = process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE === "1";

  return NextResponse.json({
    ok: true,
    renewalLiveFlag: flagLive,
    totalPreflights,
    scheduledPreflights,
    dueButUnexecuted,
    executedToday,
    statHolidayCoverage: {
      latestCoveredYear: coverage.latestCoveredYear,
      totalEntries: coverage.totalEntries,
      currentYear: now.getUTCFullYear(),
      yearsRemainingInCoverage: coverage.latestCoveredYear - now.getUTCFullYear(),
    },
    checkedAt: now.toISOString(),
  }, { status: 200 });
}

export async function POST(): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const flagLive = process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE === "1";
  if (!flagLive) {
    // Dry-run: enumerate what WOULD be recovered without actually
    // invoking the service (service refuses when flag is OFF).
    const due = await prisma.billingRenewalPreflight.findMany({
      where: { executedAt: null, scheduledFor: { lte: new Date() } },
      orderBy: { scheduledFor: "asc" },
      select: { id: true, billingCycleId: true, checkpointLabel: true, scheduledFor: true },
      take: 200,
    });
    await audit(null, {
      action: "signup.m4.int.renewal_preflight_probe.dry_run",
      entityType: "AdminProbe",
      entityId: "renewal-preflight",
      clubId: null,
      meta: {
        triggeringUserIdTail: principal.id.slice(-6),
        dueCount: due.length,
      },
    });
    return NextResponse.json({
      ok: true,
      mode: "dry_run_flag_off",
      renewalLiveFlag: false,
      candidates: due.map((pf) => ({
        preflightIdTail: pf.id.slice(-6),
        cycleIdTail: pf.billingCycleId.slice(-6),
        checkpoint: pf.checkpointLabel,
        scheduledFor: pf.scheduledFor.toISOString(),
      })),
    }, { status: 200 });
  }

  // Live: iterate billing cycles that have open preflights.
  const cyclesWithDue = await prisma.billingRenewalPreflight.findMany({
    where: { executedAt: null, scheduledFor: { lte: new Date() } },
    select: { billingCycleId: true },
    distinct: ["billingCycleId"],
    take: 100,
  });
  const svc = await import("@/lib/billing/signup-2m4-renewal-service");
  const results: Array<{ cycleIdTail: string; recovered: number }> = [];
  let totalRecovered = 0;
  for (const row of cyclesWithDue) {
    try {
      const r = await svc.recoverMissedPreflightsForCycle(row.billingCycleId);
      results.push({ cycleIdTail: row.billingCycleId.slice(-6), recovered: r.recovered });
      totalRecovered += r.recovered;
    } catch {
      // The service wraps its own errors; a cycle-level failure is
      // non-fatal for the sweep.
      results.push({ cycleIdTail: row.billingCycleId.slice(-6), recovered: 0 });
    }
  }
  await audit(null, {
    action: "signup.m4.int.renewal_preflight_probe.sweep",
    entityType: "AdminProbe",
    entityId: "renewal-preflight",
    clubId: null,
    meta: {
      triggeringUserIdTail: principal.id.slice(-6),
      cyclesTouched: results.length,
      totalRecovered,
    },
  });
  return NextResponse.json({
    ok: true,
    mode: "live_sweep",
    renewalLiveFlag: true,
    cyclesTouched: results.length,
    totalRecovered,
    results,
  }, { status: 200 });
}
