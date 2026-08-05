// Phase 8A — Background job queue.
//
// Two-adapter design:
//   - inMemoryQueue: a single-process queue used by tests + dev. Jobs run
//     synchronously when triggered; a `processPending()` driver simulates a
//     worker for tests.
//   - bullmqQueue: dynamic-import BullMQ + Redis when REDIS_URL is set in
//     production. Workers run via `bin/worker.ts`.
//
// All queued work is recorded in the BackgroundJob table for audit, retry,
// and observability — independent of the adapter.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { logger } from "../observability/logger";
import { env } from "../env";
import { optionalImport } from "../integrations/optional-import";

export type JobKind =
  | "EXPORT"
  | "NOTIFICATION"
  | "LLM_COMMENTARY"
  | "DOCUMENT_BACKFILL"
  | "POS_WEBHOOK"
  | "WEBHOOK_DELIVERY"
  | "PUSH_RETRY"
  | "INVENTORY_SYNC"
  | "TEE_SHEET_SYNC"
  | "SCHEDULED_REPORT"
  | "SCHEDULED_NOTIFICATION"
  // Sprint 2 (2026-07-19) — Outlook / Work Intake integration.
  // Every handler MUST be idempotent per §9 of the Phase B directive:
  // rerunning any of these with the same payload produces the same
  // final DB state. Delta cursors, upsert unique keys, and Redis
  // per-connection locks combine to deliver at-most-once effective
  // execution over at-least-once queue delivery.
  | "MAILBOX_INITIAL_SYNC"
  | "MAILBOX_DELTA_SYNC"
  | "MAILBOX_RENEW_SUBSCRIPTION"
  | "MAILBOX_ATTACHMENT_FETCH"
  | "MAILBOX_RECONCILIATION_HEARTBEAT"
  // Sprint 3 · Checkpoint 15P-7 — post-commit Outlook archive of
  // the source email after an AP invoice is successfully posted.
  // Idempotent per invoiceId: rerunning with the same payload is a
  // no-op if the message has already been archived (best-effort
  // check via the mailbox integration when it lands). See
  // src/lib/queue/handlers.ts for the handler.
  | "MAILBOX_ARCHIVE_MESSAGE"
  // Sprint 3 · Checkpoint 16H rejection (2026-08-06) — reconcile a
  // Spectre-originated outbound reply with the corresponding message
  // in Outlook Sent Items. Idempotent per (conversationMessageId,
  // attempt). Payload: { conversationMessageId: string; attempt: number }
  // Handler: src/lib/queue/handlers.ts → runConversationReconciliation
  | "CONVERSATION_MESSAGE_RECONCILE"
  // Sprint 3 · Checkpoint 15X continuation (2026-07-29) — AP
  // document OCR extraction via AWS Textract AnalyzeExpense.
  //
  // Idempotency: enqueue with key
  //   `ap-doc-ocr:{clubId}:{sha256}:{provider}:{extractionVersion}`
  // See src/lib/ap-intelligence/ocr/enqueue.ts. The worker uses the
  // DocumentOcrExtraction table's unique constraint as the durable
  // safeguard so concurrent workers cannot double-invoke.
  //
  // Payload: { extractionRowId: string }
  // Handler: src/lib/ap-intelligence/ocr/worker.ts#runAPDocumentOcrJob
  | "AP_DOCUMENT_OCR";

export type JobHandler<P = unknown, R = unknown> = (args: {
  jobId: string;
  clubId: string | null;
  payload: P;
  attempt: number;
  correlationId: string;
}) => Promise<R>;

const HANDLERS = new Map<JobKind, JobHandler>();

export function registerHandler<P = unknown, R = unknown>(kind: JobKind, fn: JobHandler<P, R>) {
  HANDLERS.set(kind, fn as unknown as JobHandler);
}

