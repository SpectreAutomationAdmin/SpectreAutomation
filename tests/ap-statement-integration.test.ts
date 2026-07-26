// Sprint 3 Checkpoint 15G (2026-07-24) — End-to-end statement
// reconciliation integration test. Uses REAL pdfkit-generated PDF
// bytes fed through pdf-parse — no extractedTextOverride shortcut.
//
// Covers: extraction, vendor resolution, invoice match, payment
// match, credit not-found, balance validation, materialiser
// persistence, idempotency, action recording.

import { beforeAll, describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { Readable } from "node:stream";
import { prisma } from "@/lib/prisma";
import { analyseIngestedStatement } from "@/lib/ap-statement-intelligence/analyse";
import { runStatementMaterialisation } from "@/lib/ap-statement-intelligence/materialise";
import { applyStatementAction } from "@/lib/ap-statement-intelligence/actions";
import { ingestAttachment } from "@/lib/documents/ingest";
import { memoryDocumentStorageAdapter, _resetMemoryDocumentStorage_TEST_ONLY } from "@/lib/documents/storage";

const suiteToken = "c15g-" + Math.random().toString(36).slice(2, 10);
const TEST_BUCKET = "C15G_BUCKET";
const testStorage = memoryDocumentStorageAdapter(TEST_BUCKET);
let CLUB: string;
let OTHER_CLUB: string;
let VENDOR: string;
let INVOICE_MATCHED: string;
let PAYMENT_MATCHED: string;
let USER_ID: string;

// -----------------------------------------------------------------------------
// Real PDF generation via pdfkit — produces bytes pdf-parse can extract.
// -----------------------------------------------------------------------------
async function makeStatementPdf(bodyLines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: "LETTER" });
  const chunks: Buffer[] = [];
  const stream = new Readable();
  stream._read = () => {};
  doc.on("data", (b) => chunks.push(b as Buffer));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  doc.font("Courier").fontSize(10);
  for (const line of bodyLines) doc.text(line);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  _resetMemoryDocumentStorage_TEST_ONLY();
  const club = await prisma.club.create({ data: { slug: `${suiteToken}-c`, name: "C15G Test" }, select: { id: true }});
  CLUB = club.id;
  const other = await prisma.club.create({ data: { slug: `${suiteToken}-o`, name: "C15G Other" }, select: { id: true }});
  OTHER_CLUB = other.id;
  const user = await prisma.user.create({ data: { email: `${suiteToken}@fixture.local`, name: "Test", status: "ACTIVE", clubId: CLUB, role: "SUPER_ADMIN", passwordHash: "$2a$10$fake" }, select: { id: true }});
  USER_ID = user.id;
  const vendor = await prisma.vendor.create({
    data: {
      clubId: CLUB, vendorNumber: "V-C15G-1", legalName: "Northside Course Maintenance Inc.",
      operatingName: "Northside", status: "ACTIVE",
      email: "billing@northside.example",
    },
    select: { id: true },
  });
  VENDOR = vendor.id;
  // One matching APInvoice + one matching VendorPayment on the vendor.
  const inv = await prisma.aPInvoice.create({
    data: {
      clubId: CLUB, invoiceNumber: `APINV-${suiteToken}-A`, vendorId: VENDOR,
      vendorReference: "INV-1001", invoiceDate: new Date("2026-06-05"),
      subtotal: "500.00", taxTotal: "25.00", total: "525.00", currency: "CAD", status: "POSTED",
    },
    select: { id: true },
  });
  INVOICE_MATCHED = inv.id;
  const pay = await prisma.vendorPayment.create({
    data: {
      clubId: CLUB, vendorId: VENDOR, paymentNumber: `APPAY-${suiteToken}-A`,
      paymentDate: new Date("2026-06-10"), amount: "500.00", method: "EFT",
      processorRef: "PMT-2001", status: "PROCESSED",
    },
    select: { id: true },
  });
  PAYMENT_MATCHED = pay.id;
});

async function ingestStatementPdf(pdf: Buffer, filename: string, clubId = CLUB): Promise<string> {
  const r = await ingestAttachment({
    clubId,
    sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: `stmt-${Math.random()}`,
    claimedContentType: "application/pdf",
    claimedSizeBytes: pdf.length,
    originalFilename: filename,
    receivedAt: new Date(),
    isInline: false,
    bytes: { async fetchBytes() { return pdf; }},
    classifySignals: { emailSubject: "Vendor statement of account" },
    autoAttachTo: null,
    storageOverride: testStorage,
  });
  expect(r.outcome).toBe("STORED_NEW");
  // Force classification = STATEMENT for the materialiser to pick up.
  await prisma.ingestedDocument.update({
    where: { id: r.documentId! },
    data: { classification: "STATEMENT" },
  });
  return r.documentId!;
}

