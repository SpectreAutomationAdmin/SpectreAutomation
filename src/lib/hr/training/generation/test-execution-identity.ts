// EP-TRAIN-4Y-BF — server-verified test execution identity.
//
// Automated browser tests run as dedicated test principals: synthetic
// user accounts the SERVER recognises as such. The identity is the
// authenticated session — never a request header, cookie flag or query
// parameter — so it cannot go missing halfway through a test: a request
// either carries the test principal's session (and is non-billable) or
// is not authenticated at all (and is rejected).
//
// A user is a test principal when EITHER holds:
//   1. its id is listed in TRAINING_TEST_PRINCIPAL_USER_IDS, or
//   2. its e-mail address is in the reserved domain `example.test`.
// The second rule lives in the database, not in per-process
// configuration, so a missing or mistyped variable on one app cannot
// silently turn a test account into a real one. `.test` is a reserved
// top-level domain: no real person can have a mailbox there.
//
// Anything a test principal touches is durably NON-BILLABLE:
//   - a course it created;
//   - a version it uploaded a video to (a marker row is written BEFORE
//     the video is stored);
//   - a version it authorized, or requested a job or run for.
// The workers resolve this from the database at execution time, so the
// identity survives queue dispatch, retries, worker restarts and browser
// termination. A non-billable version is simulated when the environment
// allows simulation and refused otherwise; it never reaches a provider.
//
// The two worlds are also kept apart: a test principal may only work on
// courses a test principal created, and a real account cannot upload
// into a test course. So a test can never leave a real manager's course
// permanently "simulated-only", and a real upload can never be answered
// with simulated content.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

export const ENV_TEST_PRINCIPAL_USER_IDS = "TRAINING_TEST_PRINCIPAL_USER_IDS" as const;
export const TEST_PRINCIPAL_EMAIL_DOMAIN = "example.test" as const;
export const TEST_ISOLATION_MARK_ACTION = "hr.training.test_isolation.mark" as const;
const AUTHORIZE_ACTION = "hr.training.generation.authorize";
const VERSION_ENTITY = "TrainingCourseVersion";

