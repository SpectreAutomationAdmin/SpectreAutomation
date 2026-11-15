// Durable per-version authorization for automatic course preparation.
//
// A successful video upload writes one AuditLog row
// (action "hr.training.generation.authorize", source UPLOAD). That row
// is what lets the orchestrator run the pipeline for that version —
// transcription, question generation, bounded retries and repairs —
// for PIPELINE_WINDOW_MS. A Spectre operator can write the same kind
// of row (source ADMIN_RECOVERY) to resume a course that was uploaded
// before automatic preparation existed.
//
// Why AuditLog: it is append-only in production and carries userId +
// createdAt, which is exactly what a replay-proof authorization needs.
// Nothing a browser can poll or re-send writes one.

import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Principal } from "@/lib/rbac";
import type { PrismaClient } from "@prisma/client";
import { resolveProcessingIdentity } from "./test-execution-identity";

/** TTL (ms) a single authorization record is considered fresh. Two
 *  hours is long enough to cover the full automated pipeline (upload
 *  → transcription → generation can take ~15 min for a typical
 *  10-min video, with slack for one manager retry) but short enough
 *  that a stale legacy browser poll will NOT find a usable record
 *  the next day. */
export const AUTHORIZATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Narrow set of operations an authorization grants. A record for
 *  `GENERATE_FULL` also authorizes `GENERATE_RECOVERY` under the same
 *  freshness window — the recovery is strictly a subset. */
export type AuthorizationOperation =
  | "GENERATE_FULL"      // first-time auto-prepare / generate
  | "GENERATE_RECOVERY"; // targeted shortfall-only recovery

/** Write a fresh authorization record. Called by explicit user-driven
 *  endpoints (`/start-preparation`, `/authorize-recovery`) BEFORE
 *  delegating to the enqueue path. */
export async function recordProcessingAuthorization(
  principal: Principal,
  args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly operation: AuthorizationOperation;
    /** What produced this authorization. */
    readonly source?: "UPLOAD" | "ADMIN_RECOVERY";
    /** MOCK is only ever written by the upload route when the
     *  environment explicitly allows mock inference (staging). */
    readonly inferenceMode?: InferenceMode;
    readonly mockDelayMs?: number;
    readonly mockFault?: MockInferenceOptions["fault"];
  },
): Promise<void> {
  await audit(principal, {
    action: "hr.training.generation.authorize",
    entityType: "TrainingCourseVersion",
    entityId: args.courseVersionId,
    clubId: args.clubId,
    after: {
      operation: args.operation,
      authorizedAt: new Date().toISOString(),
      source: args.source ?? null,
      inferenceMode: args.inferenceMode ?? "LIVE",
      ...(args.inferenceMode === "MOCK"
        ? { mockDelayMs: args.mockDelayMs ?? 0, mockFault: args.mockFault ?? "NONE" }
        : {}),
    },
  });
}

export type InferenceMode = "LIVE" | "MOCK";

/** How long an upload (or an administrative recovery) keeps driving the
 *  automatic pipeline, retries and repairs included. A normal course
 *  finishes in minutes; a day leaves room for recovery after an outage
 *  without letting an old draft start processing by surprise. */
export const PIPELINE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PipelineAuthorizationSource = "UPLOAD" | "ADMIN_RECOVERY";

/** Test-only behaviours of mock inference (staging). */
export interface MockInferenceOptions {
  /** Artificial delay per mocked model call, to exercise refresh and
   *  leave-and-return while work is in flight. */
  readonly delayMs: number;
  /** DROP_FIRST_CHECKPOINT: the first run returns nothing for its first
   *  checkpoint, to exercise automatic repair.
   *  FORMATTING_DEFECTS: every simulated question carries the three
   *  formatting defects real model output showed (source reference in
   *  the stem, segment pointer in the explanation, answer-key notes in
   *  the options), to exercise deterministic normalisation end to end. */
  readonly fault: "NONE" | "DROP_FIRST_CHECKPOINT" | "FORMATTING_DEFECTS";
}

export interface PipelineAuthorization {
  readonly auditId: string;
  readonly authorizedAt: Date;
  readonly authorizedByUserId: string | null;
  readonly source: PipelineAuthorizationSource;
  readonly inferenceMode: InferenceMode;
  readonly mock: MockInferenceOptions;
}

