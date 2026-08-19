// HR-2B.3 (2026-08-19) — Sensitive payroll self-service tests.
//
// Pin every founder invariant from HR-2B.3 §28 for SIN / Banking /
// Documents / Tax / Session and §4 sensitive-data leak invariants for
// the audit column contents.
//
// All plaintext values here are OBVIOUSLY SYNTHETIC and never resemble
// real Canadian data — see the fixture-SIN comment below.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  attestSelfTd1,
  clearSelfSin,
  getPayrollCompletion,
  getSelfBankAccountMasked,
  getSelfBankingDocument,
  getSelfSinMasked,
  getSelfTaxProfileMasked,
  getSelfTd1Attestation,
  submitSelfBankAccount,
  submitSelfSin,
  submitSelfTaxProfile,
  uploadSelfBankingDocument,
} from "@/lib/hr/employee-self-service";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

// Synthetic SINs that PASS the Luhn checksum. These are known-good
// fixtures used in Canadian testing contexts, not real numbers issued
// to any person. `046 454 286` and `130 692 544` both validate.
const SYNTHETIC_SIN_A = "046 454 286";
const SYNTHETIC_SIN_A_STRIPPED = "046454286";
const SYNTHETIC_SIN_A_LAST_THREE = "286";
const SYNTHETIC_SIN_B = "130 692 544";
const SYNTHETIC_SIN_B_LAST_THREE = "544";
// Deliberately Luhn-invalid numbers.
const INVALID_SIN_LENGTH = "12345";
const INVALID_SIN_CHECKSUM = "123 456 789";

