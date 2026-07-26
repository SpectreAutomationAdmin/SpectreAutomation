// COA mapping taxonomy — FS Groups vs Departments.
//
// Founder spec 2026-07-02: the FS Group dropdown was leaking
// department labels (Food & Beverage, Pro Shop, Clubhouse, Golf
// Operations, Course & Grounds, Administration). The fix:
//
//   • Strip department labels from DEFAULT_FS_GROUPS.
//   • Replace with PRESENTATION buckets (Wages and Benefits,
//     Repairs and Maintenance, Utilities, etc.) that can span
//     multiple departments.
//   • Track retired keys (RETIRED_FS_GROUP_KEYS) so the migration
//     can drop them deterministically and tests can guard against
//     accidental re-introduction.
//
// These tests assert the contract at the source — the seed
// template — so the dropdown rendered by CoaMappingTable.tsx
// inherits a clean taxonomy.

import { describe, it, expect } from "vitest";

import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_FS_GROUPS,
  DEFAULT_DEPARTMENTS,
  DEFAULT_ACCOUNTS,
  RETIRED_FS_GROUP_KEYS,
  RETIRED_DEPARTMENT_CODES,
  DEPARTMENT_CODE_ALIASES,
} from "@/lib/accounting/coa-template";
import { resolveCoaRow } from "@/lib/imports/coa-mapping";

const DEPARTMENT_LABELS = new Set([
  "Food & Beverage",
  "Pro Shop",
  "Clubhouse",
  "Golf Operations",
  "Course & Grounds",
  "Administration",
]);

describe("DEFAULT_FS_GROUPS — no department labels leak into the FS Group dropdown", () => {
  it("contains zero entries whose name matches a department label", () => {
    const leaks = DEFAULT_FS_GROUPS.filter((g) => DEPARTMENT_LABELS.has(g.name));
    expect(leaks).toEqual([]);
  });

  it("contains zero duplicate names across INCOME_STATEMENT (one bucket per presentation line)", () => {
    const incomeStatementNames = DEFAULT_FS_GROUPS
      .filter((g) => g.statement === "INCOME_STATEMENT")
      .map((g) => g.name);
    const unique = new Set(incomeStatementNames);
    expect(unique.size).toBe(incomeStatementNames.length);
  });

  it("INCOME_STATEMENT contains the founder's canonical presentation buckets", () => {
    // Founder rule 2026-07-19: the canonical income-statement
    // taxonomy expanded from a handful of legacy buckets to the
    // full 18-revenue / 29-expense permanent framework. The
    // assertion below pins the FULL canonical name set so a
    // future drift surfaces immediately.
    const incomeStatementNames = new Set(
      DEFAULT_FS_GROUPS
        .filter((g) => g.statement === "INCOME_STATEMENT")
        .map((g) => g.name),
    );
    for (const expected of [
      // Revenue (18)
      "Membership Dues",
      "Annual Fees",
      "Entrance Fees",
      "Capital Assessments",
      "Green Fees",
      "Cart Revenue",
      "Driving Range Revenue",
      "Golf Lessons",
      "Tournament Revenue",
      "Pro Shop Merchandise",
      "Food Sales",
      "Beverage Sales",
      "Catering Revenue",
      "Event Revenue",
      "Facility Rentals",
      "Interest Income",
      "Gain/Loss on Asset Disposal",
      "Other Revenue",
      // Expenses (28) — IS_EMPLOYEE_BENEFITS consolidated into
      // the renamed IS_PAYROLL ("Salaries and Benefits") in v11.
      "Salaries and Benefits",
      "Cost of Merchandise Sold",
      "Cost of Food Sold",
      "Cost of Beverage Sold",
      "Utilities",
      "Repairs & Maintenance",
      "Property Tax Expense",
      "Income Tax Expense",
      "Insurance",
      "Office Supplies",
      "Professional Fees",
      "IT & Software",
      "Telephone & Internet",
      "Bank Charges",
      "Merchant Fees",
      "Vehicle & Equipment",
      "Small Tools",
      "Janitorial Supplies",
      "Cleaning Services",
      "Security",
      "Staff Training",
      "Marketing & Advertising",
      "Travel & Meals",
      "Memberships & Subscriptions",
      "Licences & Permits",
      "Depreciation & Amortization",
      "Interest Expense",
      "Other Expenses",
    ]) {
      expect(incomeStatementNames.has(expected)).toBe(true);
    }
  });

  it("removes all retired keys (none appear in the current DEFAULT_FS_GROUPS)", () => {
    const currentKeys = new Set(DEFAULT_FS_GROUPS.map((g) => g.key));
    for (const retired of RETIRED_FS_GROUP_KEYS) {
      expect(currentKeys.has(retired)).toBe(false);
    }
  });

  it("balance sheet + cash flow taxonomies match the canonical framework (no department leak in those statements either)", () => {
    // Founder rule 2026-07-19: the BS taxonomy was rebuilt around
    // the permanent FS Group keys (Cash & Cash Equivalents,
    // Capital Assets, etc.). The legacy aggregate names ("Current
    // Assets", "Property & Equipment", "Equity") are no longer
    // FS Group names — they live on the Category axis now.
    const balanceSheetNames = DEFAULT_FS_GROUPS
      .filter((g) => g.statement === "BALANCE_SHEET")
      .map((g) => g.name);
    expect(balanceSheetNames).toContain("Cash & Cash Equivalents");
    expect(balanceSheetNames).toContain("Capital Assets");
    expect(balanceSheetNames).toContain("Accounts Payable");
    expect(balanceSheetNames).toContain("Retained Earnings");

    const cashFlowNames = DEFAULT_FS_GROUPS
      .filter((g) => g.statement === "CASH_FLOW")
      .map((g) => g.name);
    expect(cashFlowNames).toEqual([
      "Operating Activities",
      "Investing Activities",
      "Financing Activities",
    ]);
  });
});

