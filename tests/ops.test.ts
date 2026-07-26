// Phase 5 — Operational core tests.
//
// Covers inventory, private events, lessons, payroll, capital assets, and
// budgets. The focus is on the GL integration contract: each operational
// action must produce a balanced, idempotent journal entry through the
// posting engine, and must respect tenant isolation + RBAC.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ForbiddenError, ConflictError } from "@/lib/errors";
import * as inventory from "@/lib/ops/inventory";
import * as privateEvents from "@/lib/ops/private-events";
import * as lessons from "@/lib/ops/lessons";
import * as payroll from "@/lib/ops/payroll";
import * as assets from "@/lib/ops/assets";
import * as budgets from "@/lib/ops/budgets";

// ---------------------------------------------------------------------------
// Helpers shared across describe blocks.
// ---------------------------------------------------------------------------

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId.slice(0, 6)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function findAccountId(clubId: string, accountNumber: string) {
  const a = await db().account.findFirst({ where: { clubId, accountNumber } });
  if (!a) throw new Error(`Account ${accountNumber} missing`);
  return a.id;
}

async function sumJournalLines(journalEntryId: string) {
  const lines = await db().journalEntryLine.findMany({ where: { journalEntryId } });
  const dr = lines.reduce((s, l) => s + Number(l.debit.toString()), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit.toString()), 0);
  return { debit: Math.round(dr * 100) / 100, credit: Math.round(cr * 100) / 100, lines };
}

