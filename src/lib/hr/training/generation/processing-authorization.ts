// EP-TRAIN-4Y-BC §6 — Durable, explicit per-version AI-generation
// processing authorization. Replaces the BB 5-minute "recent FAILED
// cooldown" with a stronger invariant:
//
//   > No GPU-side-effect endpoint may enqueue a generation run for
//   > `(clubId, courseVersionId, operation)` unless an AuditLog row
//   > with action="hr.training.generation.authorize" exists for that
//   > tuple, created in the last `AUTHORIZATION_TTL_MS` by a principal
//   > with hr:training:write.
//
// Why AuditLog: Spectre already has it, it is append-only in
// production (no UPDATE/DELETE grants on the application role), and it
// carries `userId` + `createdAt` + `metaJson` — enough to express a
// replay-protected authorization scoped to (versionId, operation).
//
// The record is written by:
//   - `/start-preparation` (explicit Start click, covers both
//     transcription and downstream generation under one umbrella).
//   - A new explicit `/authorize-recovery` endpoint when the manager
//     clicks "Continue preparation" to recover a shortfall.
//   - (Future) the upload-completion handler, so the natural
//     upload → auto-transcribe → auto-generate flow works without a
//     separate button for first-time preparation.
//
// Legacy browser polls do NOT go through the explicit endpoints and
// therefore cannot produce an authorization. The auto-prepare generation
// branch refuses when no fresh auth is found.

import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Principal } from "@/lib/rbac";
import type { PrismaClient } from "@prisma/client";

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
    },
  });
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
