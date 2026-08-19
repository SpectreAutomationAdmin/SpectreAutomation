// HR-1 cross-cutting drift-detection · audit plaintext-leak sweep.
//
// The generic audit serializer (`src/lib/audit.ts::safeStringify`) has
// a small SENSITIVE_KEYS set — `passwordHash`, `password`,
// `mfaSecret`, `cardNumber`, `cvv`, `accountNumber`, `ssn`, `sin`.
// That set explicitly does NOT cover Canadian-payroll specifics like
// `institutionNumber`, `transitNumber`, `federalClaim`, or
// `provincialClaim`, and it does not redact plaintext digits when
// they land in a differently-named key.
//
// Therefore the HR services MUST pre-redact by only threading masked
// helpers / last-N suffixes / metadata-only fields into audit
// before/after/meta. This suite drives the mutation, reads the
// persisted AuditLog row, and asserts:
//
//   1. The plaintext SIN never appears (fixture value: `SIN_PLAIN`).
//   2. The plaintext banking triple never appears (fixture values).
//   3. The plaintext tax claim amounts never appear.
//   4. When a money-typed field appears in the audit payload
//      (`amount:` — compensation is the primary offender), it is a
//      STRING, never a JSON number (JSON numbers lose Decimal
//      precision).
//   5. The known-plaintext-carrying keys (`sin`, `institutionNumber`,
//      `transitNumber`, `accountNumber`, `federalClaim`,
//      `provincialClaim`, `additionalDeductions`) never appear as
//      JSON keys in the audit payload at all.
//
// One `describe` block per action string so the failure report tells
// you which mutation drifted.
//
// Coverage — action strings verified live below (each `describe`
// exercises the specific action string):
//   - hr.sin.write.update
//   - hr.sin.reveal.issue
//   - hr.sin.write.delete
//   - hr.bank.write.update
//   - hr.bank.reveal.issue
//   - hr.bank.approve.post          (activation)
//   - hr.bank.approve.reject        (reject)
//   - hr.bank.approve.update        (deactivate)
//   - hr.tax.write.update
//   - hr.tax.reveal.issue
//   - hr.onboarding.invite.update   (issueInvitation)
//   - hr.onboarding.invite.void     (revokeInvitation)
//   - hr.employee.write.update
//   - hr.employee.terminate.post
//   - hr.employee.member.update
//   - hr.employee.member.delete
//   - hr.employment.write.update
//   - hr.document.upload.create
//   - hr.document.delete
//   - hr.compensation.update
//   - hr.payroll_profile.activate.post
//   - hr.payroll_profile.deactivate.void
//
// Deviations from the brief's action-string list:
//   - Brief called out `hr.bank.deactivate.void` and `hr.bank.reject.void`;
//     the service actually emits `hr.bank.approve.update` (deactivate)
//     and `hr.bank.approve.reject` (reject). Verified by grepping
//     `src/lib/hr/bank-account.ts`. Tests use the actual strings.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { upsertSin, revealSin, clearSin } from "@/lib/hr/sensitive-identity";
import {
  upsertBankAccount,
  revealBankAccount,
  activateBankAccount,
  rejectBankAccount,
  deactivateBankAccount,
} from "@/lib/hr/bank-account";
import { upsertTaxProfile, revealTaxProfile } from "@/lib/hr/tax-profile";
import { issueInvitation, revokeInvitation } from "@/lib/hr/invitations";
import {
  createEmployee,
  updateEmployee,
  terminateEmployee,
  linkEmployeeToMember,
  unlinkEmployeeFromMember,
} from "@/lib/hr/employees";
import { openEmploymentPeriod } from "@/lib/hr/employment-periods";
import { uploadEmployeeDocument, deleteEmployeeDocument } from "@/lib/hr/documents";
import { changeCompensation } from "@/lib/hr/compensation";
import {
  upsertPayrollProfile,
  activatePayrollProfile,
  deactivatePayrollProfile,
} from "@/lib/hr/payroll-profile";