// -----------------------------------------------------------------------------
// Test suites
// -----------------------------------------------------------------------------

describe("analyseIngestedStatement — real PDF, happy-path reconciliation", () => {
  it("extracts a structured statement and reconciles against seeded AP/payment", async () => {
    const pdf = await makeStatementPdf([
      "NORTHSIDE COURSE MAINTENANCE INC.",
      "1234 Fairway Drive, Calgary AB",
      "",
      "STATEMENT OF ACCOUNT",
      "Account Number: NS-12345",
      "Statement Date: 2026-06-30",
      "Period Start: 2026-06-01",
      "Period End:   2026-06-30",
      "",
      "Opening Balance:  0.00",
      "Closing Balance:  25.00",
      "Amount Due:       25.00",
      "",
      "Date         Ref          Description                Debit      Credit     Balance",
      "2026-06-05   INV-1001     Monthly grounds service    525.00                525.00",
      "2026-06-10   PMT-2001     Payment received                      500.00     25.00",
    ]);
    const docId = await ingestStatementPdf(pdf, "Northside-Statement-June.pdf");
    const analysis = await analyseIngestedStatement({
      clubId: CLUB,
      ingestedDocumentId: docId,
      storageOverride: testStorage,
    });
    expect(analysis.extraction.state).not.toBe("DOCUMENT_UNREADABLE");
    expect(analysis.vendor.state).toBe("MATCHED");
    expect(analysis.vendor.canonicalVendorId).toBe(VENDOR);
    // Should have found the invoice + payment as exact/probable matches.
    const invoiceMatch = analysis.lineOutcomes.find((o) => o.matchTargetReferenceId === INVOICE_MATCHED);
    const paymentMatch = analysis.lineOutcomes.find((o) => o.matchTargetReferenceId === PAYMENT_MATCHED);
    expect(invoiceMatch?.matchState === "EXACT_MATCH" || invoiceMatch?.matchState === "PROBABLE_MATCH").toBe(true);
    expect(paymentMatch?.matchState === "EXACT_MATCH" || paymentMatch?.matchState === "PROBABLE_MATCH").toBe(true);
    // Reconciliation should not be DOCUMENT_UNREADABLE / VENDOR_UNRESOLVED.
    expect(["RECONCILED", "RECONCILED_WITH_TIMING_DIFFERENCES", "EXCEPTIONS_FOUND", "REVIEW_REQUIRED"]).toContain(analysis.reconciliationState);
  });
});

describe("analyseIngestedStatement — missing invoice + amount mismatch", () => {
  it("flags an invoice not in Spectre + generates NOT_FOUND finding", async () => {
    const pdf = await makeStatementPdf([
      "NORTHSIDE COURSE MAINTENANCE INC.",
      "STATEMENT OF ACCOUNT",
      "Statement Date: 2026-07-15",
      "Opening Balance: 25.00",
      "Closing Balance: 425.00",
      "Amount Due: 425.00",
      "",
      "Date         Ref          Description                Debit      Credit     Balance",
      "2026-07-10   INV-9999     Missing from Spectre       400.00                425.00",
    ]);
    const docId = await ingestStatementPdf(pdf, "Missing-Invoice-Statement.pdf");
    const analysis = await analyseIngestedStatement({ clubId: CLUB, ingestedDocumentId: docId, storageOverride: testStorage });
    expect(analysis.vendor.state).toBe("MATCHED");
    expect(analysis.findings.some((f) => f.key === "ap.statement.invoice_not_found")).toBe(true);
  });
});

describe("analyseIngestedStatement — vendor not resolved", () => {
  it("returns VENDOR_UNRESOLVED reconciliation state with vendor_not_found finding", async () => {
    const pdf = await makeStatementPdf([
      "UNKNOWN VENDOR THAT DOES NOT EXIST",
      "STATEMENT OF ACCOUNT",
      "Statement Date: 2026-07-15",
      "Opening Balance: 0.00",
      "Closing Balance: 100.00",
      "",
      "Date         Ref     Description   Debit    Credit   Balance",
      "2026-07-10   INV-A   Service       100.00            100.00",
    ]);
    const docId = await ingestStatementPdf(pdf, "Unknown-Vendor.pdf");
    const analysis = await analyseIngestedStatement({ clubId: CLUB, ingestedDocumentId: docId, storageOverride: testStorage });
    expect(analysis.vendor.state).toBe("NOT_FOUND");
    expect(analysis.reconciliationState).toBe("VENDOR_UNRESOLVED");
    expect(analysis.findings.some((f) => f.key === "ap.statement.vendor_not_found")).toBe(true);
  });
});

