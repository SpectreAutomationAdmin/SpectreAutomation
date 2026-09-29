// DIM-1 (2026-09-29) — dimensional-validation service test matrix.
//
// Covers the Section 15 matrix from the founder's DIM-1 directive
// (15 explicit cases) plus the cross-tenant / reconciliation
// invariants. Uses mocked Prisma so the tests exercise the pure
// validation logic without a DB fixture — the service is
// intentionally I/O-light (four findUnique/count calls at most).

import { describe, expect, it, vi, beforeEach } from "vitest";

// The service under test.
import {
  validateLineDimensions,
} from "@/lib/accounting/dimensional-validation";

// Mock the prisma module (module-level so the service picks it up
// on import). All findUnique + count methods are vi.fn(); each
// test wires the return values it needs.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    account:           { findUnique: vi.fn() },
    department:        { findUnique: vi.fn() },
    fund:              { findUnique: vi.fn() },
    accountDepartment: { count: vi.fn() },
    accountFund:       { count: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

const CLUB_A = "club_a";
const CLUB_B = "club_b";
const ACCT_A = "acct_a";
const DEPT_A = "dept_a";
const FUND_A = "fund_a";

type MockedPrisma = {
  account:           { findUnique: ReturnType<typeof vi.fn> };
  department:        { findUnique: ReturnType<typeof vi.fn> };
  fund:              { findUnique: ReturnType<typeof vi.fn> };
  accountDepartment: { count: ReturnType<typeof vi.fn> };
  accountFund:       { count: ReturnType<typeof vi.fn> };
};

const mocked = prisma as unknown as MockedPrisma;

// Convenience builder for the standard account mock shape.
function mockAccount(overrides: Partial<{
  id: string;
  clubId: string;
  departmentPolicy: string;
  fundPolicy: string;
}> = {}) {
  mocked.account.findUnique.mockResolvedValueOnce({
    id: overrides.id ?? ACCT_A,
    clubId: overrides.clubId ?? CLUB_A,
    departmentPolicy: overrides.departmentPolicy ?? "OPTIONAL",
    fundPolicy: overrides.fundPolicy ?? "OPTIONAL",
  });
}

function mockDepartment(overrides: Partial<{ id: string; clubId: string }> = {}) {
  mocked.department.findUnique.mockResolvedValueOnce({
    id: overrides.id ?? DEPT_A,
    clubId: overrides.clubId ?? CLUB_A,
  });
}

function mockFund(overrides: Partial<{ id: string; clubId: string; isActive: boolean }> = {}) {
  mocked.fund.findUnique.mockResolvedValueOnce({
    id: overrides.id ?? FUND_A,
    clubId: overrides.clubId ?? CLUB_A,
    isActive: overrides.isActive ?? true,
  });
}

function mockNoDeptApplicability() {
  mocked.accountDepartment.count.mockResolvedValueOnce(0);
}

function mockDeptApplicability(hasThisOne: boolean) {
  mocked.accountDepartment.count.mockResolvedValueOnce(1); // applicability set exists
  mocked.accountDepartment.count.mockResolvedValueOnce(hasThisOne ? 1 : 0);
}

function mockNoFundApplicability() {
  mocked.accountFund.count.mockResolvedValueOnce(0);
}

function mockFundApplicability(hasThisOne: boolean) {
  mocked.accountFund.count.mockResolvedValueOnce(1);
  mocked.accountFund.count.mockResolvedValueOnce(hasThisOne ? 1 : 0);
}

beforeEach(() => {
  mocked.account.findUnique.mockReset();
  mocked.department.findUnique.mockReset();
  mocked.fund.findUnique.mockReset();
  mocked.accountDepartment.count.mockReset();
  mocked.accountFund.count.mockReset();
});

describe("DIM-1 · dimensional-validation · department policy matrix", () => {
  it("(1) Department REQUIRED + missing department → rejected", async () => {
    mockAccount({ departmentPolicy: "REQUIRED" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "DEPARTMENT_REQUIRED")).toBe(true);
    }
  });

  it("(2) Department REQUIRED + allowed department → accepted", async () => {
    mockAccount({ departmentPolicy: "REQUIRED" });
    mockDepartment();
    mockDeptApplicability(true);
    mockNoFundApplicability();
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: DEPT_A, fundId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("(3) Department supplied but NOT in AccountDepartment applicability → rejected", async () => {
    mockAccount({ departmentPolicy: "OPTIONAL" });
    mockDepartment();
    mockDeptApplicability(false); // applicability rows exist, but this dept isn't in them
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: DEPT_A, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "DEPARTMENT_NOT_ALLOWED_ON_ACCOUNT")).toBe(true);
    }
  });

  it("(4) Department OPTIONAL + null → accepted", async () => {
    mockAccount({ departmentPolicy: "OPTIONAL" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("(5) Department NOT_APPLICABLE + null → accepted", async () => {
    mockAccount({ departmentPolicy: "NOT_APPLICABLE" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("(5b) Department NOT_APPLICABLE + supplied → rejected", async () => {
    mockAccount({ departmentPolicy: "NOT_APPLICABLE" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: DEPT_A, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "DEPARTMENT_NOT_APPLICABLE")).toBe(true);
    }
  });

  it("(6) defaultDepartmentId populated + caller submits no department → default does NOT silently become ledger department (service never reads defaultDepartmentId)", async () => {
    // Prove the service does not query anywhere that could resolve
    // account.defaultDepartmentId. Even if the row's defaultDepartmentId
    // were "some-preferred-dept", passing departmentId=null on an
    // OPTIONAL account yields ok with departmentId still null — no
    // silent promotion.
    mockAccount({ departmentPolicy: "OPTIONAL" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(true);
    // Prove: nothing about the department pathway was queried when the
    // caller passed null.
    expect(mocked.department.findUnique).not.toHaveBeenCalled();
    expect(mocked.accountDepartment.count).not.toHaveBeenCalled();
  });
});

describe("DIM-1 · dimensional-validation · fund policy matrix", () => {
  it("(7) Fund REQUIRED + missing fund → rejected", async () => {
    mockAccount({ fundPolicy: "REQUIRED" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "FUND_REQUIRED")).toBe(true);
    }
  });

  it("(8) Fund REQUIRED + valid AccountFund → accepted", async () => {
    mockAccount({ fundPolicy: "REQUIRED" });
    mockFund();
    mockFundApplicability(true);
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: FUND_A,
    });
    expect(result.ok).toBe(true);
  });

  it("(9) Fund supplied but not applicable to Account → rejected", async () => {
    mockAccount({ fundPolicy: "OPTIONAL" });
    mockFund();
    mockFundApplicability(false);
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: FUND_A,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "FUND_NOT_ALLOWED_ON_ACCOUNT")).toBe(true);
    }
  });

  it("(10) Fund OPTIONAL + null → accepted", async () => {
    mockAccount({ fundPolicy: "OPTIONAL" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("(11) Fund NOT_APPLICABLE + null → accepted", async () => {
    mockAccount({ fundPolicy: "NOT_APPLICABLE" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("(11b) Fund NOT_APPLICABLE + supplied → rejected", async () => {
    mockAccount({ fundPolicy: "NOT_APPLICABLE" });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: FUND_A,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "FUND_NOT_APPLICABLE")).toBe(true);
    }
  });
});

describe("DIM-1 · dimensional-validation · cross-tenant guards (Section 15 final case)", () => {
  it("no cross-tenant Account can validate", async () => {
    mockAccount({ clubId: CLUB_B }); // account belongs to another tenant
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("ACCOUNT_CROSS_TENANT");
    }
  });

  it("no cross-tenant AccountDepartment combination can validate", async () => {
    mockAccount({ clubId: CLUB_A });
    // Department belongs to different club.
    mocked.department.findUnique.mockResolvedValueOnce({
      id: DEPT_A, clubId: CLUB_B,
    });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: DEPT_A, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "DEPARTMENT_CROSS_TENANT")).toBe(true);
    }
  });

  it("no cross-tenant AccountFund combination can validate", async () => {
    mockAccount({ clubId: CLUB_A });
    mocked.fund.findUnique.mockResolvedValueOnce({
      id: FUND_A, clubId: CLUB_B, isActive: true,
    });
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: FUND_A,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "FUND_CROSS_TENANT")).toBe(true);
    }
  });

  it("unknown account → rejected with ACCOUNT_NOT_FOUND", async () => {
    mocked.account.findUnique.mockResolvedValueOnce(null);
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: "no_such_id",
      departmentId: null, fundId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("ACCOUNT_NOT_FOUND");
    }
  });
});

describe("DIM-1 · dimensional-validation · applicability semantics (empty applicability = unconstrained)", () => {
  it("Account with ZERO AccountDepartment rows accepts any valid department (unconstrained)", async () => {
    mockAccount({ departmentPolicy: "OPTIONAL" });
    mockDepartment();
    mockNoDeptApplicability();
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: DEPT_A, fundId: null,
    });
    expect(result.ok).toBe(true);
  });

  it("Account with ZERO AccountFund rows accepts any valid fund (unconstrained)", async () => {
    mockAccount({ fundPolicy: "OPTIONAL" });
    mockFund();
    mockNoFundApplicability();
    const result = await validateLineDimensions({
      clubId: CLUB_A, accountId: ACCT_A,
      departmentId: null, fundId: FUND_A,
    });
    expect(result.ok).toBe(true);
  });
});
