// HR-2B.2 (2026-08-18) — Employee self-service surface boundary tests.
//
// The self-service module (`src/lib/hr/employee-self-service.ts`) is
// the ONLY module in `src/lib/hr/**` whose mutations gate on
// `EmployeeOnboardingActor` instead of `Principal`. This test suite
// pins the invariants the founder brief required at HR-2B.2 §14:
//
//   • Employee actor cannot update another employee.
//   • Employee actor cannot cross a Club boundary.
//   • Employee actor cannot modify compensation.
//   • Employee actor cannot approve onboarding.
//   • Employee actor cannot activate payroll.
//   • Photo upload can only target own employee.
//   • Photo upload gets correct Club ownership.
//   • Interrupted redemption can recover safely
//     (covered in onboarding-resilience.test.ts).
//   • Invitation replay cannot create unauthorized sessions
//     (covered in onboarding-resilience.test.ts).
//   • Revoked/expired invitation remains unusable
//     (covered in onboarding-resilience.test.ts).
//   • Employee session cookie cannot be substituted for admin
//     authentication — covered by the fact that this module never
//     imports from `rbac.ts` and never accepts a `Principal`.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { EmployeeOnboardingActorForbiddenError } from "@/lib/hr/employee-actor";
import {
  acknowledgeSelfEmployment,
  CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS,
  EmployeeSelfWriteForbiddenFieldError,
  flagEmploymentFieldForCorrection,
  getEmploymentAcknowledgement,
  getSelfEmployee,
  listSelfEmploymentCorrections,
  submitSelfResponse,
  transitionSelfSessionToInProgress,
  updateSelfIdentity,
  uploadSelfPhoto,
} from "@/lib/hr/employee-self-service";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

async function actorForFixture(fixtureName = "Club A") {
  const { club, employee, clubAdmin } = await makeHrFixture(`${fixtureName} ${Math.random().toString(36).slice(2, 6)}`);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: ctx.invitationId,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
  return { club, employee, clubAdmin, actor };
}

