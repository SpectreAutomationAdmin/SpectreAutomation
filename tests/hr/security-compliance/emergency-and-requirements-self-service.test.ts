// HR-2B.4 (2026-08-19) — Employee self-service tests for
// Emergency-contact + Requirements fulfilment.
//
// Every mutation gates on `EmployeeOnboardingActor`; every fixture
// exercises tenant + cross-employee + terminal-session invariants.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  submitSelfEmergencyContact,
  getSelfEmergencyContact,
  submitSelfCredentialDetails,
  confirmSelfRequirement,
  uploadSelfRequirementDocument,
} from "@/lib/hr/employee-self-service";
import { createOnboardingRequirement } from "@/lib/hr/onboarding-requirements";
import { ValidationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");
const PDF_BYTES = Buffer.from("%PDF-1.4\n%test\n%%EOF", "utf8");

async function actorForFixture(name: string) {
  const { club, employee, clubAdmin, foreignClub, foreignClubAdmin } = await makeAdminHrFixture(name);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId, employeeId: ctx.employeeId, sessionId: ctx.sessionId,
    invitationId: ctx.invitationId, sessionState: "INVITED", redeemedAt: new Date().toISOString(),
  };
  return { club, employee, clubAdmin, actor, foreignClub, foreignClubAdmin };
}

describe("HR-2B.4 · Emergency contact self-service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("first save creates a primary contact; second save updates it in-place", async () => {
    const { actor } = await actorForFixture("Emergency-Create");
    const first = await submitSelfEmergencyContact(actor, {
      name: "Jamie Whitfield", relation: "Spouse", phone: "403-555-0123",
    });
    expect(first.isPrimary).toBe(true);
    expect(first.name).toBe("Jamie Whitfield");

    const second = await submitSelfEmergencyContact(actor, {
      name: "Jamie W.", relation: "Spouse", phone: "403-555-9999", email: "jamie@example.test",
    });
    expect(second.id).toBe(first.id); // in-place update
    expect(second.name).toBe("Jamie W.");
    expect(second.phone).toBe("403-555-9999");
    expect(second.email).toBe("jamie@example.test");

    // Only ONE contact exists — never accumulates duplicates.
    const count = await prisma.employeeEmergencyContact.count({
      where: { employeeId: actor.employeeId },
    });
    expect(count).toBe(1);
  });

  it("rejects blank name / relation / phone with employee-friendly copy", async () => {
    const { actor } = await actorForFixture("Emergency-Blank");
    const cases = [
      { input: { name: "", relation: "Spouse", phone: "403-555-0123" }, expectPath: "name", expectMsg: /who to contact/i },
      { input: { name: "Jamie", relation: "", phone: "403-555-0123" }, expectPath: "relation", expectMsg: /how you know/i },
      { input: { name: "Jamie", relation: "Spouse", phone: "" }, expectPath: "phone", expectMsg: /phone/i },
    ];
    for (const c of cases) {
      let caught: unknown;
      try { await submitSelfEmergencyContact(actor, c.input); } catch (e) { caught = e; }
      expect(caught, `${c.expectPath} should throw`).toBeInstanceOf(ValidationError);
      const issues = (caught as ValidationError).issues;
      expect(issues.some((i) => i.path === c.expectPath && c.expectMsg.test(i.message))).toBe(true);
    }
  });

  it("rejects phone with too few digits (structural check only)", async () => {
    const { actor } = await actorForFixture("Emergency-Phone");
    let caught: unknown;
    try {
      await submitSelfEmergencyContact(actor, { name: "Jamie", relation: "Spouse", phone: "12" });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.find((i) => i.path === "phone")?.message).toMatch(/phone number we can call/i);
  });

  it("getSelfEmergencyContact returns primary + non-sensitive fields", async () => {
    const { actor } = await actorForFixture("Emergency-Get");
    await submitSelfEmergencyContact(actor, {
      name: "Jamie", relation: "Spouse", phone: "403-555-0123", email: "j@x.test",
    });
    const row = await getSelfEmergencyContact(actor);
    expect(row?.name).toBe("Jamie");
    expect(row?.isPrimary).toBe(true);
    expect(row?.email).toBe("j@x.test");
  });
});

