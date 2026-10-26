// SIGNUP-2 Phase 2H (2026-10-26) -- RBAC permission contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PERMISSIONS = readFileSync(
  join(process.cwd(), "src/lib/permissions.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2H · three new permission keys", () => {
  it("platform:tenants:suspend declared under PLATFORM_TENANT_LIFECYCLE", () => {
    const block = PERMISSIONS.match(/"platform:tenants:suspend":[\s\S]+?}/)![0];
    expect(block).toMatch(/category:\s*"PLATFORM_TENANT_LIFECYCLE"/);
  });
  it("platform:tenants:reinstate declared under PLATFORM_TENANT_LIFECYCLE", () => {
    const block = PERMISSIONS.match(/"platform:tenants:reinstate":[\s\S]+?}/)![0];
    expect(block).toMatch(/category:\s*"PLATFORM_TENANT_LIFECYCLE"/);
  });
  it("platform:tenants:remediate declared under PLATFORM_TENANT_LIFECYCLE", () => {
    const block = PERMISSIONS.match(/"platform:tenants:remediate":[\s\S]+?}/)![0];
    expect(block).toMatch(/category:\s*"PLATFORM_TENANT_LIFECYCLE"/);
  });
  it("SUPER_ADMIN auto-receives via allPermissionKeys() wildcard", () => {
    // No explicit grant line is required because the SUPER_ADMIN
    // role maps to allPermissionKeys().  Verify the wildcard line
    // is in place.
    expect(PERMISSIONS).toMatch(/SUPER_ADMIN:\s*allPermissionKeys\(\)/);
  });
  it("Phase 2H keys live under the SIGNUP-2 Phase 2H anchor", () => {
    // Guards against accidental renames/moves.  All three keys MUST
    // appear in the ~1 KB window after the Phase 2H marker.
    const idx = PERMISSIONS.indexOf("SIGNUP-2 Phase 2H");
    expect(idx).toBeGreaterThan(-1);
    const window = PERMISSIONS.slice(idx, idx + 1200);
    expect(window).toMatch(/platform:tenants:suspend/);
    expect(window).toMatch(/platform:tenants:reinstate/);
    expect(window).toMatch(/platform:tenants:remediate/);
  });
});