export function listRegisteredHandlers(): JobKind[] {
  return Array.from(HANDLERS.keys());
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------
export const enqueueSchema = z.object({
  kind: z.string(),
  queue: z.string().default("default"),
  clubId: z.string().nullable().default(null),
  payload: z.unknown(),
  priority: z.number().int().default(0),
  maxAttempts: z.number().int().min(1).max(50).default(5),
  idempotencyKey: z.string().optional().nullable(),
  scheduledFor: z.date().optional(),
  correlationId: z.string().optional().nullable(),
});

export async function enqueue(args: {
  kind: JobKind;
  queue?: string;
  clubId?: string | null;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  scheduledFor?: Date;
  correlationId?: string | null;
  createdByUserId?: string | null;
}) {
  const parsed = enqueueSchema.parse({
    kind: args.kind, queue: args.queue ?? "default",
    clubId: args.clubId ?? null, payload: args.payload,
    priority: args.priority ?? 0, maxAttempts: args.maxAttempts ?? 5,
    idempotencyKey: args.idempotencyKey ?? null,
    scheduledFor: args.scheduledFor,
    correlationId: args.correlationId ?? null,
  });

  // Idempotency: if a job with this key already exists (QUEUED or RUNNING),
  // return the existing row.
  if (parsed.idempotencyKey) {
    const existing = await prisma.backgroundJob.findFirst({
      where: {
        clubId: parsed.clubId,
        kind: parsed.kind,
        idempotencyKey: parsed.idempotencyKey,
        status: { in: ["QUEUED", "RUNNING"] },
      },
    });
    if (existing) {
      logger.info("queue.enqueue.duplicate", { jobId: existing.id, kind: parsed.kind, idempotencyKey: parsed.idempotencyKey });
      return existing;
    }
  }

  const job = await prisma.backgroundJob.create({
    data: {
      clubId: parsed.clubId,
      queue: parsed.queue,
      kind: parsed.kind,
      payloadJson: JSON.stringify(parsed.payload ?? null),
      status: "QUEUED",
      priority: parsed.priority,
      maxAttempts: parsed.maxAttempts,
      idempotencyKey: parsed.idempotencyKey,
      scheduledFor: parsed.scheduledFor ?? new Date(),
      correlationId: parsed.correlationId,
      createdByUserId: args.createdByUserId ?? null,
    },
  });
  logger.info("queue.enqueue", { jobId: job.id, kind: parsed.kind, queue: parsed.queue, idempotencyKey: parsed.idempotencyKey });

  // If a real BullMQ adapter is configured, mirror the job there. The
  // database row remains the durable source of truth.
  const adapter = await selectAdapter();
  await adapter.enqueue(job);
  return job;
}

// ---------------------------------------------------------------------------
// Run a single job (used by both adapters)
// ---------------------------------------------------------------------------
export async function runOne(jobId: string, workerId = "local"): Promise<{ status: "SUCCEEDED" | "FAILED" | "RETRYING"; error?: string }> {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) return { status: "FAILED", error: "job not found" };
  if (job.status === "COMPLETED" || job.status === "DEAD_LETTER" || job.status === "CANCELLED") {
    return { status: "SUCCEEDED" };
  }

  const handler = HANDLERS.get(job.kind as JobKind);
  if (!handler) {
    await markFailed(job.id, "no handler registered", true);
    return { status: "FAILED", error: "no handler registered" };
  }

  const attempt = job.attempts + 1;
  const started = Date.now();
  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", attempts: attempt, startedAt: new Date() },
  });
  logger.info("queue.runOne.start", { jobId: job.id, kind: job.kind, attempt });

  try {
    const payload = job.payloadJson ? JSON.parse(job.payloadJson) : null;
    const result = await handler({
      jobId: job.id, clubId: job.clubId, payload, attempt,
      correlationId: job.correlationId ?? job.id,
    });
    const finished = Date.now();
    await prisma.jobRun.create({
      data: {
        clubId: job.clubId, jobId: job.id, attemptNumber: attempt,
        startedAt: new Date(started), finishedAt: new Date(finished),
        durationMs: finished - started, status: "SUCCEEDED", workerId,
      },
    });
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", finishedAt: new Date(), resultJson: result === undefined ? null : JSON.stringify(result).slice(0, 200_000) },
    });
    logger.info("queue.runOne.success", { jobId: job.id, kind: job.kind, attempt, durationMs: finished - started });
    return { status: "SUCCEEDED" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const finished = Date.now();
    await prisma.jobRun.create({
      data: {
        clubId: job.clubId, jobId: job.id, attemptNumber: attempt,
        startedAt: new Date(started), finishedAt: new Date(finished),
        durationMs: finished - started, status: "FAILED", errorMessage, workerId,
      },
    });
    await prisma.jobFailure.create({
      data: { clubId: job.clubId, jobId: job.id, attemptNumber: attempt, errorMessage, stack: stack ?? null },
    });
    logger.warn("queue.runOne.failed", { jobId: job.id, kind: job.kind, attempt, error: errorMessage });
    // Decide retry vs dead-letter.
    if (attempt >= job.maxAttempts) {
      await markFailed(job.id, errorMessage, true);
      return { status: "FAILED", error: errorMessage };
    }
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: "QUEUED", lastError: errorMessage,
        // Exponential backoff: 2^attempt seconds.
        scheduledFor: new Date(Date.now() + Math.min(60_000 * 60, 1000 * Math.pow(2, attempt))),
      },
    });
    return { status: "RETRYING", error: errorMessage };
  }
}