describe("HR-2B.4 · Requirement fulfilment self-service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("uploadSelfRequirementDocument persists an EmployeeDocument with sensitivity from category", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Upload-Doc");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "WORK_PERMIT", displayName: "Work permit", kind: "DOCUMENT_UPLOAD",
      documentCategory: "work_permit", appliesToAll: true,
    });
    const result = await uploadSelfRequirementDocument(actor, {
      requirementId: req.id, bytes: PDF_BYTES, mimeType: "application/pdf",
      displayName: "permit.pdf",
    });
    expect(result.document.category).toBe("work_permit");
    // work_permit is on EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES → RESTRICTED
    expect(result.document.sensitivity).toBe("RESTRICTED");
    expect(result.credentialId).toBeNull(); // DOCUMENT_UPLOAD, no credential row
  });

  it("uploadSelfRequirementDocument upserts an EmployeeCredential when kind=CREDENTIAL_WITH_EXPIRY", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Upload-Cred");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "PROSERVE", displayName: "ProServe", kind: "CREDENTIAL_WITH_EXPIRY",
      documentCategory: "certification", appliesToAll: true, requireExpiry: true,
    });
    const result = await uploadSelfRequirementDocument(actor, {
      requirementId: req.id, bytes: PDF_BYTES, mimeType: "application/pdf",
    });
    expect(result.document.category).toBe("certification");
    expect(result.document.sensitivity).toBe("STANDARD");
    expect(result.credentialId).toBeTruthy();
    const cred = await prisma.employeeCredential.findFirst({
      where: { employeeId: actor.employeeId, credentialCode: "PROSERVE" },
    });
    expect(cred?.documentId).toBe(result.document.id);
  });

  it("uploadSelfRequirementDocument refuses foreign-club requirement id", async () => {
    const { actor, foreignClub, foreignClubAdmin } = await actorForFixture("Upload-XClub");
    const foreignReq = await createOnboardingRequirement(foreignClubAdmin, foreignClub.id, {
      code: "FOREIGN", displayName: "Foreign", kind: "DOCUMENT_UPLOAD",
      documentCategory: "certification", appliesToAll: true,
    });
    await expect(
      uploadSelfRequirementDocument(actor, {
        requirementId: foreignReq.id, bytes: PDF_BYTES, mimeType: "application/pdf",
      }),
    ).rejects.toThrow();
  });

  it("submitSelfCredentialDetails requires expiresAt when requirement.requireExpiry=true", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Cred-Expiry-Required");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "PROSERVE", displayName: "ProServe", kind: "CREDENTIAL_WITH_EXPIRY",
      documentCategory: "certification", appliesToAll: true, requireExpiry: true,
    });
    let caught: unknown;
    try {
      await submitSelfCredentialDetails(actor, { requirementId: req.id, reference: "PS-12345" });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.find((i) => i.path === "expiresAt")?.message).toMatch(/expiry/i);
  });

  it("submitSelfCredentialDetails persists reference + expiresAt", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Cred-Persist");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "PROSERVE", displayName: "ProServe", kind: "CREDENTIAL_WITH_EXPIRY",
      documentCategory: "certification", appliesToAll: true, requireExpiry: true,
    });
    const row = await submitSelfCredentialDetails(actor, {
      requirementId: req.id, reference: "PS-99999", expiresAt: "2027-06-30",
    });
    expect(row.reference).toBe("PS-99999");
    expect(row.expiresAt?.toISOString()).toBe(new Date("2027-06-30").toISOString());
    expect(row.credentialCode).toBe("PROSERVE");
  });

  it("confirmSelfRequirement records an acknowledgement keyed on requirement_confirmation:<code>", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Confirm");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "WHMIS", displayName: "WHMIS", kind: "CONFIRMATION_ONLY", appliesToAll: true,
    });
    const ack = await confirmSelfRequirement(actor, req.id);
    expect(ack.kind).toBe("requirement_confirmation:WHMIS");
    // Idempotent — second call updates the same row.
    const second = await confirmSelfRequirement(actor, req.id);
    expect(second.id).toBe(ack.id);
    const count = await prisma.employeeOnboardingAcknowledgement.count({
      where: { sessionId: actor.sessionId, kind: "requirement_confirmation:WHMIS" },
    });
    expect(count).toBe(1);
  });

  it("confirmSelfRequirement refuses a DOCUMENT_UPLOAD requirement", async () => {
    const { actor, club, clubAdmin } = await actorForFixture("Confirm-Wrong-Kind");
    const req = await createOnboardingRequirement(clubAdmin, club.id, {
      code: "WORK_PERMIT", displayName: "Work permit", kind: "DOCUMENT_UPLOAD",
      documentCategory: "work_permit", appliesToAll: true,
    });
    let caught: unknown;
    try { await confirmSelfRequirement(actor, req.id); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as ValidationError).issues;
    expect(issues.find((i) => i.path === "requirementId")?.message).toMatch(/not a confirmation/i);
  });
});
