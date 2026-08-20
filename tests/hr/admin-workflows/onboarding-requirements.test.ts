// HR-2B.4 (2026-08-19) — OnboardingRequirement service tests.
//
// Covers: admin CRUD + applicability resolver + fulfilment checker +
// completion helpers + cross-club/permission invariants.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createOnboardingRequirement,
  updateOnboardingRequirement,
  listClubOnboardingRequirements,
  resolveApplicableRequirements,
  checkRequirementFulfillment,
  resolveRequirementStatus,
  isDocumentsSectionComplete,
  isEmergencySectionComplete,
  confirmationAckKind,
} from "@/lib/hr/onboarding-requirements";
import { ValidationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { createHash } from "crypto";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

async function makeDept(clubId: string, name: string) {
  return prisma.department.create({
    data: {
      clubId, name,
      code: name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" + Math.random().toString(36).slice(2, 6).toUpperCase(),
      isActive: true,
    },
  });
}
async function makePosition(clubId: string, name: string, deptId: string) {
  return prisma.employeePosition.create({
    data: {
      clubId, name,
      code: name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_" + Math.random().toString(36).slice(2, 6).toUpperCase(),
      isActive: true, departmentId: deptId,
    },
  });
}
async function actorForFixture(clubName: string) {
  const { club, employee, clubAdmin } = await makeAdminHrFixture(clubName);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId, employeeId: ctx.employeeId, sessionId: ctx.sessionId,
    invitationId: ctx.invitationId, sessionState: "INVITED", redeemedAt: new Date().toISOString(),
  };
  return { club, employee, clubAdmin, actor };
}

describe("HR-2B.4 · OnboardingRequirement CRUD", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("createOnboardingRequirement requires displayName + kind + applicability", async () => {
    const fx = await makeAdminHrFixture("Create-Requires");
    await expect(
      createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
        code: "", displayName: "", kind: "DOCUMENT_UPLOAD",
      }),
    ).rejects.toThrow();
  });

  it("createOnboardingRequirement enforces `appliesToAll OR dept/position`", async () => {
    const fx = await makeAdminHrFixture("Create-Applies");
    let caught: unknown;
    try {
      await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
        code: "TEST", displayName: "Test", kind: "CONFIRMATION_ONLY",
        appliesToAll: false, appliesToDeptIds: [], appliesToPositionIds: [],
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.some((i) => i.path === "appliesTo")).toBe(true);
  });

  it("createOnboardingRequirement refuses foreign-club dept/position ids", async () => {
    const fx = await makeAdminHrFixture("Create-XClub");
    const foreignDept = await makeDept(fx.foreignClub.id, "Foreign Dept");
    let caught: unknown;
    try {
      await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
        code: "TEST", displayName: "Test", kind: "DOCUMENT_UPLOAD",
        documentCategory: "certification",
        appliesToDeptIds: [foreignDept.id],
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.find((i) => i.path === "appliesToDeptIds")?.message).toMatch(/not found/i);
  });

  it("auditor cannot create; club admin can", async () => {
    const fx = await makeAdminHrFixture("Create-Auditor");
    await expect(
      createOnboardingRequirement(fx.auditor, fx.club.id, {
        code: "TEST", displayName: "Test", kind: "CONFIRMATION_ONLY", appliesToAll: true,
      }),
    ).rejects.toThrow();
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "TEST", displayName: "Test", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    expect(req.id).toBeTruthy();
  });

  it("updateOnboardingRequirement can deactivate; historical rows unaffected", async () => {
    const fx = await makeAdminHrFixture("Update-Deactivate");
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "TEST", displayName: "Test", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    const upd = await updateOnboardingRequirement(fx.clubAdmin, req.id, { active: false });
    expect(upd.active).toBe(false);
    const list = await listClubOnboardingRequirements(fx.clubAdmin, fx.club.id);
    expect(list.map((r) => r.id)).not.toContain(req.id);
    const listAll = await listClubOnboardingRequirements(fx.clubAdmin, fx.club.id, { includeInactive: true });
    expect(listAll.map((r) => r.id)).toContain(req.id);
  });

  it("cross-club admin cannot update another club's requirement", async () => {
    const fx = await makeAdminHrFixture("Update-XClub");
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "TEST", displayName: "Test", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    await expect(
      updateOnboardingRequirement(fx.foreignClubAdmin, req.id, { active: false }),
    ).rejects.toThrow();
  });
});

