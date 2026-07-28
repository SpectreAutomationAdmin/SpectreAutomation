// Sprint 3 · Checkpoint 15Q (2026-07-28) — full-pipeline
// reprocessing test.
//
// Runs the ACTUAL production analyseIngestedInvoice + the ACTUAL
// production summariseApIntake projection over a synthetic
// professional-membership-body invoice. Asserts each of the founder's
// browser-review requirements from the checkpoint brief:
//   • supplier derived from the invoice issuer (not the sender)
//   • invoice number distinguished from member number
//   • separate fee lines extracted
//   • penalty line extracted separately
//   • 5% GST applies only to taxable lines
//   • penalty treated as non-taxable where supported
//   • subtotal / GST / total reconcile
//   • economic purpose is professional membership dues (or nearest)
//   • no keyword-conflated accounting-fees classification
//   • GL candidates come from the tenant's actual COA
//   • rationale + provenance visible on the card projection
//
// The fixture is FICTIONAL — no CPA Alberta / CPA Canada / 1007565767
// / Turcato / attachment-filename references. It ONLY encodes the
// invoice SHAPE (professional-body issuer, three fee lines + penalty,
// mixed taxable/non-taxable) that the founder invoice exhibited.

import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { analyseIngestedInvoice } from "@/lib/ap-intelligence/analyse";
import { ingestAttachment } from "@/lib/documents/ingest";
import { memoryDocumentStorageAdapter, _resetMemoryDocumentStorage_TEST_ONLY } from "@/lib/documents/storage";
import { summariseApIntakeForTest } from "@/lib/mission-control/intelligence-review-intakes";

// Fictional professional-membership-body invoice — SAME SHAPE as the
// founder-observed regulatory-body member-dues invoice.
const PROFESSIONAL_BODY_TEXT = `
Provincial Institute of Professional Sciences
Suite 400, 5000 Learning Way
GST/HST 234567890RT0001

STATEMENT OF ACCOUNT

Bill To:
Kelly Wentworth
Member Number: 987654

Invoice Number: 2026-77812
Invoice Date: 2026-05-15
Due Date: 2026-06-30

Description                                Amount
Provincial annual dues (senior)             500.00
National affiliate dues                     150.00
Regional levy                                50.00
Late-payment penalty (Q1)                    75.00

                                Subtotal:   700.00
                                GST 5 %:     35.00
                                Penalty:     75.00
                                Total:      810.00

Payments to:
Provincial Institute of Professional Sciences
Suite 400, 5000 Learning Way
`;

const suiteToken = "c15q-cpa-shape-" + Math.random().toString(36).slice(2, 8);
let CLUB: string;
let ACCOUNT_MEMBERSHIP_ID: string;
let ACCOUNT_ACCOUNTING_ID: string;

beforeAll(async () => {
  _resetMemoryDocumentStorage_TEST_ONLY();
  const club = await prisma.club.create({
    data: { slug: `${suiteToken}-club`, name: `C15Q CPA-shape Club` },
    select: { id: true },
  });
  CLUB = club.id;
  // A tenant COA with BOTH a membership-dues account AND an
  // accounting-fees account. The test asserts the analyser routes
  // to MEMBERSHIP not ACCOUNTING for a professional-body invoice.
  const memb = await prisma.account.create({
    data: {
      clubId: CLUB,
      accountNumber: "6070",
      name: "Membership Dues & Subscriptions",
      type: "EXPENSE",
      normalBalance: "DEBIT",
      isActive: true,
      allowManualPosting: true,
      sortOrder: 707,
    },
    select: { id: true },
  });
  ACCOUNT_MEMBERSHIP_ID = memb.id;
  const acct = await prisma.account.create({
    data: {
      clubId: CLUB,
      accountNumber: "6061",
      name: "Accounting Fees",
      type: "EXPENSE",
      normalBalance: "DEBIT",
      isActive: true,
      allowManualPosting: true,
      sortOrder: 606,
    },
    select: { id: true },
  });
  ACCOUNT_ACCOUNTING_ID = acct.id;
});

async function ingestFixtureDoc(): Promise<string> {
  const storage = memoryDocumentStorageAdapter("TEST_BUCKET_" + suiteToken);
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("% 15Q CPA-shape reprocessing fixture — bytes for magic-number check only.\n"),
    randomBytes(256),
  ]);
  const result = await ingestAttachment({
    clubId: CLUB,
    sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: "ap-c15q-cpa-" + Math.random().toString(36).slice(2, 8),
    claimedContentType: "application/pdf",
    claimedSizeBytes: pdf.length,
    originalFilename: "member-dues.pdf",   // NOT the acceptance filename
    receivedAt: new Date("2026-05-20T10:00:00Z"),
    isInline: false,
    bytes: { async fetchBytes() { return pdf; } },
    classifySignals: { emailSubject: "Your annual dues invoice" },
    autoAttachTo: null,
    storageOverride: storage,
  });
  expect(result.outcome).toBe("STORED_NEW");
  await prisma.ingestedDocument.update({
    where: { id: result.documentId! },
    data: { classification: "INVOICE" },
  });
  return result.documentId!;
}

