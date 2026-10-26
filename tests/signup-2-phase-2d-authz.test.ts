// SIGNUP-2 Phase 2D (2026-10-25) -- Authorisation contract tests.
//
// Pins the authorisation chain across all four POST API routes:
//   • unauthenticated → 401 (or redirect to /login for HTML)
//   • rate-limited → 429 (or redirect)
//   • service error → mapped by err.httpStatus
//   • super-admin via platform:signups:release gate
//   • NO Microsoft tenant-ID equality check (founder §3A)
//   • self-approval via email equality
//   • three-distinct-operators rule enforced at the service

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/lib/signup/operator-verification.ts"), "utf8");
const PERMISSIONS = readFileSync(join(ROOT, "src/lib/permissions.ts"), "utf8");
const STANDING_ROUTE = readFileSync(join(ROOT, "src/app/api/admin/signup-ops/registration/[id]/standing-verified/route.ts"), "utf8");
const AUTHORITY_ROUTE = readFileSync(join(ROOT, "src/app/api/admin/signup-ops/registration/[id]/authority-verified/route.ts"), "utf8");
const RELEASE_ROUTE = readFileSync(join(ROOT, "src/app/api/admin/signup-ops/registration/[id]/release/route.ts"), "utf8");
const REJECT_ROUTE = readFileSync(join(ROOT, "src/app/api/admin/signup-ops/registration/[id]/reject/route.ts"), "utf8");
const QUEUE_ROUTE = readFileSync(join(ROOT, "src/app/api/admin/signup-ops/queue/route.ts"), "utf8");

describe("SIGNUP-2 Phase 2D · permission scope registered", () => {
  it("permissions table declares platform:signups:release", () => {
    expect(PERMISSIONS).toMatch(/"platform:signups:release":\s*\{[\s\S]+?category:\s*"PLATFORM_SIGNUPS"/);
  });

  it("SUPER_ADMIN role grants platform:signups:release (via allPermissionKeys)", () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain("platform:signups:release" as any);
  });

  it("No other role in ROLE_PERMISSIONS carries platform:signups:release by default at launch", () => {
    for (const [roleKey, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (roleKey === "SUPER_ADMIN") continue;
      expect(perms as readonly string[], `role ${roleKey} must not carry platform:signups:release at launch`).not.toContain("platform:signups:release");
    }
  });
});

describe("SIGNUP-2 Phase 2D · routes consistently gate on authentication", () => {
  for (const [label, route] of [
    ["standing-verified", STANDING_ROUTE],
    ["authority-verified", AUTHORITY_ROUTE],
    ["release", RELEASE_ROUTE],
    ["reject", REJECT_ROUTE],
    ["queue", QUEUE_ROUTE],
  ] as const) {
    it(`${label}: no principal → 401 or redirect`, () => {
      expect(route).toMatch(/if \(!principal\)/);
    });
  }

  it("queue route checks platform:signups:release directly", () => {
    expect(QUEUE_ROUTE).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });

  for (const [label, route] of [
    ["standing-verified", STANDING_ROUTE],
    ["authority-verified", AUTHORITY_ROUTE],
    ["release", RELEASE_ROUTE],
    ["reject", REJECT_ROUTE],
  ] as const) {
    it(`${label}: rate-limited by signup_operator_action scope`, () => {
      expect(route).toMatch(/checkAuthRateLimit\("signup_operator_action",\s*principal\.id/);
    });
  }
});

describe("SIGNUP-2 Phase 2D · NO Microsoft-tenant-ID-equality check (founder §3A)", () => {
  it("service never COMPARES against adminMicrosoftTenantId", () => {
    // Comments / documentation may mention the field; the test
    // asserts the service never performs a comparison on it.
    const compareUsages = SERVICE.match(/adminMicrosoftTenantId\s*(?:===|!==|==|!=)/g) ?? [];
    expect(compareUsages).toEqual([]);
    // Also never read into a comparison variable.
    const assignUsages = SERVICE.match(/const\s+\w+\s*=\s*[^;]*adminMicrosoftTenantId/g) ?? [];
    expect(assignUsages).toEqual([]);
  });

  it("self-approval protection uses NORMALISED email (not raw lower-cased)", () => {
    // Phase 2D identity-control correction (2026-10-26): the
    // comparator now goes through normaliseEmailForComparison on
    // both sides.
    expect(SERVICE).toMatch(/normaliseEmailForComparison\(principal\.email\)/);
    expect(SERVICE).toMatch(/normaliseEmailForComparison\(reg\.adminEmail\)/);
  });

  it("the self-approval check runs on every write entry point", () => {
    expect(SERVICE.match(/assertNotApplicant\(principal, reg\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("SIGNUP-2 Phase 2D · service returns the correct error class per founder §3A", () => {
  it("same-operator standing+authority rejection raises ForbiddenError", () => {
    expect(SERVICE).toMatch(/throw new ForbiddenError\(\s*`Operator \$\{principal\.id\.slice\(-6\)\} already signed the \$\{otherConcept\}/);
  });

  it("three-distinct-operators release rejection raises ForbiddenError", () => {
    expect(SERVICE).toMatch(/throw new ForbiddenError\(\s*"Standing and authority verifications were signed by the same operator/);
    expect(SERVICE).toMatch(/throw new ForbiddenError\(\s*"Releasing operator must differ from both/);
  });

  it("stale evidence raises ForbiddenError (release gate)", () => {
    expect(SERVICE).toMatch(/throw new ForbiddenError\("Standing verification evidence is stale/);
    expect(SERVICE).toMatch(/throw new ForbiddenError\("Authority verification evidence is stale/);
  });

  it("terminal-state writes raise AppError with 409 httpStatus", () => {
    expect(SERVICE).toMatch(/throw new AppError\(\s*"SIGNUP_2D_REGISTRATION_TERMINAL"[\s\S]+?409/);
    expect(SERVICE).toMatch(/throw new AppError\(\s*"SIGNUP_2D_REGISTRATION_REJECTED"[\s\S]+?409/);
    expect(SERVICE).toMatch(/throw new AppError\(\s*"SIGNUP_2D_REGISTRATION_AUTHORISED"[\s\S]+?409/);
  });
});