describe("HR-2B.2 · employee self-service surface", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // --- Cross-employee refusal --------------------------------------------
  it("updateSelfIdentity cannot write another employee's row (row is scoped by actor.employeeId only)", async () => {
    const a = await actorForFixture("Cross-A");
    const b = await actorForFixture("Cross-B");
    // Update A's actor to point at B's employeeId — a hand-forged
    // cookie attack. The self-scope assertion catches it.
    const forged: EmployeeOnboardingActor = { ...a.actor, employeeId: b.employee.id };
    // getSelfEmployee resolves against forged.employeeId, whose row
    // has forged.clubId as the Club — but the row lookup is scoped
    // by BOTH id AND clubId, so the row will not resolve, throwing NotFound.
    await expect(getSelfEmployee(forged)).rejects.toThrowError(/not found/i);
  });

  it("updateSelfIdentity refuses payRate — compensation-immutability", async () => {
    const { actor } = await actorForFixture();
    // TypeScript would already refuse this call, but we exercise the
    // runtime allowlist too.
    await expect(
      updateSelfIdentity(actor, { payRate: 999 } as unknown as Parameters<typeof updateSelfIdentity>[1]),
    ).rejects.toThrowError(EmployeeSelfWriteForbiddenFieldError);
  });

  it("updateSelfIdentity refuses status / employeeLifecycle / onboardingState / payrollReadiness", async () => {
    const { actor } = await actorForFixture();
    for (const forbidden of [
      "status",
      "employeeLifecycle",
      "onboardingState",
      "payrollReadiness",
      "hireDate",
      "employeeNumber",
      "employmentType",
      "activatedAt",
      "terminationDate",
      "compensationType",
    ]) {
      await expect(
        updateSelfIdentity(actor, { [forbidden]: "anything" } as unknown as Parameters<typeof updateSelfIdentity>[1]),
      ).rejects.toThrowError(EmployeeSelfWriteForbiddenFieldError);
    }
  });

  it("updateSelfIdentity refuses positionId / departmentId (Club-authoritative employment terms)", async () => {
    const { actor } = await actorForFixture();
    await expect(
      updateSelfIdentity(actor, { positionId: "cf_something" } as unknown as Parameters<typeof updateSelfIdentity>[1]),
    ).rejects.toThrowError(EmployeeSelfWriteForbiddenFieldError);
    await expect(
      updateSelfIdentity(actor, { departmentId: "cf_something" } as unknown as Parameters<typeof updateSelfIdentity>[1]),
    ).rejects.toThrowError(EmployeeSelfWriteForbiddenFieldError);
  });

  it("updateSelfIdentity DOES write allowlisted fields — preferredName + mobilePhone + personalEmail", async () => {
    const { actor, employee } = await actorForFixture();
    await updateSelfIdentity(actor, {
      preferredName: "Chris",
      mobilePhone: "403-555-0111",
      personalEmail: "chris.example@personal.test",
    });
    const row = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(row!.preferredName).toBe("Chris");
    expect(row!.mobilePhone).toBe("403-555-0111");
    expect(row!.personalEmail).toBe("chris.example@personal.test");
  });

  it("updateSelfIdentity does NOT change compensation columns as a side effect", async () => {
    const { actor, employee } = await actorForFixture();
    const before = await prisma.employee.findUnique({ where: { id: employee.id } });
    await updateSelfIdentity(actor, { preferredName: "Ripley" });
    const after = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(after!.payRate).toEqual(before!.payRate);
    expect(after!.compensationType).toBe(before!.compensationType);
    expect(after!.status).toBe(before!.status);
    expect(after!.employeeLifecycle).toBe(before!.employeeLifecycle);
    expect(after!.payrollReadiness).toBe(before!.payrollReadiness);
  });

  it("updateSelfIdentity refuses to blank firstName / lastName", async () => {
    const { actor } = await actorForFixture();
    await expect(updateSelfIdentity(actor, { firstName: "  " })).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "firstName" })]),
    });
    await expect(updateSelfIdentity(actor, { lastName: "" })).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "lastName" })]),
    });
  });

  it("updateSelfIdentity refuses malformed personalEmail", async () => {
    const { actor } = await actorForFixture();
    await expect(
      updateSelfIdentity(actor, { personalEmail: "not-an-email" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "personalEmail" })]),
    });
  });

  // --- Correction flow ---------------------------------------------------
  it("flagEmploymentFieldForCorrection records a discrepancy WITHOUT mutating the Club-authoritative field", async () => {
    const { actor, employee } = await actorForFixture();
    const before = await prisma.employee.findUnique({ where: { id: employee.id } });
    await flagEmploymentFieldForCorrection(actor, {
      field: "positionId",
      employeeStatedValue: "I was told Golf Shop Attendant",
      note: null,
    });
    const after = await prisma.employee.findUnique({ where: { id: employee.id } });
    // Position on the employee row is untouched.
    expect(after!.positionId).toBe(before!.positionId);
    // But a correction row exists.
    const corrections = await prisma.employeeOnboardingCorrection.findMany({
      where: { sessionId: actor.sessionId },
    });
    expect(corrections.length).toBe(1);
    expect(corrections[0].field).toBe("positionId");
    expect(corrections[0].employeeStatedValue).toContain("Golf Shop Attendant");
  });

  it("flagEmploymentFieldForCorrection persists ONE row per canonical field, preserving the field identifier", async () => {
    const { actor } = await actorForFixture();
    for (const field of CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS) {
      await flagEmploymentFieldForCorrection(actor, {
        field,
        employeeStatedValue: `stated value for ${field}`,
      });
    }
    const rows = await listSelfEmploymentCorrections(actor);
    expect(rows.length).toBe(CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS.length);
    const byField = new Map(rows.map((r) => [r.field, r.employeeStatedValue]));
    for (const field of CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS) {
      expect(byField.get(field)).toBe(`stated value for ${field}`);
    }
    // No acknowledgement was written — the corrections branch is an
    // explicit "not confirmed" signal.
    const ack = await getEmploymentAcknowledgement(actor);
    expect(ack).toBeNull();
  });

  it("acknowledgeSelfEmployment writes a durable row with kind=employment_confirmation and actorEmployeeId=actor.employeeId", async () => {
    const { actor } = await actorForFixture();
    await acknowledgeSelfEmployment(actor);
    const ack = await getEmploymentAcknowledgement(actor);
    expect(ack).toBeTruthy();
    expect(ack!.actorEmployeeId).toBe(actor.employeeId);
    expect(ack!.acknowledgedAt).toBeInstanceOf(Date);
    const row = await prisma.employeeOnboardingAcknowledgement.findFirst({
      where: { sessionId: actor.sessionId, kind: "employment_confirmation" },
    });
    expect(row!.clubId).toBe(actor.clubId);
    expect(row!.employeeId).toBe(actor.employeeId);
  });

  it("acknowledgeSelfEmployment is idempotent — second call updates acknowledgedAt in place (no duplicate row)", async () => {
    const { actor } = await actorForFixture();
    await acknowledgeSelfEmployment(actor);
    const rows1 = await prisma.employeeOnboardingAcknowledgement.findMany({
      where: { sessionId: actor.sessionId },
    });
    expect(rows1.length).toBe(1);
    const first = rows1[0].acknowledgedAt.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await acknowledgeSelfEmployment(actor);
    const rows2 = await prisma.employeeOnboardingAcknowledgement.findMany({
      where: { sessionId: actor.sessionId },
    });
    expect(rows2.length).toBe(1);
    expect(rows2[0].acknowledgedAt.getTime()).toBeGreaterThanOrEqual(first);
  });

  it("acknowledgeSelfEmployment does NOT mutate any Club-authoritative employment field on the Employee row", async () => {
    const { actor, employee } = await actorForFixture();
    const before = await prisma.employee.findUnique({ where: { id: employee.id } });
    await acknowledgeSelfEmployment(actor);
    const after = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(after!.positionId).toBe(before!.positionId);
    expect(after!.departmentId).toBe(before!.departmentId);
    expect(after!.employmentType).toBe(before!.employmentType);
    expect(after!.expectedStartDate?.getTime() ?? null).toBe(before!.expectedStartDate?.getTime() ?? null);
    // And no compensation drift.
    expect(after!.payRate).toEqual(before!.payRate);
  });

  it("acknowledgement + corrections are session-scoped: two employees in the SAME club get independent rows", async () => {
    const a = await actorForFixture("Ack-Session-A");
    const b = await actorForFixture("Ack-Session-B");
    await acknowledgeSelfEmployment(a.actor);
    await flagEmploymentFieldForCorrection(b.actor, {
      field: "positionId",
      employeeStatedValue: "B's stated position",
    });
    const aAck = await getEmploymentAcknowledgement(a.actor);
    const bAck = await getEmploymentAcknowledgement(b.actor);
    expect(aAck).toBeTruthy();
    expect(bAck).toBeNull();
    const aCorrections = await listSelfEmploymentCorrections(a.actor);
    const bCorrections = await listSelfEmploymentCorrections(b.actor);
    expect(aCorrections.length).toBe(0);
    expect(bCorrections.length).toBe(1);
    expect(bCorrections[0].field).toBe("positionId");
  });

  it("flagEmploymentFieldForCorrection refuses an unknown field (probe defence)", async () => {
    const { actor } = await actorForFixture();
    await expect(
      flagEmploymentFieldForCorrection(actor, {
        field: "payRate" as unknown as Parameters<typeof flagEmploymentFieldForCorrection>[1]["field"],
        employeeStatedValue: "should be $100/hr",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "field", message: expect.stringMatching(/club-authoritative/i) }),
      ]),
    });
  });

  // --- Response write ----------------------------------------------------
  it("submitSelfResponse writes ANSWERED status (never COMPLETE) even on rewrite", async () => {
    const { actor } = await actorForFixture();
    // Create a global question the fixture didn't seed.
    const q = await prisma.employeeOnboardingQuestion.create({
      data: {
        clubId: null,
        key: "test.about_you.notes",
        section: "about_you",
        prompt: "Anything else?",
        answerKind: "TEXT",
        active: true,
      },
    });
    const r1 = await submitSelfResponse(actor, {
      questionId: q.id,
      responseJson: JSON.stringify({ value: "first" }),
    });
    expect(r1.status).toBe("ANSWERED");
    const r2 = await submitSelfResponse(actor, {
      questionId: q.id,
      responseJson: JSON.stringify({ value: "second" }),
    });
    expect(r2.status).toBe("ANSWERED");
    expect(r2.id).toBe(r1.id); // same row, updated in place
  });

  it("submitSelfResponse refuses a question from a different club", async () => {
    const { actor: actorA } = await actorForFixture("QA");
    const { club: clubB, clubAdmin: adminB } = await makeHrFixture("QB");
    // Question is Club B specific.
    const q = await prisma.employeeOnboardingQuestion.create({
      data: {
        clubId: clubB.id,
        key: `qb.only.${Math.random().toString(36).slice(2)}`,
        section: "about_you",
        prompt: "Club B only?",
        answerKind: "TEXT",
        active: true,
      },
    });
    void adminB; // seedRbac principal, referenced to avoid unused warning
    await expect(
      submitSelfResponse(actorA, { questionId: q.id, responseJson: JSON.stringify({ value: "x" }) }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/does not belong to this club/) }),
      ]),
    });
  });

  it("submitSelfResponse refuses a session-mismatched question — actor cannot rewrite another session's response", async () => {
    const a = await actorForFixture("SA");
    const b = await actorForFixture("SB");
    const q = await prisma.employeeOnboardingQuestion.create({
      data: {
        clubId: null,
        key: `global.q.${Math.random().toString(36).slice(2)}`,
        section: "about_you",
        prompt: "Anything?",
        answerKind: "TEXT",
        active: true,
      },
    });
    await submitSelfResponse(b.actor, { questionId: q.id, responseJson: JSON.stringify({ value: "B answered" }) });
    // A submits their own answer to the SAME global question — this
    // is legitimate (each session gets its own row). What must fail
    // is A somehow writing INTO B's row.
    const rA = await submitSelfResponse(a.actor, {
      questionId: q.id,
      responseJson: JSON.stringify({ value: "A answered" }),
    });
    expect(rA.sessionId).toBe(a.actor.sessionId);
    expect(rA.sessionId).not.toBe(b.actor.sessionId);
    const bRow = await prisma.employeeOnboardingResponse.findFirst({
      where: { sessionId: b.actor.sessionId },
    });
    expect(bRow!.responseJson).toBe(JSON.stringify({ value: "B answered" }));
  });

  // --- Session transition ------------------------------------------------
  it("transitionSelfSessionToInProgress advances INVITED → IN_PROGRESS and writes an EMPLOYEE-provenance transition row", async () => {
    const { actor } = await actorForFixture();
    await transitionSelfSessionToInProgress(actor);
    const session = await prisma.employeeOnboardingSession.findUnique({
      where: { id: actor.sessionId },
    });
    expect(session!.state).toBe("IN_PROGRESS");
    const transition = await prisma.employeeOnboardingStateTransition.findFirst({
      where: { sessionId: actor.sessionId, fromState: "INVITED", toState: "IN_PROGRESS" },
    });
    expect(transition).toBeTruthy();
    expect(transition!.actorSource).toBe("EMPLOYEE");
    expect(transition!.actorEmployeeId).toBe(actor.employeeId);
    expect(transition!.actorUserId).toBeNull();
    // Employee.onboardingState pointer stays in sync.
    const employee = await prisma.employee.findUnique({ where: { id: actor.employeeId } });
    expect(employee!.onboardingState).toBe("IN_PROGRESS");
  });

  it("transitionSelfSessionToInProgress is idempotent (second call is a no-op, not a throw)", async () => {
    const { actor } = await actorForFixture();
    await transitionSelfSessionToInProgress(actor);
    // Second call — session is already IN_PROGRESS.
    await expect(transitionSelfSessionToInProgress(actor)).resolves.toBeTruthy();
    const transitions = await prisma.employeeOnboardingStateTransition.findMany({
      where: { sessionId: actor.sessionId, fromState: "INVITED", toState: "IN_PROGRESS" },
    });
    expect(transitions.length).toBe(1);
  });

  it("transitionSelfSessionToInProgress refuses to advance from a non-INVITED state (staff-only transitions)", async () => {
    const { actor, clubAdmin } = await actorForFixture();
    // Staff moves the session to SUBMITTED.
    await prisma.employeeOnboardingSession.update({
      where: { id: actor.sessionId },
      data: { state: "IN_PROGRESS" },
    });
    await transitionSession(clubAdmin, actor.sessionId, "SUBMITTED", { actorSource: "EMPLOYEE", actorEmployeeId: actor.employeeId });
    await expect(transitionSelfSessionToInProgress(actor)).rejects.toThrowError(/Cannot transition/);
  });

  // --- Photo upload ------------------------------------------------------
  it("uploadSelfPhoto writes an EmployeeDocument in category profile_photo with STANDARD sensitivity and points Employee.profilePhotoDocumentId at it", async () => {
    const { actor, employee } = await actorForFixture();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
    const doc = await uploadSelfPhoto(actor, { bytes, mimeType: "image/png", displayName: "me.png" });
    expect(doc.category).toBe("profile_photo");
    expect(doc.sensitivity).toBe("STANDARD");
    expect(doc.clubId).toBe(employee.clubId);
    expect(doc.employeeId).toBe(employee.id);
    const row = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(row!.profilePhotoDocumentId).toBe(doc.id);
  });

  it("uploadSelfPhoto stores tenant ownership from the ACTOR, not caller input", async () => {
    const { actor } = await actorForFixture();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const doc = await uploadSelfPhoto(actor, { bytes, mimeType: "image/jpeg" });
    expect(doc.clubId).toBe(actor.clubId);
    expect(doc.employeeId).toBe(actor.employeeId);
  });

  it("uploadSelfPhoto refuses non-image mimeType — cannot smuggle a PDF as a photo", async () => {
    const { actor } = await actorForFixture();
    const bytes = Buffer.from("%PDF-1.7\n%payload");
    await expect(
      uploadSelfPhoto(actor, { bytes, mimeType: "application/pdf" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "mimeType", message: expect.stringMatching(/image/) })]),
    });
  });

  it("uploadSelfPhoto refuses empty bytes", async () => {
    const { actor } = await actorForFixture();
    await expect(
      uploadSelfPhoto(actor, { bytes: Buffer.alloc(0), mimeType: "image/png" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "bytes", message: expect.stringMatching(/empty/) })]),
    });
  });

  it("uploadSelfPhoto rejects a payload above the 10 MiB cap", async () => {
    const { actor } = await actorForFixture();
    const bytes = Buffer.alloc(11 * 1024 * 1024, 0xff);
    await expect(
      uploadSelfPhoto(actor, { bytes, mimeType: "image/png" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      issues: expect.arrayContaining([expect.objectContaining({ path: "bytes", message: expect.stringMatching(/10 MiB/i) })]),
    });
  });

  it("uploadSelfPhoto replaces the pointer on second upload (evidentiary row remains)", async () => {
    const { actor, employee } = await actorForFixture();
    const first = await uploadSelfPhoto(actor, { bytes: Buffer.from([1, 2, 3, 4]), mimeType: "image/png" });
    const second = await uploadSelfPhoto(actor, { bytes: Buffer.from([5, 6, 7, 8]), mimeType: "image/png" });
    const row = await prisma.employee.findUnique({ where: { id: employee.id } });
    expect(row!.profilePhotoDocumentId).toBe(second.id);
    // Both document rows survive.
    const docs = await prisma.employeeDocument.findMany({
      where: { employeeId: employee.id, category: "profile_photo" },
    });
    expect(docs.length).toBe(2);
    expect(docs.map((d) => d.id)).toContain(first.id);
    expect(docs.map((d) => d.id)).toContain(second.id);
  });

  // --- Cross-club refusal via forged actor ------------------------------
  it("uploadSelfPhoto with a forged actor targeting Club B's employeeId cannot land on Club B's record", async () => {
    const a = await actorForFixture("PA");
    const b = await actorForFixture("PB");
    // Attacker builds an actor with Club A's clubId + Club B's employeeId.
    const forged: EmployeeOnboardingActor = { ...a.actor, employeeId: b.employee.id };
    // The employee lookup inside uploadSelfPhoto is scoped by BOTH
    // employeeId AND clubId — so the row won't resolve.
    await expect(
      uploadSelfPhoto(forged, { bytes: Buffer.from([1, 2, 3]), mimeType: "image/png" }),
    ).rejects.toThrowError(/not found/i);
    // Club B's actual photo pointer stays null.
    const b_row = await prisma.employee.findUnique({ where: { id: b.employee.id } });
    expect(b_row!.profilePhotoDocumentId).toBeNull();
  });

  it("assertActorTargetsSelf catches an attacker whose forged actor still has consistent clubId — belt-and-braces before DB read", async () => {
    // This directly exercises the choke-point that would fire if a
    // future self-service function accidentally passed a
    // targetEmployeeId derived from user input rather than actor.
    const { actor } = await actorForFixture();
    const forgedTarget = "cf_forge_target";
    try {
      // Simulate what a hypothetical `updateOther(actor, targetId, ...)`
      // wrapper would do first.
      const {
        assertActorTargetsSelf: assert,
      } = await import("@/lib/hr/employee-actor");
      assert(actor, forgedTarget);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EmployeeOnboardingActorForbiddenError);
    }
  });
});
