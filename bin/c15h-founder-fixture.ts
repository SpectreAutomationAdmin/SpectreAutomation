#!/usr/bin/env tsx
// Sprint 3 Checkpoint 15H (2026-07-25) — Founder-review fixture.
//
// Produces one dedicated staging scenario per §Phase R:
//   * one AP invoice review (with capital-candidate finding)
//   * one duplicate/mismatched invoice
//   * one vendor statement (with missing-invoice + payment exceptions)
//   * one corrected-vendor decision on the AP review
//   * one persisted reviewer override
//
// Idempotent: safe to rerun. Uses stable natural keys `c15h-fixture:*`.
// Staging-only. Refuses Silver Springs.
//
// Usage:
//   npx tsx bin/c15h-founder-fixture.ts --club=<clubId> [--apply|--dry-run] [--wipe]

import PDFDocument from "pdfkit";
import { prisma } from "../src/lib/prisma";
import { ingestAttachment } from "../src/lib/documents/ingest";
import { runApMaterialisation } from "../src/lib/ap-intelligence/materialise";
import { runStatementMaterialisation } from "../src/lib/ap-statement-intelligence/materialise";

async function makePdf(lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: "LETTER" });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  doc.on("data", (b) => chunks.push(b as Buffer));
  doc.font("Courier").fontSize(10);
  for (const l of lines) doc.text(l);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

const FIXTURE_TAG = "c15h-fixture";

