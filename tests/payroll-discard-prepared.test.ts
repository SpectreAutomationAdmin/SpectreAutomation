// Discard-Prepared-Payroll hotfix (2026-09-14) — §18 domain tests.
//
// Coverage of the founder-visible action `discardPreparedPayrollBatch`:
// PREPARED-only guard, idempotent on VOIDED, releases approved-time
// reservations, preserves audit history, distinct `payroll.batch.discard`
// audit event, does not weaken POSTED immutability.
//
// Tests create batches directly at specific lifecycle statuses to focus
// on the discard-path semantics without depending on the full Prepare
// pipeline (which has its own dedicated coverage in the 3B/3D suites).

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { discardPreparedPayrollBatch } from "@/lib/payroll/batch-preparation";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

async function seedBatch(opts: { clubName: string; status: string; role?: "PAYROLL_ADMIN" | "MEMBER" }) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const email = `pa.${opts.clubName}@t.test`;
  await makeUser({ email, clubId: club.id, role: opts.role ?? "PAYROLL_ADMIN" });
  const principal = await principalFor(email);

  const payGroup = await c.payrollPayGroup.create({
    data: {
      clubId: club.id, code: `PG-${opts.clubName}`.slice(0, 20),
      name: "Test Pay Group", payFrequency: "BIWEEKLY", active: true,
      calendarAnchorDate: new Date("2026-01-04"),
    },
  });
  const payPeriod = await c.payrollPayPeriod.create({
    data: {
      clubId: club.id, payGroupId: payGroup.id,
      sequenceInYear: 1, taxYear: 2026,
      periodStart: new Date("2026-01-04"), periodEnd: new Date("2026-01-17"),
      payDate: new Date("2026-01-17"), status: "OPEN",
    },
  });
  const batch = await c.payrollBatch.create({
    data: {
      clubId: club.id, payGroupId: payGroup.id, payPeriodId: payPeriod.id,
      status: opts.status, sequence: 1,
      sourceSnapshotAt: new Date(),
      createdByUserId: principal.id,
      preparedAt: ["PREPARED", "CALCULATED", "SUBMITTED_FOR_APPROVAL", "APPROVED", "POSTED"].includes(opts.status) ? new Date() : null,
      preparedByUserId: ["PREPARED", "CALCULATED", "SUBMITTED_FOR_APPROVAL", "APPROVED", "POSTED"].includes(opts.status) ? principal.id : null,
    },
  });
  return { club, principal, payGroup, payPeriod, batch };
}

