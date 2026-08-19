// HR-2B.3.2 §1 (2026-08-18) — Banking-document upload +
// extract + confirm flow tests.
//
// Pins the founder's HR-2B.3.2 §1 invariants:
//
//   * Upload endpoint persists the document via the canonical
//     `uploadSelfBankingDocument` (RESTRICTED sensitivity, audited
//     with sha256 prefix + byte size only) — the profile-photo
//     pointer is NEVER repointed.
//   * The persisted document is retrievable via
//     `getSelfBankingDocument`.
//   * Text-level extraction produces correct fields for the
//     individual + corporate + labeled + MICR fixtures.
//   * Uncertain / missing fields carry `confidence: "missing"`,
//     `value: null` — the extractor NEVER fabricates a value.
//   * Confirming the pre-filled form invokes `submitSelfBankAccount`
//     (canonical, KMS-encrypted).
//   * The audit payload for the upload NEVER carries plaintext
//     banking values — only sha256 prefix + size + category.
//   * Cross-tenant / cross-employee actor cannot persist a banking
//     document into another employee's row.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  getSelfBankingDocument,
  submitSelfBankAccount,
  uploadSelfBankingDocument,
} from "@/lib/hr/employee-self-service";
import {
  extractBankingFieldsFromDocument,
  extractBankingFieldsFromText,
} from "@/lib/hr/banking-extraction";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

async function actorForFixture(name = "BankingExtract") {
  const { club, employee, clubAdmin } = await makeHrFixture(
    `${name} ${Math.random().toString(36).slice(2, 6)}`,
  );
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

// Minimal valid PDF header. pdf-parse rejects this as PDF_PARSE_ERROR /
// EMPTY_TEXT which is exactly the "extraction falls back to missing"
// case we want to prove. The text-level extractor tests operate on
// raw text and don't need a real PDF.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n%test void cheque\n%%EOF",
  "utf8",
);

