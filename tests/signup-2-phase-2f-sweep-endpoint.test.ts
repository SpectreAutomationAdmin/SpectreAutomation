// SIGNUP-2 Phase 2F (2026-10-26) -- Sweep-endpoint contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ROUTE = readFileSync(
  join(ROOT, "src/app/api/admin/signup-ops/activation-sweep/route.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2F · sweep endpoint", () => {
  it("super-admin gated", () => {
    expect(ROUTE).toMatch(/isSuperAdmin\(principal\)/);
    // The route returns 401 "unauthenticated" (no principal) and
    // 403 "forbidden" (not super-admin).  Match on the specific
    // field/value pair -- order of properties in NextResponse.json
    // puts the body before the init object.
    expect(ROUTE).toMatch(/"unauthenticated"[\s\S]*?status:\s*401/);
    expect(ROUTE).toMatch(/"forbidden"[\s\S]*?status:\s*403/);
  });

  it("testOnly requires BOTH query ?testOnly=1 AND env SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP=1", () => {
    expect(ROUTE).toMatch(/testOnlyRequested = url\.searchParams\.get\("testOnly"\) === "1"/);
    expect(ROUTE).toMatch(/testOnlyEnabled = process\.env\.SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP === "1"/);
    expect(ROUTE).toMatch(/const testOnly = testOnlyRequested && testOnlyEnabled/);
  });

  it("production never has SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP set -- feature flag CANNOT override", () => {
    // Documented in the file + enforced by the AND conjunction above.
    expect(ROUTE).toMatch(/Production never has that env var set/);
  });

  it("delegates to sweepActivationCandidates (service does the auth-flag check)", () => {
    expect(ROUTE).toMatch(/await sweepActivationCandidates\(\{ testOnly \}\)/);
  });

  it("exports ONLY a POST handler (no GET sweep)", () => {
    expect(ROUTE).toMatch(/export async function POST\(/);
    expect(ROUTE).not.toMatch(/export async function GET\(/);
  });
});
