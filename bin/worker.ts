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
