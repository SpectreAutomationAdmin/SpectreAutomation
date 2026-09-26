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

  it("Employee button is gated by the same admin capability as the password-reset button", () => {
    // Both are rendered inside a `canLifecycle ? (…) : null` guard —
    // asserting the button lives inside a canLifecycle guard ties the
    // visibility to the existing authorization derivation without
    // adding a new one.
    const idx = profileSrc.indexOf("<SignOutEmployeeEverywhereButton");
    const preceding = profileSrc.slice(Math.max(0, idx - 300), idx);
    expect(preceding).toMatch(/canLifecycle\s*\?/);
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
