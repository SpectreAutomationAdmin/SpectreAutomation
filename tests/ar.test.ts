import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { postCharge, postPayment, voidCharge, reverseCharge, voidPayment, postAdjustment, recomputeAccount } from "@/lib/services/ar";
import { calculateAging } from "@/lib/services/aging";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { db, makeClub, makeUser, makeMember, resetDb, seedRbac, principalFor } from "./util/db";

describe("AR — posting + balance recompute", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("post charge then payment leaves zero current balance", async () => {
    const club = await makeClub("AR1");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    await postCharge(p, m.id, { description: "Dues", category: "DUES", amount: 410 });
    await postPayment(p, m.id, { method: "CREDIT_CARD", amount: 410 });

    const acct = await db().memberAccount.findUnique({ where: { memberId: m.id } });
    expect(acct?.currentBalance).toBe(0);
    expect(acct?.lastPaymentDate).not.toBeNull();
  });

  it("void on a posted charge removes its impact on balance", async () => {
    const club = await makeClub("AR2");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    const c = await postCharge(p, m.id, { description: "Dues", category: "DUES", amount: 410 });
    await voidCharge(p, c.id, "data-entry error");

    const acct = await db().memberAccount.findUnique({ where: { memberId: m.id } });
    expect(acct?.currentBalance).toBe(0);

    // Original charge still exists — never deleted.
    const original = await db().charge.findUnique({ where: { id: c.id } });
    expect(original?.status).toBe("VOIDED");
  });

  it("reverse posts a contra row leaving both original and reversal POSTED/REVERSED", async () => {
    const club = await makeClub("AR3");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    const c = await postCharge(p, m.id, { description: "Dues", category: "DUES", amount: 200 });
    const contra = await reverseCharge(p, c.id, "duplicate");

    expect(contra.amount).toBe(-200);
    expect(contra.reversesId).toBe(c.id);

    const acct = await db().memberAccount.findUnique({ where: { memberId: m.id } });
    expect(acct?.currentBalance).toBe(0);

    const orig = await db().charge.findUnique({ where: { id: c.id } });
    expect(orig?.status).toBe("REVERSED");
  });

  it("FINANCE_ADMIN cannot void (lacks ar:void), CONTROLLER can", async () => {
    const club = await makeClub("AR4");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const ctl = await principalFor("ctl@example.com");
    const fin = await principalFor("fin@example.com");
    const m = await makeMember(club.id);

    const c = await postCharge(ctl, m.id, { description: "Dues", category: "DUES", amount: 100 });
    await expect(voidCharge(fin, c.id, "x")).rejects.toBeInstanceOf(ForbiddenError);
    await voidCharge(ctl, c.id, "x");
  });

  it("FAILED payment does not reduce balance", async () => {
    const club = await makeClub("AR5");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    await postCharge(p, m.id, { description: "Dues", category: "DUES", amount: 410 });
    await postPayment(p, m.id, { method: "CREDIT_CARD", amount: 410, status: "FAILED", failureReason: "Card declined" });

    const acct = await db().memberAccount.findUnique({ where: { memberId: m.id } });
    expect(acct?.currentBalance).toBe(410);
  });

  it("voiding a non-POSTED charge is rejected", async () => {
    const club = await makeClub("AR6");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    const c = await postCharge(p, m.id, { description: "Dues", category: "DUES", amount: 100 });
    await voidCharge(p, c.id, "x");
    await expect(voidCharge(p, c.id, "again")).rejects.toBeInstanceOf(ConflictError);
  });

  it("CREDIT adjustment reduces balance and is reflected after recompute", async () => {
    const club = await makeClub("AR7");
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const m = await makeMember(club.id);

    await postCharge(p, m.id, { description: "Dues", category: "DUES", amount: 500 });
    await postAdjustment(p, m.id, { type: "CREDIT", amount: 150, description: "Goodwill credit" });
    await recomputeAccount(m.id);
    const acct = await db().memberAccount.findUnique({ where: { memberId: m.id } });
    expect(acct?.currentBalance).toBe(350);
  });
});

describe("Aging — pure helper", () => {
  it("buckets unpaid amounts by age, FIFO-allocates payments", () => {
    const now = new Date("2025-06-01");
    const r = calculateAging({
      charges: [
        { id: "c1", amount: 100, dueDate: new Date("2025-01-01"), transactionDate: new Date("2025-01-01"), status: "POSTED", reversesId: null }, // ~150 days old → 120+
        { id: "c2", amount: 200, dueDate: new Date("2025-04-01"), transactionDate: new Date("2025-04-01"), status: "POSTED", reversesId: null }, // ~61 days old → 60d bucket
        { id: "c3", amount: 50,  dueDate: new Date("2025-05-25"), transactionDate: new Date("2025-05-25"), status: "POSTED", reversesId: null }, // ~7 days → current
      ],
      payments: [
        { id: "p1", amount: 80,  paymentDate: new Date("2025-05-10"), status: "SUCCESS", reversesId: null }, // pays oldest first
      ],
      adjustments: [],
    }, now);

    // 80 of c1 is paid; 20 remains in 120+. c2 untouched. c3 untouched.
    expect(r.buckets.d120).toBe(20);
    expect(r.buckets.d60).toBe(200);
    expect(r.buckets.current).toBe(50);
    expect(r.currentBalance).toBe(270);
  });

  it("excludes voided charges and failed payments", () => {
    const r = calculateAging({
      charges: [
        { id: "c1", amount: 100, dueDate: new Date(), transactionDate: new Date(), status: "VOIDED", reversesId: null },
        { id: "c2", amount: 50,  dueDate: new Date(), transactionDate: new Date(), status: "POSTED", reversesId: null },
      ],
      payments: [
        { id: "p1", amount: 50, paymentDate: new Date(), status: "FAILED", reversesId: null },
      ],
      adjustments: [],
    });
    expect(r.currentBalance).toBe(50);
  });
});
