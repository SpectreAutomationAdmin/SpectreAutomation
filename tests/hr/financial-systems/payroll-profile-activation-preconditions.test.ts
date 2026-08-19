// HR-1 financial-systems — PayrollProfile activation preconditions.
//
// Activation requires (all three):
//   1. current EmployeeCompensation row
//   2. SIN on file (masked read returns non-null)
//   3. banking in VERIFIED status
//
// Any missing precondition throws
// PayrollProfileActivationPreconditionError with a machine-
// inspectable `precondition` field. No plaintext in the message.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ConflictError } from "@/lib/errors";
import {
  activatePayrollProfile,
  deactivatePayrollProfile,
  upsertPayrollProfile,
  getPayrollProfile,
  PayrollProfileActivationPreconditionError,
} from "@/lib/hr/payroll-profile";
import { changeCompensation } from "@/lib/hr/compensation";
import { upsertSin } from "@/lib/hr/sensitive-identity";
import {
  upsertBankAccount,
  activateBankAccount,
} from "@/lib/hr/bank-account";
import { resetDb, seedRbac } from "../../util/db";
import { latestAuditForAction, makeAdminHrFixture } from "../admin-workflows/_helpers";
import { seedActivationTrio } from "./_helpers";

describe("HR financial-systems · PayrollProfile activation preconditions", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("activatePayrollProfile refuses when NO current compensation row exists", async () => {
    const fx = await makeAdminHrFixture();
    await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-ON", payGroup: "BIWEEKLY_HOURLY", payFrequency: "BIWEEKLY",
    });
    // SIN + bank present, compensation absent.
    await upsertSin(fx.payrollAdmin, fx.employee.id, "123456789");
    await upsertBankAccount(fx.payrollAdmin, fx.employee.id, {
      institutionNumber: "003", transitNumber: "12345",
      accountNumber: "9876543210", holderName: "River Sensitive",
    });
    await activateBankAccount(fx.payrollAdmin, fx.employee.id);

    await expect(activatePayrollProfile(fx.payrollAdmin, fx.employee.id))
      .rejects.toMatchObject({
        name: expect.any(String),
        precondition: "no_current_compensation",
      });
  });

  it("activatePayrollProfile refuses when SIN is NOT on file", async () => {
    const fx = await makeAdminHrFixture();
    await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-ON", payGroup: "BIWEEKLY_HOURLY", payFrequency: "BIWEEKLY",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01"), amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    await upsertBankAccount(fx.payrollAdmin, fx.employee.id, {
      institutionNumber: "003", transitNumber: "12345",
      accountNumber: "9876543210", holderName: "River Sensitive",
    });
    await activateBankAccount(fx.payrollAdmin, fx.employee.id);
    // No upsertSin.

    const err = await activatePayrollProfile(fx.payrollAdmin, fx.employee.id)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PayrollProfileActivationPreconditionError);
    expect((err as PayrollProfileActivationPreconditionError).precondition).toBe("sin_not_on_file");
    // No plaintext SIN in the message (SIN was never provided anyway,
    // but the guard is: the *precondition-name* is the safe surface).
    expect((err as Error).message).not.toMatch(/\d{9}/);
  });

  it("activatePayrollProfile refuses when banking is NOT in VERIFIED status (still PENDING_PENNY_TEST)", async () => {
    const fx = await makeAdminHrFixture();
    await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-ON", payGroup: "BIWEEKLY_HOURLY", payFrequency: "BIWEEKLY",
    });
    await changeCompensation(fx.payrollAdmin, fx.employee.id, {
      effectiveFrom: new Date("2024-01-01"), amount: 22, cadence: "HOURLY", currency: "CAD",
    });
    await upsertSin(fx.payrollAdmin, fx.employee.id, "123456789");
    // Bank inserted but NOT activated → status stays PENDING_PENNY_TEST.
    await upsertBankAccount(fx.payrollAdmin, fx.employee.id, {
      institutionNumber: "003", transitNumber: "12345",
      accountNumber: "9876543210", holderName: "River Sensitive",
    });

    const err = await activatePayrollProfile(fx.payrollAdmin, fx.employee.id)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PayrollProfileActivationPreconditionError);
    expect((err as PayrollProfileActivationPreconditionError).precondition).toBe("bank_not_active");
    // No plaintext transit/account/institution in the message.
    expect((err as Error).message).not.toContain("9876543210");
    expect((err as Error).message).not.toContain("003");
    expect((err as Error).message).not.toContain("12345");
  });

  it("activatePayrollProfile succeeds when all three preconditions are met, sets activatedAt + directDepositActive", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    const activated = await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);
    expect(activated.activatedAt).toBeInstanceOf(Date);
    expect(activated.directDepositActive).toBe(true);
    expect(activated.suspendedAt).toBeNull();

    // Audit emitted with the expected action.
    const audit = await latestAuditForAction("hr.payroll_profile.activate.post");
    expect(audit?.entityType).toBe("PayrollProfile");
    expect(audit?.entityId).toBe(activated.id);
    // Meta carries only masked helpers — no plaintext SIN or account.
    const meta = JSON.parse(audit!.metaJson!);
    expect(meta.sinMasked).toBeTruthy();
    expect(meta.sinMasked).not.toMatch(/^\d{9}$/); // masked, not raw
    expect(meta.accountLastFour).toBeTruthy();
    expect(meta.accountLastFour).not.toContain("9876543210"); // masked, not raw
  });

  it("activatePayrollProfile refuses to re-activate an already-active profile (ConflictError)", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);
    await expect(
      activatePayrollProfile(fx.payrollAdmin, fx.employee.id),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("deactivatePayrollProfile clears activatedAt, disables direct-deposit, records suspension reason + audit", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);
    const deactivated = await deactivatePayrollProfile(
      fx.payrollAdmin, fx.employee.id, "employee terminated",
    );
    expect(deactivated.activatedAt).toBeNull();
    expect(deactivated.directDepositActive).toBe(false);
    expect(deactivated.suspendedAt).toBeInstanceOf(Date);
    expect(deactivated.suspensionReason).toBe("employee terminated");

    const audit = await latestAuditForAction("hr.payroll_profile.deactivate.void");
    expect(audit?.entityId).toBe(deactivated.id);

    // Re-read via the read helper confirms the persisted state.
    const readBack = await getPayrollProfile(fx.payrollAdmin, fx.employee.id);
    expect(readBack?.activatedAt).toBeNull();
    expect(readBack?.directDepositActive).toBe(false);
  });

  it("deactivatePayrollProfile is a no-op if profile has never been activated", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    // Never activated. Deactivating returns the current draft unchanged.
    const row = await deactivatePayrollProfile(fx.payrollAdmin, fx.employee.id);
    expect(row.activatedAt).toBeNull();
    expect(row.suspendedAt).toBeNull();
  });
});
