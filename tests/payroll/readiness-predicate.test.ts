// Payroll MVP posting hotfix (2026-09-07) — unit tests for the
// time-approval readiness predicate that gates the Prepare button
// on the Payroll Processing page.

import { describe, it, expect } from "vitest";
import {
  evaluateTimeApprovalReadiness,
  type DepartmentApprovalRow,
} from "@/lib/payroll/readiness-predicate";

const row = (id: string, state: DepartmentApprovalRow["state"]): DepartmentApprovalRow =>
  ({ departmentId: id, state });

describe("evaluateTimeApprovalReadiness", () => {
  it("salary-only — 0 required departments → READY", () => {
    const r = evaluateTimeApprovalReadiness([]);
    expect(r.requiredCount).toBe(0);
    expect(r.approvedCount).toBe(0);
    expect(r.salaryOnly).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("no payable hourly time (0 required) → READY", () => {
    // Structural equivalent of salary-only: no department needs an
    // approval because none has payable time. Same READY decision.
    const r = evaluateTimeApprovalReadiness([]);
    expect(r.ready).toBe(true);
  });

  it("one department, PENDING → BLOCKED 0/1", () => {
    const r = evaluateTimeApprovalReadiness([row("d1", "PENDING")]);
    expect(r.requiredCount).toBe(1);
    expect(r.approvedCount).toBe(0);
    expect(r.salaryOnly).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["d1"]);
  });

  it("one department, APPROVED → READY 1/1", () => {
    const r = evaluateTimeApprovalReadiness([row("d1", "APPROVED")]);
    expect(r.requiredCount).toBe(1);
    expect(r.approvedCount).toBe(1);
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("mixed batch — 2 required, 1 approved → BLOCKED 1/2 with the pending listed", () => {
    const r = evaluateTimeApprovalReadiness([
      row("grounds", "APPROVED"),
      row("food-bev", "PENDING"),
    ]);
    expect(r.requiredCount).toBe(2);
    expect(r.approvedCount).toBe(1);
    expect(r.salaryOnly).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["food-bev"]);
  });

  it("mixed batch — REOPENED counts as not-approved", () => {
    const r = evaluateTimeApprovalReadiness([
      row("grounds", "APPROVED"),
      row("food-bev", "REOPENED"),
    ]);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["food-bev"]);
  });

  it("all approved with N > 1 → READY N/N", () => {
    const r = evaluateTimeApprovalReadiness([
      row("grounds", "APPROVED"),
      row("food-bev", "APPROVED"),
      row("pro-shop", "APPROVED"),
    ]);
    expect(r.requiredCount).toBe(3);
    expect(r.approvedCount).toBe(3);
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });
});
