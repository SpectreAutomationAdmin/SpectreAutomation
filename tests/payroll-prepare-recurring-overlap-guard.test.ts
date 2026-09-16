// Phase 4 follow-up (2026-09-16) — DB-backed regression proving the
// canonical Prepare-time fail-closed guard is wired through the REAL
// `preparePayrollBatch` service.
//
// Scenarios:
//   §3 · Corrupt-overlap direct-insert makes Prepare throw ConflictError
//        and leaves NO PayrollBatchComponentSnapshot rows behind.
//        Repair fixes the state and Prepare succeeds.
//   §4 · Effective-date boundary: an assignment ending on the pay
//        period's periodEnd (exclusive) does NOT apply; its successor
//        starting on the same date DOES apply.
//   §5 · Frozen-snapshot invariant re-verified end-to-end through the
//        real preparePayrollBatch — mutating the live successor amount
//        after a successful Prepare does NOT alter the resolved amount
//        on the persisted PayrollBatchComponentSnapshot.

import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { declareImplementation } from "@/lib/payroll/implementation-declaration";
import { ConflictError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-p4fu@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-p4fu@spectre.test", name: "SupP4FU", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-p4fu@spectre.test");
}

async function seedSemiMonthlyCalendar(clubId: string, payGroupId: string) {
  const c = db();
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 1), periodEnd: utc(2026, m + 1, 16),
        payDate: utc(2026, m + 1, 16), status: "OPEN",
      },
    });
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 16), periodEnd: utc(2026, m + 2, 1),
        payDate: utc(2026, m + 2, 1), status: "OPEN",
      },
    });
  }
}

async function baseline(name: string) {
  const sup = await superAdminP();
  try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
  const club = await makeClub(name);
  const admin = await makeUser({ email: `admin.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
  const pa    = await makeUser({ email: `pa.${club.id}@t.test`,    role: "PAYROLL_ADMIN", clubId: club.id });
  const ctl   = await makeUser({ email: `ctl.${club.id}@t.test`,   role: "CONTROLLER",    clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP    = await principalFor(pa.email);
  const controllerP = await principalFor(ctl.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctl.id,
  });
  // The Prepare-time gate added in an earlier slice requires a
  // PayrollImplementationDeclaration for the batch's tax year.
  await declareImplementation(paP, club.id, { taxYear: 2026, mode: "ZERO_OPENING_YTD" });

  const c = db();
  const emp = await c.employee.create({
    data: {
      clubId: club.id, firstName: "Ovrlp", lastName: "Test",
      email: `emp.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
      dateOfBirth: utc(1985, 5, 12),
      status: "ACTIVE", employeeNumber: `E-OV-${club.id.slice(-4)}`,
      employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
    },
  });
  const assn = await c.employeeEmploymentAssignment.create({
    data: {
      clubId: club.id, employeeId: emp.id, role: "PRIMARY",
      employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
    },
  });
  await c.employeeCompensation.create({
    data: {
      clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
      cadence: "SALARY", rate: "120000", currency: "CAD",
      effectiveFrom: utc(2020, 1, 1),
    },
  });
  await writeEncryptedTd1Claims({
    clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
    province: "AB", td1FormVersion: "2026-01",
    federalClaim: "16452.00", provincialClaim: "22769.00",
  });
  const pg = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: "SAL-SM", name: "Salary Semi-Monthly",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await seedSemiMonthlyCalendar(club.id, pg.id);
  await c.payrollPayGroupMember.create({
    data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
  });
  const comp = await upsertPayrollComponent(adminP, club.id, {
    code: "CELL_PHONE", displayName: "Cell Phone Allowance",
    category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
    taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
    displaySection: "EARNINGS", displayOrder: 10,
    calculationMethod: "FIXED_AMOUNT",
  });
  return { club, adminP, paP, controllerP, emp, pg, comp };
}

async function pickPeriod(clubId: string, payGroupId: string, seq: number) {
  return db().payrollPayPeriod.findFirstOrThrow({
    where: { clubId, payGroupId, sequenceInYear: seq },
  });
}