describe("Department taxonomy — founder spec 2026-07-02 cleanup", () => {
  it("DEFAULT_DEPARTMENTS contains exactly the 6 founder-canonical codes", () => {
    const codes = DEFAULT_DEPARTMENTS.map((d) => d.code).sort();
    expect(codes).toEqual(["ADMIN", "CLUBHOUSE", "EVENTS", "F&B", "GROUNDS", "PROSHOP"]);
  });

  it("retired codes (GOLF, COURSE, FB) no longer appear in DEFAULT_DEPARTMENTS", () => {
    const codes = new Set(DEFAULT_DEPARTMENTS.map((d) => d.code));
    expect(codes.has("GOLF")).toBe(false);
    expect(codes.has("COURSE")).toBe(false);
    expect(codes.has("FB")).toBe(false);
  });

  it("alias map preserves the rename + merge contract for the migration", () => {
    expect(RETIRED_DEPARTMENT_CODES).toEqual(["GOLF", "COURSE", "FB"]);
    expect(DEPARTMENT_CODE_ALIASES).toEqual({
      GOLF: "PROSHOP",
      COURSE: "GROUNDS",
      FB: "F&B",
    });
  });

  it("DEFAULT_ACCOUNTS use only NON-RETIRED department codes", () => {
    const liveCodes = new Set(DEFAULT_DEPARTMENTS.map((d) => d.code));
    for (const acct of DEFAULT_ACCOUNTS) {
      if (!acct.defaultDepartmentCode) continue;
      expect(liveCodes.has(acct.defaultDepartmentCode)).toBe(true);
      expect(RETIRED_DEPARTMENT_CODES).not.toContain(
        acct.defaultDepartmentCode,
      );
    }
  });

  it("display names match the canonical Department taxonomy (founder rule 2026-07-19)", () => {
    const byCode = new Map(DEFAULT_DEPARTMENTS.map((d) => [d.code, d.name]));
    expect(byCode.get("PROSHOP")).toBe("Pro Shop");
    expect(byCode.get("F&B")).toBe("Food & Beverage");
    expect(byCode.get("GROUNDS")).toBe("Grounds");
    expect(byCode.get("CLUBHOUSE")).toBe("Clubhouse");
    expect(byCode.get("ADMIN")).toBe("Administration");
    expect(byCode.get("EVENTS")).toBe("Events");
  });
});

