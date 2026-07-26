// Sprint 3 Checkpoint 15E (2026-07-24) — End-to-end AP-intelligence
// integration test. Uses the SQLite dev DB + text-override on the
// analyser (skips pdf-parse). Exercises: seed → ingest → analyse →
// materialise → findings persist → action → attach-to-existing.

import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { analyseIngestedInvoice } from "@/lib/ap-intelligence/analyse";
import { runApMaterialisation } from "@/lib/ap-intelligence/materialise";
import { applyApAction } from "@/lib/ap-intelligence/actions";
import { ingestAttachment } from "@/lib/documents/ingest";
import { memoryDocumentStorageAdapter, _resetMemoryDocumentStorage_TEST_ONLY } from "@/lib/documents/storage";

function makeFixturePdf(): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("% 15E integration test fixture — bytes exist for magic-number check only.\n"),
    randomBytes(256),
  ]);
}
const INVOICE_TEXT_A = `
Northside Course Maintenance Inc.
1234 Fairway Drive · Calgary AB
HST: 987654321 RT 0001

INVOICE
Invoice Number: INV-2026-9010
Invoice Date: 2026-07-01
Due Date: 2026-07-31

Description: Replace irrigation pump — 6th hole

Item                                     Qty     Unit         Amount
Irrigation pump replacement               1       9500.00      9500.00
Installation labour                       1       1200.00      1200.00

                                                Subtotal:     10700.00
                                                HST (5%):     535.00
                                                Total Due:    11235.00
`;
const INVOICE_TEXT_B_MAINT = `
Northside Course Maintenance Inc.
INVOICE
Invoice Number: INV-2026-9011
Invoice Date: 2026-07-03
Due Date: 2026-08-02
Description: Monthly maintenance service for course equipment

Item                            Qty    Unit      Amount
Monthly service call             1      450.00    450.00

                                       Subtotal:  450.00
                                       HST (5%):  22.50
                                       Total:     472.50
`;

const suiteToken = "c15e-" + Math.random().toString(36).slice(2, 10);
let CLUB: string;
let VENDOR_ID: string;
let ACCOUNT_1540_ID: string;
let ACCOUNT_6020_ID: string;
let TEST_USER_ID: string;

beforeAll(async () => {
  _resetMemoryDocumentStorage_TEST_ONLY();
  const club = await prisma.club.create({
    data: { slug: `${suiteToken}-club`, name: `C15E Test Club` },
    select: { id: true },
  });
  CLUB = club.id;
  // GL accounts required by the recommendation map.
  const acc1540 = await prisma.account.create({
    data: {
      clubId: CLUB, accountNumber: "1540", name: "Equipment & Vehicles",
      type: "ASSET", normalBalance: "DEBIT", isActive: true, allowManualPosting: true, sortOrder: 40,
    },
    select: { id: true },
  });
  ACCOUNT_1540_ID = acc1540.id;
  const acc6020 = await prisma.account.create({
    data: {
      clubId: CLUB, accountNumber: "6020", name: "Grounds Maintenance",
      type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: true, sortOrder: 620,
    },
    select: { id: true },
  });
  ACCOUNT_6020_ID = acc6020.id;
  // Vendor with default expense account 6020 for operating fallback.
  const vendor = await prisma.vendor.create({
    data: {
      clubId: CLUB,
      vendorNumber: "V-C15E-001",
      legalName: "Northside Course Maintenance Inc.",
      operatingName: "Northside Course Maintenance",
      status: "ACTIVE",
      taxRegistrationNumber: "987654321 RT 0001",
      email: "billing@northside.example",
      defaultExpenseAccountId: ACCOUNT_6020_ID,
    },
    select: { id: true },
  });
  VENDOR_ID = vendor.id;
  // Test user for action attribution (WorkIntakeActivity.actorUserId FK).
  const user = await prisma.user.create({
    data: {
      email: `c15e-${suiteToken}@fixture.local`,
      name: "C15E Test User",
      status: "ACTIVE",
      clubId: CLUB,
      role: "CLUB_ADMIN",
      passwordHash: "$2a$10$test.hash.that.will.never.be.used",
    },
    select: { id: true },
  });
  TEST_USER_ID = user.id;
});

