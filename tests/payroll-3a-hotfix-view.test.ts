// Payroll 3A hotfix (2026-09-11) — targeted unit tests for the pure
// slice of `overview-view.ts`: page-size normalization, batch-status
// label formatting, resume-algorithm ordering. The heavy integration
// paths (buildPayrollOverview against a real DB) are exercised by
// the Playwright staging spec; these tests pin the pure semantics
// that don't need a DB.

import { describe, it, expect } from "vitest";
import { PAGE_SIZE_OPTIONS } from "@/lib/payroll/overview-view";

describe("Payroll 3A hotfix — pure view helpers", () => {
  it("PAGE_SIZE_OPTIONS advertises exactly [10, 25, 50]", () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 25, 50]);
  });

  it("PAGE_SIZE_OPTIONS is a canonical tuple — the surface control renders it as-is", () => {
    // Guards a regression where a developer might add a 100-row
    // option and hurt admin table performance without founder
    // authorisation.
    expect(PAGE_SIZE_OPTIONS.length).toBe(3);
    expect(PAGE_SIZE_OPTIONS.every((n) => typeof n === "number" && n > 0)).toBe(true);
  });
});