function parsePipelineAuthorization(row: {
  id: string;
  afterJson: string | null;
  createdAt: Date;
  userId: string | null;
}): PipelineAuthorization | null {
  if (!row.afterJson) return null;
  try {
    const after = JSON.parse(row.afterJson) as Record<string, unknown>;
    if (after.operation !== "GENERATE_FULL") return null;
    if (after.source !== "UPLOAD" && after.source !== "ADMIN_RECOVERY") return null;
    const delay = typeof after.mockDelayMs === "number" ? after.mockDelayMs : 0;
    return {
      auditId: row.id,
      authorizedAt: row.createdAt,
      authorizedByUserId: row.userId,
      source: after.source,
      inferenceMode: after.inferenceMode === "MOCK" ? "MOCK" : "LIVE",
      mock: {
        delayMs: Math.max(0, Math.min(10_000, Math.floor(delay))),
        fault:
          after.mockFault === "DROP_FIRST_CHECKPOINT"
            ? "DROP_FIRST_CHECKPOINT"
            : after.mockFault === "FORMATTING_DEFECTS"
              ? "FORMATTING_DEFECTS"
              : "NONE",
      },
    };
  } catch {
    return null;
  }
}

/** The authorization that currently drives automatic preparation for a
 *  version: the newest upload / administrative-recovery record inside
 *  the pipeline window. Null means nothing may run automatically. */
export async function readPipelineAuthorization(
  args: { readonly clubId: string; readonly courseVersionId: string; readonly now?: Date },
  opts: { prisma?: PrismaClient } = {},
): Promise<PipelineAuthorization | null> {
  const db = opts.prisma ?? defaultPrisma;
  const cutoff = new Date((args.now ?? new Date()).getTime() - PIPELINE_WINDOW_MS);
  const rows = await db.auditLog.findMany({
    where: {
      clubId: args.clubId,
      action: "hr.training.generation.authorize",
      entityType: "TrainingCourseVersion",
      entityId: args.courseVersionId,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, afterJson: true, createdAt: true, userId: true },
  });
  for (const row of rows) {
    const parsed = parsePipelineAuthorization(row);
    if (parsed) return parsed;
  }
  return null;
}

/** Versions with a pipeline authorization inside the window — the
 *  watchdog's work list. */
export async function listPipelineCandidates(
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<Array<{ clubId: string; courseVersionId: string }>> {
  const db = opts.prisma ?? defaultPrisma;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - PIPELINE_WINDOW_MS);
  const rows = await db.auditLog.findMany({
    where: {
      action: "hr.training.generation.authorize",
      entityType: "TrainingCourseVersion",
      createdAt: { gte: cutoff },
    },
    select: { clubId: true, entityId: true, afterJson: true },
  });
  const seen = new Map<string, { clubId: string; courseVersionId: string }>();
  for (const row of rows) {
    if (!row.clubId || !row.entityId || !row.afterJson) continue;
    if (!/"source":"(UPLOAD|ADMIN_RECOVERY)"/.test(row.afterJson)) continue;
    seen.set(`${row.clubId}:${row.entityId}`, { clubId: row.clubId, courseVersionId: row.entityId });
  }
  return [...seen.values()];
}

export const PREPARATION_COMPLETED_ACTION = "hr.training.preparation.completed";

/** True once automatic preparation finished for the current upload.
 *  From then on the course belongs to the manager: editing or
 *  discarding a question must never make Spectre generate again. */
export async function hasPreparationCompleted(
  args: { readonly clubId: string; readonly courseVersionId: string; readonly since: Date },
  opts: { prisma?: PrismaClient } = {},
): Promise<boolean> {
  const db = opts.prisma ?? defaultPrisma;
  const row = await db.auditLog.findFirst({
    where: {
      clubId: args.clubId,
      action: PREPARATION_COMPLETED_ACTION,
      entityType: "TrainingCourseVersion",
      entityId: args.courseVersionId,
      createdAt: { gte: args.since },
    },
    select: { id: true },
  });
  return row !== null;
}

export const PREPARATION_HALT_ACTION = "hr.training.preparation.halted";

/** Internal reason automatic preparation stopped. Never shown to a
 *  manager; the customer-facing text is derived from the family. */
export type PreparationHaltCode =
  | "BUDGET_INFEASIBLE"
  | "BUDGET_EXHAUSTED"
  | "TRANSCRIPTION_ATTEMPTS_EXHAUSTED"
  | "GENERATION_ATTEMPTS_EXHAUSTED"
  | "PARTIAL_AFTER_REPAIR"
  | "TRANSCRIPTION_REJECTED"
  | "GENERATION_REJECTED"
  | "NON_RETRYABLE_FAILURE"
  | "AUTHORIZER_LOST_ACCESS"
  | "MOCK_REQUIRES_EXISTING_TRANSCRIPT"
  // EP-TRAIN-4Y-BF — this environment has not enabled billable
  // inference, so a real (non-test) course cannot be processed here.
  | "BILLABLE_INFERENCE_LOCKED"
  // EP-TRAIN-4Y-BF — a test-identity (non-billable) version in an
  // environment that does not allow simulated processing.
  | "TEST_ISOLATION_UNAVAILABLE";

