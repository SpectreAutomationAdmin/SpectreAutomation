// HR-1 financial-systems — PayrollProfile CRUD + permissions +
// tenant isolation (activation is covered separately).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError, TenantViolationError, ValidationError } from "@/lib/errors";
import {
  upsertPayrollProfile,
  getPayrollProfile,
} from "@/lib/hr/payroll-profile";
import { resetDb, seedRbac } from "../../util/db";
import { latestAuditForAction, makeAdminHrFixture } from "../admin-workflows/_helpers";
import { makeEmployee } from "../security-compliance/_helpers";

describe("HR financial-systems · PayrollProfile CRUD", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("upsertPayrollProfile creates the row with jurisdiction / payGroup / payFrequency + audits hr.payroll_profile.write.update", async () => {
    const fx = await makeAdminHrFixture();
    const row = await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-ON",
      payGroup: "BIWEEKLY_HOURLY",
      payFrequency: "BIWEEKLY",
    });
    expect(row.employeeId).toBe(fx.employee.id);
    expect(row.jurisdiction).toBe("CA-ON");
    expect(row.payGroup).toBe("BIWEEKLY_HOURLY");
    expect(row.payFrequency).toBe("BIWEEKLY");
    expect(row.directDepositActive).toBe(false);
    expect(row.activatedAt).toBeNull();

    const audit = await latestAuditForAction("hr.payroll_profile.write.update");
    expect(audit?.entityType).toBe("PayrollProfile");
    expect(audit?.entityId).toBe(row.id);
  });

  it("upsertPayrollProfile is idempotent per employee (updates existing draft)", async () => {
    const fx = await makeAdminHrFixture();
    const first = await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-ON", payGroup: "BIWEEKLY_HOURLY", payFrequency: "BIWEEKLY",
    });
    const second = await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-BC", payGroup: "MONTHLY_SALARY", payFrequency: "MONTHLY",
    });
    expect(second.id).toBe(first.id); // same row (employeeId @unique)
    expect(second.jurisdiction).toBe("CA-BC");
    expect(second.payFrequency).toBe("MONTHLY");
  });

  it("upsertPayrollProfile rejects unknown jurisdiction", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
        jurisdiction: "US-CA", payGroup: "X", payFrequency: "BIWEEKLY",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("upsertPayrollProfile rejects unknown payFrequency", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
        jurisdiction: "CA-ON", payGroup: "X", payFrequency: "DAILY",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("upsertPayrollProfile denies GM (has read but not write)", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      upsertPayrollProfile(fx.gm, fx.employee.id, {
        jurisdiction: "CA-ON", payGroup: "X", payFrequency: "BIWEEKLY",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("upsertPayrollProfile refuses cross-club employee (TenantViolationError)", async () => {
    const fx = await makeAdminHrFixture();
    const foreignEmployee = await makeEmployee(fx.foreignClub.id);
    await expect(
      upsertPayrollProfile(fx.payrollAdmin, foreignEmployee.id, {
        jurisdiction: "CA-ON", payGroup: "X", payFrequency: "BIWEEKLY",
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("getPayrollProfile returns null when no row exists", async () => {
    const fx = await makeAdminHrFixture();
    const row = await getPayrollProfile(fx.payrollAdmin, fx.employee.id);
    expect(row).toBeNull();
  });

  it("getPayrollProfile refuses cross-club employee", async () => {
    const fx = await makeAdminHrFixture();
    const foreignEmployee = await makeEmployee(fx.foreignClub.id);
    await expect(
      getPayrollProfile(fx.payrollAdmin, foreignEmployee.id),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });
});