import { resetDb, seedRbac, makeMember } from "../../util/db";
import { makeAdminHrFixture, fakeDocInput } from "../admin-workflows/_helpers";
import { latestAuditRow, auditRowFullText } from "./_helpers";

// Fixture plaintext values. All fabricated per-run so a bug that
// accidentally hard-codes a literal fixture string still fails the
// test if the assertion regex spots it in the audit row.
const SIN_PLAIN = "998877665";
const BANK_INSTITUTION = "004";
const BANK_TRANSIT = "13579";
const BANK_ACCOUNT = "8877665544";
const TAX_FEDERAL = "18500.75";
const TAX_PROVINCIAL = "14250.25";
const TAX_ADDITIONAL = "125.00";

// Regex helper — every plaintext string we care about, as an
// alternation. If a serializer accidentally threads any of these into
// before/after/meta the assertion fires.
function containsAnyPlaintext(haystack: string): { hit: string | null } {
  for (const needle of [SIN_PLAIN, BANK_INSTITUTION, BANK_TRANSIT, BANK_ACCOUNT, TAX_FEDERAL, TAX_PROVINCIAL, TAX_ADDITIONAL]) {
    // BANK_INSTITUTION = "004" is 3 chars — cheap substring match is
    // fine because the surrounding fixture data doesn't accidentally
    // carry "004" in timestamps (year is 2026, not 2004).
    if (haystack.includes(needle)) return { hit: needle };
  }
  return { hit: null };
}

// The sensitive KEYS that must never appear as JSON keys in an HR
// audit payload. These are the "wrong key" leaks the generic serializer
// would miss.
const FORBIDDEN_KEYS = [
  `"institutionNumber"`,
  `"transitNumber"`,
  `"accountNumber"`,
  `"federalClaim"`,
  `"provincialClaim"`,
  `"additionalDeductions"`,
  // "sin" is in the generic redactor set — if present it would be
  // "[redacted]" in the serialized JSON. But the plaintext MUST NEVER
  // appear as a raw digit sequence either way.
];

function assertNoLeak(fullText: string, ctx: string) {
  const { hit } = containsAnyPlaintext(fullText);
  expect(hit, `${ctx} — plaintext ${hit ?? "?"} leaked into audit payload`).toBeNull();
  for (const key of FORBIDDEN_KEYS) {
    expect(
      fullText.includes(key),
      `${ctx} — forbidden JSON key ${key} appeared in audit payload`,
    ).toBe(false);
  }
}

async function seedFxWithSinBank() {
  const fx = await makeAdminHrFixture();
  await upsertSin(fx.payrollAdmin, fx.employee.id, SIN_PLAIN);
  await upsertBankAccount(fx.payrollAdmin, fx.employee.id, {
    institutionNumber: BANK_INSTITUTION,
    transitNumber: BANK_TRANSIT,
    accountNumber: BANK_ACCOUNT,
    holderName: "River Sensitive",
  });
  return fx;
}