describe("Phase 4 follow-up · Prepare wired to canonical resolver", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§3 — corrupt overlap makes preparePayrollBatch throw ConflictError; no snapshots persisted", async () => {
    const s = await baseline("prep-ov");
    // Direct-insert TWO active overlapping assignments — bypasses the
    // canonical service's overlap check to simulate legacy corrupt data.
    await db().employeeRecurringPayrollComponent.createMany({
      data: [
        {
          clubId: s.club.id, employeeId: s.emp.id, componentId: s.comp.id,
          amount: new Prisma.Decimal("75.00"),
          effectiveFrom: utc(2026, 8, 1), effectiveTo: null, active: true,
        },
        {
          clubId: s.club.id, employeeId: s.emp.id, componentId: s.comp.id,
          amount: new Prisma.Decimal("100.00"),
          effectiveFrom: utc(2026, 8, 15), effectiveTo: null, active: true,
        },
      ],
    });
    const pp = await pickPeriod(s.club.id, s.pg.id, 17); // Sep 1 → Sep 16, applicability instant Sep 16 - 1ms
    await expect(preparePayrollBatch(s.paP, s.club.id, pp.id)).rejects.toBeInstanceOf(ConflictError);

    // ATOMICITY: nothing left behind. The whole preparation transaction
    // rolled back, so no snapshot, no batch employee, and the batch
    // itself has NOT reached PREPARED.
    const snapCount = await db().payrollBatchComponentSnapshot.count({ where: { clubId: s.club.id } });
    expect(snapCount).toBe(0);
    const beCount = await db().payrollBatchEmployee.count({ where: { clubId: s.club.id } });
    expect(beCount).toBe(0);
    const preparedBatch = await db().payrollBatch.findFirst({
      where: { clubId: s.club.id, status: "PREPARED" },
    });
    expect(preparedBatch).toBeNull();

    // REPAIR: end the wrong row, re-Prepare — succeeds. Direct-update
    // because the canonical End service also checks for overlaps but
    // this row was never validated to begin with.
    const wrong = await db().employeeRecurringPayrollComponent.findFirstOrThrow({
      where: { clubId: s.club.id, employeeId: s.emp.id, componentId: s.comp.id, amount: new Prisma.Decimal("100.00") },
    });
    await db().employeeRecurringPayrollComponent.update({
      where: { id: wrong.id },
      data: { effectiveTo: utc(2026, 8, 15), active: false },
    });
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    expect(prep.batchId).toBeTruthy();
  });

  it("§4 — effective-date boundary: half-open [from, to) applied at asOf = periodEnd − 1ms", async () => {
    const s = await baseline("prep-boundary");
    // Pay period #17: Sep 1 → Sep 16 (periodEnd = Sep 16 UTC).
    // Assignment 1: [Sep 1, Sep 16) $75 — covers Sep 15, asOf just before periodEnd → APPLIES.
    // Assignment 2: [Sep 16, ∞)   $100 — covers Sep 16 onward → DOES NOT apply to period #17.
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 9, 1), effectiveTo: utc(2026, 9, 16),
    });
    await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: s.comp.id,
      amount: "100.00", effectiveFrom: utc(2026, 9, 16),
    });
    // Prepare period #17 (Sep 1 → Sep 16).
    const p17 = await pickPeriod(s.club.id, s.pg.id, 17);
    const prep17 = await preparePayrollBatch(s.paP, s.club.id, p17.id);
    const snap17 = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep17.batchId, componentCode: "CELL_PHONE" },
    });
    expect(snap17.resolvedAmount!.toString()).toBe("75");

    // Prepare period #18 (Sep 16 → Oct 1). Successor applies.
    const p18 = await pickPeriod(s.club.id, s.pg.id, 18);
    const prep18 = await preparePayrollBatch(s.paP, s.club.id, p18.id);
    const snap18 = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep18.batchId, componentCode: "CELL_PHONE" },
    });
    expect(snap18.resolvedAmount!.toString()).toBe("100");
  });

  it("§5 — successful Prepare freezes the resolved amount; later live mutation does not alter snapshot", async () => {
    const s = await baseline("prep-frozen");
    const assn = await createRecurringComponentAssignment(s.adminP, s.club.id, {
      employeeId: s.emp.id, componentId: s.comp.id,
      amount: "75.00", effectiveFrom: utc(2026, 1, 1),
    });
    const pp = await pickPeriod(s.club.id, s.pg.id, 17);
    const prep = await preparePayrollBatch(s.paP, s.club.id, pp.id);
    const snap = await db().payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "CELL_PHONE" },
    });
    expect(snap.resolvedAmount!.toString()).toBe("75");

    // Mutate the live assignment's amount after Prepare.
    await db().employeeRecurringPayrollComponent.update({
      where: { id: assn.id },
      data: { amount: new Prisma.Decimal("999.99") },
    });
    const snapAfter = await db().payrollBatchComponentSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(snapAfter.resolvedAmount!.toString()).toBe("75");
  });
});