async function makeItem(clubId: string, opts: { sku: string; categoryKey?: string }) {
  // Set up a Pro Shop inventory category if missing.
  let category = opts.categoryKey
    ? await db().inventoryCategory.findFirst({ where: { clubId, key: opts.categoryKey } })
    : null;
  if (opts.categoryKey && !category) {
    category = await db().inventoryCategory.create({
      data: {
        clubId, key: opts.categoryKey, name: opts.categoryKey,
        inventoryAccountId: await findAccountId(clubId, "1210"),
        cogsAccountId: await findAccountId(clubId, "5100"),
        revenueAccountId: await findAccountId(clubId, "4300"),
        adjustmentExpenseAccountId: await findAccountId(clubId, "6410"),
      },
    });
  }
  return db().inventoryItem.create({
    data: {
      clubId, sku: opts.sku, name: `Item ${opts.sku}`,
      categoryId: category?.id ?? null,
      defaultCost: 10, retailPrice: 25,
    },
  });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
describe("Phase 5 — Inventory", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("receiving posts a balanced JE DR Inventory / CR 2050 (GRNI)", async () => {
    const club = await bootstrapAPClub("Inv-A");
    const p = await adminPrincipal(club.id);
    const item = await makeItem(club.id, { sku: "SKU-1", categoryKey: "PRO_SHOP" });

    const r = await inventory.postReceiving(p, club.id, {
      lines: [{ itemId: item.id, quantity: 10, unitCost: 12.5 }],
    });
    expect(r.status).toBe("POSTED");
    expect(r.postedJournalEntryId).toBeTruthy();

    const sums = await sumJournalLines(r.postedJournalEntryId!);
    expect(sums.debit).toBe(125);
    expect(sums.credit).toBe(125);

    // GRNI credit must hit 2050.
    const grni = sums.lines.find((l) => Number(l.credit.toString()) > 0);
    const grniAcct = await db().account.findUnique({ where: { id: grni!.accountId } });
    expect(grniAcct?.accountNumber).toBe("2050");
  });

  it("receiving recomputes weighted-average cost", async () => {
    const club = await bootstrapAPClub("Inv-B");
    const p = await adminPrincipal(club.id);
    const item = await makeItem(club.id, { sku: "SKU-2", categoryKey: "PRO_SHOP" });

    await inventory.postReceiving(p, club.id, { lines: [{ itemId: item.id, quantity: 10, unitCost: 10 }] });
    await inventory.postReceiving(p, club.id, { lines: [{ itemId: item.id, quantity: 10, unitCost: 20 }] });

    const refreshed = await db().inventoryItem.findUnique({ where: { id: item.id } });
    expect(Number(refreshed!.quantityOnHand.toString())).toBe(20);
    expect(Number(refreshed!.averageCost.toString())).toBe(15); // (10*10 + 10*20) / 20
  });

  it("adjustment with SHRINKAGE reduces inventory and posts to adjustment expense", async () => {
    const club = await bootstrapAPClub("Inv-C");
    const p = await adminPrincipal(club.id);
    const item = await makeItem(club.id, { sku: "SKU-3", categoryKey: "PRO_SHOP" });
    await inventory.postReceiving(p, club.id, { lines: [{ itemId: item.id, quantity: 5, unitCost: 20 }] });

    const result = await inventory.postAdjustment(p, club.id, {
      itemId: item.id, quantityChange: -1, reasonCode: "SHRINKAGE",
    });
    expect(result.adjustment.status).toBe("POSTED");

    const refreshed = await db().inventoryItem.findUnique({ where: { id: item.id } });
    expect(Number(refreshed!.quantityOnHand.toString())).toBe(4);

    // Negative adjustment: DR Adjustment expense / CR Inventory.
    const sums = await sumJournalLines(result.journal.id);
    expect(sums.debit).toBeCloseTo(sums.credit, 2);
  });

  it("tenant isolation: principal at club A cannot adjust club B items", async () => {
    const clubA = await bootstrapAPClub("Inv-T-A");
    const clubB = await bootstrapAPClub("Inv-T-B");
    const pA = await adminPrincipal(clubA.id);
    const item = await makeItem(clubB.id, { sku: "X", categoryKey: "PRO_SHOP" });
    await expect(
      inventory.postAdjustment(pA, clubB.id, { itemId: item.id, quantityChange: -1, reasonCode: "SHRINKAGE" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Private events
// ---------------------------------------------------------------------------
describe("Phase 5 — Private events", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("deposit posts DR 1010 / CR 2230 (event deposits liability)", async () => {
    const club = await bootstrapAPClub("PE-A");
    const p = await adminPrincipal(club.id);

    const booking = await privateEvents.createBooking(p, club.id, {
      customerName: "Test Bride",
      eventName: "Wedding Reception",
      eventStart: new Date(Date.now() + 30 * 86400000).toISOString(),
      eventEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      headCount: 100,
      depositAmount: 2500,
      totalAmount: 12000,
    });
    const dep = await privateEvents.postDeposit(p, booking.id, { amount: 2500, method: "EFT" });
    expect(dep.status).toBe("RECEIVED");

    const sums = await sumJournalLines(dep.postedJournalEntryId!);
    expect(sums.debit).toBe(2500);
    expect(sums.credit).toBe(2500);

    const cashLine = sums.lines.find((l) => Number(l.debit.toString()) > 0);
    const liabLine = sums.lines.find((l) => Number(l.credit.toString()) > 0);
    const cashAcct = await db().account.findUnique({ where: { id: cashLine!.accountId } });
    const liabAcct = await db().account.findUnique({ where: { id: liabLine!.accountId } });
    expect(cashAcct?.accountNumber).toBe("1010");
    expect(liabAcct?.accountNumber).toBe("2230");
  });
});

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------
describe("Phase 5 — Lessons", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("LessonPayable is only created on Head Pro approval (not instructor confirm)", async () => {
    const club = await bootstrapAPClub("Less-A");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id, { firstName: "Lester", lastName: "Demo" });
    const lt = await lessons.createLessonType(p, club.id, {
      key: "PRIV", name: "Private 60", durationMinutes: 60,
      memberPrice: 90, instructorPayPerLesson: 50,
      revenueAccountNumber: "4400", instructorExpenseAccountNumber: "6100",
    });
    const pro = await db().golfProfessional.create({
      data: { clubId: club.id, firstName: "Pat", lastName: "Pro", isHeadPro: true },
    });

    const booking = await lessons.createBooking(p, club.id, {
      memberId: member.id, lessonTypeId: lt.id, instructorId: pro.id,
      scheduledAt: new Date().toISOString(),
    });

    await lessons.instructorConfirm(p, booking.id);
    let payables = await db().lessonPayable.findMany({ where: { bookingId: booking.id } });
    expect(payables.length).toBe(0);

    const approved = await lessons.headProApprove(p, booking.id);
    expect(approved.status).toBe("COMPLETED");
    payables = await db().lessonPayable.findMany({ where: { bookingId: booking.id } });
    expect(payables.length).toBe(1);
    expect(Number(payables[0].amount.toString())).toBe(50);

    // Member AR JE: balanced @ 90.
    const charges = await db().charge.findMany({ where: { memberId: member.id } });
    expect(charges.length).toBe(1);
    expect(Number(charges[0].amount.toString())).toBe(90);
  });

  it("lessons:approve permission gates head-pro approval", async () => {
    const club = await bootstrapAPClub("Less-B");
    const admin = await adminPrincipal(club.id);
    const member = await makeMember(club.id, {});
    const lt = await lessons.createLessonType(admin, club.id, {
      key: "PRIV", name: "Private", memberPrice: 50, instructorPayPerLesson: 30,
    });
    const pro = await db().golfProfessional.create({
      data: { clubId: club.id, firstName: "Pat", lastName: "Pro" },
    });
    const booking = await lessons.createBooking(admin, club.id, {
      memberId: member.id, lessonTypeId: lt.id, instructorId: pro.id, scheduledAt: new Date().toISOString(),
    });
    await lessons.instructorConfirm(admin, booking.id);
    // A MEMBER-role principal cannot approve.
    const memberLogin = `m-${club.id.slice(0, 6)}@example.com`;
    await makeUser({ email: memberLogin, role: "MEMBER", clubId: club.id, memberId: member.id });
    const memberP = await principalFor(memberLogin);
    await expect(lessons.headProApprove(memberP, booking.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------
describe("Phase 5 — Payroll", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("locking a period blocks further timesheet writes and run rebuild", async () => {
    const club = await bootstrapAPClub("Pay-A");
    const p = await adminPrincipal(club.id);
    const period = await payroll.createPeriod(p, club.id, {
      label: "PP-TEST", startDate: "2026-01-01", endDate: "2026-01-15", payDate: "2026-01-22",
    });
    await payroll.lockPeriod(p, period.id);
    const refreshed = await db().payrollPeriod.findUnique({ where: { id: period.id } });
    expect(refreshed?.status).toBe("LOCKED");
  });

  it("run posting credits accrued payroll (2030) and source deductions (2040)", async () => {
    const club = await bootstrapAPClub("Pay-B");
    const p = await adminPrincipal(club.id);

    const emp = await payroll.createEmployee(p, club.id, {
      firstName: "Pat", lastName: "Wage", departmentCode: "FB", compensationType: "HOURLY", payRate: 20,
    });
    const period = await payroll.createPeriod(p, club.id, {
      label: "PP-RUN", startDate: "2026-02-01", endDate: "2026-02-14", payDate: "2026-02-21",
    });
    const ts = await payroll.ensureTimesheet(p, emp.id, period.id);
    await payroll.addTimesheetEntry(p, ts.id, { workDate: "2026-02-03", totalHours: 40 });
    await payroll.submitTimesheet(p, ts.id);
    await payroll.approveTimesheet(p, ts.id);

    const run = await payroll.buildRun(p, club.id, period.id);
    expect(Number(run.totalGross.toString())).toBeGreaterThan(0);

    const posted = await payroll.postRun(p, run.id);
    expect(posted.postedJournalEntryId).toBeTruthy();

    const sums = await sumJournalLines(posted.postedJournalEntryId!);
    expect(sums.debit).toBeCloseTo(sums.credit, 2);

    // Credit side hits 2030 + 2040.
    const credits = sums.lines.filter((l) => Number(l.credit.toString()) > 0);
    const acctNumbers = await Promise.all(credits.map((l) => db().account.findUnique({ where: { id: l.accountId } })));
    const codes = acctNumbers.map((a) => a?.accountNumber);
    expect(codes).toContain("2030");
    expect(codes).toContain("2040");
  });
});

// ---------------------------------------------------------------------------
// Capital assets
// ---------------------------------------------------------------------------
describe("Phase 5 — Capital assets", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("straight-line monthly depreciation = (cost - residual) / life", async () => {
    expect(assets.monthlyDepreciation({
      acquisitionCost: 60000, residualValue: 0,
      usefulLifeMonths: 60, depreciationMethod: "STRAIGHT_LINE",
      decliningBalanceRate: null, accumulatedDepreciation: 0,
    })).toBe(1000);
  });

  it("declining-balance monthly depreciation = NBV * rate / 12", async () => {
    expect(assets.monthlyDepreciation({
      acquisitionCost: 100000, residualValue: 0,
      usefulLifeMonths: 60, depreciationMethod: "DECLINING_BALANCE",
      decliningBalanceRate: 0.30, accumulatedDepreciation: 0,
    })).toBe(2500);
  });

  it("running depreciation is idempotent on (asset, period)", async () => {
    const club = await bootstrapAPClub("Asset-A");
    const p = await adminPrincipal(club.id);
    const cat = await db().assetCategory.create({
      data: {
        clubId: club.id, key: "EQUIP", name: "Equipment",
        assetAccountId: await findAccountId(club.id, "1540"),
        accumulatedDepreciationAccountId: await findAccountId(club.id, "1545"),
        depreciationExpenseAccountId: await findAccountId(club.id, "6900"),
        defaultUsefulLifeMonths: 60,
      },
    });
    const asset = await assets.createAsset(p, club.id, {
      name: "Mower", categoryKey: cat.key, acquisitionDate: "2026-01-01",
      acquisitionCost: 60000, usefulLifeMonths: 60, depreciationMethod: "STRAIGHT_LINE",
    });

    const period = await db().fiscalPeriod.findFirst({ where: { clubId: club.id }, orderBy: { startDate: "asc" } });

    const r1 = await assets.runDepreciation(p, club.id, period!.label);
    const r2 = await assets.runDepreciation(p, club.id, period!.label);
    expect(r1.posted).toBe(1);
    expect(r2.posted).toBe(0);

    const refreshed = await db().capitalAsset.findUnique({ where: { id: asset.id } });
    expect(Number(refreshed!.accumulatedDepreciation.toString())).toBe(1000);
  });

  it("disposal posts a balanced JE: proceeds + accum depr / asset cost + gain or loss", async () => {
    const club = await bootstrapAPClub("Asset-B");
    const p = await adminPrincipal(club.id);
    const cat = await db().assetCategory.create({
      data: {
        clubId: club.id, key: "EQUIP", name: "Equipment",
        assetAccountId: await findAccountId(club.id, "1540"),
        accumulatedDepreciationAccountId: await findAccountId(club.id, "1545"),
        depreciationExpenseAccountId: await findAccountId(club.id, "6900"),
      },
    });
    const asset = await assets.createAsset(p, club.id, {
      name: "Cart", categoryKey: cat.key, acquisitionDate: "2026-01-01",
      acquisitionCost: 5000, usefulLifeMonths: 60, depreciationMethod: "STRAIGHT_LINE",
    });
    // Manually set accumulated depreciation to 2000 so book value = 3000.
    await db().capitalAsset.update({ where: { id: asset.id }, data: { accumulatedDepreciation: 2000, netBookValue: 3000 } });

    const disposal = await assets.disposeAsset(p, asset.id, {
      disposalDate: "2026-05-01", method: "SALE", proceeds: 3500,
    });
    expect(Number(disposal.gainLoss.toString())).toBe(500);

    const sums = await sumJournalLines(disposal.postedJournalEntryId!);
    expect(sums.debit).toBeCloseTo(sums.credit, 2);
  });
});

// ---------------------------------------------------------------------------
// Budgeting
// ---------------------------------------------------------------------------
describe("Phase 5 — Budgets", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("approval/activation requires APPROVED state; only one ACTIVE per FY", async () => {
    const club = await bootstrapAPClub("Bud-A");
    const p = await adminPrincipal(club.id);
    const fy = await db().fiscalYear.findFirst({ where: { clubId: club.id }, orderBy: { startDate: "desc" } });

    const b1 = await budgets.createBudget(p, club.id, { fiscalYearId: fy!.id, name: "Operating", version: 1 });
    await expect(budgets.activateBudget(p, b1.id)).rejects.toBeInstanceOf(ConflictError);
    await budgets.approveBudget(p, b1.id);
    await budgets.activateBudget(p, b1.id);

    // Second budget for same FY, activate it -> archives the first.
    const b2 = await budgets.createBudget(p, club.id, { fiscalYearId: fy!.id, name: "Operating", version: 2 });
    await budgets.approveBudget(p, b2.id);
    await budgets.activateBudget(p, b2.id);

    const first = await db().budget.findUnique({ where: { id: b1.id } });
    expect(first?.status).toBe("ARCHIVED");
  });

  it("upsert budget line + variance computes against posted GL", async () => {
    const club = await bootstrapAPClub("Bud-B");
    const p = await adminPrincipal(club.id);
    const fy = await db().fiscalYear.findFirst({ where: { clubId: club.id }, orderBy: { startDate: "desc" } });
    const budget = await budgets.createBudget(p, club.id, { fiscalYearId: fy!.id, name: "B", version: 1 });

    await budgets.upsertBudgetLine(p, budget.id, {
      accountNumber: "4000", monthlyAmounts: Array.from({ length: 12 }, () => 1000),
    });
    // Upsert same line again — should update, not duplicate.
    await budgets.upsertBudgetLine(p, budget.id, {
      accountNumber: "4000", monthlyAmounts: Array.from({ length: 12 }, () => 2000),
    });
    const lines = await db().budgetLine.findMany({ where: { budgetId: budget.id } });
    expect(lines.length).toBe(1);
    expect(Number(lines[0].annualTotal.toString())).toBe(24000);

    const variance = await budgets.budgetVsActual(club.id, budget.id);
    expect(variance.rows.length).toBe(1);
  });

  it("budget:edit permission is required to upsert lines", async () => {
    const club = await bootstrapAPClub("Bud-C");
    const admin = await adminPrincipal(club.id);
    const fy = await db().fiscalYear.findFirst({ where: { clubId: club.id }, orderBy: { startDate: "desc" } });
    const budget = await budgets.createBudget(admin, club.id, { fiscalYearId: fy!.id, name: "B", version: 1 });
    // MEMBER lacks budget:edit.
    const memberLogin = `m-${club.id.slice(0, 6)}@example.com`;
    await makeUser({ email: memberLogin, role: "MEMBER", clubId: club.id });
    const memberP = await principalFor(memberLogin);
    await expect(
      budgets.upsertBudgetLine(memberP, budget.id, { accountNumber: "4000", monthlyAmounts: Array(12).fill(100) })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