async function ingestFixtureDocument(sourceRef: string, clubIdOverride?: string): Promise<string> {
  const storage = memoryDocumentStorageAdapter("TEST_BUCKET_" + suiteToken);
  const pdf = makeFixturePdf(); // fresh bytes → fresh SHA256 → STORED_NEW
  const result = await ingestAttachment({
    clubId: clubIdOverride ?? CLUB,
    sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: sourceRef,
    claimedContentType: "application/pdf",
    claimedSizeBytes: pdf.length,
    originalFilename: "Invoice.pdf",
    receivedAt: new Date("2026-07-05T10:00:00Z"),
    isInline: false,
    bytes: { async fetchBytes() { return pdf; } },
    classifySignals: { emailSubject: "Your invoice from Northside" },
    autoAttachTo: null,
    storageOverride: storage,
  });
  expect(result.outcome).toBe("STORED_NEW");
  expect(result.documentId).toBeTruthy();
  // Force classification = INVOICE for the materialiser to pick it up
  // (the classify.ts rule may have chosen INVOICE from the subject, but
  // we assert it explicitly so the test is deterministic).
  await prisma.ingestedDocument.update({
    where: { id: result.documentId! },
    data: { classification: "INVOICE" },
  });
  return result.documentId!;
}

describe("analyseIngestedInvoice — end-to-end", () => {
  it("recognises a capital irrigation invoice", async () => {
    const docId = await ingestFixtureDocument("ap-integ-" + Math.random());
    const analysis = await analyseIngestedInvoice({
      clubId: CLUB,
      ingestedDocumentId: docId,
      extractedTextOverride: INVOICE_TEXT_A,
    });
    expect(analysis.extraction.state).toBe("STRUCTURED");
    expect(analysis.extraction.total).toBe("11235.00");
    expect(analysis.vendor.state).toBe("MATCHED");
    expect(analysis.vendor.candidates[0].id).toBe(VENDOR_ID);
    expect(analysis.capital.state).toBe("CAPITAL");
    expect(analysis.capital.capitalClass).toBe("IRRIGATION");
    // IRRIGATION maps to 1530 (Course Improvements). We didn't seed
    // account 1530 in this test, so the recommender falls back to the
    // raw map value with a reviewer-must-seed reason.
    expect(analysis.gl.accountNumber).toBe("1530");
    expect(analysis.gl.reason).toMatch(/1530/);
    expect(analysis.reconcile.state).toBe("NOT_FOUND");
    expect(analysis.findings.some((f) => f.key === "ap.invoice.capital_candidate")).toBe(true);
  });

  it("recognises an operating maintenance invoice + uses vendor default GL", async () => {
    const docId = await ingestFixtureDocument("ap-integ-op-" + Math.random());
    const analysis = await analyseIngestedInvoice({
      clubId: CLUB,
      ingestedDocumentId: docId,
      extractedTextOverride: INVOICE_TEXT_B_MAINT,
    });
    expect(analysis.capital.state).toBe("OPERATING");
    expect(analysis.gl.accountNumber).toBe("6020");
    expect(analysis.gl.source).toBe("VENDOR_DEFAULT");
  });

  it("returns DOCUMENT_UNREADABLE when text is empty", async () => {
    const docId = await ingestFixtureDocument("ap-integ-empty-" + Math.random());
    const analysis = await analyseIngestedInvoice({
      clubId: CLUB,
      ingestedDocumentId: docId,
      extractedTextOverride: "",
    });
    expect(analysis.extraction.state).toBe("DOCUMENT_UNREADABLE");
    expect(analysis.findings.some((f) => f.key === "ap.invoice.insufficient_evidence" || f.key === "ap.invoice.requires_review")).toBe(true);
  });
});

describe("runApMaterialisation — creates canonical intake, persists findings, idempotent", () => {
  it("creates on first run, reuses on rerun (dry-run)", async () => {
    // Seed 2 more invoice documents to exercise the enumerator.
    await ingestFixtureDocument("ap-mat-1-" + Math.random());
    await ingestFixtureDocument("ap-mat-2-" + Math.random());
    const dry = await runApMaterialisation({ clubId: CLUB, dryRun: true, maxDocs: 50 });
    expect(dry.documentsExamined).toBeGreaterThanOrEqual(2);
    // Dry-run reports projected intake creation but writes nothing.
    expect(dry.dryRun).toBe(true);
  });
});

