// AUTH-3C — source-contract for the admin page wiring.
//
// Guards against future contributors accidentally decoupling the
// buttons from the canonical AUTH-3B services or from server actions
// that carry an authenticated principal. Cheap, fast, deterministic.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();

describe("AUTH-3C · Employee-profile wiring", () => {
  const profileSrc = readFileSync(
    join(REPO, "src/app/app/admin/people/employees/[id]/page.tsx"),
    "utf8",
  );
  const actionsSrc = readFileSync(
    join(REPO, "src/app/app/admin/people/employees/[id]/_signout-actions.ts"),
    "utf8",
  );

  it("Employee Profile page renders SignOutEmployeeEverywhereButton", () => {
    expect(profileSrc).toMatch(/import\s+SignOutEmployeeEverywhereButton/);
    expect(profileSrc).toMatch(/<SignOutEmployeeEverywhereButton/);
  });

  it("Employee Profile passes the AUTH-3C server action bound to the profile id", () => {
    expect(profileSrc).toMatch(/signOutEmployeeEverywhereAction\.bind\(null,\s*profile\.id\)/);
  });

  it("Employee button is gated by canEmployeeSecurity (AUTH-3D.RBAC.FIX narrow permission)", () => {
    // AUTH-3D.RBAC.FIX (2026-09-26): password-reset + sign-out-on-all-
    // devices are ACCOUNT-SECURITY actions, gated on the new narrow
    // hr:employee:security permission rather than the broad
    // hr:employee:write. The button now lives inside a
    // canEmployeeSecurity ? (…) : null guard.
    const idx = profileSrc.indexOf("<SignOutEmployeeEverywhereButton");
    const preceding = profileSrc.slice(Math.max(0, idx - 300), idx);
    expect(preceding).toMatch(/canEmployeeSecurity\s*\?/);
    // And confirm the source derives canEmployeeSecurity from the
    // narrow permission key, not from the write key.
    expect(profileSrc).toMatch(
      /canEmployeeSecurity\s*=\s*hasPermission\([^)]*"hr:employee:security"\)/,
    );
  });

  it("Delete/Archive lifecycle controls remain gated by hr:employee:write (canLifecycle unchanged)", () => {
    // AUTH-3D.RBAC.FIX explicitly preserves canLifecycle for the
    // Delete/Archive slot — record-lifecycle authority must NOT be
    // widened by the security-tier grant. Prove both derivations
    // co-exist in the page source.
    expect(profileSrc).toMatch(
      /canLifecycle\s*=\s*hasPermission\([^)]*"hr:employee:write"\)/,
    );
    expect(profileSrc).toMatch(/canLifecycle\s*&&\s*deleteEligibility/);
  });

  it("Server action wraps the AUTH-3B canonical service", () => {
    expect(actionsSrc).toMatch(/"use server"/);
    expect(actionsSrc).toMatch(/from\s+"@\/lib\/hr\/employee-session-revocation"/);
    expect(actionsSrc).toMatch(/signOutEmployeeEverywhere\(principal,\s*employeeId\)/);
    // Principal must be resolved server-side, not read from client input.
    expect(actionsSrc).toMatch(/getCurrentPrincipal/);
  });
});

describe("AUTH-3C · Tenant-Users wiring", () => {
  const clientSrc = readFileSync(
    join(REPO, "src/app/app/admin/settings/users/TenantUsersClient.tsx"),
    "utf8",
  );
  const pageSrc = readFileSync(
    join(REPO, "src/app/app/admin/settings/users/page.tsx"),
    "utf8",
  );
  const actionsSrc = readFileSync(
    join(REPO, "src/app/app/admin/settings/users/_signout-actions.ts"),
    "utf8",
  );

  it("Tenant Users client renders the per-user SignOutUserEverywhereButton", () => {
    expect(clientSrc).toMatch(/import\s+SignOutUserEverywhereButton/);
    expect(clientSrc).toMatch(/<SignOutUserEverywhereButton/);
  });

  it("Row correctly distinguishes self via user.userId === currentUserId", () => {
    expect(clientSrc).toMatch(/isSelf=\{user\.userId\s*===\s*currentUserId\}/);
  });

  it("Row binds the server action to the row's userId", () => {
    expect(clientSrc).toMatch(/signOutUserEverywhereAction\.bind\(null,\s*user\.userId\)/);
  });

  it("page.tsx passes principal.id as currentUserId", () => {
    expect(pageSrc).toMatch(/currentUserId=\{principal\.id\}/);
  });

  it("Server action wraps the AUTH-3B canonical service and returns selfRevocation", () => {
    expect(actionsSrc).toMatch(/"use server"/);
    expect(actionsSrc).toMatch(/from\s+"@\/lib\/tenant-admin\/user-session-revocation"/);
    expect(actionsSrc).toMatch(/signOutUserEverywhere\(principal,\s*targetUserId\)/);
    expect(actionsSrc).toMatch(/selfRevocation/);
    expect(actionsSrc).toMatch(/getCurrentPrincipal/);
  });
});
