// SIGNUP-1 (2026-10-19) — Expired-registration sweeper.
//
// Runs inside the existing worker loop (bin/worker.ts) alongside the
// mailbox / timesheet schedulers.  Marks expired DRAFT registrations
// as ABANDONED so the dashboards + duplicate-detection counts stay
// accurate.  Separately, consumes expired SignupOAuthTransaction rows
// so stale OAuth state doesn't accumulate.
//
// Bounded + idempotent:
//   • Default interval 15 min.
//   • At most 200 rows per sweep.
//   • Pure UPDATE / UPDATE_MANY — no cascading writes.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";

let lastTickAt = 0;

interface TickResult {
  ran: boolean;
  reason?: "not_due" | "ok";
  abandonedRegistrations: number;
  expiredTransactions: number;
}

const INTERVAL_MS = Number(
  process.env.SIGNUP_SWEEP_INTERVAL_MS ?? String(15 * 60 * 1000),
);

export async function tickSignupSweep(args: { now?: Date } = {}): Promise<TickResult> {
  const now = args.now ?? new Date();
  if (now.getTime() - lastTickAt < INTERVAL_MS) {
    return { ran: false, reason: "not_due", abandonedRegistrations: 0, expiredTransactions: 0 };
  }
  lastTickAt = now.getTime();

  // Expired DRAFT registrations → ABANDONED.  Never touches VERIFIED
  // or ESCALATED rows.
  const abandoned = await prisma.signupRegistration.updateMany({
    where: {
      status: "DRAFT",
      expiresAt: { lt: now },
    },
    data: {
      status: "ABANDONED",
    },
  });

  // Expired OAuth transactions — mark outcome EXPIRED (idempotent).
  const expired = await prisma.signupOAuthTransaction.updateMany({
    where: {
      consumedAt: null,
      outcome: null,
      expiresAt: { lt: now },
    },
    data: {
      consumedAt: now,
      outcome: "EXPIRED",
    },
  });

  if (abandoned.count > 0 || expired.count > 0) {
    logger.info("signup.sweep.tick", {
      abandonedRegistrations: abandoned.count,
      expiredTransactions: expired.count,
    });
  }
  return {
    ran: true,
    reason: "ok",
    abandonedRegistrations: abandoned.count,
    expiredTransactions: expired.count,
  };
}
