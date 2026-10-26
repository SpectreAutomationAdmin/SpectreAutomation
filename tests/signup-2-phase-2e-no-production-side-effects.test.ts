// SIGNUP-2 Phase 2E (2026-10-26) -- grep-sweep for forbidden
// patterns across every Phase 2E source file.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) listTsFiles(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

const PHASE_2E_FILES = [
  "src/lib/billing/signup-2e-mandate-service.ts",
  "src/lib/billing/signup-2e-webhook-dispatch.ts",
  ...listTsFiles(join(ROOT, "src/lib/billing/stripe-adapter")),
  ...listTsFiles(join(ROOT, "src/app/api/signup/mandate")),
  ...listTsFiles(join(ROOT, "src/app/api/webhooks/stripe")),
  "src/app/signup/t/[token]/mandate/page.tsx",
].map((p) => (p.startsWith(ROOT) ? p : join(ROOT, p)));

describe("SIGNUP-2 Phase 2E · forbidden patterns absent from every Phase 2E source file", () => {
  const forbidden: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /from "stripe"/, label: "import from 'stripe' SDK" },
    { pattern: /from "@stripe\//, label: "import from @stripe/* package" },
    { pattern: /govId/i, label: "gov-ID surface" },
    { pattern: /government[-_ ]?id/i, label: "government-id surface" },
    { pattern: /\bpassport\b/i, label: "passport reference" },
    { pattern: /prisma\.user\.create/, label: "User.create" },
    { pattern: /prisma\.club\.create/, label: "Club.create" },
    { pattern: /prisma\.userClubRole\.create/, label: "UserClubRole.create" },
    { pattern: /prisma\.tenantProvisioningJob\.create/, label: "TenantProvisioningJob.create" },
    { pattern: /\baccessTier\s*:/, label: "accessTier write" },
    // Must never issue a production ToS activation or disable Phase 2B gate.
    { pattern: /SPECTRE_SIGNUP_2B_ATTESTATION_LIVE\s*=\s*["']1["']/, label: "activates Phase 2B flag" },
    { pattern: /SPECTRE_SIGNUP_2C_VERIFICATION_LIVE\s*=\s*["']1["']/, label: "activates Phase 2C flag" },
  ];

  for (const path of PHASE_2E_FILES) {
    const content = readFileSync(path, "utf8");
    const rel = path.replace(ROOT, "").replace(/\\/g, "/");
    for (const { pattern, label } of forbidden) {
      it(`${rel} does NOT ${label}`, () => {
        expect(content).not.toMatch(pattern);
      });
    }
  }
});

describe("SIGNUP-2 Phase 2E · never creates a TenantProvisioningJob (Phase 2F boundary)", () => {
  it("mandate service does not write to the provisioning job table", () => {
    const service = readFileSync(join(ROOT, "src/lib/billing/signup-2e-mandate-service.ts"), "utf8");
    expect(service).not.toMatch(/tenantProvisioningJob/i);
  });
  it("webhook dispatch does not write to the provisioning job table", () => {
    const dispatch = readFileSync(join(ROOT, "src/lib/billing/signup-2e-webhook-dispatch.ts"), "utf8");
    expect(dispatch).not.toMatch(/tenantProvisioningJob/i);
  });
});

describe("SIGNUP-2 Phase 2E · all adapter results carry evidenceSource invariant", () => {
  it("mock adapter marks every return as 'mock-stripe'", () => {
    const mock = readFileSync(join(ROOT, "src/lib/billing/stripe-adapter/mock.ts"), "utf8");
    const occurrences = mock.match(/evidenceSource:\s*"mock-stripe"/g) ?? [];
    // At least one per method that returns an evidence-carrying type:
    //  createCustomer, createMandateCheckoutSession, retrieveCheckoutSession,
    //  createSubscription, retrieveBalanceTransaction.
    expect(occurrences.length).toBeGreaterThanOrEqual(5);
  });
});
