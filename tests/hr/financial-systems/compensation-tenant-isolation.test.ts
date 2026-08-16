// HR-1 financial-systems — cross-club tenant isolation.
//
// A principal scoped to Club A cannot call the compensation service
// for an employee in Club B — must throw TenantViolationError from
// `assertTenantOwned` in loadEmployee.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError, TenantViolationError } from "@/lib/errors";
import {
  changeCompensation,
  getCompensationAt,
  getCurrentCompensation,
  listCompensationHistory,
} from "@/lib/hr/compensation";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";
import { makeEmployee } from "../security-compliance/_helpers";

describe("HR financial-systems · compensation tenant isolation", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("changeCompensation refuses when the employee belongs to a foreign club", async () => {
    const fx = await makeAdminHrFixture();
    // Employee lives in fx.foreignClub — payrollAdmin in fx.club cannot touch it.
    const foreignEmployee = await makeEmployee(fx.foreignClub.id, {
      firstName: "Foreign", lastName: "Employee",
    });
    await expect(
      changeCompensation(fx.payrollAdmin, foreignEmployee.id, {
        effectiveFrom: new Date("2024-01-01"),
        amount: 22, cadence: "HOURLY", currency: "CAD",
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("getCompensationAt refuses when the employee belongs to a foreign club", async () => {
    const fx = await makeAdminHrFixture();
    const foreignEmployee = await makeEmployee(fx.foreignClub.id);
    await expect(
      getCompensationAt(fx.payrollAdmin, foreignEmployee.id, new Date()),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("getCurrentCompensation and listCompensationHistory refuse when the employee is foreign", async () => {
    const fx = await makeAdminHrFixture();
    const foreignEmployee = await makeEmployee(fx.foreignClub.id);
    await expect(
      getCurrentCompensation(fx.payrollAdmin, foreignEmployee.id),
    ).rejects.toBeInstanceOf(TenantViolationError);
    await expect(
      listCompensationHistory(fx.payrollAdmin, foreignEmployee.id),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("a caller with no hr:compensation:write permission is denied even on their own club's employee", async () => {
    const fx = await makeAdminHrFixture();
    // GM has hr:compensation:read but NOT hr:compensation:write.
    await expect(
      changeCompensation(fx.gm, fx.employee.id, {
        effectiveFrom: new Date("2024-01-01"),
        amount: 22, cadence: "HOURLY", currency: "CAD",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