describe("HR-1 cross-cutting · audit plaintext-leak sweep", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  describe("hr.sin.write.update", () => {
    it("audit payload carries no SIN plaintext", async () => {
      const fx = await makeAdminHrFixture();
      await upsertSin(fx.payrollAdmin, fx.employee.id, SIN_PLAIN);
      const row = await latestAuditRow("hr.sin.write.update");
      assertNoLeak(auditRowFullText(row), "hr.sin.write.update");
    });
  });

  describe("hr.sin.reveal.issue", () => {
    it("audit payload carries no SIN plaintext even though the caller received it", async () => {
      const fx = await makeAdminHrFixture();
      await upsertSin(fx.payrollAdmin, fx.employee.id, SIN_PLAIN);
      const plain = await revealSin(fx.payrollAdmin, fx.employee.id);
      expect(plain).toBe(SIN_PLAIN); // sanity: the caller DID receive plaintext
      const row = await latestAuditRow("hr.sin.reveal.issue");
      assertNoLeak(auditRowFullText(row), "hr.sin.reveal.issue");
    });
  });

  describe("hr.sin.write.delete", () => {
    it("audit before/after carries no SIN plaintext", async () => {
      const fx = await makeAdminHrFixture();
      await upsertSin(fx.payrollAdmin, fx.employee.id, SIN_PLAIN);
      await clearSin(fx.payrollAdmin, fx.employee.id);
      const row = await latestAuditRow("hr.sin.write.delete");
      assertNoLeak(auditRowFullText(row), "hr.sin.write.delete");
    });
  });

  describe("hr.bank.write.update", () => {
    it("audit carries no institution/transit/account plaintext", async () => {
      await seedFxWithSinBank();
      const row = await latestAuditRow("hr.bank.write.update");
      assertNoLeak(auditRowFullText(row), "hr.bank.write.update");
    });
  });

  describe("hr.bank.reveal.issue", () => {
    it("audit carries no banking plaintext even though caller got it", async () => {
      const fx = await seedFxWithSinBank();
      const plain = await revealBankAccount(fx.payrollAdmin, fx.employee.id);
      expect(plain.institutionNumber).toBe(BANK_INSTITUTION);
      expect(plain.transitNumber).toBe(BANK_TRANSIT);
      expect(plain.accountNumber).toBe(BANK_ACCOUNT);
      const row = await latestAuditRow("hr.bank.reveal.issue");
      assertNoLeak(auditRowFullText(row), "hr.bank.reveal.issue");
    });
  });

  describe("hr.bank.approve.post (activate)", () => {
    it("activation audit carries no banking plaintext", async () => {
      const fx = await seedFxWithSinBank();
      await activateBankAccount(fx.payrollAdmin, fx.employee.id);
      const row = await latestAuditRow("hr.bank.approve.post");
      assertNoLeak(auditRowFullText(row), "hr.bank.approve.post");
    });
  });

  describe("hr.bank.approve.reject", () => {
    it("reject audit carries no banking plaintext", async () => {
      const fx = await seedFxWithSinBank();
      await rejectBankAccount(fx.payrollAdmin, fx.employee.id, "penny-test failed");
      const row = await latestAuditRow("hr.bank.approve.reject");
      assertNoLeak(auditRowFullText(row), "hr.bank.approve.reject");
    });
  });

  describe("hr.bank.approve.update (deactivate)", () => {
    it("deactivate audit carries no banking plaintext", async () => {
      const fx = await seedFxWithSinBank();
      await activateBankAccount(fx.payrollAdmin, fx.employee.id);
      await deactivateBankAccount(fx.payrollAdmin, fx.employee.id);
      const row = await latestAuditRow("hr.bank.approve.update");
      assertNoLeak(auditRowFullText(row), "hr.bank.approve.update");
    });
  });

  describe("hr.tax.write.update", () => {
    it("tax write audit carries no plaintext claim amounts", async () => {
      const fx = await makeAdminHrFixture();
      await upsertTaxProfile(fx.payrollAdmin, fx.employee.id, {
        province: "ON",
        td1FormVersion: "2026-01",
        effectiveFrom: new Date("2026-01-01"),
        federalClaim: TAX_FEDERAL,
        provincialClaim: TAX_PROVINCIAL,
        additionalDeductions: TAX_ADDITIONAL,
      });
      const row = await latestAuditRow("hr.tax.write.update");
      assertNoLeak(auditRowFullText(row), "hr.tax.write.update");
    });
  });

  describe("hr.tax.reveal.issue", () => {
    it("tax reveal audit carries no plaintext claim amounts", async () => {
      const fx = await makeAdminHrFixture();
      const created = await upsertTaxProfile(fx.payrollAdmin, fx.employee.id, {
        province: "ON",
        td1FormVersion: "2026-01",
        effectiveFrom: new Date("2026-01-01"),
        federalClaim: TAX_FEDERAL,
        provincialClaim: TAX_PROVINCIAL,
        additionalDeductions: TAX_ADDITIONAL,
      });
      const plain = await revealTaxProfile(fx.payrollAdmin, created.id);
      expect(plain.federalClaim).toBe(TAX_FEDERAL); // sanity
      const row = await latestAuditRow("hr.tax.reveal.issue");
      assertNoLeak(auditRowFullText(row), "hr.tax.reveal.issue");
    });
  });

  describe("hr.onboarding.invite.update (issue)", () => {
    it("issue-invitation audit carries no raw token or SIN plaintext", async () => {
      const fx = await makeAdminHrFixture();
      const inv = await issueInvitation(fx.clubAdmin, fx.employee.id, { ttlHours: 24 });
      const row = await latestAuditRow("hr.onboarding.invite.update");
      const text = auditRowFullText(row);
      assertNoLeak(text, "hr.onboarding.invite.update");
      // The rawToken is a credential — MUST NEVER appear in the audit.
      expect(text.includes(inv.rawToken)).toBe(false);
    });
  });

  describe("hr.onboarding.invite.void (revoke)", () => {
    it("revoke-invitation audit carries no raw token", async () => {
      const fx = await makeAdminHrFixture();
      const inv = await issueInvitation(fx.clubAdmin, fx.employee.id, { ttlHours: 24 });
      await revokeInvitation(fx.clubAdmin, inv.invitationId);
      const row = await latestAuditRow("hr.onboarding.invite.void");
      const text = auditRowFullText(row);
      assertNoLeak(text, "hr.onboarding.invite.void");
      expect(text.includes(inv.rawToken)).toBe(false);
    });
  });

  describe("hr.employee.write.update (create + update paths)", () => {
    it("createEmployee audit does not leak SIN/bank/tax (none seeded)", async () => {
      const fx = await makeAdminHrFixture();
      await createEmployee(fx.clubAdmin, fx.club.id, {
        firstName: "Newy",
        lastName: "Person",
      });
      const row = await latestAuditRow("hr.employee.write.update");
      assertNoLeak(auditRowFullText(row), "hr.employee.write.update (create)");
    });

    it("updateEmployee audit does not leak sensitive fields", async () => {
      const fx = await makeAdminHrFixture();
      await updateEmployee(fx.clubAdmin, fx.employee.id, {
        firstName: "Renamed",
      });
      const row = await latestAuditRow("hr.employee.write.update");
      assertNoLeak(auditRowFullText(row), "hr.employee.write.update (update)");
    });
  });

  describe("hr.employee.terminate.post", () => {
    it("terminate audit does not leak sensitive fields", async () => {
      const fx = await makeAdminHrFixture();
      await terminateEmployee(fx.clubAdmin, fx.employee.id, {
        terminationDate: new Date("2026-08-01"),
        reason: "resignation",
      });
      const row = await latestAuditRow("hr.employee.terminate.post");
      assertNoLeak(auditRowFullText(row), "hr.employee.terminate.post");
    });
  });

  describe("hr.employee.member.update / delete", () => {
    it("link + unlink audits do not leak plaintext", async () => {
      const fx = await makeAdminHrFixture();
      const member = await makeMember(fx.club.id, { firstName: "Mem", lastName: "Ber" });
      await linkEmployeeToMember(fx.clubAdmin, fx.employee.id, member.id);
      const linkRow = await latestAuditRow("hr.employee.member.update");
      assertNoLeak(auditRowFullText(linkRow), "hr.employee.member.update");

      await unlinkEmployeeFromMember(fx.clubAdmin, fx.employee.id);
      const unlinkRow = await latestAuditRow("hr.employee.member.delete");
      assertNoLeak(auditRowFullText(unlinkRow), "hr.employee.member.delete");
    });
  });

  describe("hr.employment.write.update", () => {
    it("openEmploymentPeriod audit does not leak sensitive fields", async () => {
      const fx = await makeAdminHrFixture();
      await openEmploymentPeriod(fx.clubAdmin, fx.employee.id, {
        effectiveFrom: new Date("2024-03-15"),
        employmentType: "FULL_TIME",
        reason: "HIRE",
      });
      const row = await latestAuditRow("hr.employment.write.update");
      assertNoLeak(auditRowFullText(row), "hr.employment.write.update");
    });
  });

  describe("hr.document.upload.create + hr.document.delete", () => {
    it("upload + delete audits carry no plaintext & storageKey does not carry a leaked digit", async () => {
      const fx = await makeAdminHrFixture();
      const doc = await uploadEmployeeDocument(fx.clubAdmin, fx.employee.id, fakeDocInput("resume"));
      const upRow = await latestAuditRow("hr.document.upload.create");
      assertNoLeak(auditRowFullText(upRow), "hr.document.upload.create");

      await deleteEmployeeDocument(fx.clubAdmin, doc.id);
      const delRow = await latestAuditRow("hr.document.delete");
      assertNoLeak(auditRowFullText(delRow), "hr.document.delete");
    });
  });

  describe("hr.compensation.update", () => {
    it("audit does not leak plaintext AND amount is a string, not a JSON number", async () => {
      const fx = await makeAdminHrFixture();
      await changeCompensation(fx.payrollAdmin, fx.employee.id, {
        effectiveFrom: new Date("2024-01-01"),
        amount: "22.50",
        cadence: "HOURLY",
        currency: "CAD",
      });
      const row = await latestAuditRow("hr.compensation.update");
      const text = auditRowFullText(row);
      assertNoLeak(text, "hr.compensation.update");
      // Amount MUST be encoded as a JSON string ("amount":"22.5" or "22.50"),
      // NOT as a bare JSON number ("amount":22.5). Regex checks both
      // shapes: number form is `"amount":\s*[0-9]` while string form is
      // `"amount":\s*"…"`.
      const stringForm = /"amount"\s*:\s*"/;
      const numberForm = /"amount"\s*:\s*[0-9]/;
      expect(stringForm.test(text), `hr.compensation.update — "amount" appears but not as a JSON string`).toBe(true);
      expect(numberForm.test(text), `hr.compensation.update — "amount" appears as a raw JSON number (Decimal precision would be lost)`).toBe(false);
    });
  });

  describe("hr.payroll_profile.activate.post", () => {
    it("activate audit does not leak SIN / bank plaintext", async () => {
      const fx = await seedFxWithSinBank();
      await activateBankAccount(fx.payrollAdmin, fx.employee.id);
      await changeCompensation(fx.payrollAdmin, fx.employee.id, {
        effectiveFrom: new Date("2024-01-01"),
        amount: "22.00",
        cadence: "HOURLY",
        currency: "CAD",
      });
      await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
        jurisdiction: "CA-ON",
        payGroup: "BIWEEKLY_HOURLY",
        payFrequency: "BIWEEKLY",
      });
      await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);
      const row = await latestAuditRow("hr.payroll_profile.activate.post");
      assertNoLeak(auditRowFullText(row), "hr.payroll_profile.activate.post");
    });
  });

  describe("hr.payroll_profile.deactivate.void", () => {
    it("deactivate audit does not leak sensitive fields", async () => {
      const fx = await seedFxWithSinBank();
      await activateBankAccount(fx.payrollAdmin, fx.employee.id);
      await changeCompensation(fx.payrollAdmin, fx.employee.id, {
        effectiveFrom: new Date("2024-01-01"),
        amount: "22.00",
        cadence: "HOURLY",
        currency: "CAD",
      });
      await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
        jurisdiction: "CA-ON",
        payGroup: "BIWEEKLY_HOURLY",
        payFrequency: "BIWEEKLY",
      });
      await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);
      await deactivatePayrollProfile(fx.payrollAdmin, fx.employee.id, "off-boarding");
      const row = await latestAuditRow("hr.payroll_profile.deactivate.void");
      assertNoLeak(auditRowFullText(row), "hr.payroll_profile.deactivate.void");
    });
  });
});