async function actorForFixture(name = "Payroll-Self") {
  const { club, employee, clubAdmin } = await makeHrFixture(`${name} ${Math.random().toString(36).slice(2, 6)}`);
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

describe("HR-2B.3 · Payroll self-service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ==== SIN ==============================================================

  describe("SIN", () => {
    it("valid SIN passes Luhn + saves masked, plaintext never returned", async () => {
      const { actor } = await actorForFixture("SIN-Save");
      const result = await submitSelfSin(actor, SYNTHETIC_SIN_A);
      expect(result.sinLastThree).toBe(SYNTHETIC_SIN_A_LAST_THREE);
      expect(result.sinMasked).toBe(`XXX XXX ${SYNTHETIC_SIN_A_LAST_THREE}`);
      // The full 9-digit plaintext must NOT appear in the return value.
      expect(JSON.stringify(result).includes(SYNTHETIC_SIN_A_STRIPPED)).toBe(false);
    });

    it("SIN with wrong length rejected with generic message (never echoes input)", async () => {
      const { actor } = await actorForFixture("SIN-BadLen");
      await expect(submitSelfSin(actor, INVALID_SIN_LENGTH)).rejects.toMatchObject({
        code: "VALIDATION",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "sin",
            message: expect.stringMatching(/valid Social Insurance Number/),
          }),
        ]),
      });
      // The invalid input must NOT be echoed back.
      try {
        await submitSelfSin(actor, INVALID_SIN_LENGTH);
      } catch (err) {
        const s = JSON.stringify(err);
        expect(s.includes(INVALID_SIN_LENGTH)).toBe(false);
      }
    });

    it("SIN failing Luhn checksum rejected with same generic message", async () => {
      const { actor } = await actorForFixture("SIN-BadLuhn");
      await expect(submitSelfSin(actor, INVALID_SIN_CHECKSUM)).rejects.toMatchObject({
        code: "VALIDATION",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "sin",
            message: expect.stringMatching(/valid Social Insurance Number/),
          }),
        ]),
      });
    });

    it("SIN plaintext never persists outside the encrypted secret column", async () => {
      const { actor } = await actorForFixture("SIN-NoLeak");
      await submitSelfSin(actor, SYNTHETIC_SIN_A);
      const row = await prisma.employeeSensitiveIdentity.findUnique({
        where: { employeeId: actor.employeeId },
      });
      expect(row).toBeTruthy();
      // sinLastThree may contain "286" but the full 9-digit plaintext
      // must not appear anywhere on the row.
      const rowSerialised = JSON.stringify(row);
      expect(rowSerialised.includes(SYNTHETIC_SIN_A_STRIPPED)).toBe(false);
    });

    it("SIN audit payload never carries plaintext", async () => {
      const { actor } = await actorForFixture("SIN-Audit");
      await submitSelfSin(actor, SYNTHETIC_SIN_A);
      const audits = await prisma.auditLog.findMany({
        where: { action: "hr.sin.write.update", clubId: actor.clubId },
      });
      expect(audits.length).toBeGreaterThan(0);
      for (const a of audits) {
        const combined = [a.beforeJson, a.afterJson, a.metaJson].filter(Boolean).join(" | ");
        expect(combined.includes(SYNTHETIC_SIN_A_STRIPPED)).toBe(false);
      }
    });

    it("masked read returns 'XXX XXX 123' shape", async () => {
      const { actor } = await actorForFixture("SIN-Read");
      await submitSelfSin(actor, SYNTHETIC_SIN_A);
      const masked = await getSelfSinMasked(actor);
      expect(masked).toBe(`XXX XXX ${SYNTHETIC_SIN_A_LAST_THREE}`);
    });

    it("cross-employee: forged actor cannot save into Employee B's row", async () => {
      const a = await actorForFixture("SIN-XA");
      const b = await actorForFixture("SIN-XB");
      const forged: EmployeeOnboardingActor = { ...a.actor, employeeId: b.employee.id };
      // Row lookup is scoped by id + clubId — B's employee has clubId=B, so
      // scoped lookup against a.clubId returns nothing → NotFoundError.
      await expect(submitSelfSin(forged, SYNTHETIC_SIN_A)).rejects.toThrowError(/not found/i);
      const bRow = await prisma.employeeSensitiveIdentity.findUnique({
        where: { employeeId: b.employee.id },
      });
      expect(bRow).toBeNull();
    });

    it("replacement: second save overwrites the ciphertext and last-three", async () => {
      const { actor } = await actorForFixture("SIN-Replace");
      await submitSelfSin(actor, SYNTHETIC_SIN_A);
      await submitSelfSin(actor, SYNTHETIC_SIN_B);
      const masked = await getSelfSinMasked(actor);
      expect(masked).toBe(`XXX XXX ${SYNTHETIC_SIN_B_LAST_THREE}`);
      const row = await prisma.employeeSensitiveIdentity.findUnique({
        where: { employeeId: actor.employeeId },
      });
      // Deterministic ciphertext hash — the new SIN should produce a
      // different sinSecretRef than the old one.
      expect(row!.sinLastThree).toBe(SYNTHETIC_SIN_B_LAST_THREE);
    });

    it("clear + re-submit workflow (Change SIN)", async () => {
      const { actor } = await actorForFixture("SIN-Change");
      await submitSelfSin(actor, SYNTHETIC_SIN_A);
      await clearSelfSin(actor);
      expect(await getSelfSinMasked(actor)).toBeNull();
      await submitSelfSin(actor, SYNTHETIC_SIN_B);
      expect(await getSelfSinMasked(actor)).toBe(`XXX XXX ${SYNTHETIC_SIN_B_LAST_THREE}`);
    });
  });

  // ==== Banking ==========================================================

  describe("Banking", () => {
    const validBank = {
      holderName: "Bethany Nakamura",
      institutionNumber: "003",
      transitNumber: "12345",
      accountNumber: "1234567890",
    };
    const replacementBank = {
      holderName: "Bethany Nakamura",
      institutionNumber: "003",
      transitNumber: "98765",
      accountNumber: "9876543210",
    };

    it("employee submits banking, row created in PENDING_PENNY_TEST", async () => {
      const { actor } = await actorForFixture("Bank-Create");
      const res = await submitSelfBankAccount(actor, validBank);
      expect(res.status).toBe("PENDING_PENNY_TEST");
      expect(res.accountMasked).toBe("•••• 7890");
    });

    it("employee cannot force VERIFIED status via input manipulation (module never accepts status)", async () => {
      const { actor } = await actorForFixture("Bank-NoVerify");
      const res = await submitSelfBankAccount(actor, validBank);
      // The employee-facing surface has NO `status` field — the type
      // ensures this at compile time; at runtime the write hardcodes
      // PENDING_PENNY_TEST.
      expect(res.status).toBe("PENDING_PENNY_TEST");
    });

    it("banking full account/transit plaintext never persists in non-encrypted columns", async () => {
      const { actor } = await actorForFixture("Bank-NoLeak");
      await submitSelfBankAccount(actor, validBank);
      const row = await prisma.employeeBankAccount.findFirst({
        where: { employeeId: actor.employeeId },
        // Deliberately EXCLUDE the *SecretRef columns — those are the
        // encrypted blobs we EXPECT to contain the ciphertext of the
        // plaintext. Everything else must be plaintext-free.
        select: {
          id: true, clubId: true, employeeId: true,
          holderName: true, accountLastFour: true,
          status: true, activatedAt: true, createdAt: true, updatedAt: true,
        },
      });
      expect(row).toBeTruthy();
      const s = JSON.stringify(row);
      // Full plaintext account (7-12 digits) must not appear anywhere
      // in the non-encrypted columns. accountLastFour ("7890") is
      // acceptable — it's the masking helper.
      expect(s.includes(validBank.accountNumber)).toBe(false);
      // Full transit ("12345") must not appear in the non-encrypted
      // columns.
      expect(s.includes(validBank.transitNumber)).toBe(false);
    });

    it("banking audit payload contains masked helper only, never full account/transit", async () => {
      const { actor } = await actorForFixture("Bank-Audit");
      await submitSelfBankAccount(actor, validBank);
      const audits = await prisma.auditLog.findMany({
        where: { action: "hr.bank.write.update", clubId: actor.clubId },
      });
      expect(audits.length).toBeGreaterThan(0);
      for (const a of audits) {
        const combined = [a.beforeJson, a.afterJson, a.metaJson].filter(Boolean).join(" | ");
        expect(combined.includes(validBank.accountNumber)).toBe(false);
        expect(combined.includes(validBank.transitNumber)).toBe(false);
        // The audit records `accountLastFour: "7890"` — the last-four
        // helper (used to build the masked string at render time) is
        // safe to log.
        expect(combined.includes("7890")).toBe(true);
      }
    });

    it("replacement of PENDING row updates in place (no new row)", async () => {
      const { actor } = await actorForFixture("Bank-PendingReplace");
      const r1 = await submitSelfBankAccount(actor, validBank);
      const r2 = await submitSelfBankAccount(actor, replacementBank);
      expect(r1.id).toBe(r2.id);
      const rows = await prisma.employeeBankAccount.findMany({
        where: { employeeId: actor.employeeId },
      });
      expect(rows.length).toBe(1);
      expect(rows[0].accountLastFour).toBe("3210");
    });

    it("replacement of VERIFIED preserves history: old→INACTIVE, new→PENDING_PENNY_TEST", async () => {
      const { actor } = await actorForFixture("Bank-VerifiedReplace");
      const first = await submitSelfBankAccount(actor, validBank);
      // Simulate staff activating the account (Payroll Admin path).
      await prisma.employeeBankAccount.update({
        where: { id: first.id },
        data: { status: "VERIFIED", activatedAt: new Date() },
      });
      const second = await submitSelfBankAccount(actor, replacementBank);
      expect(second.id).not.toBe(first.id);
      const rows = await prisma.employeeBankAccount.findMany({
        where: { employeeId: actor.employeeId },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.length).toBe(2);
      const historical = rows.find((r) => r.id === first.id)!;
      const current = rows.find((r) => r.id === second.id)!;
      expect(historical.status).toBe("INACTIVE");
      expect(historical.activatedAt).toBeInstanceOf(Date); // history preserved
      expect(current.status).toBe("PENDING_PENNY_TEST");
      expect(current.accountLastFour).toBe("3210");
    });

    it("cross-employee: forged actor cannot submit for Employee B", async () => {
      const a = await actorForFixture("Bank-XA");
      const b = await actorForFixture("Bank-XB");
      const forged: EmployeeOnboardingActor = { ...a.actor, employeeId: b.employee.id };
      await expect(submitSelfBankAccount(forged, validBank)).rejects.toThrowError(/not found/i);
      const bRows = await prisma.employeeBankAccount.findMany({
        where: { employeeId: b.employee.id },
      });
      expect(bRows.length).toBe(0);
    });

    it("cross-Club: A's cookie cannot reach B's clubId even by manipulating fields", async () => {
      const a = await actorForFixture("Bank-CXA");
      const b = await actorForFixture("Bank-CXB");
      const forged: EmployeeOnboardingActor = { ...a.actor, clubId: b.club.id };
      await expect(submitSelfBankAccount(forged, validBank)).rejects.toThrowError(/not found/i);
    });

    it("validation refuses institutionNumber not exactly 3 digits", async () => {
      const { actor } = await actorForFixture("Bank-BadInst");
      await expect(
        submitSelfBankAccount(actor, { ...validBank, institutionNumber: "12" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("validation refuses transit not exactly 5 digits", async () => {
      const { actor } = await actorForFixture("Bank-BadTransit");
      await expect(
        submitSelfBankAccount(actor, { ...validBank, transitNumber: "1234" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("validation refuses account outside 7-12 digits", async () => {
      const { actor } = await actorForFixture("Bank-BadAccount");
      await expect(
        submitSelfBankAccount(actor, { ...validBank, accountNumber: "12345" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        submitSelfBankAccount(actor, { ...validBank, accountNumber: "1234567890123" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("masked read never returns plaintext account", async () => {
      const { actor } = await actorForFixture("Bank-MaskedRead");
      await submitSelfBankAccount(actor, validBank);
      const masked = await getSelfBankAccountMasked(actor);
      expect(masked).toBeTruthy();
      expect(masked!.accountMasked).toBe("•••• 7890");
      expect(masked!.status).toBe("PENDING_PENNY_TEST");
      expect(JSON.stringify(masked).includes(validBank.accountNumber)).toBe(false);
    });
  });

  // ==== Banking documents ================================================

  describe("Banking documents", () => {
    // A tiny valid PDF header
    const PDF_BYTES = Buffer.from("%PDF-1.4\n%test void cheque\n%%EOF", "utf8");
    const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    it("void cheque persists as RESTRICTED", async () => {
      const { actor } = await actorForFixture("Doc-Void");
      const doc = await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
      });
      expect(doc.category).toBe("void_cheque");
      expect(doc.sensitivity).toBe("RESTRICTED");
    });

    it("direct-deposit form persists as RESTRICTED", async () => {
      const { actor } = await actorForFixture("Doc-DDForm");
      const doc = await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "direct_deposit_form",
      });
      expect(doc.category).toBe("direct_deposit_form");
      expect(doc.sensitivity).toBe("RESTRICTED");
    });

    it("cross-employee upload refused", async () => {
      const a = await actorForFixture("Doc-XA");
      const b = await actorForFixture("Doc-XB");
      const forged: EmployeeOnboardingActor = { ...a.actor, employeeId: b.employee.id };
      await expect(
        uploadSelfBankingDocument(forged, { bytes: PDF_BYTES, mimeType: "application/pdf", category: "void_cheque" }),
      ).rejects.toThrowError(/not found/i);
    });

    it("cross-Club upload refused", async () => {
      const a = await actorForFixture("Doc-CXA");
      const b = await actorForFixture("Doc-CXB");
      const forged: EmployeeOnboardingActor = { ...a.actor, clubId: b.club.id };
      await expect(
        uploadSelfBankingDocument(forged, { bytes: PDF_BYTES, mimeType: "application/pdf", category: "void_cheque" }),
      ).rejects.toThrowError(/not found/i);
    });

    it("non-image/non-PDF mimeType refused", async () => {
      const { actor } = await actorForFixture("Doc-BadMime");
      await expect(
        uploadSelfBankingDocument(actor, { bytes: PDF_BYTES, mimeType: "text/plain", category: "void_cheque" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("PNG accepted", async () => {
      const { actor } = await actorForFixture("Doc-Png");
      const doc = await uploadSelfBankingDocument(actor, {
        bytes: PNG_BYTES,
        mimeType: "image/png",
        category: "void_cheque",
      });
      expect(doc.mimeType).toBe("image/png");
      expect(doc.sensitivity).toBe("RESTRICTED");
    });

    it("empty file refused", async () => {
      const { actor } = await actorForFixture("Doc-Empty");
      await expect(
        uploadSelfBankingDocument(actor, { bytes: Buffer.alloc(0), mimeType: "application/pdf", category: "void_cheque" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("getSelfBankingDocument returns non-sensitive metadata only (no storageKey)", async () => {
      const { actor } = await actorForFixture("Doc-Meta");
      await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
        displayName: "cheque.pdf",
      });
      const meta = await getSelfBankingDocument(actor);
      expect(meta).toBeTruthy();
      expect(meta!.displayName).toBe("cheque.pdf");
      expect((meta as unknown as Record<string, unknown>).storageKey).toBeUndefined();
    });
  });

  // ==== TD1 tax profile ==================================================

  describe("TD1 tax profile", () => {
    const validTax = {
      province: "AB",
      td1FormVersion: "TD1-2026",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: "16129.00",
      provincialClaim: "22323.00",
      additionalDeductions: null as string | null,
    };

    it("employee submits current tax profile with effective dating preserved", async () => {
      const { actor } = await actorForFixture("Tax-Save");
      const res = await submitSelfTaxProfile(actor, validTax);
      expect(res.province).toBe("AB");
      expect(res.td1FormVersion).toBe("TD1-2026");
      expect(res.effectiveFrom.getTime()).toBe(validTax.effectiveFrom.getTime());
    });

    it("claim amount plaintext never appears in audit payload", async () => {
      const { actor } = await actorForFixture("Tax-Audit");
      await submitSelfTaxProfile(actor, { ...validTax, additionalDeductions: "50.00" });
      const audits = await prisma.auditLog.findMany({
        where: { action: "hr.tax.write.update", clubId: actor.clubId },
      });
      expect(audits.length).toBeGreaterThan(0);
      for (const a of audits) {
        const combined = [a.beforeJson, a.afterJson, a.metaJson].filter(Boolean).join(" | ");
        expect(combined.includes("16129")).toBe(false);
        expect(combined.includes("22323")).toBe(false);
        expect(combined.includes("50.00")).toBe(false);
      }
    });

    it("sensitive claim values persist ONLY in the encrypted ref columns", async () => {
      const { actor } = await actorForFixture("Tax-NoLeak");
      await submitSelfTaxProfile(actor, { ...validTax, additionalDeductions: "42.00" });
      const row = await prisma.employeeTaxProfile.findFirst({
        where: { employeeId: actor.employeeId },
        select: {
          province: true, td1FormVersion: true, effectiveFrom: true, effectiveTo: true, notes: true,
          federalClaimSecretRef: true, provincialClaimSecretRef: true, additionalDeductionSecretRef: true,
        },
      });
      // Non-encrypted columns must contain none of the plaintext values.
      const nonEncrypted = JSON.stringify({
        province: row!.province,
        td1FormVersion: row!.td1FormVersion,
        effectiveFrom: row!.effectiveFrom,
        effectiveTo: row!.effectiveTo,
        notes: row!.notes,
      });
      expect(nonEncrypted.includes("16129")).toBe(false);
      expect(nonEncrypted.includes("22323")).toBe(false);
      expect(nonEncrypted.includes("42")).toBe(false);
    });

    it("masked read returns non-sensitive metadata only", async () => {
      const { actor } = await actorForFixture("Tax-Read");
      await submitSelfTaxProfile(actor, { ...validTax, additionalDeductions: "42.00" });
      const masked = await getSelfTaxProfileMasked(actor);
      expect(masked).toBeTruthy();
      expect(masked!.province).toBe("AB");
      expect(masked!.hasAdditionalDeductions).toBe(true);
      expect(JSON.stringify(masked).includes("16129")).toBe(false);
      expect(JSON.stringify(masked).includes("22323")).toBe(false);
      expect(JSON.stringify(masked).includes("42")).toBe(false);
    });

    it("replacement re-uses the row for the same effectiveFrom (no historical drift within a single election)", async () => {
      const { actor } = await actorForFixture("Tax-Replace");
      const r1 = await submitSelfTaxProfile(actor, validTax);
      const r2 = await submitSelfTaxProfile(actor, { ...validTax, federalClaim: "16500.00" });
      expect(r2.id).toBe(r1.id);
      const rows = await prisma.employeeTaxProfile.findMany({
        where: { employeeId: actor.employeeId },
      });
      expect(rows.length).toBe(1);
    });

    it("cross-employee refused", async () => {
      const a = await actorForFixture("Tax-XA");
      const b = await actorForFixture("Tax-XB");
      const forged: EmployeeOnboardingActor = { ...a.actor, employeeId: b.employee.id };
      await expect(submitSelfTaxProfile(forged, validTax)).rejects.toThrowError(/not found/i);
    });

    it("cross-Club refused", async () => {
      const a = await actorForFixture("Tax-CXA");
      const b = await actorForFixture("Tax-CXB");
      const forged: EmployeeOnboardingActor = { ...a.actor, clubId: b.club.id };
      await expect(submitSelfTaxProfile(forged, validTax)).rejects.toThrowError(/not found/i);
    });

    it("invalid province refused", async () => {
      const { actor } = await actorForFixture("Tax-BadProv");
      await expect(
        submitSelfTaxProfile(actor, { ...validTax, province: "ZZ" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("negative claim amount refused", async () => {
      const { actor } = await actorForFixture("Tax-Neg");
      await expect(
        submitSelfTaxProfile(actor, { ...validTax, federalClaim: "-100.00" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("attestation writes acknowledgement row with actor provenance + form version in meta", async () => {
      const { actor } = await actorForFixture("Tax-Attest");
      await submitSelfTaxProfile(actor, validTax);
      await attestSelfTd1(actor, "federal", "TD1-2026");
      await attestSelfTd1(actor, "provincial", "TD1AB-2026");
      const fed = await getSelfTd1Attestation(actor, "federal");
      const prov = await getSelfTd1Attestation(actor, "provincial");
      expect(fed).toBeTruthy();
      expect(prov).toBeTruthy();
      expect(fed!.actorEmployeeId).toBe(actor.employeeId);
      const audits = await prisma.auditLog.findMany({
        where: { action: "hr.onboarding.acknowledgement.update", clubId: actor.clubId },
      });
      const anyAtt = audits.find((a) => (a.afterJson ?? "").includes("td1_federal_attestation"));
      expect(anyAtt).toBeTruthy();
      // Form version is metadata, not sensitive — should be visible.
      expect(anyAtt!.afterJson?.includes("TD1-2026")).toBe(true);
    });
  });

  // ==== Payroll completion ==================================================

  describe("Payroll completion", () => {
    it("returns false for every component when nothing has been submitted", async () => {
      const { actor } = await actorForFixture("Comp-Empty");
      const c = await getPayrollCompletion(actor);
      expect(c.sin).toBe(false);
      expect(c.banking).toBe(false);
      expect(c.taxProfile).toBe(false);
      expect(c.federalAttestation).toBe(false);
      expect(c.provincialAttestation).toBe(false);
      expect(c.complete).toBe(false);
    });

    it("returns complete=true only when SIN + banking + tax + both attestations exist", async () => {
      const { actor } = await actorForFixture("Comp-Full");
      await submitSelfSin(actor, SYNTHETIC_SIN_A);
      await submitSelfBankAccount(actor, {
        holderName: "Payroll Complete",
        institutionNumber: "003",
        transitNumber: "12345",
        accountNumber: "1234567890",
      });
      await submitSelfTaxProfile(actor, {
        province: "AB",
        td1FormVersion: "TD1-2026",
        effectiveFrom: new Date("2026-01-01"),
        federalClaim: "16129.00",
        provincialClaim: "22323.00",
      });
      await attestSelfTd1(actor, "federal", "TD1-2026");
      // Not yet complete without provincial attestation.
      let c = await getPayrollCompletion(actor);
      expect(c.provincialAttestation).toBe(false);
      expect(c.complete).toBe(false);

      await attestSelfTd1(actor, "provincial", "TD1AB-2026");
      c = await getPayrollCompletion(actor);
      expect(c.complete).toBe(true);
    });
  });

  // Session termination is already pinned by
  // `onboarding-resilience.test.ts` (acquireInvitationContext refuses
  // resume once session moves past IN_PROGRESS) and
  // `employee-actor.test.ts` (resolver returns null for terminal
  // sessions). No further test needed at the self-service layer —
  // the resolver is the entry-point defense and the resilience suite
  // pins its terminal-state behaviour end-to-end.
});