describe("HR-2B.4 · Applicability resolver", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("appliesToAll requirements surface for every employee", async () => {
    const fx = await makeAdminHrFixture("Applies-All");
    await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "WHMIS", displayName: "WHMIS", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    const rows = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: null, positionId: null,
    });
    expect(rows.map((r) => r.code)).toContain("WHMIS");
  });

  it("dept-scoped requirement surfaces only for matching department", async () => {
    const fx = await makeAdminHrFixture("Applies-Dept");
    const service = await makeDept(fx.club.id, "Service");
    const admin = await makeDept(fx.club.id, "Administration");
    await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "PROSERVE", displayName: "ProServe", kind: "CREDENTIAL_WITH_EXPIRY",
      documentCategory: "certification", appliesToDeptIds: [service.id], requireExpiry: true,
    });
    const rowsService = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: service.id, positionId: null,
    });
    expect(rowsService.map((r) => r.code)).toContain("PROSERVE");
    const rowsAdmin = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: admin.id, positionId: null,
    });
    expect(rowsAdmin.map((r) => r.code)).not.toContain("PROSERVE");
  });

  it("position-scoped requirement surfaces only for matching position", async () => {
    const fx = await makeAdminHrFixture("Applies-Position");
    const dept = await makeDept(fx.club.id, "Service");
    const server = await makePosition(fx.club.id, "Server", dept.id);
    const bartender = await makePosition(fx.club.id, "Bartender", dept.id);
    await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "PROSERVE_SERVERS", displayName: "ProServe (servers)", kind: "CREDENTIAL_WITH_EXPIRY",
      documentCategory: "certification", appliesToPositionIds: [server.id], requireExpiry: true,
    });
    const rowsServer = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: dept.id, positionId: server.id,
    });
    expect(rowsServer.map((r) => r.code)).toContain("PROSERVE_SERVERS");
    const rowsBartender = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: dept.id, positionId: bartender.id,
    });
    expect(rowsBartender.map((r) => r.code)).not.toContain("PROSERVE_SERVERS");
  });

  it("inactive requirements never surface", async () => {
    const fx = await makeAdminHrFixture("Applies-Inactive");
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "OLD", displayName: "Old", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    await updateOnboardingRequirement(fx.clubAdmin, req.id, { active: false });
    const rows = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: null, positionId: null,
    });
    expect(rows.map((r) => r.code)).not.toContain("OLD");
  });

  it("another club's requirements never surface", async () => {
    const fx = await makeAdminHrFixture("Applies-XClub");
    await createOnboardingRequirement(fx.foreignClubAdmin, fx.foreignClub.id, {
      code: "FOREIGN_REQ", displayName: "Foreign", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    const rows = await resolveApplicableRequirements({
      clubId: fx.club.id, employeeId: fx.employee.id, departmentId: null, positionId: null,
    });
    expect(rows.map((r) => r.code)).not.toContain("FOREIGN_REQ");
  });
});

