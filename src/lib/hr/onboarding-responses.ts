// HR-1 (2026-08-16) — EmployeeOnboardingResponse service.
//
// Hard invariant (schema DEFAULT + service enforced):
//   `EmployeeOnboardingResponse.status` is created as "PENDING".
//   The `submitResponse` service writes rows as "PENDING" (or
//   "ANSWERED" for autosaves). ONLY the explicit `approveResponse`
//   service path may promote a row to "COMPLETE".
//
// Reads: `hr:onboarding:read`.
// Writes (submit / rewrite): `hr:onboarding:invite` OR employee-self
//   context (staff-initiated). Sensitive-action guard on the response
//   action string.
// Approve: `hr:onboarding:approve` + sensitive-action guard.
//
// Status vocabulary:
//   PENDING   — row exists but employee has not answered yet
//   ANSWERED  — employee has provided a response; awaiting review
//   COMPLETE  — reviewer approved the response
//   REJECTED  — reviewer sent it back with a note

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { findQuestionById } from "./onboarding-questions";

const RESPONSE_ENTITY = "EmployeeOnboardingResponse";

const ALLOWED_STATUSES = ["PENDING", "ANSWERED", "COMPLETE", "REJECTED"] as const;

async function loadSession(principal: Principal, sessionId: string) {
  const session = await prisma.employeeOnboardingSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError("EmployeeOnboardingSession", sessionId);
  assertTenantOwned(session, principal);
  return session;
}

async function loadResponse(principal: Principal, responseId: string) {
  const row = await prisma.employeeOnboardingResponse.findUnique({ where: { id: responseId } });
  if (!row) throw new NotFoundError(RESPONSE_ENTITY, responseId);
  assertTenantOwned(row, principal);
  return row;
}

// ---------------------------------------------------------------------------
// Submit (employee provides an answer). Creates or updates the row.
// Status transitions to "ANSWERED" (never "COMPLETE" — approver only).
// If the row does not yet exist, it is created with status "PENDING"
// FIRST, then the answer promotes it to "ANSWERED" — this preserves
// the schema DEFAULT and the "no COMPLETE in create path" rule.
// ---------------------------------------------------------------------------
export interface SubmitResponseInput {
  sessionId: string;
  questionId: string;
  responseJson: string;
}

export async function submitResponse(
  principal: Principal,
  input: SubmitResponseInput,
) {
  const session = await loadSession(principal, input.sessionId);
  requirePermission(principal, session.clubId, "hr:onboarding:invite");
  await assertSensitiveActionAllowed(
    principal,
    session.clubId,
    "hr.onboarding.response.update",
    RESPONSE_ENTITY,
    input.sessionId,
  );

  if (typeof input.questionId !== "string" || input.questionId.length === 0) {
    throw new ValidationError([{ path: "questionId", message: "required" }]);
  }
  if (typeof input.responseJson !== "string") {
    throw new ValidationError([{ path: "responseJson", message: "must be a string (JSON payload)" }]);
  }

  // Question tenancy check: the question must be either a global
  // default (clubId=null) OR belong to the session's club. Routed
  // through the canonical resolver's internal helper so the pin
  // test at tests/hr/onboarding-question-canonical-reader.test.ts
  // still catches raw reads elsewhere.
  const question = await findQuestionById(input.questionId);
  if (!question) throw new NotFoundError("EmployeeOnboardingQuestion", input.questionId);
  if (question.clubId != null && question.clubId !== session.clubId) {
    throw new ValidationError([{
      path: "questionId",
      message: `question ${input.questionId} does not belong to club ${session.clubId}`,
    }]);
  }

  const now = new Date();

  // Two-step to preserve invariant #1 (no COMPLETE writes in the
  // create path — we ALWAYS create as PENDING first, then update
  // to ANSWERED in the same transaction).
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.employeeOnboardingResponse.findUnique({
      where: { sessionId_questionId: { sessionId: input.sessionId, questionId: input.questionId } },
    });

    if (!existing) {
      // Create as PENDING (schema DEFAULT + explicit for clarity).
      const created = await tx.employeeOnboardingResponse.create({
        data: {
          clubId: session.clubId,
          sessionId: input.sessionId,
          questionId: input.questionId,
          status: "PENDING",
        },
      });
      // Promote to ANSWERED with the payload.
      return tx.employeeOnboardingResponse.update({
        where: { id: created.id },
        data: {
          responseJson: input.responseJson,
          answeredAt: now,
          status: "ANSWERED",
        },
      });
    }

    // Existing row — allow re-answer as long as it's not COMPLETE.
    if (existing.status === "COMPLETE") {
      throw new ConflictError(
        `Cannot rewrite an approved response (id=${existing.id}) — reset via reviewer workflow first`,
      );
    }

    return tx.employeeOnboardingResponse.update({
      where: { id: existing.id },
      data: {
        responseJson: input.responseJson,
        answeredAt: now,
        status: "ANSWERED",
      },
    });
  });

  await audit(principal, {
    action: "hr.onboarding.response.update",
    entityType: RESPONSE_ENTITY,
    entityId: row.id,
    clubId: session.clubId,
    after: {
      id: row.id,
      status: row.status,
      questionId: row.questionId,
      sessionId: row.sessionId,
    },
  });

  return row;
}

