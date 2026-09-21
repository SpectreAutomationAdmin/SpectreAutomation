// FPP-7 (2026-09-21) — Segregation-of-duties permission contract.
//
// Pins the club-role grants that make Chris (Controller) and Marc
// (Payroll Admin) genuinely distinct principals in staging.
//
//   CHRIS (CONTROLLER):
//     ✓ payroll:read · payroll:approve · payroll:return
//     ✗ payroll:post · payroll:submit · payroll:prepare · payroll:edit · payroll:void
//
//   MARC (PAYROLL_ADMIN):
//     ✓ payroll:read · payroll:prepare · payroll:edit · payroll:submit · payroll:post
//     ✗ payroll:approve · payroll:return
//
// The RBAC layer resolves permissions ONLY from `UserClubRole` rows
// (see src/lib/rbac.ts:hasPermission). Neither the top-level
// User.role field nor the employee↔user linkage grant permissions.

import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { hasPermission, type Principal } from "@/lib/rbac";

const CLUB_ID = "cmrvdeny7000144372ktmmg9c";

function principalFor(userId: string, roleKey: keyof typeof ROLE_PERMISSIONS): Principal {
  return {
    id: userId,
    memberships: [{ clubId: CLUB_ID, roleKey }],
  } as unknown as Principal;
}

describe("FPP-7 — Chris (Controller) permissions", () => {
  const chris = principalFor("cmrvdenz700034437agp7gqs5", "CONTROLLER");

  it("has payroll:read", () => { expect(hasPermission(chris, CLUB_ID, "payroll:read")).toBe(true); });
  it("has payroll:approve", () => { expect(hasPermission(chris, CLUB_ID, "payroll:approve")).toBe(true); });
  it("has payroll:return", () => { expect(hasPermission(chris, CLUB_ID, "payroll:return")).toBe(true); });

  it("does NOT have payroll:post", () => { expect(hasPermission(chris, CLUB_ID, "payroll:post")).toBe(false); });
  it("does NOT have payroll:submit", () => { expect(hasPermission(chris, CLUB_ID, "payroll:submit")).toBe(false); });
  it("does NOT have payroll:prepare", () => { expect(hasPermission(chris, CLUB_ID, "payroll:prepare")).toBe(false); });
  it("does NOT have payroll:edit", () => { expect(hasPermission(chris, CLUB_ID, "payroll:edit")).toBe(false); });
  it("does NOT have payroll:void", () => { expect(hasPermission(chris, CLUB_ID, "payroll:void")).toBe(false); });
});

describe("FPP-7 — Marc (Payroll Admin) permissions", () => {
  const marc = principalFor("cmu0r9isy003i3v4yudyxpyn7", "PAYROLL_ADMIN");

  it("has payroll:read", () => { expect(hasPermission(marc, CLUB_ID, "payroll:read")).toBe(true); });
  it("has payroll:prepare", () => { expect(hasPermission(marc, CLUB_ID, "payroll:prepare")).toBe(true); });
  it("has payroll:edit", () => { expect(hasPermission(marc, CLUB_ID, "payroll:edit")).toBe(true); });
  it("has payroll:submit", () => { expect(hasPermission(marc, CLUB_ID, "payroll:submit")).toBe(true); });
  it("has payroll:post", () => { expect(hasPermission(marc, CLUB_ID, "payroll:post")).toBe(true); });

  it("does NOT have payroll:approve", () => { expect(hasPermission(marc, CLUB_ID, "payroll:approve")).toBe(false); });
  it("does NOT have payroll:return", () => { expect(hasPermission(marc, CLUB_ID, "payroll:return")).toBe(false); });
});

describe("FPP-7 — CONTROLLER + PAYROLL_ADMIN grants align with pre-Phase-5 restoration", () => {
  it("CONTROLLER holds payroll:approve + payroll:return but NOT payroll:post", () => {
    const grants = ROLE_PERMISSIONS.CONTROLLER;
    expect(grants).toContain("payroll:approve");
    expect(grants).toContain("payroll:return");
    expect(grants).not.toContain("payroll:post");
    expect(grants).not.toContain("payroll:submit");
  });
  it("PAYROLL_ADMIN holds submit + post but NOT approve", () => {
    const grants = ROLE_PERMISSIONS.PAYROLL_ADMIN;
    expect(grants).toContain("payroll:submit");
    expect(grants).toContain("payroll:post");
    expect(grants).not.toContain("payroll:approve");
    expect(grants).not.toContain("payroll:return");
  });
});