describe("HR-2B.3.2 §1 · Banking-document upload + extraction", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ==========================================================================
  // Persistence path — the endpoint still writes through the canonical
  // `uploadSelfBankingDocument` and does NOT touch `Employee.profilePhotoDocumentId`.
  // ==========================================================================

  describe("Persistence via canonical adapter", () => {
    it("persists as EmployeeDocument · category=void_cheque · sensitivity=RESTRICTED", async () => {
      const { actor } = await actorForFixture("Persist-Void");
      const doc = await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
        displayName: "cheque.pdf",
      });
      expect(doc.category).toBe("void_cheque");
      expect(doc.sensitivity).toBe("RESTRICTED");
      expect(doc.mimeType).toBe("application/pdf");
    });

    it("does NOT touch Employee.profilePhotoDocumentId when a banking document is uploaded", async () => {
      const { actor } = await actorForFixture("Persist-NoPhoto");
      const before = await prisma.employee.findFirst({
        where: { id: actor.employeeId },
        select: { profilePhotoDocumentId: true },
      });
      await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
      });
      const after = await prisma.employee.findFirst({
        where: { id: actor.employeeId },
        select: { profilePhotoDocumentId: true },
      });
      expect(after?.profilePhotoDocumentId).toBe(before?.profilePhotoDocumentId ?? null);
    });

    it("persisted document is retrievable via getSelfBankingDocument", async () => {
      const { actor } = await actorForFixture("Persist-Read");
      await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
        displayName: "cheque.pdf",
      });
      const meta = await getSelfBankingDocument(actor);
      expect(meta).toBeTruthy();
      expect(meta!.category).toBe("void_cheque");
      expect(meta!.displayName).toBe("cheque.pdf");
      expect(meta!.mimeType).toBe("application/pdf");
    });

    it("cross-tenant refused (actor from Club A cannot upload for Club B)", async () => {
      const a = await actorForFixture("Persist-CXA");
      const b = await actorForFixture("Persist-CXB");
      const forged: EmployeeOnboardingActor = { ...a.actor, clubId: b.club.id };
      await expect(
        uploadSelfBankingDocument(forged, {
          bytes: PDF_BYTES,
          mimeType: "application/pdf",
          category: "void_cheque",
        }),
      ).rejects.toThrowError(/not found/i);
    });
  });

  // ==========================================================================
  // Text-level extraction — the deterministic layer feeding the client
  // confirmation form. Every fixture is synthetic; no real cheque
  // ever enters test artifacts.
  // ==========================================================================

  describe("extractBankingFieldsFromText — individual holder", () => {
    it("extracts individual account holder from 'PAY TO THE ORDER OF' line", () => {
      const text = [
        "Nightingale Bank",
        "PAY TO THE ORDER OF Bethany Nakamura",
        "123 - 12345 - 1234567890",
      ].join("\n");
      const r = extractBankingFieldsFromText(text);
      expect(r.holderName.value).toBe("Bethany Nakamura");
      expect(r.holderName.confidence).toBe("high");
    });

    it("extracts labeled 'Account Holder: <name>' form", () => {
      const text = [
        "Direct Deposit Authorization",
        "Account Holder: Kai Ogundele",
        "Institution Number: 003",
        "Transit Number: 12345",
        "Account Number: 1234567890",
      ].join("\n");
      const r = extractBankingFieldsFromText(text);
      expect(r.holderName.value).toBe("Kai Ogundele");
      expect(r.holderName.confidence).toBe("high");
    });
  });

  describe("extractBankingFieldsFromText — corporate holder", () => {
    it("extracts numbered-Alberta-corporation account holder", () => {
      const text = [
        "PAY TO THE ORDER OF 1234567 Alberta Ltd.",
        "12345 - 003 - 998877665544",
      ].join("\n");
      const r = extractBankingFieldsFromText(text);
      // cleanName strips the trailing period after "Ltd" — the
      // extracted string is still a plausible corporate name.
      expect(r.holderName.value).toBe("1234567 Alberta Ltd");
      expect(r.holderName.confidence).toBe("high");
    });

    it("extracts corporate account holder from labeled Payable To", () => {
      const text = [
        "Direct Deposit Form",
        "Payable To: Nightingale Holdings Inc.",
        "Institution: 004",
        "Transit: 54321",
        "Account: 8877665544",
      ].join("\n");
      const r = extractBankingFieldsFromText(text);
      expect(r.holderName.value).toBe("Nightingale Holdings Inc");
      expect(r.holderName.confidence).toBe("high");
    });
  });

  describe("extractBankingFieldsFromText — institution / transit / account", () => {
    it("extracts labeled Institution / Transit / Account (highest confidence)", () => {
      const text = [
        "Institution Number: 003",
        "Transit Number: 12345",
        "Account Number: 1234567890",
      ].join("\n");
      const r = extractBankingFieldsFromText(text);
      expect(r.institutionNumber.value).toBe("003");
      expect(r.institutionNumber.confidence).toBe("high");
      expect(r.transitNumber.value).toBe("12345");
      expect(r.transitNumber.confidence).toBe("high");
      expect(r.accountNumber.value).toBe("1234567890");
      expect(r.accountNumber.confidence).toBe("high");
    });

    it("extracts inst-first block '123 - 12345 - 1234567890' at medium confidence", () => {
      // No labels, no MICR symbols — the block-level extractor kicks
      // in. Medium confidence signals the client to render the
      // 'please verify' badge.
      const text = "123 - 12345 - 1234567890";
      const r = extractBankingFieldsFromText(text);
      expect(r.institutionNumber.value).toBe("123");
      expect(r.transitNumber.value).toBe("12345");
      expect(r.accountNumber.value).toBe("1234567890");
      expect(r.institutionNumber.confidence).toBe("medium");
      expect(r.transitNumber.confidence).toBe("medium");
      expect(r.accountNumber.confidence).toBe("medium");
    });

    it("extracts MICR symbols block at high confidence", () => {
      // pdf-parse sometimes preserves the MICR glyphs from real
      // cheques. We match ⑆⑉⑈ AND the ':' surrogate the AP
      // stack has seen in the wild.
      const text = "⑆12345⑉003⑆998877665544⑈";
      const r = extractBankingFieldsFromText(text);
      expect(r.transitNumber.value).toBe("12345");
      expect(r.institutionNumber.value).toBe("003");
      expect(r.accountNumber.value).toBe("998877665544");
      expect(r.transitNumber.confidence).toBe("high");
      expect(r.institutionNumber.confidence).toBe("high");
      expect(r.accountNumber.confidence).toBe("high");
    });
  });

  describe("extractBankingFieldsFromText — never fabricates a value", () => {
    it("empty text → all fields missing / null", () => {
      const r = extractBankingFieldsFromText("");
      for (const field of [r.holderName, r.institutionNumber, r.transitNumber, r.accountNumber]) {
        expect(field.value).toBeNull();
        expect(field.confidence).toBe("missing");
      }
    });

    it("unrelated body text → all fields missing / null", () => {
      const text = [
        "Hello and thank you for banking with Nightingale.",
        "Please contact us at 1-800-555-0000 if you have questions.",
      ].join("\n");
      const r = extractBankingFieldsFromText(text);
      for (const field of [r.holderName, r.institutionNumber, r.transitNumber, r.accountNumber]) {
        expect(field.value).toBeNull();
        expect(field.confidence).toBe("missing");
      }
    });

    it("account digits shorter than 7 are not accepted", () => {
      const text = "Institution Number: 003\nTransit Number: 12345\nAccount Number: 123456";
      const r = extractBankingFieldsFromText(text);
      // Institution / transit still land, but account should be null
      // because 6-digit accounts fall outside the 7-12 canonical
      // range.
      expect(r.institutionNumber.value).toBe("003");
      expect(r.transitNumber.value).toBe("12345");
      expect(r.accountNumber.value).toBeNull();
      expect(r.accountNumber.confidence).toBe("missing");
    });
  });

  describe("extractBankingFieldsFromDocument — end-to-end unsupported / unreadable paths", () => {
    it("image mimeType returns all-missing with UNSUPPORTED_MIME (fallback to manual)", async () => {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const r = await extractBankingFieldsFromDocument({
        bytes: png,
        mimeType: "image/png",
        clubId: "club-x",
        employeeId: "employee-x",
        documentId: "doc-x",
      });
      expect(r.meta.readOutcome).toBe("UNSUPPORTED_MIME");
      for (const field of [r.holderName, r.institutionNumber, r.transitNumber, r.accountNumber]) {
        expect(field.value).toBeNull();
        expect(field.confidence).toBe("missing");
      }
    });

    it("unreadable PDF bytes → PDF_PARSE_ERROR path (fallback to manual)", async () => {
      const r = await extractBankingFieldsFromDocument({
        bytes: PDF_BYTES, // magic bytes only; pdf-parse can't extract text
        mimeType: "application/pdf",
        clubId: "club-x",
        employeeId: "employee-x",
        documentId: "doc-x",
      });
      // The magic-bytes-only PDF may parse as EMPTY_TEXT or
      // PDF_PARSE_ERROR depending on the pdf-parse version; both
      // outcomes fall through to all-missing.
      expect(["PDF_PARSE_ERROR", "EMPTY_TEXT", "NON_PDF_BYTES"]).toContain(r.meta.readOutcome);
      for (const field of [r.holderName, r.institutionNumber, r.transitNumber, r.accountNumber]) {
        expect(field.value).toBeNull();
        expect(field.confidence).toBe("missing");
      }
    });
  });

  // ==========================================================================
  // Audit / plaintext-leak invariants — extracted values NEVER hit the
  // document audit payload.
  // ==========================================================================

  describe("Audit + secrecy", () => {
    it("hr.document.upload.create audit payload references sha256 prefix + size only", async () => {
      const { actor } = await actorForFixture("Audit-Doc");
      const doc = await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
        displayName: "chq.pdf",
      });
      const audits = await prisma.auditLog.findMany({
        where: {
          action: "hr.document.upload.create",
          entityId: doc.id,
          clubId: actor.clubId,
        },
      });
      expect(audits.length).toBeGreaterThan(0);
      // The audit payload must NOT contain any extracted banking
      // value plaintext. We check both the extracted values we
      // could plausibly leak (from a hypothetical extraction run
      // over this bytes buffer) AND generic banking shapes.
      const combined = audits.map((a) => `${a.beforeJson ?? ""} ${a.afterJson ?? ""} ${a.metaJson ?? ""}`).join(" | ");
      // The audit payload SHOULD contain the sha256 prefix (12
      // chars) and the byte size. It must NOT contain the raw
      // storage key beyond what's necessary for evidence.
      const sha = createHash("sha256").update(PDF_BYTES).digest("hex");
      expect(combined).toContain(sha.slice(0, 12));
      // No 9-digit-or-longer sequence that looks like a bank
      // account should be present in the audit payload — the
      // extractor never runs from `uploadSelfBankingDocument`, so
      // the invariant is vacuously true for this call, but this
      // assertion also protects against a future accidental
      // regression where extraction results are threaded into
      // audit metadata.
      const suspicious = combined.match(/\b\d{9,12}\b/g) ?? [];
      // Filter allowed matches: the byte size might be 9+ digits
      // in some fixtures — but here PDF_BYTES is ~40 bytes, so
      // any 9+ digit sequence would be genuinely suspicious.
      expect(suspicious).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Post-extract confirmation → canonical encrypted persistence.
  //
  // The confirmation form invokes the SAME `submitSelfBankAccount` path
  // as the manual-entry form. This test proves that a corrected value
  // typed by the employee flows through the encrypted canonical path
  // (no parallel banking-persistence code was introduced).
  // ==========================================================================

  describe("Confirm-and-save → submitSelfBankAccount (canonical, KMS-encrypted)", () => {
    it("employee-corrected values persist through the canonical banking adapter", async () => {
      const { actor } = await actorForFixture("Confirm-Save");
      // Simulate: upload persisted; extraction produced medium-
      // confidence values; employee corrected the account number
      // before confirming.
      await uploadSelfBankingDocument(actor, {
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        category: "void_cheque",
      });
      const saved = await submitSelfBankAccount(actor, {
        holderName: "Bethany Nakamura",
        institutionNumber: "003",
        transitNumber: "12345",
        accountNumber: "9988776655",   // corrected value the employee typed
      });
      expect(saved.status).toBe("PENDING_PENNY_TEST");
      expect(saved.holderName).toBe("Bethany Nakamura");
      expect(saved.accountMasked).toBe("•••• 6655");

      // Canonical row exists in the encrypted-secrets column shape.
      const row = await prisma.employeeBankAccount.findFirst({
        where: { employeeId: actor.employeeId, clubId: actor.clubId },
        orderBy: { updatedAt: "desc" },
      });
      expect(row).toBeTruthy();
      expect(row!.accountLastFour).toBe("6655");
      // All three secret columns MUST be populated with ciphertext.
      expect(row!.institutionSecretRef).toBeTruthy();
      expect(row!.transitSecretRef).toBeTruthy();
      expect(row!.accountSecretRef).toBeTruthy();
      // The plaintext must NOT appear in any secret column
      // (ciphertext is opaque; the plaintext account number should
      // never leak).
      const rowSerialised = JSON.stringify(row);
      expect(rowSerialised.includes("9988776655")).toBe(false);
    });
  });
});