/** User ids the server's configuration lists as test principals. */
export function trainingTestPrincipalIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env[ENV_TEST_PRINCIPAL_USER_IDS];
  if (typeof raw !== "string" || raw.trim().length === 0) return new Set();
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((id) => id.trim().replace(/^["']|["']$/g, ""))
      .filter((id) => id.length > 0),
  );
}

/** True for an address in the reserved test domain. */
export function isTestPrincipalEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${TEST_PRINCIPAL_EMAIL_DOMAIN}`);
}

/** Id-only check against the configured list. */
export function isTrainingTestPrincipal(
  userId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!userId) return false;
  return trainingTestPrincipalIds(env).has(userId);
}

/** Is the authenticated caller a test principal (by id list or by
 *  reserved e-mail domain)? */
export function isTestExecutionPrincipal(
  principal: { readonly id: string; readonly email?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!principal) return false;
  return isTrainingTestPrincipal(principal.id, env) || isTestPrincipalEmail(principal.email);
}

/** Durably mark a version as non-billable. Written by the upload route
 *  before a test principal's video is stored. Append-only; nothing ever
 *  removes it. */
export async function markVersionNonBillable(
  actor: { readonly id: string },
  args: { readonly clubId: string; readonly courseVersionId: string; readonly reason: string },
  opts: { prisma?: PrismaClient } = {},
): Promise<void> {
  // Written directly (not through `audit()`, which swallows failures):
  // if the marker cannot be persisted the caller must fail, not carry on
  // unmarked.
  const db = opts.prisma ?? defaultPrisma;
  await db.auditLog.create({
    data: {
      clubId: args.clubId,
      userId: actor.id,
      action: TEST_ISOLATION_MARK_ACTION,
      entityType: VERSION_ENTITY,
      entityId: args.courseVersionId,
      afterJson: JSON.stringify({
        nonBillable: true,
        reason: args.reason,
        markedAt: new Date().toISOString(),
      }),
    },
  });
}

export type NonBillableReason =
  | "MOCK_AUTHORIZATION"
  | "TEST_ISOLATION_MARKER"
  | "AUTHORIZED_BY_TEST_PRINCIPAL"
  | "COURSE_CREATED_BY_TEST_PRINCIPAL"
  | "RUN_REQUESTED_BY_TEST_PRINCIPAL"
  | "TRANSCRIPTION_REQUESTED_BY_TEST_PRINCIPAL";

export interface ProcessingIdentity {
  /** True when this version must never reach a billable provider. */
  readonly nonBillable: boolean;
  readonly reasons: readonly NonBillableReason[];
}

/** Which of these user ids are test principals (configured list, or
 *  reserved e-mail domain read from the database)? */
async function testPrincipalsAmong(
  db: PrismaClient,
  userIds: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): Promise<ReadonlySet<string>> {
  const configured = trainingTestPrincipalIds(env);
  const result = new Set<string>();
  for (const id of userIds) if (configured.has(id)) result.add(id);
  const unknown = [...userIds].filter((id) => !result.has(id));
  if (unknown.length > 0) {
    const users = await db.user.findMany({ where: { id: { in: unknown } }, select: { id: true, email: true } });
    for (const u of users) if (isTestPrincipalEmail(u.email)) result.add(u.id);
  }
  return result;
}

/** Resolve, from durable state only, whether a version is non-billable.
 *  Sticky by construction: every signal is append-only or immutable, so
 *  once a version is non-billable it stays so. A database error
 *  propagates — callers must not treat "could not tell" as billable. */
export async function resolveProcessingIdentity(
  args: { readonly clubId: string; readonly courseVersionId: string },
  opts: { prisma?: PrismaClient; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessingIdentity> {
  const db = opts.prisma ?? defaultPrisma;
  const env = opts.env ?? process.env;
  const reasons = new Set<NonBillableReason>();

  const rows = await db.auditLog.findMany({
    where: {
      clubId: args.clubId,
      entityType: VERSION_ENTITY,
      entityId: args.courseVersionId,
      action: { in: [AUTHORIZE_ACTION, TEST_ISOLATION_MARK_ACTION] },
    },
    select: { action: true, afterJson: true, userId: true },
  });
  const authorizers = new Set<string>();
  for (const row of rows) {
    if (row.action === TEST_ISOLATION_MARK_ACTION) {
      reasons.add("TEST_ISOLATION_MARKER");
      continue;
    }
    if (row.userId) authorizers.add(row.userId);
    if (!row.afterJson) continue;
    try {
      const after = JSON.parse(row.afterJson) as { inferenceMode?: unknown };
      if (after.inferenceMode === "MOCK") reasons.add("MOCK_AUTHORIZATION");
    } catch {
      // Malformed record: it cannot authorize anything; other records
      // and the checks below still decide.
    }
  }

  const version = await db.trainingCourseVersion.findFirst({
    where: { id: args.courseVersionId, course: { clubId: args.clubId } },
    select: { course: { select: { createdByUserId: true } } },
  });
  const creator = version?.course.createdByUserId ?? null;
  const runRequesters = new Set(
    (
      await db.trainingQuestionAiGenerationRun.findMany({
        where: { clubId: args.clubId, courseVersionId: args.courseVersionId, requestedByUserId: { not: null } },
        select: { requestedByUserId: true },
        distinct: ["requestedByUserId"],
      })
    )
      .map((r) => r.requestedByUserId)
      .filter((id): id is string => typeof id === "string"),
  );
  const jobRequesters = new Set(
    (
      await db.trainingTranscriptionJob.findMany({
        where: { clubId: args.clubId, courseVersionId: args.courseVersionId },
        select: { requestedByUserId: true },
        distinct: ["requestedByUserId"],
      })
    )
      .map((j) => j.requestedByUserId)
      .filter((id): id is string => typeof id === "string"),
  );

  const everyone = new Set<string>([...authorizers, ...runRequesters, ...jobRequesters]);
  if (creator) everyone.add(creator);
  if (everyone.size > 0) {
    const testPrincipals = await testPrincipalsAmong(db, everyone, env);
    if ([...authorizers].some((id) => testPrincipals.has(id))) reasons.add("AUTHORIZED_BY_TEST_PRINCIPAL");
    if (creator && testPrincipals.has(creator)) reasons.add("COURSE_CREATED_BY_TEST_PRINCIPAL");
    if ([...runRequesters].some((id) => testPrincipals.has(id))) reasons.add("RUN_REQUESTED_BY_TEST_PRINCIPAL");
    if ([...jobRequesters].some((id) => testPrincipals.has(id))) {
      reasons.add("TRANSCRIPTION_REQUESTED_BY_TEST_PRINCIPAL");
    }
  }

  return { nonBillable: reasons.size > 0, reasons: [...reasons].sort() };
}

export type TestScope =
  /** A real account working on a real course. */
  | "REAL"
  /** A test principal working on a course a test principal created. */
  | "TEST"
  /** A test principal reaching for a real manager's course. Refused. */
  | "TEST_PRINCIPAL_ON_REAL_COURSE"
  /** A real account reaching for a test course. Refused. */
  | "REAL_PRINCIPAL_ON_TEST_COURSE";

/** Keep the two worlds apart. Callers refuse the two crossing cases
 *  BEFORE writing anything. */
export async function resolveTestScope(
  principal: { readonly id: string; readonly email?: string | null },
  args: { readonly clubId: string; readonly courseVersionId: string },
  opts: { prisma?: PrismaClient; env?: NodeJS.ProcessEnv } = {},
): Promise<TestScope> {
  const db = opts.prisma ?? defaultPrisma;
  const env = opts.env ?? process.env;
  const callerIsTest = isTestExecutionPrincipal(principal, env);
  const version = await db.trainingCourseVersion.findFirst({
    where: { id: args.courseVersionId, course: { clubId: args.clubId } },
    select: { course: { select: { createdByUserId: true } } },
  });
  const creator = version?.course.createdByUserId ?? null;
  const creatorIsTest = creator ? (await testPrincipalsAmong(db, new Set([creator]), env)).has(creator) : false;
  if (callerIsTest) return creatorIsTest ? "TEST" : "TEST_PRINCIPAL_ON_REAL_COURSE";
  if (creatorIsTest) return "REAL_PRINCIPAL_ON_TEST_COURSE";
  // A version that became non-billable some other way (an earlier
  // marker, a simulated authorization) is a test version too.
  const identity = await resolveProcessingIdentity(args, { prisma: db, env });
  return identity.nonBillable ? "REAL_PRINCIPAL_ON_TEST_COURSE" : "REAL";
}