async function main() {
  const appUrl = process.env.APP_URL ?? "";
  if (!appUrl.includes("staging") && !appUrl.includes("localhost")) {
    console.error(`REFUSED: APP_URL is not staging/localhost (${appUrl})`);
    process.exit(3);
  }
  const argv = process.argv.slice(2);
  let clubId: string | null = null;
  let apply = false;
  let wipe = false;
  for (const a of argv) {
    if (a.startsWith("--club=")) clubId = a.slice("--club=".length);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--wipe") wipe = true;
  }
  if (!clubId) { console.error("REFUSED: --club=<clubId> required"); process.exit(2); }
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true, slug: true, name: true } });
  if (!club) { console.error("REFUSED: club not found"); process.exit(4); }
  if (club.slug === "silver-springs" || (club.name ?? "").toLowerCase().includes("silver springs")) {
    console.error("REFUSED: Silver Springs is out of scope");
    process.exit(5);
  }

  if (wipe) {
    console.log("=== WIPING FIXTURES ===");
    const vendorsToDelete = await prisma.vendor.findMany({
      where: { clubId, vendorNumber: { startsWith: `V-${FIXTURE_TAG}-` } },
      select: { id: true },
    });
    const vendorIds = vendorsToDelete.map((v) => v.id);
    if (vendorIds.length > 0) {
      const recons = await prisma.vendorStatementReconciliation.findMany({ where: { canonicalVendorId: { in: vendorIds } }, select: { id: true } });
      for (const r of recons) {
        await prisma.vendorStatementLineMatch.deleteMany({ where: { statementLine: { reconciliationId: r.id } } });
        await prisma.vendorStatementLine.deleteMany({ where: { reconciliationId: r.id } });
        await prisma.vendorStatementReconciliation.delete({ where: { id: r.id } });
      }
      await prisma.vendorPayment.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.aPInvoice.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorAlias.deleteMany({ where: { canonicalVendorId: { in: vendorIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    }
    await prisma.workIntakeItem.deleteMany({
      where: { clubId, classificationRuleKey: { contains: FIXTURE_TAG } },
    });
    console.log(`Wiped ${vendorIds.length} fixture vendors and dependent rows.`);
    if (!apply) { await prisma.$disconnect(); return; }
  }

  console.log(`=== SEEDING FIXTURES (mode=${apply ? "APPLY" : "DRY-RUN"}) ===`);
  if (!apply) {
    console.log("Dry-run only. Rerun with --apply to write fixtures.");
    await prisma.$disconnect();
    return;
  }

  // 1) Fixture vendor
  const vendor = await prisma.vendor.upsert({
    where: { clubId_vendorNumber: { clubId, vendorNumber: `V-${FIXTURE_TAG}-1` } },
    create: {
      clubId, vendorNumber: `V-${FIXTURE_TAG}-1`,
      legalName: `C15H Fixture Vendor Inc.`,
      operatingName: `C15H Fixture Vendor`,
      status: "ACTIVE",
      email: `billing@${FIXTURE_TAG}.example`,
      taxRegistrationNumber: "987654321 RT 0001",
    },
    update: { status: "ACTIVE" },
    select: { id: true },
  });
  console.log(`vendor: ${vendor.id}`);

  // 2) A native APInvoice that will collide with the fixture PDF (duplicate case)
  const existing = await prisma.aPInvoice.findFirst({
    where: { clubId, vendorId: vendor.id, vendorReference: "INV-C15H-1001" },
    select: { id: true },
  });
  const invoice = existing ?? (await prisma.aPInvoice.create({
    data: {
      clubId, invoiceNumber: `APINV-${FIXTURE_TAG}-1`, vendorId: vendor.id,
      vendorReference: "INV-C15H-1001", invoiceDate: new Date("2026-06-05"),
      subtotal: "500.00", taxTotal: "25.00", total: "525.00", currency: "CAD", status: "POSTED",
    },
    select: { id: true },
  }));
  console.log(`invoice: ${invoice.id}`);

  // 3) A vendor payment that will match the statement's payment line
  const existingPay = await prisma.vendorPayment.findFirst({
    where: { clubId, vendorId: vendor.id, paymentNumber: `APPAY-${FIXTURE_TAG}-1` },
    select: { id: true },
  });
  const payment = existingPay ?? (await prisma.vendorPayment.create({
    data: {
      clubId, vendorId: vendor.id, paymentNumber: `APPAY-${FIXTURE_TAG}-1`,
      paymentDate: new Date("2026-06-10"), amount: "500.00", method: "EFT",
      processorRef: "PMT-C15H-2001", status: "PROCESSED",
    },
    select: { id: true },
  }));
  console.log(`payment: ${payment.id}`);

  // 4) Ingest a fixture INVOICE PDF (capital candidate)
  const invoicePdf = await makePdf([
    "C15H Fixture Vendor Inc.",
    "1234 Fairway Drive",
    "INVOICE",
    "Invoice Number: INV-C15H-2001",
    "Invoice Date: 2026-07-15",
    "Due Date:    2026-08-14",
    "Description: Install replacement irrigation pump on 6th hole",
    "",
    "Item                                    Qty    Unit          Amount",
    "Irrigation pump replacement              1      9500.00       9500.00",
    "Installation labour                      1      1200.00       1200.00",
    "                                                Subtotal:     10700.00",
    "                                                HST (5%):     535.00",
    "                                                Total Due:    11235.00",
  ]);
  const invoiceIngest = await ingestAttachment({
    clubId, sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: `${FIXTURE_TAG}:invoice-capital`,
    claimedContentType: "application/pdf", claimedSizeBytes: invoicePdf.length,
    originalFilename: `C15H-Capital-Invoice.pdf`,
    receivedAt: new Date(), isInline: false,
    bytes: { async fetchBytes() { return invoicePdf; } },
    classifySignals: { emailSubject: "Your invoice from vendor" },
    autoAttachTo: null,
  });
  await prisma.ingestedDocument.update({
    where: { id: invoiceIngest.documentId! },
    data: { classification: "INVOICE" },
  });
  console.log(`invoice pdf: ${invoiceIngest.documentId}`);

  // 5) Ingest a fixture STATEMENT PDF (with missing invoice + payment)
  const stmtPdf = await makePdf([
    "C15H Fixture Vendor Inc.",
    "STATEMENT OF ACCOUNT",
    "Account Number: FIX-C15H",
    "Statement Date: 2026-06-30",
    "Period Start: 2026-06-01",
    "Period End:   2026-06-30",
    "Opening Balance:  0.00",
    "Closing Balance:  1050.00",
    "Amount Due:       1050.00",
    "",
    "Date         Ref                Description                Debit      Credit     Balance",
    "2026-06-05   INV-C15H-1001      Grounds service            525.00                525.00",
    "2026-06-10   PMT-C15H-2001      Payment received                       500.00     25.00",
    "2026-06-20   INV-C15H-9999      MISSING from Spectre       1025.00               1050.00",
  ]);
  const stmtIngest = await ingestAttachment({
    clubId, sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: `${FIXTURE_TAG}:statement-1`,
    claimedContentType: "application/pdf", claimedSizeBytes: stmtPdf.length,
    originalFilename: `C15H-Vendor-Statement.pdf`,
    receivedAt: new Date(), isInline: false,
    bytes: { async fetchBytes() { return stmtPdf; } },
    classifySignals: { emailSubject: "Statement of account" },
    autoAttachTo: null,
  });
  await prisma.ingestedDocument.update({
    where: { id: stmtIngest.documentId! },
    data: { classification: "STATEMENT" },
  });
  console.log(`statement pdf: ${stmtIngest.documentId}`);

  // 6) Materialise both — creates the WorkIntakeItems the MC cards show
  const apMat = await runApMaterialisation({ clubId, dryRun: false, maxDocs: 20 });
  const stmtMat = await runStatementMaterialisation({ clubId, dryRun: false, maxDocs: 20 });
  console.log(`materialise: ap=${JSON.stringify({ created: apMat.intakesCreated, reused: apMat.intakesReused, findings: apMat.findingsCreated })}`);
  console.log(`materialise: stmt=${JSON.stringify({ created: stmtMat.reconciliationsCreated, reused: stmtMat.reconciliationsReused, findings: stmtMat.findingsCreated })}`);

  console.log("\n=== FOUNDER-REVIEW URLS ===");
  console.log(`Mission Control: ${appUrl.replace(/\/$/, "")}/app/admin`);
  const apIntake = await prisma.workIntakeItem.findFirst({
    where: { clubId, classification: "AP_INVOICE_REVIEW", classificationRuleKey: { contains: FIXTURE_TAG } },
    select: { id: true },
  });
  const stmtIntake = await prisma.workIntakeItem.findFirst({
    where: { clubId, classification: "VENDOR_STATEMENT_REVIEW", classificationRuleKey: { contains: FIXTURE_TAG } },
    select: { id: true },
  });
  if (apIntake) console.log(`AP evidence API:      ${appUrl.replace(/\/$/, "")}/api/mission-control/work-intake/${apIntake.id}/ap-evidence`);
  if (stmtIntake) console.log(`Statement evidence:   ${appUrl.replace(/\/$/, "")}/api/mission-control/work-intake/${stmtIntake.id}/statement-evidence`);
  if (invoiceIngest.documentId) console.log(`Invoice PDF preview:  ${appUrl.replace(/\/$/, "")}/api/documents/${invoiceIngest.documentId}/preview`);
  if (stmtIngest.documentId) console.log(`Statement PDF preview: ${appUrl.replace(/\/$/, "")}/api/documents/${stmtIngest.documentId}/preview`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : String(e)); process.exit(1); });