describe("HR-2B.4 · Fulfillment checker", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("DOCUMENT_UPLOAD is satisfied only when an EmployeeDocument with matching category exists", async () => {
    const fx = await makeAdminHrFixture("Fulfill-Doc");
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "WORK_PERMIT", displayName: "Work permit", kind: "DOCUMENT_UPLOAD",
      documentCategory: "work_permit", appliesToAll: true,
    });
    const before = await checkRequirementFulfillment({
      requirement: { id: req.id, code: req.code, kind: req.kind, documentCategory: req.documentCategory, requireExpiry: req.requireExpiry },
      employeeId: fx.employee.id, sessionId: null,
    });
    expect(before.satisfied).toBe(false);
    await prisma.employeeDocument.create({
      data: {
        clubId: fx.club.id, employeeId: fx.employee.id,
        storageKey: "s3://test/wp", contentSha256: "a".repeat(64),
        sizeBytes: 100, mimeType: "application/pdf", category: "work_permit",
      },
    });
    const after = await checkRequirementFulfillment({
      requirement: { id: req.id, code: req.code, kind: req.kind, documentCategory: req.documentCategory, requireExpiry: req.requireExpiry },
      employeeId: fx.employee.id, sessionId: null,
    });
    expect(after.satisfied).toBe(true);
    expect(after.documentId).toBeTruthy();
  });

  it("CREDENTIAL_WITH_EXPIRY + requireExpiry blocks until expiresAt is set", async () => {
    const fx = await makeAdminHrFixture("Fulfill-Cred");
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "PROSERVE", displayName: "ProServe", kind: "CREDENTIAL_WITH_EXPIRY",
      documentCategory: "certification", appliesToAll: true, requireExpiry: true,
    });
    // Row exists but expiresAt missing → still unsatisfied.
    await prisma.employeeCredential.create({
      data: {
        clubId: fx.club.id, employeeId: fx.employee.id,
        credentialCode: "PROSERVE", displayName: "ProServe",
      },
    });
    const missing = await checkRequirementFulfillment({
      requirement: { id: req.id, code: req.code, kind: req.kind, documentCategory: req.documentCategory, requireExpiry: req.requireExpiry },
      employeeId: fx.employee.id, sessionId: null,
    });
    expect(missing.satisfied).toBe(false);
    await prisma.employeeCredential.updateMany({
      where: { employeeId: fx.employee.id, credentialCode: "PROSERVE" },
      data: { expiresAt: new Date("2027-06-30") },
    });
    const ok = await checkRequirementFulfillment({
      requirement: { id: req.id, code: req.code, kind: req.kind, documentCategory: req.documentCategory, requireExpiry: req.requireExpiry },
      employeeId: fx.employee.id, sessionId: null,
    });
    expect(ok.satisfied).toBe(true);
    expect(ok.expiresAt?.toISOString()).toBe(new Date("2027-06-30").toISOString());
  });

  it("CONFIRMATION_ONLY needs an EmployeeOnboardingAcknowledgement keyed on requirement_confirmation:<code>", async () => {
    const fx = await actorForFixture("Fulfill-Confirm");
    const req = await createOnboardingRequirement(fx.clubAdmin, fx.club.id, {
      code: "WHMIS", displayName: "WHMIS", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    const before = await checkRequirementFulfillment({
      requirement: { id: req.id, code: req.code, kind: req.kind, documentCategory: req.documentCategory, requireExpiry: req.requireExpiry },
      employeeId: fx.employee.id, sessionId: fx.actor.sessionId,
    });
    expect(before.satisfied).toBe(false);
    await prisma.employeeOnboardingAcknowledgement.create({
      data: {
        clubId: fx.club.id, sessionId: fx.actor.sessionId, employeeId: fx.employee.id,
        kind: confirmationAckKind("WHMIS"), actorEmployeeId: fx.employee.id,
        acknowledgedAt: new Date(),
      },
    });
    const after = await checkRequirementFulfillment({
      requirement: { id: req.id, code: req.code, kind: req.kind, documentCategory: req.documentCategory, requireExpiry: req.requireExpiry },
      employeeId: fx.employee.id, sessionId: fx.actor.sessionId,
    });
    expect(after.satisfied).toBe(true);
    expect(after.acknowledgedAt).toBeTruthy();
  });
});

describe("HR-2B.4 · Completion helpers", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Emergency incomplete when no contact; complete when primary contact has name+relation+phone", async () => {
    const { actor, club, employee } = await actorForFixture("Emergency-Complete");
    expect(await isEmergencySectionComplete(actor)).toBe(false);
    await prisma.employeeEmergencyContact.create({
      data: {
        clubId: club.id, employeeId: employee.id,
        name: "Jamie", relation: "Spouse", phone: "403-555-0123",
        isPrimary: true,
      },
    });
    expect(await isEmergencySectionComplete(actor)).toBe(true);
  });

  it("Documents complete only when every REQUIRED applicable requirement is satisfied; optional never blocks", async () => {
    const { actor, club, employee, clubAdmin } = await actorForFixture("Docs-Complete");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "PROSERVE", displayName: "ProServe", kind: "CONFIRMATION_ONLY",
      appliesToAll: true, required: true,
    });
    const optReq = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "OPTIONAL_ONE", displayName: "Optional one", kind: "CONFIRMATION_ONLY",
      appliesToAll: true, required: false,
    });
    expect(req.id).toBeTruthy();
    expect(optReq.id).toBeTruthy();
    // Required unsatisfied → incomplete.
    expect(await isDocumentsSectionComplete(actor)).toBe(false);
    // Satisfy required → complete (even without optional).
    await prisma.employeeOnboardingAcknowledgement.create({
      data: {
        clubId: club.id, sessionId: actor.sessionId, employeeId: employee.id,
        kind: confirmationAckKind("PROSERVE"), actorEmployeeId: employee.id,
        acknowledgedAt: new Date(),
      },
    });
    expect(await isDocumentsSectionComplete(actor)).toBe(true);
  });

  it("Documents complete with zero applicable requirements (empty-state)", async () => {
    const { actor } = await actorForFixture("Docs-Empty");
    expect(await isDocumentsSectionComplete(actor)).toBe(true);
  });

  it("resolveRequirementStatus returns both requirement + fulfillment", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Status-Resolve");
    await createOnboardingRequirement(clubAdmin, club.id, {
      code: "TEST", displayName: "Test", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    const status = await resolveRequirementStatus(actor);
    expect(status.requirements.length).toBe(1);
    expect(status.requirements[0].requirement.code).toBe("TEST");
    expect(status.requirements[0].fulfillment.satisfied).toBe(false);
  });
});
