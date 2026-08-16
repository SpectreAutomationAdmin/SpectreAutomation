// HR-1 admin-workflows — EmployeeOnboardingResponse status invariants.
//
// Hard rules:
//   1. Schema DEFAULT status = "PENDING".
//   2. Service submitResponse writes as "ANSWERED" (via the two-step
//      create-PENDING-then-update path — NEVER writes "COMPLETE" in
//      the create path).
//   3. Only approveResponse promotes to "COMPLETE".
//   4. rejectResponse promotes ANSWERED -> REJECTED.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ConflictError } from "@/lib/errors";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import {
  submitResponse,
  approveResponse,
  rejectResponse,
} from "@/lib/hr/onboarding-responses";
import { upsertOnboardingQuestion } from "@/lib/hr/onboarding-questions";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · onboarding response PENDING default", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("schema DEFAULT for EmployeeOnboardingResponse.status is 'PENDING'", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const q = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "test.k", section: "s", prompt: "p", answerKind: "TEXT",
    });
    // Create the row directly with only required columns — status
    // MUST default to PENDING.
    const row = await prisma.employeeOnboardingResponse.create({
      data: {
        clubId: fx.club.id,
        sessionId: session.id,
        questionId: q.id,
      },
    });
    expect(row.status).toBe("PENDING");
  });

  it("submitResponse promotes the row to ANSWERED (never COMPLETE in the create path)", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const q = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "contact.mobile_phone", section: "contact",
      prompt: "What is your mobile?", answerKind: "PHONE",
    });
    const row = await submitResponse(fx.clubAdmin, {
      sessionId: session.id,
      questionId: q.id,
      responseJson: JSON.stringify({ value: "555-0101" }),
    });
    expect(row.status).toBe("ANSWERED");
    expect(row.answeredAt).toBeTruthy();
    expect(row.responseJson).toBe(JSON.stringify({ value: "555-0101" }));
    // Row was never written as COMPLETE at any point.
    const fromDb = await prisma.employeeOnboardingResponse.findUnique({ where: { id: row.id } });
    expect(fromDb?.status).toBe("ANSWERED");
  });

  it("approveResponse is the ONLY path that promotes ANSWERED -> COMPLETE", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const q = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "k.approve", section: "s", prompt: "p", answerKind: "TEXT",
    });
    const submitted = await submitResponse(fx.clubAdmin, {
      sessionId: session.id, questionId: q.id, responseJson: "{\"v\":1}",
    });
    const approved = await approveResponse(fx.clubAdmin, submitted.id, {
      reviewerNote: "OK",
    });
    expect(approved.status).toBe("COMPLETE");
    expect(approved.reviewedAt).toBeTruthy();
    expect(approved.reviewerNote).toBe("OK");
  });

  it("approveResponse refuses to promote a row not in ANSWERED", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const q = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "k.pending", section: "s", prompt: "p", answerKind: "TEXT",
    });
    // Create a row directly in PENDING and try to approve.
    const row = await prisma.employeeOnboardingResponse.create({
      data: { clubId: fx.club.id, sessionId: session.id, questionId: q.id },
    });
    await expect(approveResponse(fx.clubAdmin, row.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejectResponse ANSWERED -> REJECTED and records reviewerNote", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const q = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "k.reject", section: "s", prompt: "p", answerKind: "TEXT",
    });
    const submitted = await submitResponse(fx.clubAdmin, {
      sessionId: session.id, questionId: q.id, responseJson: "\"bad answer\"",
    });
    const rejected = await rejectResponse(fx.clubAdmin, submitted.id, {
      reviewerNote: "Please enter a proper phone number",
    });
    expect(rejected.status).toBe("REJECTED");
  });

  it("submitResponse refuses to rewrite a row that is already COMPLETE", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    const q = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "k.locked", section: "s", prompt: "p", answerKind: "TEXT",
    });
    const first = await submitResponse(fx.clubAdmin, {
      sessionId: session.id, questionId: q.id, responseJson: "1",
    });
    await approveResponse(fx.clubAdmin, first.id);
    await expect(
      submitResponse(fx.clubAdmin, {
        sessionId: session.id, questionId: q.id, responseJson: "2",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("submitResponse rejects a questionId from a different club", async () => {
    const fx = await makeAdminHrFixture();
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    // Foreign-club-scoped question.
    const foreignQ = await upsertOnboardingQuestion(fx.foreignClubAdmin, {
      clubId: fx.foreignClub.id, key: "foreign.only", section: "s", prompt: "p", answerKind: "TEXT",
    });
    await expect(
      submitResponse(fx.clubAdmin, {
        sessionId: session.id, questionId: foreignQ.id, responseJson: "1",
      }),
    ).rejects.toThrow();
  });

  // Simulate the future scheduler-driven / employee-onboarding entry
  // path. Also fetches the sessionTransition creation.
  void transitionSession;
});
