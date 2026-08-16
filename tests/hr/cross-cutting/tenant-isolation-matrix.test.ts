// HR-1 cross-cutting drift-detection · cross-tenant rejection sweep.
//
// The individual slice suites already cover cross-tenant refusal at
// the "at least one function per module" level. This file is the
// COMPLETENESS MATRIX: one test per HR service function that accepts a
// `principal`, with a Club-B-scoped attacker attempting to operate on
// a Club-A-owned entity.
//
// A refusal is any of:
//   - TenantViolationError (assertTenantOwned)
//   - ForbiddenError       (requirePermission at the wrong club)
//   - NotFoundError        (a legitimate "wrong tenant should look
//                          like `not found`" response)
//
// A successful resolution is a REGRESSION and must fail the test.
//
// This suite is intentionally boring — each test seeds a matching
// entity in Club A, invokes the target function with the attacker
// principal, and asserts refusal via `expectRefusal`. When HR-2 adds
// a new service function, adding a test here is a one-liner.
//
// The redeem-invitation path is deliberately NOT covered by a
// principal-based cross-tenant test — its tenant safety comes from
// token→invitation→clubId resolution (no caller-supplied clubId),
// which is tested in `tests/hr/security-compliance/invitations-tenant-safety.test.ts`.

import { describe, it, beforeAll, beforeEach } from "vitest";

import {
  upsertSin,
  getSinMasked,
  revealSin,
  clearSin,
} from "@/lib/hr/sensitive-identity";
import {
  upsertBankAccount,
  getBankAccountMasked,
  revealBankAccount,
  activateBankAccount,
  deactivateBankAccount,
  rejectBankAccount,
} from "@/lib/hr/bank-account";
import {
  upsertTaxProfile,
  getTaxProfileMasked,
  revealTaxProfile,
} from "@/lib/hr/tax-profile";
import { issueInvitation, revokeInvitation } from "@/lib/hr/invitations";
import {
  createEmployee,
  updateEmployee,
  terminateEmployee,
  linkEmployeeToMember,
  unlinkEmployeeFromMember,
  setManager,
  setProfilePhoto,
  setResume,
  getEmployee,
  listEmployees,
} from "@/lib/hr/employees";
import {
  openEmploymentPeriod,
  closeCurrentEmploymentPeriod,
  getEmploymentAt,
  listEmploymentPeriods,
} from "@/lib/hr/employment-periods";
import {
  uploadEmployeeDocument,
  listEmployeeDocuments,
  getEmployeeDocument,
  deleteEmployeeDocument,
} from "@/lib/hr/documents";
import {
  createCredential,
  updateCredential,
  deleteCredential,
  listCredentials,
} from "@/lib/hr/credentials";
import {
  createEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
  listEmergencyContacts,
} from "@/lib/hr/emergency-contacts";
import {
  createSession,
  transitionSession,
  listTransitions,
} from "@/lib/hr/onboarding-sessions";
import { upsertOnboardingQuestion } from "@/lib/hr/onboarding-questions";
import {
  submitResponse,
  approveResponse,
  rejectResponse,
} from "@/lib/hr/onboarding-responses";
import {
  changeCompensation,
  getCompensationAt,
  getCurrentCompensation,
  listCompensationHistory,
} from "@/lib/hr/compensation";
import {
  upsertPayrollProfile,
  activatePayrollProfile,
  deactivatePayrollProfile,
  getPayrollProfile,
} from "@/lib/hr/payroll-profile";

import { resetDb, seedRbac, makeMember } from "../../util/db";
import { seedTwoClubsWithEmployees, expectRefusal, type TwoClubHrFixture } from "./_helpers";
import { fakeDocInput } from "../admin-workflows/_helpers";