describe("Discard Prepared Payroll · §18 domain tests", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §18 item 1 — PREPARED batch can be discarded by authorized actor.
  it("PREPARED batch is discarded → status VOIDED + distinct audit", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d1", status: "PREPARED" });
    const result = await discardPreparedPayrollBatch(principal, club.id, batch.id);
    expect(result.batchId).toBe(batch.id);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("VOIDED");
    expect(after.voidedAt).not.toBeNull();
    expect(after.voidedByUserId).toBe(principal.id);
    // Distinct audit event.
    const audits = await db().auditLog.findMany({
      where: { clubId: club.id, action: "payroll.batch.discard", entityId: batch.id },
    });
    expect(audits.length).toBe(1);
  });

  // §18 item 2 — unauthorized actor cannot discard.
  it("member without payroll:run cannot discard", async () => {
    const { club, batch } = await seedBatch({ clubName: "d2", status: "PREPARED", role: "MEMBER" });
    const memberEmail = `pa.d2@t.test`;
    const memberP = await principalFor(memberEmail);
    await expect(discardPreparedPayrollBatch(memberP, club.id, batch.id))
      .rejects.toBeInstanceOf(ForbiddenError);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("PREPARED");
  });

  // §18 item 3 — server rejects discard from SUBMITTED_FOR_APPROVAL.
  it("rejects discard from SUBMITTED_FOR_APPROVAL", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d3", status: "SUBMITTED_FOR_APPROVAL" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id))
      .rejects.toBeInstanceOf(ValidationError);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("SUBMITTED_FOR_APPROVAL");
  });

  // §18 item 4 — server rejects discard from APPROVED.
  it("rejects discard from APPROVED", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d4", status: "APPROVED" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id))
      .rejects.toBeInstanceOf(ValidationError);
  });

  // §18 item 5 + 13 — server rejects discard from POSTED (POSTED immutability regression).
  it("rejects discard from POSTED — POSTED immutability preserved", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d5", status: "POSTED" });
    await expect(discardPreparedPayrollBatch(principal, club.id, batch.id))
      .rejects.toBeInstanceOf(ValidationError);
    const after = await db().payrollBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("POSTED");
  });

  // §18 item 6 — discard does not delete audit history (batch row + child rows persist).
  it("preserves batch row + PayrollBatchEmployee rows as historical audit evidence", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d6", status: "PREPARED" });
    // Attach a snapshot child row so we can prove it survives.
    const emp = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-00001",
        firstName: "Test", lastName: "EmpD6",
        employeeLifecycle: "ACTIVE", onboardingState: "APPROVED",
      },
    });
    await db().payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: emp.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
        bankingReady: false, bankingStatus: "MISSING",
        sinReady: false, federalTd1Ready: true, provincialTd1Ready: true,
        compensationReady: true, status: "INCLUDED",
        salaried: true,
        sourceFactsJson: "{}",
      },
    });
    await discardPreparedPayrollBatch(principal, club.id, batch.id);
    // Batch row survives.
    const afterBatch = await db().payrollBatch.findUnique({ where: { id: batch.id } });
    expect(afterBatch).not.toBeNull();
    expect(afterBatch?.status).toBe("VOIDED");
    // Child snapshot row survives.
    const children = await db().payrollBatchEmployee.count({ where: { batchId: batch.id } });
    expect(children).toBe(1);
  });

  // §18 item 7 — discarded batch does not block replacement Prepare.
  // Indirectly proven: the Prepare-idempotency check filters on
  // `status: { not: "VOIDED" }`. This test asserts that filter shape stays
  // consistent by counting non-VOIDED batches after discard.
  it("discarded batch drops out of the non-VOIDED index used by Prepare's idempotency", async () => {
    const { club, principal, batch, payGroup, payPeriod } = await seedBatch({
      clubName: "d7", status: "PREPARED",
    });
    await discardPreparedPayrollBatch(principal, club.id, batch.id);
    const nonVoided = await db().payrollBatch.count({
      where: { clubId: club.id, payGroupId: payGroup.id, payPeriodId: payPeriod.id, status: { not: "VOIDED" } },
    });
    expect(nonVoided).toBe(0);
  });

  // §18 item 11 — approved-time reservations are released.
  it("releases PayrollApprovedTimeEntry reservations on discard", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d11", status: "PREPARED" });
    const emp = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-00001",
        firstName: "Time", lastName: "Owner",
        employeeLifecycle: "ACTIVE", onboardingState: "APPROVED",
      },
    });
    // Insert an approved-time entry pinned to the batch.
    await db().payrollApprovedTimeEntry.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        workDate: new Date("2026-01-05"),
        hours: "8",
        approvalState: "APPROVED",
        approvedByUserId: principal.id,
        approvedAt: new Date(),
        consumedByBatchId: batch.id,
      },
    });
    const beforeConsumed = await db().payrollApprovedTimeEntry.count({
      where: { clubId: club.id, consumedByBatchId: batch.id },
    });
    expect(beforeConsumed).toBe(1);
    await discardPreparedPayrollBatch(principal, club.id, batch.id);
    const afterConsumed = await db().payrollApprovedTimeEntry.count({
      where: { clubId: club.id, consumedByBatchId: batch.id },
    });
    expect(afterConsumed).toBe(0);
    // The row still exists — just released.
    const total = await db().payrollApprovedTimeEntry.count({ where: { clubId: club.id } });
    expect(total).toBe(1);
  });

  // §18 item 12 — concurrent / double-discard is CAS-safe / idempotent.
  it("second discard against an already-discarded batch is a no-op success", async () => {
    const { club, principal, batch } = await seedBatch({ clubName: "d12", status: "PREPARED" });
    await discardPreparedPayrollBatch(principal, club.id, batch.id);
    // Second call returns success with 0 released time entries.
    const second = await discardPreparedPayrollBatch(principal, club.id, batch.id);
    expect(second.batchId).toBe(batch.id);
    expect(second.releasedTimeEntryCount).toBe(0);
    // No second audit row.
    const audits = await db().auditLog.findMany({
      where: { clubId: club.id, action: "payroll.batch.discard", entityId: batch.id },
    });
    expect(audits.length).toBe(1);
  });

  // NotFoundError for missing batch id.
  it("throws NotFoundError for an unknown batchId", async () => {
    const { club, principal } = await seedBatch({ clubName: "dnf", status: "PREPARED" });
    await expect(discardPreparedPayrollBatch(principal, club.id, "nonexistent"))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
