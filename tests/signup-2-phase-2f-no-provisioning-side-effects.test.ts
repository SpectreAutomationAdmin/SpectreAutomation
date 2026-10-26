// SIGNUP-2 Phase 2F (2026-10-26) -- Grep-sweep: no provisioning
// side effects.
//
// Phase 2F's responsibility is to CREATE the authorisation record;
// Phase 2G owns the actual Club / User / UserClubRole writes.  This
// contract test asserts Phase 2F never crosses the boundary.

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

const PHASE_2F_FILES = [
  "src/lib/billing/signup-2f-activation-service.ts",
  ...listTsFiles(join(ROOT, "src/app/api/admin/signup-ops/activation-sweep")),
].map((p) => (p.startsWith(ROOT) ? p : join(ROOT, p)));

describe("SIGNUP-2 Phase 2F · forbidden patterns absent", () => {
  const forbidden: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /from "stripe"/, label: "import from Stripe SDK" },
    { pattern: /from "@stripe\//, label: "import from @stripe/* package" },
    { pattern: /prisma\.user\.create/, label: "User.create" },
    { pattern: /prisma\.club\.create/, label: "Club.create" },
    { pattern: /prisma\.userClubRole\.create/, label: "UserClubRole.create" },
    { pattern: /\baccessTier\s*:/, label: "accessTier write" },
    { pattern: /govId/i, label: "gov-ID surface" },
    { pattern: /government[-_ ]?id/i, label: "government-id surface" },
    { pattern: /\bpassport\b/i, label: "passport reference" },
    // Phase 2F must NOT activate upstream flags to simulate production.
    { pattern: /SPECTRE_SIGNUP_2B_ATTESTATION_LIVE\s*=\s*["']1["']/, label: "activates Phase 2B flag" },
    { pattern: /SPECTRE_SIGNUP_2C_VERIFICATION_LIVE\s*=\s*["']1["']/, label: "activates Phase 2C flag" },
    { pattern: /SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE\s*=\s*["']1["']/, label: "activates Phase 2D flag" },
    { pattern: /SPECTRE_SIGNUP_2E_PAYMENT_LIVE\s*=\s*["']1["']/, label: "activates Phase 2E flag" },
  ];

  for (const path of PHASE_2F_FILES) {
    const content = readFileSync(path, "utf8");
    const rel = path.replace(ROOT, "").replace(/\\/g, "/");
    for (const { pattern, label } of forbidden) {
      it(`${rel} does NOT ${label}`, () => {
        expect(content).not.toMatch(pattern);
      });
    }
  }
});

describe("SIGNUP-2 Phase 2F · writes stay within the allowed table set", () => {
  const service = readFileSync(join(ROOT, "src/lib/billing/signup-2f-activation-service.ts"), "utf8");

  it("only writes to tenantProvisioningJob + paymentReconciliationEntry + operatorInboxEntry", () => {
    const writes = service.match(/(tx|prisma)\.([a-zA-Z]+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)/g) ?? [];
    const allowed = new Set(["tenantProvisioningJob", "paymentReconciliationEntry", "operatorInboxEntry"]);
    for (const w of writes) {
      const m = w.match(/\.([a-zA-Z]+)\./);
      expect(m, `could not parse ${w}`).not.toBeNull();
      const model = m![1];
      expect(allowed, `unexpected write to ${model} in ${w}`).toContain(model);
    }
  });

  it("the TenantProvisioningJob writes stay within authorisation/invalidation columns", () => {
    const service2 = readFileSync(join(ROOT, "src/lib/billing/signup-2f-activation-service.ts"), "utf8");
    const writes = service2.match(/tenantProvisioningJob\.(create|updateMany|update)\(\s*\{[\s\S]+?\}\s*\)/g) ?? [];
    for (const w of writes) {
      // These are the authorisation / invalidation / idempotency
      // fields Phase 2F owns.  Phase 2G owns step-level fields
      // (provisionedUserId / clubCreated / rolesAssigned / …) and
      // Phase 2F MUST NOT touch them.
      expect(w).not.toMatch(/provisionedUserId:/);
      expect(w).not.toMatch(/provisionedClubId:/);
      expect(w).not.toMatch(/rolesAssignedBatchKey:/);
      expect(w).not.toMatch(/committedCoaBatchKey:/);
      expect(w).not.toMatch(/committedOpeningBalanceBatchKey:/);
      expect(w).not.toMatch(/welcomeEmailProviderMessageId:/);
    }
  });
});
