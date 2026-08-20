// HR-2B.5 §11-15 — Source-contract regression for compensation UI on Add Employee.
//
// UI-level render tests need an admin login + Playwright; here we pin the
// source shape so the compensation section can't be silently removed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.5 · AddEmployeeForm compensation section", () => {
  const form = src("src/app/app/admin/people/employees/new/AddEmployeeForm.tsx");
  const page = src("src/app/app/admin/people/employees/new/page.tsx");
  const route = src("src/app/api/people/employees/route.ts");

  it("form exposes canSetCompensation prop", () => {
    expect(form).toMatch(/canSetCompensation\?:\s*boolean/);
  });

  it("form gates compensation section on canSetCompensation", () => {
    expect(form).toMatch(/\{canSetCompensation && \(/);
    expect(form).toMatch(/data-testid="compensation-section"/);
  });

  it("form offers only Hourly + Salary cadences (no COMMISSION / PIECE_RATE)", () => {
    expect(form).toMatch(/HOURLY.*Hourly/);
    expect(form).toMatch(/SALARY.*Salary/);
    expect(form).not.toMatch(/COMMISSION/);
    expect(form).not.toMatch(/PIECE_RATE/);
  });

  it("form has cadence-aware label + placeholder (hourly rate vs annual salary)", () => {
    expect(form).toMatch(/Hourly rate.*Annual salary/s);
    expect(form).toMatch(/\/ hour.*\/ year/s);
  });

  it("page threads hr:compensation:write permission into canSetCompensation", () => {
    expect(page).toMatch(/canSetCompensation=\{hasPermission\(principal, clubId, "hr:compensation:write"\)\}/);
  });

  it("route validates cadence enum + positive amount + permission before calling changeCompensation", () => {
    expect(route).toMatch(/changeCompensation/);
    expect(route).toMatch(/compensationCadence.*HOURLY.*SALARY/s);
    expect(route).toMatch(/compensationAmount.*positive/);
    expect(route).toMatch(/hasPermission\(principal, clubId, "hr:compensation:write"\)/);
  });

  it("route calls changeCompensation with effectiveFrom = expectedStartDate", () => {
    expect(route).toMatch(/changeCompensation\(principal, employee\.id, \{[\s\S]*effectiveFrom: expectedStartDate/);
  });
});