// ---------------------------------------------------------------------------
// Approve — the ONLY path that may set status to "COMPLETE".
// ---------------------------------------------------------------------------
export async function approveResponse(
  principal: Principal,
  responseId: string,
  opts: { reviewerNote?: string | null } = {},
) {
  const row = await loadResponse(principal, responseId);
  requirePermission(principal, row.clubId, "hr:onboarding:approve");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.onboarding.response.approve.update",
    RESPONSE_ENTITY,
    responseId,
  );

  if (row.status !== "ANSWERED") {
    throw new ConflictError(
      `Cannot approve response in status ${row.status} — must be ANSWERED`,
    );
  }

  const updated = await prisma.employeeOnboardingResponse.update({
    where: { id: responseId },
    data: {
      status: "COMPLETE",
      reviewedAt: new Date(),
      reviewerNote: opts.reviewerNote ?? null,
    },
  });

  await audit(principal, {
    action: "hr.onboarding.response.approve.update",
    entityType: RESPONSE_ENTITY,
    entityId: responseId,
    clubId: row.clubId,
    before: { status: row.status },
    after: { status: updated.status, reviewedAt: updated.reviewedAt },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Reject — sends the response back to the employee for correction.
// ---------------------------------------------------------------------------
export async function rejectResponse(
  principal: Principal,
  responseId: string,
  opts: { reviewerNote?: string | null } = {},
) {
  const row = await loadResponse(principal, responseId);
  requirePermission(principal, row.clubId, "hr:onboarding:approve");
  await assertSensitiveActionAllowed(
    principal,
    row.clubId,
    "hr.onboarding.response.update",
    RESPONSE_ENTITY,
    responseId,
  );

  if (row.status !== "ANSWERED") {
    throw new ConflictError(
      `Cannot reject response in status ${row.status} — must be ANSWERED`,
    );
  }

  const updated = await prisma.employeeOnboardingResponse.update({
    where: { id: responseId },
    data: {
      status: "REJECTED",
      reviewedAt: new Date(),
      reviewerNote: opts.reviewerNote ?? null,
    },
  });

  await audit(principal, {
    action: "hr.onboarding.response.update",
    entityType: RESPONSE_ENTITY,
    entityId: responseId,
    clubId: row.clubId,
    before: { status: row.status },
    after: { status: updated.status, reviewedAt: updated.reviewedAt },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
export async function listResponsesForSession(
  principal: Principal,
  sessionId: string,
) {
  const session = await loadSession(principal, sessionId);
  requirePermission(principal, session.clubId, "hr:onboarding:read");
  return prisma.employeeOnboardingResponse.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
}

export function isKnownResponseStatus(status: string): boolean {
  return (ALLOWED_STATUSES as readonly string[]).includes(status);
}