describe("COA Mapping table — department selector is a searchable multi-select dropdown", () => {
  // Founder spec 2026-07-03 elevated the prior local
  // `DepartmentMultiSelect` to the shared `SearchablePicker` (multi
  // mode). The assertions here continue to guard the founder's
  // ORIGINAL "no pill buttons" contract from 2026-07-02 against the
  // new picker source.
  const TABLE = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/imports/[id]/CoaMappingTable.tsx",
    ),
    "utf8",
  );
  const PICKER = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/SearchablePicker.tsx"),
    "utf8",
  );

  it("renders SearchablePicker in multi mode for departments (not the legacy DepartmentMultiSelect or pill buttons)", () => {
    expect(TABLE).toContain('import { SearchablePicker');
    expect(TABLE).not.toContain('function DepartmentMultiSelect');
    // Pill-button per-code testid markup is gone.
    const codeOnly = TABLE
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/coa-row-\$\{row\.number\}-dept-\$\{d\.code\}/);
    expect(codeOnly).not.toMatch(/coa-bulk-dept-\$\{d\.code\}/);
    // The picker mounts for both row + bulk department slots.
    expect(TABLE).toMatch(/<SearchablePicker\s+multi[\s\S]+?testid="coa-bulk-dept"/);
    expect(TABLE).toMatch(/<SearchablePicker\s+multi[\s\S]+?testid=\{`coa-row-\$\{row\.number\}-dept`\}/);
  });

  it("picker carries the right ARIA + multi-select semantics", () => {
    expect(PICKER).toMatch(/aria-haspopup="listbox"/);
    expect(PICKER).toMatch(/aria-expanded=\{open\}/);
    expect(PICKER).toMatch(/role="listbox"/);
    expect(PICKER).toMatch(/aria-multiselectable=\{props\.multi \? "true" : undefined\}/);
    expect(PICKER).toMatch(/type="checkbox"/);
  });

  it("closed-state trigger joins selected labels with comma (no department-code pills inline)", () => {
    expect(PICKER).toMatch(/codes\.map\(\(o\) => o\.label\)\.join\(", "\)/);
  });

  it("picker handles outside-click + Escape + keyboard open (Enter/Space/ArrowDown)", () => {
    expect(PICKER).toMatch(/document\.addEventListener\("mousedown"/);
    expect(PICKER).toMatch(/e\.key === "Escape"/);
    expect(PICKER).toMatch(/e\.key === "ArrowDown" \|\| e\.key === "Enter" \|\| e\.key === " "/);
  });

  it("bulk department control is the same multi-mode picker as the row control (single source)", () => {
    expect(TABLE).toMatch(
      /<SearchablePicker\s+multi[\s\S]+?testid="coa-bulk-dept"/,
    );
    // Per-field Apply button is gone — replaced by the single
    // Apply All in the bulk bar (covered by the UX suite).
    expect(TABLE).not.toMatch(/data-testid="coa-bulk-dept-apply"/);
  });

  it("read-only mode disables the picker without showing a popover", () => {
    expect(PICKER).toMatch(/disabled=\{disabled\}/);
    expect(PICKER).toMatch(/open && !disabled/);
  });
});

describe("Multi-department validation still works with the new codes", () => {
  // Founder example, adapted to the new code list: one R&M account
  // assigned to ADMIN + GROUNDS + F&B + PROSHOP + EVENTS.
  const options = {
    types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
    categories: [
      { id: "cat-1", key: "OPERATING_EXPENSES", name: "Operating Expenses", accountType: "EXPENSE" as const },
    ],
    fsGroups: [
      { id: "fsg-1", key: "IS_OPEX_RM", name: "Repairs and Maintenance", statement: "INCOME_STATEMENT" },
    ],
    departments: [
      { id: "d-admin",    code: "ADMIN",    name: "Admin" },
      { id: "d-grounds",  code: "GROUNDS",  name: "Grounds" },
      { id: "d-fb",       code: "F&B",      name: "F&B" },
      { id: "d-proshop",  code: "PROSHOP",  name: "Pro Shop" },
      { id: "d-events",   code: "EVENTS",   name: "Events" },
    ],
  };

  it("accepts an account mapped to five departments using the new codes", () => {
    const result = resolveCoaRow(
      {
        number: "6700",
        name: "General Repairs and Maintenance",
        type: "EXPENSE",
        categoryKey: "OPERATING_EXPENSES",
        fsGroupKey: "IS_OPEX_RM",
        departmentCodes: ["ADMIN", "GROUNDS", "F&B", "PROSHOP", "EVENTS"],
      },
      options,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.departmentCodes.sort()).toEqual([
        "ADMIN",
        "EVENTS",
        "F&B",
        "GROUNDS",
        "PROSHOP",
      ]);
    }
  });

  it("rejects an account referencing a RETIRED code (GOLF/COURSE/FB) — the migration should have remapped these client-side", () => {
    for (const oldCode of ["GOLF", "COURSE", "FB"] as const) {
      const result = resolveCoaRow(
        {
          number: "6701",
          name: "Test account",
          type: "EXPENSE",
          categoryKey: "OPERATING_EXPENSES",
          fsGroupKey: "IS_OPEX_RM",
          departmentCodes: [oldCode],
        },
        options,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].code).toBe("UNKNOWN_DEPARTMENT");
      }
    }
  });
});