async function markFailed(jobId: string, reason: string, deadLetter: boolean) {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: deadLetter ? "DEAD_LETTER" : "FAILED",
      finishedAt: new Date(),
      lastError: reason,
    },
  });
}

// ---------------------------------------------------------------------------
// In-memory adapter (default for tests + dev)
// ---------------------------------------------------------------------------
interface QueueAdapter {
  name: string;
  enqueue(job: { id: string; queue: string; kind: string; scheduledFor: Date }): Promise<void>;
  start?(opts: { queues: string[]; workerId: string; concurrency?: number }): Promise<void>;
  stop?(): Promise<void>;
}

const inMemoryAdapter: QueueAdapter = {
  name: "in-memory",
  async enqueue() { /* no side effect; processPending() is the driver */ },
};

let activeAdapter: QueueAdapter = inMemoryAdapter;

async function selectAdapter(): Promise<QueueAdapter> {
  if (activeAdapter !== inMemoryAdapter) return activeAdapter;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return inMemoryAdapter;
  if (env.NODE_ENV === "test") return inMemoryAdapter;
  const bullmq = await bullmqAdapter(redisUrl).catch(() => null);
  if (bullmq) activeAdapter = bullmq;
  return activeAdapter;
}

// ---------------------------------------------------------------------------
// BullMQ adapter (loaded at runtime if REDIS_URL is set + `bullmq` installed)
// ---------------------------------------------------------------------------
async function bullmqAdapter(redisUrl: string): Promise<QueueAdapter | null> {
  const mod = await optionalImport("bullmq");
  if (!mod) {
    logger.warn("queue.bullmq.missing", { hint: "REDIS_URL is set but bullmq is not installed; falling back to in-memory" });
    return null;
  }
  const ioredis = await optionalImport("ioredis");
  if (!ioredis) {
    logger.warn("queue.ioredis.missing", { hint: "REDIS_URL is set but ioredis is not installed; falling back to in-memory" });
    return null;
  }
  const QueueCtor = mod.Queue;
  const WorkerCtor = mod.Worker;
  const RedisCtor = ioredis.default ?? ioredis;
  // Upstash Redis + BullMQ require two non-default connection options:
  //   • maxRetriesPerRequest: null — BullMQ's blocking `bzpop`/`brpop`
  //     commands must NEVER give up; the ioredis default of 20 causes
  //     the worker to crash with `MaxRetriesPerRequestError` on the
  //     first idle window.
  //   • enableReadyCheck: false — Upstash rejects the `INFO` command
  //     that ioredis uses for ready-check, aborting the connection.
  // Apply these unconditionally for any BullMQ connection; they are
  // safe on self-hosted Redis too.
  const bullmqRedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  function newConnection() {
    return new RedisCtor(redisUrl, bullmqRedisOptions);
  }
  const queues = new Map<string, { add: (name: string, data: unknown, opts?: { jobId?: string; delay?: number; priority?: number }) => Promise<unknown> }>();
  function getQueue(name: string) {
    let q = queues.get(name);
    if (!q) {
      q = new QueueCtor(name, { connection: newConnection() });
      queues.set(name, q!);
    }
    return q!;
  }
  return {
    name: "bullmq",
    async enqueue(job) {
      const queue = getQueue(job.queue);
      const delay = Math.max(0, job.scheduledFor.getTime() - Date.now());
      await queue.add(job.kind, { jobId: job.id }, { jobId: job.id, delay });
    },
    async start({ queues, workerId, concurrency }) {
      for (const name of queues) {
        new WorkerCtor(name, async (j: { data: { jobId: string } }) => runOne(j.data.jobId, workerId), { connection: newConnection(), concurrency: concurrency ?? 5 });
      }
      logger.info("queue.bullmq.start", { queues, workerId });
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory processor — used by tests + dev to drain the queue. In production
// the BullMQ worker is responsible for polling.
// ---------------------------------------------------------------------------
export async function processPending(opts?: { queues?: string[]; limit?: number; workerId?: string }) {
  const where = {
    status: { in: ["QUEUED" as const] },
    scheduledFor: { lte: new Date() },
    ...(opts?.queues ? { queue: { in: opts.queues } } : {}),
  };
  const pending = await prisma.backgroundJob.findMany({
    where, orderBy: [{ priority: "desc" }, { scheduledFor: "asc" }], take: opts?.limit ?? 50,
  });
  const results = [];
  for (const job of pending) {
    results.push({ id: job.id, result: await runOne(job.id, opts?.workerId ?? "local") });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Health snapshot
// ---------------------------------------------------------------------------
export async function captureQueueHealth(queue?: string) {
  const hourAgo = new Date(Date.now() - 3600_000);
  const queues = queue ? [queue] : ["default", "exports", "notifications", "pos-webhooks", "llm", "backfill"];
  const out = [];
  for (const q of queues) {
    const [depth, inFlight, failures, deadLetter] = await Promise.all([
      prisma.backgroundJob.count({ where: { queue: q, status: "QUEUED" } }),
      prisma.backgroundJob.count({ where: { queue: q, status: "RUNNING" } }),
      prisma.jobRun.count({ where: { status: "FAILED", finishedAt: { gte: hourAgo }, job: { queue: q } } }),
      prisma.backgroundJob.count({ where: { queue: q, status: "DEAD_LETTER" } }),
    ]);
    const snap = await prisma.queueHealth.create({
      data: { queue: q, queueDepth: depth, inFlight, failedLastHour: failures, deadLetterCount: deadLetter },
    });
    out.push(snap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manual requeue + cancel
// ---------------------------------------------------------------------------
export async function requeueJob(jobId: string, actor: { id: string } | null) {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("job not found");
  const updated = await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: "QUEUED", attempts: 0, lastError: null, scheduledFor: new Date(), finishedAt: null },
  });
  await audit(actor, { action: "queue.requeue", entityType: "BackgroundJob", entityId: jobId, clubId: job.clubId, after: { status: "QUEUED" } });
  return updated;
}

export async function cancelJob(jobId: string, actor: { id: string } | null) {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("job not found");
  if (job.status === "COMPLETED" || job.status === "DEAD_LETTER") return job;
  const updated = await prisma.backgroundJob.update({
    where: { id: jobId },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  await audit(actor, { action: "queue.cancel", entityType: "BackgroundJob", entityId: jobId, clubId: job.clubId, after: { status: "CANCELLED" } });
  return updated;
}