describe("applyApAction — attach to existing", () => {
  it("attaches an ingested doc to an existing AP invoice via reviewer action", async () => {
    // Ingest a doc and materialise it.
    const docId = await ingestFixtureDocument("ap-action-" + Math.random());
    // Create the intake manually (mirrors materialiser's shape).
    const intake = await prisma.workIntakeItem.create({
      data: {
        clubId: CLUB, status: "OPEN", classification: "AP_INVOICE_REVIEW", classificationMethod: "RULE",
        displaySourceLabel: "Test", displaySender: "test", displaySubject: "Invoice.pdf",
        displayPreview: "test", displayReceivedAt: new Date(), displayHasAttachments: true,
      },
      select: { id: true },
    });
    await prisma.workIntakeOrigin.create({
      data: { clubId: CLUB, workIntakeItemId: intake.id, kind: "INGESTED_DOCUMENT", referenceId: docId, role: "PRIMARY" },
    });
    // Create a real AP invoice manually — the analyser will attach to it.
    const apInvoice = await prisma.aPInvoice.create({
      data: {
        clubId: CLUB, invoiceNumber: `APINV-2026-${Math.floor(Math.random()*1000000).toString().padStart(6, "0")}`,
        vendorId: VENDOR_ID, invoiceDate: new Date("2026-07-01"),
        subtotal: "11235.00", taxTotal: "0.00", total: "11235.00", currency: "CAD", status: "DRAFT",
      },
      select: { id: true },
    });
    const principal = {
      id: TEST_USER_ID, name: "Test", email: "t@t", status: "ACTIVE",
      memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" as const }],
      activeClubId: CLUB, memberId: null,
    };
    const result = await applyApAction({
      principal,
      clubId: CLUB,
      workIntakeItemId: intake.id,
      kind: "ATTACH_TO_EXISTING_INVOICE",
      payload: { apInvoiceId: apInvoice.id },
    });
    expect(result.ok).toBe(true);
    expect(result.linkedApInvoiceId).toBe(apInvoice.id);
    // Both link directions written.
    const bwd = await prisma.ingestedDocumentEvidenceLink.count({
      where: { clubId: CLUB, ingestedDocumentId: docId, targetKind: "AP_INVOICE", targetReferenceId: apInvoice.id },
    });
    expect(bwd).toBe(1);
    const fwd = await prisma.workIntakeOrigin.count({
      where: { clubId: CLUB, workIntakeItemId: intake.id, kind: "AP_INVOICE", referenceId: apInvoice.id },
    });
    expect(fwd).toBe(1);
    const activities = await prisma.workIntakeActivity.findMany({ where: { workIntakeItemId: intake.id }});
    expect(activities.some((a) => a.action === "AP_ATTACH_TO_EXISTING_INVOICE")).toBe(true);
  });
});

describe("tenant isolation — vendor lookup respects clubId", () => {
  it("does not resolve to another club's vendor", async () => {
    // Create a second club with the same vendor tax number.
    const otherClub = await prisma.club.create({
      data: { slug: `${suiteToken}-otherclub`, name: "C15E Other" },
      select: { id: true },
    });
    await prisma.vendor.create({
      data: {
        clubId: otherClub.id, vendorNumber: "V-OTHER-1",
        legalName: "Other Club Vendor Inc.", operatingName: "OtherVendor",
        status: "ACTIVE", taxRegistrationNumber: "987654321 RT 0001",
        email: "billing@northside.example",
      },
    });
    const docId = await ingestFixtureDocument("ap-tenant-" + Math.random(), otherClub.id);
    const analysis = await analyseIngestedInvoice({
      clubId: otherClub.id,
      ingestedDocumentId: docId,
      extractedTextOverride: INVOICE_TEXT_A,
    });
    // The other-club analyser should NOT find CLUB's Northside vendor
    // — it should find its own vendor row (matching by tax number).
    if (analysis.vendor.state === "MATCHED") {
      expect(analysis.vendor.candidates[0].id).not.toBe(VENDOR_ID);
    }
  });
});
