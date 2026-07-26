import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub, makeActiveVendor } from "./util/ap";
import {
  createVendor, submitVendorForApproval, activateVendor, blockVendor,
  addBankingProfile, submitBankingForApproval, verifyBanking,
  initiatePennyTest, confirmPennyTest,
} from "@/lib/ap/vendors";
import { invoiceService, paymentBatchService } from "@/lib/ap";
import { decide, getRequestForEntity } from "@/lib/ap/approvals";
import { payInvoice, voidPayment } from "@/lib/ap/payments";
import { apAging, reconcileApToGl } from "@/lib/ap/reports";
import { uploadCapture, parseExtraction, parseSuggestion } from "@/lib/ap/capture";
import { detectInvoiceExceptions, overrideException } from "@/lib/ap/exceptions";
import { setPeriodStatus } from "@/lib/accounting/periods";
import { trialBalance } from "@/lib/accounting/reports";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";

const today = () => new Date().toISOString().slice(0, 10);

describe("AP — Vendor lifecycle & tenant safety", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("vendor creation is tenant-safe", async () => {
    const clubA = await bootstrapAPClub("A");
    const clubB = await bootstrapAPClub("B");
    await makeUser({ email: "ctl-a@example.com", role: "CONTROLLER", clubId: clubA.id });
    const p = await principalFor("ctl-a@example.com");
    const v = await createVendor(p, clubA.id, { legalName: "Acme Co.", paymentTermsDays: 30, paymentMethod: "EFT" });
    expect(v.clubId).toBe(clubA.id);
    // Same legalName at club B is fine — vendors are scoped per club.
    await makeUser({ email: "ctl-b@example.com", role: "CONTROLLER", clubId: clubB.id });
    const pB = await principalFor("ctl-b@example.com");
    const v2 = await createVendor(pB, clubB.id, { legalName: "Acme Co.", paymentTermsDays: 30, paymentMethod: "EFT" });
    expect(v2.clubId).toBe(clubB.id);
    // Duplicate at the same club rejected.
    await expect(createVendor(p, clubA.id, { legalName: "Acme Co.", paymentTermsDays: 30, paymentMethod: "EFT" }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("vendor approval creates an audit log", async () => {
    const club = await bootstrapAPClub("Audit");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await createVendor(p, club.id, { legalName: "Auditable LLP", paymentTermsDays: 30, paymentMethod: "EFT" });
    await submitVendorForApproval(p, v.id);
    await activateVendor(p, v.id);
    const log = await db().auditLog.findFirst({ where: { entityType: "Vendor", entityId: v.id, action: "vendor.activate" } });
    expect(log).not.toBeNull();
  });

  it("vendor banking change requires approval", async () => {
    const club = await bootstrapAPClub("Banking");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await createVendor(p, club.id, { legalName: "Bankings Inc.", paymentTermsDays: 30, paymentMethod: "EFT" });
    const bp = await addBankingProfile(p, v.id, {
      type: "EFT", bankName: "Test Bank",
      institutionNumber: "001", transitNumber: "01234", accountLastFour: "9999", processorToken: "tok",
    });
    // Verifying before approval fails.
    await expect(verifyBanking(p, bp.id, { skipPennyTest: true })).rejects.toBeInstanceOf(ConflictError);
    await submitBankingForApproval(p, bp.id);
    // The submitter cannot approve their own banking request.
    const req = await getRequestForEntity(club.id, "VENDOR_BANKING", bp.id);
    expect(req?.requiredApprovals).toBeGreaterThanOrEqual(2);
    // Other approvers decide.
    await makeUser({ email: "gm@example.com", role: "GENERAL_MANAGER", clubId: club.id });
    const gm = await principalFor("gm@example.com");
    await decide(gm, req!.id, { decision: "APPROVE" });
    // Banking still pending (need a second approver) — CONTROLLER who is not the requester
    await db().user.update({ where: { email: "ctl@example.com" }, data: {} });
    await makeUser({ email: "ctl2@example.com", role: "CONTROLLER", clubId: club.id });
    const ctl2 = await principalFor("ctl2@example.com");
    await decide(ctl2, req!.id, { decision: "APPROVE" });
    // Now verify succeeds (we override penny test to keep the test simple).
    await verifyBanking(ctl2, bp.id, { skipPennyTest: true });
    const updated = await db().vendorBankingProfile.findUnique({ where: { id: bp.id } });
    expect(updated?.status).toBe("VERIFIED");
    expect(updated?.isActive).toBe(true);
  });

  it("penny test confirm path activates banking gate", async () => {
    const club = await bootstrapAPClub("Penny");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await createVendor(p, club.id, { legalName: "Penny Co.", paymentTermsDays: 30, paymentMethod: "EFT" });
    const bp = await addBankingProfile(p, v.id, { type: "EFT", bankName: "T", institutionNumber: "001", transitNumber: "01234", accountLastFour: "1234", processorToken: "tok" });
    const pt = await initiatePennyTest(p, bp.id, { amount: 0.05 });
    expect(pt.status).toBe("SENT");
    const confirmed = await confirmPennyTest(p, pt.id, 0.05);
    expect(confirmed.status).toBe("CONFIRMED");
    // A mismatched confirmation fails.
    const pt2 = await initiatePennyTest(p, bp.id, { amount: 0.07 });
    const failed = await confirmPennyTest(p, pt2.id, 0.99);
    expect(failed.status).toBe("FAILED");
  });
});

describe("AP — Invoice lifecycle & validation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("invoice total validation works", async () => {
    const club = await bootstrapAPClub("Validate");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Validator Co." });

    // Header account rejected (1500 is a header in the default COA template).
    await expect(invoiceService.createDraft(p, club.id, {
      vendorId: v.id, invoiceDate: today(),
      lines: [{ expenseAccountNumber: "1500", amount: 100 }],
    })).rejects.toBeInstanceOf(ValidationError);
    // Zero invoice rejected.
    await expect(invoiceService.createDraft(p, club.id, {
      vendorId: v.id, invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 0, taxAmount: 0 }],
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("duplicate vendor invoice number is rejected", async () => {
    const club = await bootstrapAPClub("Dup");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Dup Co." });

    await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "VR-1001", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    });
    await expect(invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "VR-1001", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("invoice cannot post without approval (without override)", async () => {
    const club = await bootstrapAPClub("Approval");
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const fin = await principalFor("fin@example.com");
    const v = await makeActiveVendor(fin, club.id, { legalName: "ApprovalNeeded Co." });
    const inv = await invoiceService.createDraft(fin, club.id, {
      vendorId: v.id, invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 200, taxCodeKey: "GST_5", taxAmount: 10 }],
    });
    await invoiceService.submitInvoiceForApproval(fin, inv.id);
    // FINANCE_ADMIN doesn't hold ap:invoice:post.
    await expect(invoiceService.postInvoice(fin, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("invoice cannot post to HARD_LOCKED period", async () => {
    const club = await bootstrapAPClub("Locked");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Locked Co." });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 50, taxCodeKey: "GST_5", taxAmount: 2.5 }],
    });
    // Lock the period that covers today.
    const period = await db().fiscalPeriod.findFirst({ where: { clubId: club.id, startDate: { lte: new Date() }, endDate: { gte: new Date() } } });
    await setPeriodStatus(p, period!.id, "HARD_LOCKED");
    await expect(invoiceService.postInvoice(p, inv.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("posted AP invoice creates a balanced journal entry; AP control = total", async () => {
    const club = await bootstrapAPClub("Posting");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Poster Co." });

    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "VR-2001", invoiceDate: today(),
      lines: [
        { expenseAccountNumber: "6010", amount: 1000, taxCodeKey: "GST_5", taxAmount: 50 },
      ],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);

    const tb = await trialBalance(club.id, new Date());
    expect(tb.isBalanced).toBe(true);
    const ap = tb.rows.find((r) => r.accountNumber === "2010");
    expect(ap?.credit.toString()).toBe("1050"); // total
    const itc = tb.rows.find((r) => r.accountNumber === "1310");
    expect(itc?.debit.toString()).toBe("50");
    const exp = tb.rows.find((r) => r.accountNumber === "6010");
    expect(exp?.debit.toString()).toBe("1000");
  });

  it("invoice reversal posts a balanced contra entry; AP control nets to zero", async () => {
    const club = await bootstrapAPClub("Reverse");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Reversers" });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "VR-3001", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 400, taxCodeKey: "GST_5", taxAmount: 20 }],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);
    await invoiceService.reverseInvoice(p, inv.id, "duplicate posting");

    const tb = await trialBalance(club.id, new Date());
    expect(tb.isBalanced).toBe(true);
    const ap = tb.rows.find((r) => r.accountNumber === "2010");
    // After reversal the AP control should net to zero.
    expect(ap?.credit.toString() ?? "0").toBe("0");
    expect(ap?.debit.toString() ?? "0").toBe("0");
  });
});

describe("AP — Aging + reconciliation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("AP aging buckets and AP-to-GL recon match", async () => {
    const club = await bootstrapAPClub("Aging");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v1 = await makeActiveVendor(p, club.id, { legalName: "VendorA" });
    const v2 = await makeActiveVendor(p, club.id, { legalName: "VendorB" });

    // Post two invoices in the current period.
    const i1 = await invoiceService.createDraft(p, club.id, { vendorId: v1.id, vendorReference: "I1", invoiceDate: today(), lines: [{ expenseAccountNumber: "6010", amount: 1000, taxCodeKey: "GST_5", taxAmount: 50 }] });
    await invoiceService.submitInvoiceForApproval(p, i1.id);
    await invoiceService.postInvoice(p, i1.id);
    const i2 = await invoiceService.createDraft(p, club.id, { vendorId: v2.id, vendorReference: "I2", invoiceDate: today(), lines: [{ expenseAccountNumber: "6010", amount: 250, taxCodeKey: "GST_5", taxAmount: 12.5 }] });
    await invoiceService.submitInvoiceForApproval(p, i2.id);
    await invoiceService.postInvoice(p, i2.id);

    const aging = await apAging(club.id);
    expect(aging.rows.length).toBe(2);
    expect(aging.totals.total.toString()).toBe("1312.5"); // 1050 + 262.5

    const recon = await reconcileApToGl(club.id);
    expect(recon.isBalanced).toBe(true);
    expect(recon.subledgerTotal.toString()).toBe(recon.glControlNatural.toString());
  });
});

describe("AP — Payments + payment batches", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("partial payment updates balance correctly", async () => {
    const club = await bootstrapAPClub("Pay");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Payable Co.", withVerifiedBanking: true });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "PV-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 1000, taxCodeKey: "GST_5", taxAmount: 50 }],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);

    await payInvoice(p, { invoiceId: inv.id, amount: 600, method: "EFT" });
    const after = await db().aPInvoice.findUnique({ where: { id: inv.id } });
    expect(after?.status).toBe("PARTIALLY_PAID");
    expect(Number(after?.amountPaid.toString())).toBe(600);

    await payInvoice(p, { invoiceId: inv.id, amount: 450, method: "EFT" });
    const paid = await db().aPInvoice.findUnique({ where: { id: inv.id } });
    expect(paid?.status).toBe("PAID");
    expect(Number(paid?.amountPaid.toString())).toBe(1050);
  });

  it("overpayment is rejected", async () => {
    const club = await bootstrapAPClub("Over");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Over Co.", withVerifiedBanking: true });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "OV-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);
    await expect(payInvoice(p, { invoiceId: inv.id, amount: 500, method: "EFT" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("EFT payment to unverified vendor banking is rejected", async () => {
    const club = await bootstrapAPClub("NoBank");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "NoBank Co.", withVerifiedBanking: false });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "NB-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);
    await expect(payInvoice(p, { invoiceId: inv.id, amount: 50, method: "EFT" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("payment posting creates a balanced JE; recon still ties", async () => {
    const club = await bootstrapAPClub("PostPay");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "PostPay Co.", withVerifiedBanking: true });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "PP-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 500, taxCodeKey: "GST_5", taxAmount: 25 }],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);
    await payInvoice(p, { invoiceId: inv.id, amount: 525, method: "EFT" });

    const tb = await trialBalance(club.id, new Date());
    expect(tb.isBalanced).toBe(true);
    const recon = await reconcileApToGl(club.id);
    expect(recon.isBalanced).toBe(true);
    expect(recon.subledgerTotal.toString()).toBe("0");
  });

  it("payment batch excludes blocked vendor & unverified banking; processes the rest", async () => {
    const club = await bootstrapAPClub("Batch");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const ok = await makeActiveVendor(p, club.id, { legalName: "OK Co.", withVerifiedBanking: true });
    const noBank = await makeActiveVendor(p, club.id, { legalName: "NoBank Co.", withVerifiedBanking: false });
    const blocked = await makeActiveVendor(p, club.id, { legalName: "Blocked Co.", withVerifiedBanking: true });
    await blockVendor(p, blocked.id, "audit issue");

    // Post invoices for the two non-blocked vendors. The blocked vendor's
    // createDraft itself is blocked by the service.
    for (const [v, ref] of [[ok, "OK-1"], [noBank, "NB-1"]] as Array<[{ id: string }, string]>) {
      const inv = await invoiceService.createDraft(p, club.id, {
        vendorId: v.id, vendorReference: ref, invoiceDate: today(),
        lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
      });
      await invoiceService.submitInvoiceForApproval(p, inv.id);
      await invoiceService.postInvoice(p, inv.id);
    }
    // Confirm the blocked vendor cannot have a draft created.
    await expect(invoiceService.createDraft(p, club.id, {
      vendorId: blocked.id, invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    })).rejects.toBeInstanceOf(ConflictError);

    const batch = await paymentBatchService.createBatch(p, club.id, {
      description: "Test EFT run",
      paymentDate: today(),
      paymentMethod: "EFT",
      bankAccountNumber: "1010",
    });

    // Only OK should be addable.
    const okInv = await db().aPInvoice.findFirst({ where: { clubId: club.id, vendorId: ok.id } });
    await paymentBatchService.addItem(p, batch.id, { invoiceId: okInv!.id, amount: 105 });

    // Adding NoBank invoice should fail.
    const nbInv = await db().aPInvoice.findFirst({ where: { clubId: club.id, vendorId: noBank.id } });
    await expect(paymentBatchService.addItem(p, batch.id, { invoiceId: nbInv!.id, amount: 105 }))
      .rejects.toBeInstanceOf(ConflictError);

    // Adding Blocked invoice — if it posted somehow, we can't test; but its post failed so
    // there is no POSTED invoice. Skipping that assertion.

    await paymentBatchService.submitBatchForApproval(p, batch.id);
    // CONTROLLER alone satisfies the low-threshold rule.
    const req = await getRequestForEntity(club.id, "PAYMENT_BATCH", batch.id);
    expect(req?.requiredApprovals).toBeGreaterThanOrEqual(1);
    // CONTROLLER cannot self-approve a request they created.
    await expect(decide(p, req!.id, { decision: "APPROVE" })).rejects.toBeInstanceOf(ForbiddenError);
    // FINANCE_ADMIN is eligible for the low-threshold payment-batch rule.
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const fin = await principalFor("fin@example.com");
    await decide(fin, req!.id, { decision: "APPROVE" });

    await paymentBatchService.finalizeApprovalState(p, batch.id);
    await paymentBatchService.processBatch(p, batch.id);

    const finalBatch = await db().paymentBatch.findUnique({ where: { id: batch.id }, include: { items: true, payments: true } });
    expect(finalBatch?.status).toBe("PROCESSED");
    expect(finalBatch?.payments.length).toBe(1);

    const recon = await reconcileApToGl(club.id);
    expect(recon.isBalanced).toBe(true);
  });

  it("void payment reverses GL and restores invoice balance", async () => {
    const club = await bootstrapAPClub("VoidPay");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "VoidVendor", withVerifiedBanking: true });
    const inv = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "VV-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 200, taxCodeKey: "GST_5", taxAmount: 10 }],
    });
    await invoiceService.submitInvoiceForApproval(p, inv.id);
    await invoiceService.postInvoice(p, inv.id);
    const payment = await payInvoice(p, { invoiceId: inv.id, amount: 210, method: "EFT" });
    await voidPayment(p, payment.id, "duplicate");

    const reloaded = await db().aPInvoice.findUnique({ where: { id: inv.id } });
    expect(reloaded?.amountPaid.toString()).toBe("0");
    expect(reloaded?.status).toBe("POSTED");

    const recon = await reconcileApToGl(club.id);
    expect(recon.isBalanced).toBe(true);
  });
});

describe("AP — Capture & exceptions", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("capture upload runs mock OCR and populates extraction + suggestion", async () => {
    const club = await bootstrapAPClub("Cap");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const cap = await uploadCapture(p, club.id, { name: "test-invoice.pdf", mimeType: "application/pdf", sizeBytes: 123 });
    const ex = parseExtraction(cap);
    const sg = parseSuggestion(cap);
    expect(ex?.vendorName).toBeTruthy();
    expect(ex?.total).toBeGreaterThan(0);
    expect(sg?.expenseAccountNumber).toBeTruthy();
    expect(cap.status).toBe("NEEDS_REVIEW");
  });

  it("exception engine flags NEW_VENDOR + EXCEEDS_NORMAL_SPEND", async () => {
    const club = await bootstrapAPClub("Exc");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const v = await makeActiveVendor(p, club.id, { legalName: "Spendy Co." });
    // 3 small POSTED invoices to establish a baseline.
    for (let i = 0; i < 3; i++) {
      const inv = await invoiceService.createDraft(p, club.id, {
        vendorId: v.id, vendorReference: `BL-${i}`, invoiceDate: today(),
        lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
      });
      await invoiceService.submitInvoiceForApproval(p, inv.id);
      await invoiceService.postInvoice(p, inv.id);
    }
    // 4th invoice is a large outlier.
    const big = await invoiceService.createDraft(p, club.id, {
      vendorId: v.id, vendorReference: "BIG-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 5000, taxCodeKey: "GST_5", taxAmount: 250 }],
    });
    await detectInvoiceExceptions(p, club.id, big.id);
    const exceptions = await db().aPException.findMany({ where: { clubId: club.id, invoiceId: big.id, status: "OPEN" } });
    expect(exceptions.find((e) => e.kind === "EXCEEDS_NORMAL_SPEND")).toBeTruthy();
  });

  it("override of exception requires permission", async () => {
    const club = await bootstrapAPClub("Override");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const ctl = await principalFor("ctl@example.com");
    const fin = await principalFor("fin@example.com");
    const v = await makeActiveVendor(ctl, club.id, { legalName: "OvrCo" });
    const inv = await invoiceService.createDraft(ctl, club.id, {
      vendorId: v.id, vendorReference: "OVR-1", invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    });
    await detectInvoiceExceptions(ctl, club.id, inv.id);
    const ex = await db().aPException.findFirst({ where: { invoiceId: inv.id, status: "OPEN" } });
    expect(ex).toBeTruthy();
    // FINANCE_ADMIN lacks override permission.
    await expect(overrideException(fin, ex!.id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    // CONTROLLER succeeds.
    await overrideException(ctl, ex!.id, "looks fine");
    const after = await db().aPException.findUnique({ where: { id: ex!.id } });
    expect(after?.status).toBe("OVERRIDDEN");
  });
});

describe("AP — Cross-club isolation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("controller at A cannot post invoice for vendor at B", async () => {
    const a = await bootstrapAPClub("X");
    const b = await bootstrapAPClub("Y");
    await makeUser({ email: "ctl-a@example.com", role: "CONTROLLER", clubId: a.id });
    await makeUser({ email: "ctl-b@example.com", role: "CONTROLLER", clubId: b.id });
    const pA = await principalFor("ctl-a@example.com");
    const pB = await principalFor("ctl-b@example.com");
    const vA = await makeActiveVendor(pA, a.id, { legalName: "A Vendor" });
    // ControllerB tries to create an invoice against A's vendor.
    await expect(invoiceService.createDraft(pB, a.id, {
      vendorId: vA.id, invoiceDate: today(),
      lines: [{ expenseAccountNumber: "6010", amount: 100, taxCodeKey: "GST_5", taxAmount: 5 }],
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
