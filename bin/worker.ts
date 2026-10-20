#!/usr/bin/env tsx
// Phase 8I — Background job worker entrypoint.
//
// Usage:
//   tsx bin/worker.ts                    # all queues, in-memory (single-process)
//   REDIS_URL=redis://... tsx bin/worker.ts   # bullmq across queues
//   tsx bin/worker.ts exports notifications  # specific queues only
//
// Workers re-use the same Prisma client + handler registry as the web tier;
// the only difference is the polling loop (or the BullMQ subscription).

import "../src/lib/queue/handlers";
import "../src/lib/pos/webhooks";
import { processPending, captureQueueHealth, listRegisteredHandlers } from "../src/lib/queue";
import { logger } from "../src/lib/observability/logger";
import { tickAutoSync } from "../src/lib/mailbox/auto-sync-scheduler";
import { tickReconciliationSweep } from "../src/lib/mailbox/reconciliation-scheduler";
import { tickSubscriptionMaintenance } from "../src/lib/mailbox/subscription-scheduler";
import { tickActiveReverify } from "../src/lib/mailbox/active-reverify-scheduler";
import { tickSignupSweep } from "../src/lib/signup/sweeper";
import { tickTimesheetApprovalWiSweep } from "../src/lib/work-intake/timesheet-approval-orchestration";

const queues = process.argv.slice(2);
const workerId = `worker-${process.pid}-${Date.now().toString(36)}`;
const interval = Number(process.env.WORKER_POLL_MS ?? "1000");

async function main() {
  logger.info("worker.start", { workerId, queues: queues.length ? queues : "all", handlers: listRegisteredHandlers() });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processPending({ queues: queues.length ? queues : undefined, workerId, limit: 20 });
      // Periodically capture queue health snapshots.
      if (Date.now() % 60_000 < interval) {
        await captureQueueHealth();
      }
      // Sprint 3 Checkpoint 15H-1 (2026-07-25) — periodic mailbox
      // delta-sync scheduler. Feature-gated + time-bucketed idempotency
      // so multiple worker instances only produce one delta job per
      // mailbox per interval. Never enqueues if the feature is off.
      await tickAutoSync();
      // WI-SYNC-1b (2026-10-18) — scheduled reconciliation sweep.
      // Fires at most once per MAILBOX_RECONCILIATION_INTERVAL_MS
      // (default 15 min).  Independent cadence from the 60-second
      // delta tick; the two schedulers are additive — delta is the
      // primary polling path and reconciliation is a safety net.
      await tickReconciliationSweep();
      // WI-SYNC-1d (2026-10-18) — subscription-maintenance tick.
      // Enqueues MAILBOX_RENEW_SUBSCRIPTION jobs for mailboxes
      // whose subscription is missing / expiring / failed.  Fires
      // at most once per MAILBOX_SUBSCRIPTION_INTERVAL_MS (default
      // 5 min).  Feature-gated; collapses to zero work when
      // MAILBOX_INTEGRATION_ENABLED is false.
      await tickSubscriptionMaintenance();
      // WI-SYNC-1i (2026-10-19) — automatic active-WI reverify tick.
      // Enqueues MAILBOX_ACTIVE_REVERIFY jobs for every connected
      // mailbox with at least one active email-backed WI.  Closes
      // the automatic-convergence gap left by Microsoft Graph's
      // unreliable Inbox-delta `@removed` channel.  Default cadence
      // 60 s; feature-gated; time-bucketed idempotency; one job per
      // mailbox per bucket.
      await tickActiveReverify();
      // SIGNUP-1 (2026-10-19) — expired-registration sweep.  Default
      // cadence 15 min.  Marks expired DRAFT SignupRegistration rows
      // as ABANDONED and consumes expired SignupOAuthTransaction
      // rows.  Bounded + idempotent.
      await tickSignupSweep();
      // Payroll-3D-3B Slice 3 (2026-09-06) — periodic sweep of
      // manager-relevant pay periods → enqueue ensure jobs so the
      // approval WI obligation always exists even if inline
      // orchestration AND its enqueue-on-failure fallback both fail.
      // Interval-budgeted (default 5 min); calendar-bounded window;
      // built-in enqueue dedupe collapses concurrent workers to one
      // job per (clubId, payPeriodId).
      await tickTimesheetApprovalWiSweep();
    } catch (err) {
      logger.error("worker.loop_error", { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

main().catch((err) => {
  logger.error("worker.fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
