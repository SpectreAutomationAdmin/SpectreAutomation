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

  it("GENERAL_MANAGER holds the read-plus-onboarding-approve subset + HR-2C training read/assign/compliance + AUTH-3D.RBAC hr:employee:security", () => {
    const expected = [
      "hr:compensation:read",
      "hr:credentials:read",
      "hr:directory:view",
      "hr:documents:read",
      "hr:emergency:read",
      "hr:employee:read",
      // AUTH-3D.RBAC.FIX — account-security tier: sign employee out on
      // all devices + issue password reset. Does NOT include
      // hr:employee:write or hr:employee:terminate.
      "hr:employee:security",
      "hr:employment:read",
      "hr:onboarding:approve",
      "hr:onboarding:read",
      // HR-2C — GM can read the training catalogue + compliance, and
      // assign remedial courses; never authors or publishes course
      // content (that stays with CLUB_ADMIN).
      "hr:training:read",
      "hr:training:assign",
      "hr:training:compliance:read",
    ].sort();
    const actual = hrKeysOfRole("GENERAL_MANAGER");
    expect(actual).toEqual(expected);
    // Explicit negative: GM must NOT hold employee-record write or
    // termination authority — the security grant is deliberately narrow.
    expect(actual).not.toContain("hr:employee:write");
    expect(actual).not.toContain("hr:employee:terminate");
  });

  it("PAYROLL_ADMIN holds the reveal-tier + compensation/payroll_profile write bundle (+ HR-2C allowance read/write)", () => {
    // Reveal-tier: sin/banking/tax reveal. Full write for
    // compensation, payroll_profile, banking. Read + sensitive
    // documents. Directory/employee/employment read (no employee
    // write — HR write of employee records is CLUB_ADMIN's).
    // HR-2C — allowance read/write is a payroll-configuration seam
    // (recurring taxable allowances feed gross pay).
    const expected = [
      "hr:allowance:read",
      "hr:allowance:write",
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
      // Slice A closeout (2026-09-18) — narrow service-date correction.
      "hr:service-date:write",
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

  it("CONTROLLER holds finance-relevant HR reads + AUTH-3D.RBAC hr:employee:security — never reveal, never edit, never terminate", () => {
    const expected = [
      "hr:compensation:read",
      "hr:directory:view",
      "hr:documents:read",
      "hr:employee:read",
      // AUTH-3D.RBAC.FIX — narrow account-security grant. Controller/CFO
      // owns account-security decisions (lock out compromised employee,
      // issue password reset) WITHOUT gaining hr:employee:write,
      // hr:employee:terminate, or any PII reveal.
      "hr:employee:security",
      "hr:onboarding:approve",
      "hr:onboarding:read",
      // Slice A closeout (2026-09-18) — narrow service-date correction.
      "hr:service-date:write",
    ].sort();
    const actual = hrKeysOfRole("CONTROLLER");
    expect(actual).toEqual(expected);
    // Reveal / write / approve of sensitive tiers explicitly disallowed.
    // Also explicitly: hr:employee:write and hr:employee:terminate must
    // stay OUT — that's the entire point of the narrow security grant.
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
      "hr:employee:write",
      "hr:employee:terminate",
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

  it("hr:employee:security is held ONLY by CLUB_ADMIN + GENERAL_MANAGER + CONTROLLER + SUPER_ADMIN (AUTH-3D.RBAC.FIX)", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
    const carriers = roles.filter((r) => (ROLE_PERMISSIONS[r] as string[]).includes("hr:employee:security"));
    // Founder-approved set: senior club-management/account-administration
    // roles. Deliberately EXCLUDES PAYROLL_ADMIN — payroll access does
    // not imply identity/account-security authority.
    expect(carriers.sort()).toEqual([
      "CLUB_ADMIN",
      "CONTROLLER",
      "GENERAL_MANAGER",
      "SUPER_ADMIN",
    ].sort());
  });

  it("PAYROLL_ADMIN does NOT hold hr:employee:security (least-privilege pin per AUTH-3D.RBAC.FIX §2)", () => {
    const actual = ROLE_PERMISSIONS["PAYROLL_ADMIN"] as string[];
    expect(actual).not.toContain("hr:employee:security");
  });

  it("junior/operational roles do NOT hold hr:employee:security", () => {
    for (const role of [
      "FINANCE_ADMIN",
      "DEPARTMENT_MANAGER",
      "PRO_SHOP_MANAGER",
      "F_AND_B_MANAGER",
      "EVENT_MANAGER",
      "AUDITOR_READ_ONLY",
      "BOARD_READ_ONLY",
      "STAFF",
      "MEMBER",
    ] as RoleKey[]) {
      expect(
        (ROLE_PERMISSIONS[role] as string[]).includes("hr:employee:security"),
        `${role} unexpectedly holds hr:employee:security`,
      ).toBe(false);
    }
  });
});
