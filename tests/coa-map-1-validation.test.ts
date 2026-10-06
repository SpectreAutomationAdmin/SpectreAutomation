// COA-MAP-1 (2026-10-06) — pure-function validation tests.
// Exercises validateAccountReassignment with synthetic snapshots.

import { describe, expect, it } from "vitest";
import {
  validateAccountReassignment,
  validateGroupDeletion,
  type AccountSnapshot,
  type GroupSnapshot,
} from "@/lib/coa-mapping/validation";

const ASSET_ACCOUNT: AccountSnapshot = {
  id: "a1", accountNumber: "1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT",
  fundApplicability: null,
};
const REVENUE_ACCOUNT: AccountSnapshot = {
  id: "a2", accountNumber: "4000", name: "Dues", type: "REVENUE", normalBalance: "CREDIT",
  fundApplicability: "OPERATING",
};
const CAPITAL_REVENUE_ACCOUNT: AccountSnapshot = {
  id: "a3", accountNumber: "7100", name: "Interest Income", type: "REVENUE", normalBalance: "CREDIT",
  fundApplicability: "CAPITAL",
};

const IS_PAYROLL_GROUP: GroupSnapshot = {
  id: "g1", key: "IS_PAYROLL", name: "Payroll & Related",
  statement: "INCOME_STATEMENT", reportingRole: "PAYROLL",
};
const BS_CASH_GROUP: GroupSnapshot = {
  id: "g2", key: "BS_CASH", name: "Cash",
  statement: "BALANCE_SHEET", reportingRole: "CASH",
};
const OTHER_INCOME_GROUP: GroupSnapshot = {
  id: "g3", key: "TENANT_OTHER_INCOME", name: "Other Income",
  statement: "INCOME_STATEMENT", reportingRole: "OTHER_INCOME",
};
const OPERATING_REVENUE_GROUP: GroupSnapshot = {
  id: "g4", key: "IS_OPERATING_REVENUE", name: "Operating Revenue",
  statement: "INCOME_STATEMENT", reportingRole: "OPERATING_REVENUE",
};

describe("validateAccountReassignment", () => {
  it("BS account into IS group → BLOCKED", () => {
    const r = validateAccountReassignment({ account: ASSET_ACCOUNT, targetGroup: IS_PAYROLL_GROUP });
    expect(r.outcome).toBe("BLOCKED");
    expect(r.reasons.map((x) => x.code)).toContain("STATEMENT_MISMATCH_BS_INTO_IS");
  });

  it("IS account into BS group → BLOCKED", () => {
    const r = validateAccountReassignment({ account: REVENUE_ACCOUNT, targetGroup: BS_CASH_GROUP });
    expect(r.outcome).toBe("BLOCKED");
    expect(r.reasons.map((x) => x.code)).toContain("STATEMENT_MISMATCH_IS_INTO_BS");
  });

  it("REVENUE (OPERATING) into Other Income (OTHER_INCOME) → VALID", () => {
    const r = validateAccountReassignment({ account: REVENUE_ACCOUNT, targetGroup: OTHER_INCOME_GROUP });
    expect(r.outcome).toBe("VALID");
    expect(r.reasons).toEqual([]);
  });

  it("CAPITAL-only REVENUE into OPERATING_REVENUE group → WARNING (fund axis conflict)", () => {
    const r = validateAccountReassignment({ account: CAPITAL_REVENUE_ACCOUNT, targetGroup: OPERATING_REVENUE_GROUP });
    expect(r.outcome).toBe("WARNING");
    expect(r.reasons.map((x) => x.code)).toContain("FUND_AXIS_CAPITAL_INTO_OPERATING");
  });

  it("CAPITAL-only REVENUE into Other Income (no fund-axis role mismatch) → VALID", () => {
    const r = validateAccountReassignment({ account: CAPITAL_REVENUE_ACCOUNT, targetGroup: OTHER_INCOME_GROUP });
    expect(r.outcome).toBe("VALID");
  });

  it("OPERATING-only REVENUE into Capital Assessments role → WARNING (opposite fund axis)", () => {
    const r = validateAccountReassignment({
      account: REVENUE_ACCOUNT,
      targetGroup: { ...OTHER_INCOME_GROUP, reportingRole: "CAPITAL_ASSESSMENTS" },
    });
    expect(r.outcome).toBe("WARNING");
    expect(r.reasons.map((x) => x.code)).toContain("FUND_AXIS_OPERATING_INTO_CAPITAL");
  });
});

describe("validateGroupDeletion", () => {
  const tenantGroup: GroupSnapshot = {
    id: "g10", key: "TENANT_FOO", name: "Foo",
    statement: "INCOME_STATEMENT", reportingRole: "OTHER",
  };

  it("tenant-created group with no assignments → VALID", () => {
    const r = validateGroupDeletion({ group: tenantGroup, assignmentCount: 0, isTenantCreated: true });
    expect(r.outcome).toBe("VALID");
  });

  it("tenant-created group WITH assignments → BLOCKED", () => {
    const r = validateGroupDeletion({ group: tenantGroup, assignmentCount: 3, isTenantCreated: true });
    expect(r.outcome).toBe("BLOCKED");
    expect(r.reasons[0].code).toBe("GROUP_HAS_ASSIGNMENTS");
  });

  it("default (seeded) group → BLOCKED even with 0 assignments", () => {
    const r = validateGroupDeletion({ group: tenantGroup, assignmentCount: 0, isTenantCreated: false });
    expect(r.outcome).toBe("BLOCKED");
    expect(r.reasons[0].code).toBe("DEFAULT_GROUP_PROTECTED");
  });
});
