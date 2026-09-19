// Slice E closeout (2026-09-19) — regressions:
//   §1 PREPARED cannot generate the canonical register
//   §2-3 identity snapshot frozen at Prepare + Register + PayStatement
//   §5  live name mutation does not alter POSTED artefacts

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "./util/db";
import { createPayrollIntegrationFixture } from "./util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { buildPayrollRegister } from "@/lib/payroll/payroll-register";
import { renderPayrollRegisterCsv } from "@/lib/payroll/payroll-register-csv";
import { buildPayStatement } from "@/lib/payroll/pay-statement";
import { ConflictError } from "@/lib/errors";

describe("Slice E closeout — PREPARED register boundary (§1)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Refuses register generation for a PREPARED batch with a ConflictError", async () => {
    const s = await createPayrollIntegrationFixture({ clubName: "PREPARED gate" });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    // Batch has no blockers here (salaried full-period), so status =
    // PREPARED. Register should refuse.
    const batch = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: prep.batchId } });
    expect(batch.status).toBe("PREPARED");
    await expect(buildPayrollRegister(s.paP, s.clubId, prep.batchId)).rejects.toBeInstanceOf(ConflictError);
    await expect(buildPayrollRegister(s.paP, s.clubId, prep.batchId)).rejects.toThrow(/available after Calculate/i);
  });

  it("Accepts register once CALCULATED / SUBMITTED / APPROVED / POSTED", async () => {
    const s = await createPayrollIntegrationFixture({ clubName: "post-CALCULATED gate" });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    // CALCULATED
    let reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(reg.state).toBe("CALCULATED");
    // SUBMITTED
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(reg.state).toBe("SUBMITTED_FOR_APPROVAL");
    // APPROVED
    await approvePayrollBatch(s.controllerP, prep.batchId);
    reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(reg.state).toBe("APPROVED");
    // POSTED
    await postPayrollBatch(s.paP, prep.batchId);
    reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(reg.state).toBe("POSTED");
    expect(reg.statePosted).toBe(true);
  });
});

describe("Slice E closeout — identity snapshot + mutation immutability (§2-3, §5)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Identity is frozen at Prepare; live name mutation cannot rewrite POSTED artefacts", async () => {
    const s = await createPayrollIntegrationFixture({ clubName: "identity freeze" });
    // Rename BEFORE the pipeline so the fixture default "Full Pipeline"
    // gets replaced with a distinctive Taylor Example.
    await prisma.employee.update({
      where: { id: s.emp.id },
      data: { firstName: "Taylor", lastName: "Example" },
    });

    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);
    await postPayrollBatch(s.paP, prep.batchId);

    // Snapshot should be frozen.
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    expect(be.firstNameSnapshot).toBe("Taylor");
    expect(be.lastNameSnapshot).toBe("Example");

    // Register uses frozen names.
    const regBefore = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(regBefore.employees[0]!.employeeName).toBe("Example, Taylor");
    // PayStatement uses frozen names.
    const stmtBefore = await buildPayStatement(s.paP, s.clubId, be.id);
    expect(stmtBefore.header.employeeName).toBe("Taylor Example");
    // CSV uses frozen names.
    const csvBefore = renderPayrollRegisterCsv(regBefore);
    expect(csvBefore).toContain("Example, Taylor");

    // Live rename after POST.
    await prisma.employee.update({
      where: { id: s.emp.id },
      data: { firstName: "Taylor", lastName: "Changed" },
    });
    // Historical artefacts unchanged.
    const regAfter = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(regAfter.employees[0]!.employeeName).toBe("Example, Taylor");
    const stmtAfter = await buildPayStatement(s.paP, s.clubId, be.id);
    expect(stmtAfter.header.employeeName).toBe("Taylor Example");
    const csvAfter = renderPayrollRegisterCsv(regAfter);
    expect(csvAfter).toContain("Example, Taylor");
    expect(csvAfter).not.toContain("Changed");
  });

  it("Legacy batch with NULL identity snapshot falls back to live name", async () => {
    const s = await createPayrollIntegrationFixture({ clubName: "legacy fallback" });
    await prisma.employee.update({
      where: { id: s.emp.id },
      data: { firstName: "Legacy", lastName: "Employee" },
    });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    // Simulate a legacy batch: clear the snapshot fields on the existing row.
    await prisma.payrollBatchEmployee.updateMany({
      where: { batchId: prep.batchId },
      data: { firstNameSnapshot: null, lastNameSnapshot: null },
    });
    const reg = await buildPayrollRegister(s.paP, s.clubId, prep.batchId);
    expect(reg.employees[0]!.employeeName).toBe("Employee, Legacy");
  });
});