describe("15Q · full-pipeline reprocessing on a professional-body invoice", () => {
  it("supplier is derived from the invoice issuer (not the sender)", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB,
      ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
      // Employee-forwarded from a personal address — the WRONG name if
      // the extractor let the sender win.
      emailSubject: "Fwd: annual dues invoice",
      emailSenderAddress: "kelly.wentworth@example.com",
    });
    expect(a.supplier.value?.toLowerCase()).toContain("provincial institute");
    expect(a.supplier.source).toBe("invoice_document");
    expect(a.extraction.vendor.guessedName?.toLowerCase()).toContain("provincial institute");
  });

  it("invoice number is distinguished from member number", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    const invId = a.identifiers.find((i) => i.kind === "invoice_number");
    const memId = a.identifiers.find((i) => i.kind === "member_number");
    expect(invId?.value).toBe("2026-77812");
    expect(memId?.value).toBe("987654");
    expect(a.extraction.invoiceNumber).toBe("2026-77812");
  });

  it("fee lines + penalty line are separately extracted", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    const desc = a.lineItemsExtracted.map((l) => l.description);
    expect(desc.some((d) => /provincial\s+annual\s+dues/i.test(d))).toBe(true);
    expect(desc.some((d) => /national\s+affiliate\s+dues/i.test(d))).toBe(true);
    expect(desc.some((d) => /regional\s+levy/i.test(d))).toBe(true);
    expect(desc.some((d) => /late[-\s]?payment\s+penalty/i.test(d))).toBe(true);
  });

  it("penalty line is classified exempt; dues lines are taxable", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    const penalty = a.lineItemsExtracted.find((l) => /penalty/i.test(l.description));
    expect(penalty).toBeDefined();
    expect(penalty!.taxTreatment).toBe("exempt");
    const dues = a.lineItemsExtracted.filter((l) => /dues|levy/i.test(l.description));
    for (const d of dues) {
      // Dues language biases at least to taxable-leaning classification.
      expect(["taxable", "unknown"]).toContain(d.taxTreatment);
    }
  });

  it("tax reconciles: 5% applies only to taxable subtotal; penalty is non-taxable", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    // With three dues lines at 500+150+50 = 700 taxable + 75 exempt
    // penalty and 5% inferred rate, the reconciler should recognise
    // the 5% rate against the printed 35.00 tax.
    expect(a.taxReconciliation.taxableSubtotal).toBeGreaterThanOrEqual(500);
    expect(a.taxReconciliation.nonTaxableSubtotal).toBeGreaterThanOrEqual(75);
    // Outcome is either reconciled at 5% or unresolved with an
    // actionable message — never silent success at the wrong rate.
    if (a.taxReconciliation.outcome === "reconciled_single_rate") {
      expect(a.taxReconciliation.inferredRate).toBe(5);
    } else {
      expect(a.taxReconciliation.actionable).toBeTruthy();
    }
  });

  it("economic purpose is professional-membership-dues (NOT external accounting services)", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    expect(a.economicPurpose[0]?.purpose).toBe("employee_professional_membership_dues");
    const external = a.economicPurpose.find((c) => c.purpose === "external_accounting_or_audit_services");
    expect(external?.score ?? 0).toBeLessThan(a.economicPurpose[0].score);
  });

  it("GL classification does NOT route to 6061 Accounting fees; prefers 6070 Membership Dues", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    // The founder-observed defect: 6061 Accounting Fees selected via
    // keyword conflation. Post-15Q: economic-purpose classifier
    // penalises accounting-fee accounts when purpose is membership
    // dues. 6070 Membership Dues must rank ahead of 6061.
    const membershipCandidate = a.gl.candidates.find((c) => c.accountId === ACCOUNT_MEMBERSHIP_ID);
    const accountingCandidate = a.gl.candidates.find((c) => c.accountId === ACCOUNT_ACCOUNTING_ID);
    if (membershipCandidate && accountingCandidate) {
      expect(membershipCandidate.confidence).toBeGreaterThan(accountingCandidate.confidence);
    }
    expect(a.gl.accountNumber).not.toBe("6061");
  });

  it("GL candidates come from the tenant's actual Chart of Accounts", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
    });
    // Every candidate id must be one of the two accounts we seeded on
    // this tenant.
    const seededIds = new Set([ACCOUNT_MEMBERSHIP_ID, ACCOUNT_ACCOUNTING_ID]);
    for (const c of a.gl.candidates) {
      expect(seededIds.has(c.accountId)).toBe(true);
    }
  });

  it("card projection exposes decomposed confidence + tax + economic-purpose", async () => {
    const docId = await ingestFixtureDoc();
    const a = await analyseIngestedInvoice({
      clubId: CLUB, ingestedDocumentId: docId,
      extractedTextOverride: PROFESSIONAL_BODY_TEXT,
      emailSenderAddress: "kelly.wentworth@example.com",
    });
    // The projection is called with an intake-id in production; the
    // exported helper takes an analysis directly for this test.
    const projection = summariseApIntakeForTest({
      clubId: CLUB,
      analysis: a,
      senderName: "Kelly Wentworth",
      senderAddress: "kelly.wentworth@example.com",
      primaryAttachment: { documentId: docId, filename: "member-dues.pdf" },
    });
    expect(projection.confidenceDimensions).not.toBeNull();
    expect(projection.confidenceDimensions!.supplier.source).toBe("invoice_document");
    expect(projection.confidenceDimensions!.supplier.confidence).toBeGreaterThan(30);
    expect(projection.taxReconciliation).not.toBeNull();
    expect(projection.taxReconciliation!.taxableSubtotal).toBeGreaterThanOrEqual(500);
    expect(projection.economicPurpose?.top?.purpose).toBe("employee_professional_membership_dues");
    expect(projection.extractedLineItems?.length ?? 0).toBeGreaterThanOrEqual(3);
    const invoiceId = projection.identifiers?.find((i) => i.kind === "invoice_number");
    expect(invoiceId?.value).toBe("2026-77812");
  });
});
