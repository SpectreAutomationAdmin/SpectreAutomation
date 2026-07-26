import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createDraftAgreement,
  signAndActivate,
  applyPayment,
  payoffQuote,
  sweepMissedPayments,
  cancelAgreement,
} from "@/lib/services/financing";
import { ConflictError } from "@/lib/errors";
import { db, makeClub, makeMember, makeUser, resetDb, seedRbac, principalFor } from "./util/db";

describe("Financing — agreement lifecycle", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("creates a draft, signs it, and produces a versioned document with content hash", async () => {
    const club = await makeClub("Fin");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    const draft = await createDraftAgreement(p, m.id, {
      principalAmount: 12000,
      interestRate: 0.06,
      termMonths: 24,
    });
    expect(draft.status).toBe("DRAFT");

    const { agreement, doc } = await signAndActivate(p, draft.id, { signatureName: "John Tester" });
    expect(agreement.status).toBe("ACTIVE");
    expect(agreement.signedAt).not.toBeNull();
    expect(agreement.agreementNumber).toMatch(/^FIN-\d{4}-\d{4}$/);
    expect(doc.version).toBe(1);
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(agreement.currentDocumentId).toBe(doc.id);
  });

  it("applies a payment FIFO across the schedule", async () => {
    const club = await makeClub("FinPay");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    const draft = await createDraftAgreement(p, m.id, { principalAmount: 1200, interestRate: 0, termMonths: 12 });
    const { agreement } = await signAndActivate(p, draft.id, { signatureName: "Pay Tester" });

    // Pay first two installments + a bit of the third.
    const result = await applyPayment(p, agreement.id, { amount: 250 });
    expect(result.allocations.length).toBeGreaterThanOrEqual(2);

    const schedule = await db().financingPaymentSchedule.findMany({
      where: { financingAgreementId: agreement.id },
      orderBy: { paymentNumber: "asc" },
    });
    expect(schedule[0].status).toBe("PAID");
    expect(schedule[1].status).toBe("PAID");
    expect(schedule[2].status).toBe("PARTIAL");
  });

  it("payoffQuote returns total remaining and installment count", async () => {
    const club = await makeClub("FinPayoff");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);
    const draft = await createDraftAgreement(p, m.id, { principalAmount: 1200, interestRate: 0, termMonths: 12 });
    const { agreement } = await signAndActivate(p, draft.id, { signatureName: "PO Tester" });
    await applyPayment(p, agreement.id, { amount: 300 });

    const agreementWith = await db().financingAgreement.findUnique({
      where: { id: agreement.id },
      include: { schedule: true },
    });
    const q = payoffQuote(agreementWith!);
    expect(q.installmentsRemaining).toBe(9);
    expect(Math.round(q.totalDue)).toBe(900);
  });

  it("sweepMissedPayments marks overdue installments MISSED and defaults after 3", async () => {
    const club = await makeClub("Sweep");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    // Past-due start so installments are immediately overdue.
    const draft = await createDraftAgreement(p, m.id, {
      principalAmount: 1000, interestRate: 0, termMonths: 12, startDate: "2020-01-01",
    });
    await signAndActivate(p, draft.id, { signatureName: "Default Tester" });

    await sweepMissedPayments(club.id, { graceDays: 0, defaultAfter: 3 });

    const a = await db().financingAgreement.findUnique({ where: { id: draft.id } });
    expect(a?.status).toBe("DEFAULTED");
  });

  it("cancel on a paid-off agreement is rejected", async () => {
    const club = await makeClub("FinCancel");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);
    const draft = await createDraftAgreement(p, m.id, { principalAmount: 100, interestRate: 0, termMonths: 1 });
    const { agreement } = await signAndActivate(p, draft.id, { signatureName: "Final Tester" });
    await applyPayment(p, agreement.id, { amount: 100 });

    await expect(cancelAgreement(p, agreement.id, "x")).rejects.toBeInstanceOf(ConflictError);
  });
});