/** Latest halt recorded at or after `since` (the driving authorization). */
export async function readPreparationHalt(
  args: { readonly clubId: string; readonly courseVersionId: string; readonly since: Date },
  opts: { prisma?: PrismaClient } = {},
): Promise<{ readonly code: PreparationHaltCode; readonly at: Date } | null> {
  const db = opts.prisma ?? defaultPrisma;
  const row = await db.auditLog.findFirst({
    where: {
      clubId: args.clubId,
      action: PREPARATION_HALT_ACTION,
      entityType: "TrainingCourseVersion",
      entityId: args.courseVersionId,
      createdAt: { gte: args.since },
    },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true, createdAt: true },
  });
  if (!row?.afterJson) return null;
  try {
    const after = JSON.parse(row.afterJson) as { code?: unknown };
    if (typeof after.code !== "string") return null;
    return { code: after.code as PreparationHaltCode, at: row.createdAt };
  } catch {
    return null;
  }
}

/** Environment gate for mock inference. Absent in production, so a
 *  MOCK authorization can neither be written nor honoured there. */
export const MOCK_INFERENCE_ENV_FLAG = "TRAINING_MOCK_INFERENCE_ALLOWED";

export function isMockInferenceAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MOCK_INFERENCE_ENV_FLAG] === "true";
}

/** Inference mode every worker must use for a version: MOCK iff the
 *  version is non-billable — an authorization asked for MOCK, it carries
 *  the test-isolation marker, or a server-listed test principal created,
 *  uploaded to, authorized or requested work for it (see
 *  test-execution-identity.ts). Sticky on purpose, resolved from durable
 *  state at execution time, and independent of any request marker: a
 *  test can never fall through to billable inference because a header
 *  went missing or a later record said LIVE. */
export async function resolveInferenceModeForVersion(
  args: { readonly clubId: string; readonly courseVersionId: string },
  opts: { prisma?: PrismaClient; env?: NodeJS.ProcessEnv } = {},
): Promise<InferenceMode> {
  const identity = await resolveProcessingIdentity(args, opts);
  return identity.nonBillable ? "MOCK" : "LIVE";
}

/** Return true iff a fresh authorization exists for the (clubId,
 *  versionId, operation) tuple. GENERATE_RECOVERY is satisfied by
 *  either a GENERATE_FULL or a GENERATE_RECOVERY record. */
export async function hasFreshProcessingAuthorization(
  args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly operation: AuthorizationOperation;
    readonly now?: Date;
  },
  opts: { prisma?: PrismaClient } = {},
): Promise<boolean> {
  const db = opts.prisma ?? defaultPrisma;
  const cutoff = new Date((args.now ?? new Date()).getTime() - AUTHORIZATION_TTL_MS);
  const acceptedOperations =
    args.operation === "GENERATE_RECOVERY"
      ? ["GENERATE_FULL", "GENERATE_RECOVERY"]
      : ["GENERATE_FULL"];
  const row = await db.auditLog.findFirst({
    where: {
      clubId: args.clubId,
      action: "hr.training.generation.authorize",
      entityType: "TrainingCourseVersion",
      entityId: args.courseVersionId,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, afterJson: true, createdAt: true },
  });
  if (!row) return false;
  // The after-JSON carries `{ operation, authorizedAt }`. We check
  // operation matches the accepted set so a lower-privileged
  // RECOVERY auth cannot grant a FULL auth. Missing / malformed JSON
  // treats the record as not matching (fail-closed).
  if (!row.afterJson) return false;
  try {
    const after = JSON.parse(row.afterJson) as { operation?: unknown };
    return typeof after.operation === "string" && acceptedOperations.includes(after.operation);
  } catch {
    return false;
  }
}

/** Compute the current authorization freshness for operator visibility.
 *  Returns `null` when no record exists in the TTL window. */
export async function readProcessingAuthorizationStatus(
  args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly now?: Date;
  },
  opts: { prisma?: PrismaClient } = {},
): Promise<{
  readonly authorizedAt: string;
  readonly operation: AuthorizationOperation;
  readonly authorizedByUserId: string | null;
} | null> {
  const db = opts.prisma ?? defaultPrisma;
  const cutoff = new Date((args.now ?? new Date()).getTime() - AUTHORIZATION_TTL_MS);
  const row = await db.auditLog.findFirst({
    where: {
      clubId: args.clubId,
      action: "hr.training.generation.authorize",
      entityType: "TrainingCourseVersion",
      entityId: args.courseVersionId,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, afterJson: true, createdAt: true, userId: true },
  });
  if (!row || !row.afterJson) return null;
  try {
    const after = JSON.parse(row.afterJson) as {
      operation?: unknown;
      authorizedAt?: unknown;
    };
    if (typeof after.operation !== "string") return null;
    return {
      authorizedAt: typeof after.authorizedAt === "string" ? after.authorizedAt : row.createdAt.toISOString(),
      operation: after.operation as AuthorizationOperation,
      authorizedByUserId: row.userId,
    };
  } catch {
    return null;
  }
}
