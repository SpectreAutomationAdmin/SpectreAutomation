// HR mobile-hotfix (2026-08-30) — §4 Approve & Activate wiring.
//
// Pins the source-level integration so a future refactor cannot
// silently unwire the admin action or leave the Employee Portal
// still saying "Your Club is reviewing your onboarding" after the
// admin has already approved + activated the record.
//
// Complements the behavioural suite (approve-activate-employee.test.ts)
// which exercises the service via Prisma.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR mobile-hotfix · §4 Approve & Activate — source wiring", () => {
  const service   = src("src/lib/hr/onboarding-approve-activate.ts");
  const action    = src("src/app/app/admin/people/employees/[id]/_approve-actions.ts");
  const component = src("src/components/hr/ApproveActivateEmployee.tsx");
  const page      = src("src/app/app/admin/people/employees/[id]/page.tsx");
  const view      = src("src/components/hr/EmployeeProfileView.tsx");
  const home      = src("src/app/employee/(authed)/page.tsx");

  it("service enforces BOTH hr:onboarding:approve AND hr:employee:write", () => {
    expect(service).toMatch(/requirePermission\([^)]+,\s*employee\.clubId,\s*"hr:onboarding:approve"\)/);
    expect(service).toMatch(/requirePermission\([^)]+,\s*employee\.clubId,\s*"hr:employee:write"\)/);
  });

  it("service composes transitionSession(SUBMITTED→APPROVED) with employeeLifecycle=ACTIVE", () => {
    expect(service).toMatch(/transitionSession\([\s\S]{0,80}"APPROVED"/);
    expect(service).toMatch(/employeeLifecycle:\s*"ACTIVE"/);
    expect(service).toMatch(/activatedAt:\s*now/);
    // Rejects non-SUBMITTED with the documented code.
    expect(service).toMatch(/HR_APPROVE_INVALID_STATE/);
  });

  it("service audits the compound action", () => {
    expect(service).toMatch(/action:\s*"hr\.employee\.approve\.activate"/);
  });

  it("readiness projection returns presence flags only — no plaintext SIN or bank digits", () => {
    // No SIN full-value select, no bank account plaintext / accountNumber select.
    expect(service).not.toMatch(/\bsin:\s*true\b/);
    expect(service).not.toMatch(/\baccountEnc:\s*true\b/);
    expect(service).not.toMatch(/\baccountNumber:\s*true\b/);
    expect(service).toMatch(/sinLastThree:\s*true/);
    // Bank readiness selects id + status only.
    expect(service).toMatch(/employeeBankAccount[\s\S]{0,200}select:\s*\{\s*id:\s*true,\s*status:\s*true/);
  });

  it("server action delegates to the service (no direct prisma writes)", () => {
    expect(action).toMatch(/^"use server";/m);
    expect(action).toMatch(/import\s*\{\s*approveAndActivateEmployee\s*\}/);
    expect(action).not.toMatch(/prisma\./);
    expect(action).toMatch(/revalidatePath\(`\/app\/admin\/people\/employees\//);
  });

  it("client component is presentation-only — never invokes prisma or the service directly", () => {
    expect(component).toMatch(/^"use client";/m);
    expect(component).not.toMatch(/from\s+"@\/lib\/prisma"/);
    expect(component).not.toMatch(/approveAndActivateEmployee\s*\(/);
    // Confirmation flow — no destructive one-tap approval.
    expect(component).toMatch(/data-testid="btn-approve-activate"/);
    expect(component).toMatch(/data-testid="btn-approve-activate-confirm"/);
  });

  it("Employee Profile page loads readiness + wires the section + the action", () => {
    expect(page).toMatch(/getOnboardingApprovalReadiness\(principal,\s*profile\.id\)/);
    expect(page).toMatch(/approvalSection=\{[\s\S]{0,400}approveAndActivateAction\.bind\(null,\s*profile\.id\)/);
  });

  it("EmployeeProfileView renders the approvalSection slot above lifecycleControls", () => {
    const idxApproval = view.indexOf("{approvalSection}");
    const idxLifecycle = view.indexOf("{lifecycleControls}");
    expect(idxApproval).toBeGreaterThan(-1);
    expect(idxLifecycle).toBeGreaterThan(idxApproval);
  });

  it("Home page 'Your Club is reviewing' banner suppresses when employeeLifecycle is ACTIVE", () => {
    // The banner reads `awaitingReview`, not raw sessionState.
    expect(home).toMatch(/awaitingReview\s*=\s*sessionState === "SUBMITTED"[\s\S]{0,80}employeeLifecycle\s*!==\s*"ACTIVE"/);
    expect(home).toMatch(/\{awaitingReview && \(/);
    // employeeLifecycle is now on the loaded employee row.
    expect(home).toMatch(/select:\s*\{[\s\S]{0,400}employeeLifecycle:\s*true/);
  });
});
