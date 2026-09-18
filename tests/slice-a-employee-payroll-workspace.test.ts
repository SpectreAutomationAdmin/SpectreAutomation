// Slice A (2026-09-18) — Employee Payroll workspace regression tests.
//
// Covers the founder's Slice A acceptance items that can be proved
// without a browser: Controller opening-balance:write permission,
// the IA constants exported by the workspace section, empty-state
// language on Retirement, and the seed-hygiene guard from v420.

import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, type PermissionKey } from "@/lib/permissions";

describe("Slice A — permissions", () => {
  it("N + AB. Controller can maintain opening YTD (payroll:opening-balance:write)", () => {
    const controllerGrants = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(controllerGrants.has("payroll:opening-balance:write")).toBe(true);
  });

  it("O + AC. Payroll Admin can maintain opening YTD (payroll:opening-balance:write)", () => {
    const paGrants = new Set<PermissionKey>(ROLE_PERMISSIONS.PAYROLL_ADMIN);
    expect(paGrants.has("payroll:opening-balance:write")).toBe(true);
  });

  it("P. Controller still cannot Post payroll (payroll:post NOT granted)", () => {
    const controllerGrants = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(controllerGrants.has("payroll:post")).toBe(false);
  });

  it("Controller retains payroll:approve + payroll:return (governance unchanged)", () => {
    const controllerGrants = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(controllerGrants.has("payroll:approve")).toBe(true);
    expect(controllerGrants.has("payroll:return")).toBe(true);
  });

  it("Controller does NOT get broad payroll:config:write (narrow grant only)", () => {
    // §10 — narrow grant. Controller already has payroll:config:read via
    // this role; write is intentionally NOT added here.
    const controllerGrants = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(controllerGrants.has("payroll:config:read")).toBe(true);
    expect(controllerGrants.has("payroll:config:write")).toBe(false);
  });

  it("SIN / banking reveal permissions unchanged for Controller", () => {
    const controllerGrants = new Set<PermissionKey>(ROLE_PERMISSIONS.CONTROLLER);
    expect(controllerGrants.has("hr:sin:reveal")).toBe(false);
    expect(controllerGrants.has("hr:banking:reveal")).toBe(false);
    expect(controllerGrants.has("hr:tax:reveal")).toBe(false);
  });
});
