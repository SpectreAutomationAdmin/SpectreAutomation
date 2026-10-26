// SIGNUP-2 Phase 2G (2026-10-26) -- Non-authorisation contract.
// Verifies the service does NOT contain surfaces that are outside
// the founder's explicit authorisation boundary.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2g-provisioning-service.ts"),
  "utf8",
);
const TICK = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/provisioning-tick/route.ts"),
  "utf8",
);
const DIAG = readFileSync(
  join(process.cwd(), "src/app/api/admin/signup-ops/provisioning/[jobId]/route.ts"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · non-authorisations preserved", () => {
  it("no live Stripe adapter import", () => {
    expect(SERVICE).not.toMatch(/createLiveStripeAdapter|stripe\.customers\.|stripe\.subscriptions\.|stripe\.webhooks\./);
    // The adapter wiring stays in Phase 2E's mock-stripe facade; Phase 2G
    // reads only `authorisationEvidenceSource` from the DB.
  });
  it("no gov-ID collection", () => {
    expect(SERVICE).not.toMatch(/\b(governmentId|govId|SSN|driversLicense|passport)\b/i);
    // SIN as a word boundary — allow case-sensitive to avoid matching
    // "SINGLE" / "mISSINg" / etc.
    expect(SERVICE).not.toMatch(/\bSIN\b/);
  });
  it("no modification of pre-existing (non-fixture) tenants", () => {
    // Phase 2G never looks up clubs by name or finds a legacy tenant
    // to attach to; collision = refuse.
    const service = SERVICE;
    expect(service).not.toMatch(/updateExistingClub|attachToExistingTenant/);
    // All Club writes go through stepClubCreated with `create()`.
    const createCount = (service.match(/tx\.club\.create|prisma\.club\.create/g) ?? []).length;
    const updateCount = (service.match(/tx\.club\.update\b|prisma\.club\.update\b/g) ?? []).length;
    expect(createCount).toBeGreaterThan(0);
    // Phase 2G DOES update Club.provisioningCancelledAt on cancellation —
    // that's the sentinel, not a tenant modification.  Confirm the only
    // update field is provisioningCancelledAt.
    if (updateCount > 0) {
      const updateBlocks = service.match(/tx\.club\.update[\s\S]+?\}\)/g) ?? [];
      for (const b of updateBlocks) {
        expect(b).toMatch(/provisioningCancelledAt/);
      }
    }
  });
  it("no production-only side effects behind fail-closed flag", () => {
    // The entire Phase 2G path refuses if the flag is OFF.
    expect(SERVICE).toMatch(/assertPhase2gFlag/);
  });
  it("diagnostic route is read-only", () => {
    expect(DIAG).not.toMatch(/\.create\(|\.update\(|\.delete\(|\.updateMany|\.deleteMany/);
  });
  it("tick route does not accept side-effect query params beyond jobId", () => {
    // Guard against accidentally exposing testOnly on the HTTP surface.
    // Mock-isolation is driven by the SERVICE's env check, not a query param.
    expect(TICK).not.toMatch(/testOnly/);
  });
});