describe("HR-1 cross-cutting · tenant-isolation matrix", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // -------------------------------------------------------------------------
  // sensitive-identity
  // -------------------------------------------------------------------------
  describe("sensitive-identity", () => {
    it("upsertSin — Club B principal cannot write SIN for a Club A employee", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        upsertSin(fx.attackerB, fx.employeeA.id, "123456789"),
        "upsertSin",
      );
    });
    it("getSinMasked — Club B principal cannot read Club A SIN", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await upsertSin(fx.seederA, fx.employeeA.id, "123456789");
      await expectRefusal(
        getSinMasked(fx.attackerB, fx.employeeA.id),
        "getSinMasked",
      );
    });
    it("revealSin — Club B principal cannot reveal Club A SIN", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await upsertSin(fx.seederA, fx.employeeA.id, "123456789");
      await expectRefusal(
        revealSin(fx.attackerB, fx.employeeA.id),
        "revealSin",
      );
    });
    it("clearSin — Club B principal cannot delete Club A SIN", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await upsertSin(fx.seederA, fx.employeeA.id, "123456789");
      await expectRefusal(
        clearSin(fx.attackerB, fx.employeeA.id),
        "clearSin",
      );
    });
  });

  // -------------------------------------------------------------------------
  // bank-account
  // -------------------------------------------------------------------------
  describe("bank-account", () => {
    async function seedBankAt(fx: TwoClubHrFixture) {
      await upsertBankAccount(fx.seederA, fx.employeeA.id, {
        institutionNumber: "003",
        transitNumber: "12345",
        accountNumber: "9876543210",
        holderName: "River Sensitive",
      });
    }
    it("upsertBankAccount — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        upsertBankAccount(fx.attackerB, fx.employeeA.id, {
          institutionNumber: "003",
          transitNumber: "12345",
          accountNumber: "9876543210",
          holderName: "X",
        }),
        "upsertBankAccount",
      );
    });
    it("getBankAccountMasked — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedBankAt(fx);
      await expectRefusal(
        getBankAccountMasked(fx.attackerB, fx.employeeA.id),
        "getBankAccountMasked",
      );
    });
    it("revealBankAccount — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedBankAt(fx);
      await expectRefusal(
        revealBankAccount(fx.attackerB, fx.employeeA.id),
        "revealBankAccount",
      );
    });
    it("activateBankAccount — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedBankAt(fx);
      await expectRefusal(
        activateBankAccount(fx.attackerB, fx.employeeA.id),
        "activateBankAccount",
      );
    });
    it("deactivateBankAccount — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedBankAt(fx);
      await activateBankAccount(fx.seederA, fx.employeeA.id);
      await expectRefusal(
        deactivateBankAccount(fx.attackerB, fx.employeeA.id),
        "deactivateBankAccount",
      );
    });
    it("rejectBankAccount — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedBankAt(fx);
      await expectRefusal(
        rejectBankAccount(fx.attackerB, fx.employeeA.id),
        "rejectBankAccount",
      );
    });
  });

  // -------------------------------------------------------------------------
  // tax-profile
  // -------------------------------------------------------------------------
  describe("tax-profile", () => {
    async function seedTaxAt(fx: TwoClubHrFixture) {
      return upsertTaxProfile(fx.seederA, fx.employeeA.id, {
        province: "ON",
        td1FormVersion: "2026-01",
        effectiveFrom: new Date("2026-01-01"),
        federalClaim: "16000.00",
        provincialClaim: "13000.00",
      });
    }
    it("upsertTaxProfile — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        upsertTaxProfile(fx.attackerB, fx.employeeA.id, {
          province: "ON",
          td1FormVersion: "2026-01",
          effectiveFrom: new Date("2026-01-01"),
          federalClaim: "16000.00",
          provincialClaim: "13000.00",
        }),
        "upsertTaxProfile",
      );
    });
    it("getTaxProfileMasked — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedTaxAt(fx);
      await expectRefusal(
        getTaxProfileMasked(fx.attackerB, fx.employeeA.id),
        "getTaxProfileMasked",
      );
    });
    it("revealTaxProfile — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const row = await seedTaxAt(fx);
      await expectRefusal(
        revealTaxProfile(fx.attackerB, row.id),
        "revealTaxProfile",
      );
    });
  });

  // -------------------------------------------------------------------------
  // invitations (redeem is caller-context-less; covered in the tenant-
  // safety pin test)
  // -------------------------------------------------------------------------
  describe("invitations", () => {
    it("issueInvitation — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        issueInvitation(fx.attackerB, fx.employeeA.id),
        "issueInvitation",
      );
    });
    it("revokeInvitation — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const inv = await issueInvitation(fx.seederA, fx.employeeA.id);
      await expectRefusal(
        revokeInvitation(fx.attackerB, inv.invitationId),
        "revokeInvitation",
      );
    });
  });

  // -------------------------------------------------------------------------
  // employees
  // -------------------------------------------------------------------------
  describe("employees", () => {
    it("createEmployee — refused when creating INTO Club A from Club B principal", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        createEmployee(fx.attackerB, fx.clubA.id, {
          firstName: "New",
          lastName: "Hire",
        }),
        "createEmployee",
      );
    });
    it("updateEmployee — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        updateEmployee(fx.attackerB, fx.employeeA.id, { firstName: "X" }),
        "updateEmployee",
      );
    });
    it("terminateEmployee — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        terminateEmployee(fx.attackerB, fx.employeeA.id, { reason: "x" }),
        "terminateEmployee",
      );
    });
    it("linkEmployeeToMember — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const memberA = await makeMember(fx.clubA.id);
      await expectRefusal(
        linkEmployeeToMember(fx.attackerB, fx.employeeA.id, memberA.id),
        "linkEmployeeToMember",
      );
    });
    it("unlinkEmployeeFromMember — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        unlinkEmployeeFromMember(fx.attackerB, fx.employeeA.id),
        "unlinkEmployeeFromMember",
      );
    });
    it("setManager — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        setManager(fx.attackerB, fx.employeeA.id, null),
        "setManager",
      );
    });
    it("setProfilePhoto — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        setProfilePhoto(fx.attackerB, fx.employeeA.id, null),
        "setProfilePhoto",
      );
    });
    it("setResume — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        setResume(fx.attackerB, fx.employeeA.id, null),
        "setResume",
      );
    });
    it("getEmployee — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        getEmployee(fx.attackerB, fx.employeeA.id),
        "getEmployee",
      );
    });
    it("listEmployees — refused when listing Club A from Club B principal", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        listEmployees(fx.attackerB, fx.clubA.id),
        "listEmployees",
      );
    });
  });

  // -------------------------------------------------------------------------
  // employment-periods
  // -------------------------------------------------------------------------
  describe("employment-periods", () => {
    it("openEmploymentPeriod — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        openEmploymentPeriod(fx.attackerB, fx.employeeA.id, {
          effectiveFrom: new Date("2024-01-01"),
          employmentType: "FULL_TIME",
          reason: "HIRE",
        }),
        "openEmploymentPeriod",
      );
    });
    it("closeCurrentEmploymentPeriod — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await openEmploymentPeriod(fx.seederA, fx.employeeA.id, {
        effectiveFrom: new Date("2024-01-01"),
        employmentType: "FULL_TIME",
        reason: "HIRE",
      });
      await expectRefusal(
        closeCurrentEmploymentPeriod(fx.attackerB, fx.employeeA.id, new Date("2024-06-01")),
        "closeCurrentEmploymentPeriod",
      );
    });
    it("getEmploymentAt — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        getEmploymentAt(fx.attackerB, fx.employeeA.id, new Date("2024-06-01")),
        "getEmploymentAt",
      );
    });
    it("listEmploymentPeriods — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        listEmploymentPeriods(fx.attackerB, fx.employeeA.id),
        "listEmploymentPeriods",
      );
    });
  });

  // -------------------------------------------------------------------------
  // documents
  // -------------------------------------------------------------------------
  describe("documents", () => {
    it("uploadEmployeeDocument — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        uploadEmployeeDocument(fx.attackerB, fx.employeeA.id, fakeDocInput("resume")),
        "uploadEmployeeDocument",
      );
    });
    it("listEmployeeDocuments — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        listEmployeeDocuments(fx.attackerB, fx.employeeA.id),
        "listEmployeeDocuments",
      );
    });
    it("getEmployeeDocument — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const doc = await uploadEmployeeDocument(fx.seederA, fx.employeeA.id, fakeDocInput("resume"));
      await expectRefusal(
        getEmployeeDocument(fx.attackerB, doc.id),
        "getEmployeeDocument",
      );
    });
    it("deleteEmployeeDocument — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const doc = await uploadEmployeeDocument(fx.seederA, fx.employeeA.id, fakeDocInput("resume"));
      await expectRefusal(
        deleteEmployeeDocument(fx.attackerB, doc.id),
        "deleteEmployeeDocument",
      );
    });
  });

  // -------------------------------------------------------------------------
  // credentials
  // -------------------------------------------------------------------------
  describe("credentials", () => {
    async function seedCredentialAt(fx: TwoClubHrFixture) {
      return createCredential(fx.seederA, fx.employeeA.id, {
        credentialCode: "SMART_SERVE",
        displayName: "Smart Serve",
      });
    }
    it("createCredential — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        createCredential(fx.attackerB, fx.employeeA.id, {
          credentialCode: "SMART_SERVE",
          displayName: "Smart Serve",
        }),
        "createCredential",
      );
    });
    it("updateCredential — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const c = await seedCredentialAt(fx);
      await expectRefusal(
        updateCredential(fx.attackerB, c.id, { displayName: "Hacked" }),
        "updateCredential",
      );
    });
    it("deleteCredential — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const c = await seedCredentialAt(fx);
      await expectRefusal(
        deleteCredential(fx.attackerB, c.id),
        "deleteCredential",
      );
    });
    it("listCredentials — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        listCredentials(fx.attackerB, fx.employeeA.id),
        "listCredentials",
      );
    });
  });

  // -------------------------------------------------------------------------
  // emergency-contacts
  // -------------------------------------------------------------------------
  describe("emergency-contacts", () => {
    async function seedContactAt(fx: TwoClubHrFixture) {
      return createEmergencyContact(fx.seederA, fx.employeeA.id, {
        name: "Emma Contact",
        relation: "Spouse",
        phone: "555-0100",
      });
    }
    it("createEmergencyContact — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        createEmergencyContact(fx.attackerB, fx.employeeA.id, {
          name: "X",
          relation: "Y",
          phone: "555-0100",
        }),
        "createEmergencyContact",
      );
    });
    it("updateEmergencyContact — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const c = await seedContactAt(fx);
      await expectRefusal(
        updateEmergencyContact(fx.attackerB, c.id, { name: "Hacked" }),
        "updateEmergencyContact",
      );
    });
    it("deleteEmergencyContact — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const c = await seedContactAt(fx);
      await expectRefusal(
        deleteEmergencyContact(fx.attackerB, c.id),
        "deleteEmergencyContact",
      );
    });
    it("listEmergencyContacts — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        listEmergencyContacts(fx.attackerB, fx.employeeA.id),
        "listEmergencyContacts",
      );
    });
  });

  // -------------------------------------------------------------------------
  // onboarding-sessions
  // -------------------------------------------------------------------------
  describe("onboarding-sessions", () => {
    it("createSession — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        createSession(fx.attackerB, fx.employeeA.id),
        "createSession",
      );
    });
    it("transitionSession — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const s = await createSession(fx.seederA, fx.employeeA.id);
      await expectRefusal(
        transitionSession(fx.attackerB, s.id, "INVITED"),
        "transitionSession",
      );
    });
    it("listTransitions — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const s = await createSession(fx.seederA, fx.employeeA.id);
      await expectRefusal(
        listTransitions(fx.attackerB, s.id),
        "listTransitions",
      );
    });
  });

  // -------------------------------------------------------------------------
  // onboarding-questions (club-scoped write; global-scope requires
  // super-admin and is exercised in the per-slice question resolver
  // suite)
  // -------------------------------------------------------------------------
  describe("onboarding-questions", () => {
    it("upsertOnboardingQuestion — Club B principal cannot write a Club-A-scoped question", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        upsertOnboardingQuestion(fx.attackerB, {
          clubId: fx.clubA.id,
          key: "cross_tenant_probe",
          section: "identity",
          prompt: "should be refused",
          answerKind: "TEXT",
        }),
        "upsertOnboardingQuestion",
      );
    });
  });

  // -------------------------------------------------------------------------
  // onboarding-responses
  // -------------------------------------------------------------------------
  describe("onboarding-responses", () => {
    async function seedAnsweredResponse(fx: TwoClubHrFixture) {
      // Seed a global question so submitResponse can reference it.
      // Global writes require super-admin; use fx.superAdmin.
      const q = await upsertOnboardingQuestion(fx.superAdmin, {
        clubId: null,
        key: "cross_tenant_probe",
        section: "identity",
        prompt: "probe",
        answerKind: "TEXT",
      });
      const session = await createSession(fx.seederA, fx.employeeA.id);
      const resp = await submitResponse(fx.seederA, {
        sessionId: session.id,
        questionId: q.id,
        responseJson: JSON.stringify({ value: "ok" }),
      });
      return { session, resp, q };
    }
    it("submitResponse — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const { session, q } = await seedAnsweredResponse(fx);
      await expectRefusal(
        submitResponse(fx.attackerB, {
          sessionId: session.id,
          questionId: q.id,
          responseJson: JSON.stringify({ value: "hacked" }),
        }),
        "submitResponse",
      );
    });
    it("approveResponse — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const { resp } = await seedAnsweredResponse(fx);
      await expectRefusal(
        approveResponse(fx.attackerB, resp.id),
        "approveResponse",
      );
    });
    it("rejectResponse — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      const { resp } = await seedAnsweredResponse(fx);
      await expectRefusal(
        rejectResponse(fx.attackerB, resp.id, { reviewerNote: "no" }),
        "rejectResponse",
      );
    });
  });

  // -------------------------------------------------------------------------
  // compensation
  // -------------------------------------------------------------------------
  describe("compensation", () => {
    async function seedCompAt(fx: TwoClubHrFixture) {
      return changeCompensation(fx.seederA, fx.employeeA.id, {
        effectiveFrom: new Date("2024-01-01"),
        amount: "22.00",
        cadence: "HOURLY",
        currency: "CAD",
      });
    }
    it("changeCompensation — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        changeCompensation(fx.attackerB, fx.employeeA.id, {
          effectiveFrom: new Date("2024-01-01"),
          amount: "22.00",
          cadence: "HOURLY",
          currency: "CAD",
        }),
        "changeCompensation",
      );
    });
    it("getCompensationAt — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedCompAt(fx);
      await expectRefusal(
        getCompensationAt(fx.attackerB, fx.employeeA.id, new Date("2024-06-01")),
        "getCompensationAt",
      );
    });
    it("getCurrentCompensation — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedCompAt(fx);
      await expectRefusal(
        getCurrentCompensation(fx.attackerB, fx.employeeA.id),
        "getCurrentCompensation",
      );
    });
    it("listCompensationHistory — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedCompAt(fx);
      await expectRefusal(
        listCompensationHistory(fx.attackerB, fx.employeeA.id),
        "listCompensationHistory",
      );
    });
  });

  // -------------------------------------------------------------------------
  // payroll-profile
  // -------------------------------------------------------------------------
  describe("payroll-profile", () => {
    async function seedProfileAt(fx: TwoClubHrFixture) {
      await upsertPayrollProfile(fx.seederA, fx.employeeA.id, {
        jurisdiction: "CA-ON",
        payGroup: "BIWEEKLY_HOURLY",
        payFrequency: "BIWEEKLY",
      });
    }
    it("upsertPayrollProfile — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await expectRefusal(
        upsertPayrollProfile(fx.attackerB, fx.employeeA.id, {
          jurisdiction: "CA-ON",
          payGroup: "BIWEEKLY_HOURLY",
          payFrequency: "BIWEEKLY",
        }),
        "upsertPayrollProfile",
      );
    });
    it("activatePayrollProfile — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedProfileAt(fx);
      await expectRefusal(
        activatePayrollProfile(fx.attackerB, fx.employeeA.id),
        "activatePayrollProfile",
      );
    });
    it("deactivatePayrollProfile — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedProfileAt(fx);
      await expectRefusal(
        deactivatePayrollProfile(fx.attackerB, fx.employeeA.id),
        "deactivatePayrollProfile",
      );
    });
    it("getPayrollProfile — refused across tenants", async () => {
      const fx = await seedTwoClubsWithEmployees();
      await seedProfileAt(fx);
      await expectRefusal(
        getPayrollProfile(fx.attackerB, fx.employeeA.id),
        "getPayrollProfile",
      );
    });
  });
});
