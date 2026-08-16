// HR-1 cross-cutting drift-detection · RBAC role catalogue snapshot.
//
// Pins the exact `hr:*` grants per role. Accidental widening (a role
// gains a reveal-tier grant) or narrowing (a role loses a read grant
// its UI depends on) fails this test with a diff-friendly output.
//
// This test does NOT enumerate the full SUPER_ADMIN grant set (that
// would be brittle — SUPER_ADMIN legitimately receives every new
// permission the moment it lands in the catalogue). Instead we assert
// SUPER_ADMIN's HR count equals the total number of HR keys in the
// permission catalogue.
//
// For every OTHER role we snapshot the exact expected `hr:*` set as
// a sorted array. Any drift is surfaced as a Vitest deep-equality
// diff.

import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type PermissionKey,
  type RoleKey,
} from "@/lib/permissions";

const HR_PREFIX = "hr:";

function hrKeysOfRole(role: RoleKey): string[] {
  return [...(ROLE_PERMISSIONS[role] as PermissionKey[])]
    .filter((k) => (k as string).startsWith(HR_PREFIX))
    .sort();
}

function allHrKeys(): string[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[])
    .filter((k) => (k as string).startsWith(HR_PREFIX))
    .sort();
}

describe("HR-1 cross-cutting · ROLE_PERMISSIONS `hr:*` grants — pinned", () => {
  it("SUPER_ADMIN holds every hr:* key in the catalogue", () => {
    const expected = allHrKeys();
    const actual = hrKeysOfRole("SUPER_ADMIN");
    expect(actual).toEqual(expected);
  });

  it("CLUB_ADMIN holds every hr:* key EXCEPT the three reveal-tier keys", () => {
    const expected = allHrKeys().filter((k) => k !== "hr:sin:reveal"
      && k !== "hr:banking:reveal"
      && k !== "hr:tax:reveal");
    const actual = hrKeysOfRole("CLUB_ADMIN");
    expect(actual).toEqual(expected);
    // Explicit negative assertions for readability of the failure.
    expect(actual).not.toContain("hr:sin:reveal");
    expect(actual).not.toContain("hr:banking:reveal");
    expect(actual).not.toContain("hr:tax:reveal");
  });

  it("GENERAL_MANAGER holds only the read-plus-onboarding-approve subset", () => {
    const expected = [
      "hr:compensation:read",
      "hr:credentials:read",
      "hr:directory:view",
      "hr:documents:read",
      "hr:emergency:read",
      "hr:employee:read",
      "hr:employment:read",
      "hr:onboarding:approve",
      "hr:onboarding:read",
    ].sort();
    const actual = hrKeysOfRole("GENERAL_MANAGER");
    expect(actual).toEqual(expected);
  });

  it("PAYROLL_ADMIN holds the reveal-tier + compensation/payroll_profile write bundle", () => {
    // Reveal-tier: sin/banking/tax reveal. Full write for
    // compensation, payroll_profile, banking. Read + sensitive
    // documents. Directory/employee/employment read (no employee
    // write — HR write of employee records is CLUB_ADMIN's).
    const expected = [
      "hr:banking:approve",
      "hr:banking:read",
      "hr:banking:reveal",
      "hr:banking:write",
      "hr:compensation:approve",
      "hr:compensation:read",
      "hr:compensation:write",
      "hr:directory:view",
      "hr:documents:read",
      "hr:employee:read",
      "hr:employment:read",
      "hr:payroll_profile:activate",
      "hr:payroll_profile:read",
      "hr:payroll_profile:write",
      "hr:sensitive:read",
      "hr:sin:read",
      "hr:sin:reveal",
      "hr:sin:write",
      "hr:tax:read",
      "hr:tax:reveal",
      "hr:tax:write",
    ].sort();
    const actual = hrKeysOfRole("PAYROLL_ADMIN");
    expect(actual).toEqual(expected);
  });

  it("CONTROLLER holds only the finance-relevant HR reads — never reveal, never write", () => {
    const expected = [
      "hr:compensation:read",
      "hr:directory:view",
      "hr:documents:read",
      "hr:employee:read",
      "hr:onboarding:approve",
      "hr:onboarding:read",
    ].sort();
    const actual = hrKeysOfRole("CONTROLLER");
    expect(actual).toEqual(expected);
    // Reveal / write / approve of sensitive tiers explicitly disallowed.
    for (const banned of [
      "hr:sin:read",
      "hr:sin:reveal",
      "hr:sin:write",
      "hr:banking:read",
      "hr:banking:reveal",
      "hr:banking:write",
      "hr:banking:approve",
      "hr:tax:read",
      "hr:tax:reveal",
      "hr:tax:write",
      "hr:compensation:write",
      "hr:payroll_profile:activate",
    ]) {
      expect(actual).not.toContain(banned);
    }
  });

  it("AUDITOR_READ_ONLY holds every hr:*:read (+ hr:sensitive:read + hr:directory:view) and NOTHING mutating", () => {
    const actual = hrKeysOfRole("AUDITOR_READ_ONLY");
    // Must include every hr:*:read key in the catalogue + hr:sensitive:read + hr:directory:view.
    const requiredReads = allHrKeys().filter((k) => k.endsWith(":read") || k === "hr:sensitive:read" || k === "hr:directory:view");
    for (const key of requiredReads) {
      expect(
        actual,
        `AUDITOR_READ_ONLY must hold ${key} for statutory audit access`,
      ).toContain(key);
    }
    // And NOTHING that mutates or reveals. The audit role is
    // deliberately read-only.
    for (const key of actual) {
      expect(
        key.endsWith(":reveal") ||
          key.endsWith(":write") ||
          key.endsWith(":approve") ||
          key.endsWith(":activate") ||
          key.endsWith(":terminate") ||
          key.endsWith(":invite") ||
          key.endsWith(":revoke"),
        `AUDITOR_READ_ONLY unexpectedly holds mutating/reveal grant ${key}`,
      ).toBe(false);
    }
  });

  it("STAFF holds no hr:* grants", () => {
    expect(hrKeysOfRole("STAFF")).toEqual([]);
  });

  it("MEMBER holds no hr:* grants", () => {
    expect(hrKeysOfRole("MEMBER")).toEqual([]);
  });

  it("BOARD_READ_ONLY holds no hr:* grants", () => {
    expect(hrKeysOfRole("BOARD_READ_ONLY")).toEqual([]);
  });

  it("no role except SUPER_ADMIN and PAYROLL_ADMIN carries hr:sin:reveal", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
    const carriers = roles.filter((r) => (ROLE_PERMISSIONS[r] as string[]).includes("hr:sin:reveal"));
    expect(carriers.sort()).toEqual(["PAYROLL_ADMIN", "SUPER_ADMIN"].sort());
  });

  it("no role except SUPER_ADMIN and PAYROLL_ADMIN carries hr:banking:reveal", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
    const carriers = roles.filter((r) => (ROLE_PERMISSIONS[r] as string[]).includes("hr:banking:reveal"));
    expect(carriers.sort()).toEqual(["PAYROLL_ADMIN", "SUPER_ADMIN"].sort());
  });

  it("no role except SUPER_ADMIN and PAYROLL_ADMIN carries hr:tax:reveal", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
    const carriers = roles.filter((r) => (ROLE_PERMISSIONS[r] as string[]).includes("hr:tax:reveal"));
    expect(carriers.sort()).toEqual(["PAYROLL_ADMIN", "SUPER_ADMIN"].sort());
  });

  it("hr:employee:terminate is held ONLY by roles authorised to fire an employee", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
    const carriers = roles.filter((r) => (ROLE_PERMISSIONS[r] as string[]).includes("hr:employee:terminate"));
    // CLUB_ADMIN (HR ownership) and SUPER_ADMIN. GM does NOT terminate.
    expect(carriers.sort()).toEqual(["CLUB_ADMIN", "SUPER_ADMIN"].sort());
  });
});