describe("DEFAULT_ACCOUNTS use only NON-RETIRED FS group keys", () => {
  it("every fsGroupKey on every default account is a current canonical key", () => {
    const currentKeys = new Set(DEFAULT_FS_GROUPS.map((g) => g.key));
    const retiredSet = new Set<string>(RETIRED_FS_GROUP_KEYS);
    for (const acct of DEFAULT_ACCOUNTS) {
      if (!acct.fsGroupKey) continue;
      expect(retiredSet.has(acct.fsGroupKey)).toBe(false);
      expect(currentKeys.has(acct.fsGroupKey)).toBe(true);
    }
  });

  it("the same presentation bucket is reused across multiple departments (founder's cross-department contract)", () => {
    // Payroll (canonical IS_PAYROLL — formerly IS_OPEX_WAGES) is
    // the canonical example: every department's payroll account
    // rolls up to it.
    const wages = DEFAULT_ACCOUNTS.filter((a) => a.fsGroupKey === "IS_PAYROLL");
    const wagesDepts = new Set(wages.map((a) => a.defaultDepartmentCode).filter(Boolean));
    expect(wagesDepts.size).toBeGreaterThanOrEqual(4);
    // Department codes were renamed in the 2026-07-02 cleanup.
    expect(wagesDepts.has("GROUNDS")).toBe(true);     // was COURSE
    expect(wagesDepts.has("PROSHOP")).toBe(true);
    expect(wagesDepts.has("F&B")).toBe(true);          // was FB
    expect(wagesDepts.has("ADMIN")).toBe(true);

    // COGS was split into three buckets in the 2026-07-19
    // canonical rewrite. F&B accounts roll up to IS_COGS_FOOD;
    // Pro Shop accounts roll up to IS_COGS_MERCHANDISE. Both
    // buckets still ladder under the same COST_OF_SALES Category.
    const cogsFood = DEFAULT_ACCOUNTS.filter((a) => a.fsGroupKey === "IS_COGS_FOOD");
    const cogsMerch = DEFAULT_ACCOUNTS.filter((a) => a.fsGroupKey === "IS_COGS_MERCHANDISE");
    const cogsFoodDepts = new Set(cogsFood.map((a) => a.defaultDepartmentCode).filter(Boolean));
    const cogsMerchDepts = new Set(cogsMerch.map((a) => a.defaultDepartmentCode).filter(Boolean));
    expect(cogsFoodDepts.has("F&B")).toBe(true);
    expect(cogsMerchDepts.has("PROSHOP")).toBe(true);
  });
});

describe("resolveCoaRow accepts one FS Group across multiple Departments", () => {
  // Simulates the founder's example:
  //   Account: Repairs and Maintenance
  //   FS Group: Repairs and Maintenance (IS_OPEX_RM)
  //   Departments: ADMIN + GOLF + COURSE + FB + PROSHOP
  const options = {
    types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
    categories: [
      { id: "cat-1", key: "OPERATING_EXPENSES", name: "Operating Expenses", accountType: "EXPENSE" as const },
    ],
    fsGroups: [
      { id: "fsg-1", key: "IS_OPEX_RM", name: "Repairs and Maintenance", statement: "INCOME_STATEMENT" },
    ],
    departments: [
      { id: "d-admin",   code: "ADMIN",   name: "Administration" },
      { id: "d-golf",    code: "GOLF",    name: "Golf Operations" },
      { id: "d-course",  code: "COURSE",  name: "Course & Grounds" },
      { id: "d-fb",      code: "FB",      name: "Food & Beverage" },
      { id: "d-proshop", code: "PROSHOP", name: "Pro Shop" },
    ],
  };

  it("validates a single account mapped to one FS group + five departments", () => {
    const result = resolveCoaRow(
      {
        number: "6700",
        name: "General Repairs and Maintenance",
        type: "EXPENSE",
        categoryKey: "OPERATING_EXPENSES",
        fsGroupKey: "IS_OPEX_RM",
        departmentCodes: ["ADMIN", "GOLF", "COURSE", "FB", "PROSHOP"],
      },
      options,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.fsGroupKey).toBe("IS_OPEX_RM");
      expect(result.resolved.departmentCodes.sort()).toEqual([
        "ADMIN", "COURSE", "FB", "GOLF", "PROSHOP",
      ]);
      // No duplicate department ids in the resolved bundle.
      expect(new Set(result.resolved.departmentIds).size).toBe(result.resolved.departmentIds.length);
    }
  });
});