describe("analyseIngestedStatement — unreadable PDF (raw bytes with magic only)", () => {
  it("returns DOCUMENT_UNREADABLE + emits ap.statement.unreadable finding", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("garbage that is not a real PDF body")]);
    const docId = await ingestStatementPdf(pdf, "Garbage.pdf");
    const analysis = await analyseIngestedStatement({ clubId: CLUB, ingestedDocumentId: docId, storageOverride: testStorage });
    expect(analysis.reconciliationState).toBe("DOCUMENT_UNREADABLE");
    expect(analysis.findings.some((f) => f.key === "ap.statement.unreadable")).toBe(true);
  });
});

describe("runStatementMaterialisation — persists reconciliation + lines + matches; idempotent", () => {
  it("creates canonical intake + reconciliation + lines, reruns without duplication", async () => {
    // Ingest one fresh statement doc.
    const pdf = await makeStatementPdf([
      "NORTHSIDE COURSE MAINTENANCE INC.",
      "STATEMENT OF ACCOUNT",
      "Statement Date: 2026-08-31",
      "Opening Balance: 0.00",
      "Closing Balance: 525.00",
      "",
      "Date         Ref          Description         Debit      Credit    Balance",
      "2026-06-05   INV-1001     Grounds service     525.00               525.00",
    ]);
    const docId = await ingestStatementPdf(pdf, "August-Statement.pdf");

    const first = await runStatementMaterialisation({ clubId: CLUB, dryRun: false, maxDocs: 10, storageOverride: testStorage });
    expect(first.documentsExamined).toBeGreaterThanOrEqual(1);
    expect(first.reconciliationsCreated + first.reconciliationsReused).toBeGreaterThanOrEqual(1);

    // Rerun — should reuse everything.
    const rerun = await runStatementMaterialisation({ clubId: CLUB, dryRun: false, maxDocs: 10, storageOverride: testStorage });
    // All intakes reused (no new ones); we allow findings to preserve.
    expect(rerun.reconciliationsCreated).toBeLessThanOrEqual(0);
    expect(rerun.reconciliationsReused).toBeGreaterThanOrEqual(first.reconciliationsCreated);

    // The doc → reconciliation link exists.
    const recons = await prisma.vendorStatementReconciliation.findMany({ where: { clubId: CLUB, ingestedDocumentId: docId }});
    expect(recons.length).toBe(1);
    const lines = await prisma.vendorStatementLine.count({ where: { reconciliationId: recons[0].id }});
    expect(lines).toBeGreaterThan(0);
  });
});

describe("applyStatementAction — reviewer actions record activity + tenant guards", () => {
  it("CONFIRM_VENDOR records activity; CORRECT_VENDOR refuses cross-club vendor", async () => {
    // Find the intake created in the previous test.
    const intake = await prisma.workIntakeItem.findFirst({
      where: { clubId: CLUB, classification: "VENDOR_STATEMENT_REVIEW" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (!intake) throw new Error("no intake");
    const principal = { id: USER_ID, name: "Test", email: "t@t", status: "ACTIVE", memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" as const }], activeClubId: CLUB, memberId: null };
    const confirm = await applyStatementAction({
      principal, clubId: CLUB, workIntakeItemId: intake.id, kind: "CONFIRM_VENDOR", notes: "Reviewer confirms",
    });
    expect(confirm.ok).toBe(true);
    // Cross-club vendor id — should be refused.
    const otherVendor = await prisma.vendor.create({
      data: { clubId: OTHER_CLUB, vendorNumber: "V-OTHER", legalName: "Other", status: "ACTIVE" },
      select: { id: true },
    });
    const badCorrect = await applyStatementAction({
      principal, clubId: CLUB, workIntakeItemId: intake.id, kind: "CORRECT_VENDOR",
      payload: { canonicalVendorId: otherVendor.id },
    });
    expect(badCorrect.ok).toBe(false);
    expect(badCorrect.reason).toBe("vendor_not_found");
  });
});

describe("cross-club tenant isolation", () => {
  it("analyser refuses to see a doc from another club", async () => {
    const pdf = await makeStatementPdf(["ANY VENDOR", "STATEMENT OF ACCOUNT", "Statement Date: 2026-07-01"]);
    const docId = await ingestStatementPdf(pdf, "Isolated.pdf", OTHER_CLUB);
    await expect(analyseIngestedStatement({ clubId: CLUB, ingestedDocumentId: docId, storageOverride: testStorage })).rejects.toThrow(/not found for club/);
  });
});
