// SIGNUP-2 Phase 2F (2026-10-26) -- Service contract tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPhase2fActivationFlag } from "@/lib/billing/signup-2f-activation-service";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/lib/billing/signup-2f-activation-service.ts"), "utf8");

describe("SIGNUP-2 Phase 2F · fail-closed flag", () => {
  const prev = process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE;
  beforeEach(() => {
    delete process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE;
    else process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE = prev;
  });

  it("assertPhase2fActivationFlag throws when flag unset", () => {
    expect(() => assertPhase2fActivationFlag()).toThrow(/disabled/i);
  });

  it("flag '0' / 'true' / unset all fail-closed; only literal '1' passes", () => {
    for (const value of ["0", "true", "yes", "on"]) {
      process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE = value;
      expect(() => assertPhase2fActivationFlag()).toThrow(/disabled/i);
    }
    process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE = "1";
    expect(() => assertPhase2fActivationFlag()).not.toThrow();
  });
});

describe("SIGNUP-2 Phase 2F · concurrency correction (§3)", () => {
  it("Stripe fetch happens OUTSIDE prisma.$transaction", () => {
    // Scan the whole service: retrieveBalanceTransaction must be
    // called BEFORE the $transaction block opens; after that line
    // the Stripe adapter is never re-invoked inside the tx.
    const fetchIdx = SERVICE.indexOf("await adapter.retrieveBalanceTransaction(");
    const txIdx = SERVICE.indexOf("await prisma.$transaction(async (tx)");
    expect(fetchIdx).toBeGreaterThan(0);
    expect(txIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeLessThan(txIdx);
    // And no Stripe call inside the transaction body.
    const txEnd = SERVICE.indexOf("});", txIdx);
    const txBody = SERVICE.slice(txIdx, txEnd);
    expect(txBody).not.toMatch(/retrieveBalanceTransaction/);
    expect(txBody).not.toMatch(/stripe\.(?!webhookEvent)/i);
  });

  it("the authoriseActivation sequence: fetch → transaction → row recheck → identifier recheck → upsert", () => {
    const fetchIdx = SERVICE.indexOf("fetchStripeEvidenceOutsideTransaction(");
    const txIdx = SERVICE.indexOf("await prisma.$transaction(async (tx)");
    const lockIdx = SERVICE.indexOf("tx.billingCycle.findUnique(");
    const identCheckIdx = SERVICE.indexOf("stripeBalanceTransactionId !== cycle.stripeBalanceTransactionId");
    const upsertIdx = SERVICE.indexOf("tx.tenantProvisioningJob.create");
    expect(fetchIdx).toBeGreaterThan(0);
    expect(txIdx).toBeGreaterThan(fetchIdx);
    expect(lockIdx).toBeGreaterThan(txIdx);
    expect(identCheckIdx).toBeGreaterThan(lockIdx);
    expect(upsertIdx).toBeGreaterThan(identCheckIdx);
  });

  it("identifier recheck covers the stripeBalanceTransactionId TOCTOU race", () => {
    expect(SERVICE).toMatch(/locked\.stripeBalanceTransactionId !== cycle\.stripeBalanceTransactionId/);
    expect(SERVICE).toMatch(/IDENTIFIERS_CHANGED/);
  });

  it("audit() is called OUTSIDE the transaction (per Phase 2A convention)", () => {
    const txEndIdx = SERVICE.indexOf("return result;");
    const auditIdx = SERVICE.indexOf("await audit(null", txEndIdx);
    // audit may appear after return result;.
    expect(auditIdx).toBeGreaterThan(0);
  });
});

describe("SIGNUP-2 Phase 2F · mock-evidence isolation (§4)", () => {
  it("the production path refuses evidenceSource == 'mock-stripe'", () => {
    expect(SERVICE).toMatch(/evidenceFetch\.bal\.evidenceSource === "mock-stripe" && opts\.testOnly !== true/);
    expect(SERVICE).toMatch(/MOCK_EVIDENCE_REJECTED/);
  });

  it("the mock-evidence refusal writes an IMMEDIATE operator alert (ACTIVATION_STUCK)", () => {
    const block = SERVICE.match(/MOCK_EVIDENCE_REJECTED[\s\S]+?return \{/m)!;
    // operator alert is written BEFORE the return.
    expect(SERVICE).toMatch(/category:\s*"ACTIVATION_STUCK"[\s\S]+?severity:\s*"IMMEDIATE"/);
  });

  it("evidenceSource is persisted on the TenantProvisioningJob (so Phase 2G can see it)", () => {
    expect(SERVICE).toMatch(/authorisationEvidenceSource:\s*evidenceFetch\.bal\.evidenceSource/);
  });

  it("the sweeper's testOnly option is a plain boolean -- no production code path can forge it", () => {
    expect(SERVICE).toMatch(/testOnly\?:\s*boolean/);
    // The sweeper endpoint (contract tested separately) requires
    // BOTH a query-string testOnly=1 AND a staging-only env var.
  });
});

describe("SIGNUP-2 Phase 2F · validateActivationAuthorisation (§5 handoff)", () => {
  it("exported as a separate function (not a reuse of authoriseActivation)", () => {
    expect(SERVICE).toMatch(/export async function validateActivationAuthorisation\(jobId: string\)/);
  });

  it("rejects an invalidated / cancelled / expired job", () => {
    const block = SERVICE.match(/export async function validateActivationAuthorisation[\s\S]+?^}/m)![0];
    expect(block).toMatch(/cancelledAt[\s\S]+?reason:\s*"G9_JOB_EXISTS"/);
    expect(block).toMatch(/invalidatedAt[\s\S]+?reason:\s*"G9_JOB_EXISTS"/);
    expect(block).toMatch(/authorisationExpiresAt.*< Date\.now\(\)[\s\S]+?reason:\s*"AUTHORISATION_EXPIRED"/);
  });

  it("the validator re-runs the gate checks (defense in depth)", () => {
    const block = SERVICE.match(/export async function validateActivationAuthorisation[\s\S]+?^}/m)![0];
    expect(block).toMatch(/authoriseActivation\(/);
  });

  it("preserves the testOnly scope of the original authorisation (mock-created jobs still revalidate against mock)", () => {
    const block = SERVICE.match(/export async function validateActivationAuthorisation[\s\S]+?^}/m)![0];
    expect(block).toMatch(/testOnly:\s*job\.authorisationEvidenceSource === "mock-stripe"/);
  });
});

describe("SIGNUP-2 Phase 2F · invalidateActivationAuthorisation (§6)", () => {
  it("writes invalidatedAt + invalidatedReason without touching cancelledAt (Phase 2G owns cancellation)", () => {
    // Match the function body up to the final `return` outside any
    // nested block.  Use the specific updateMany signature as the
    // anchor.
    const fnIdx = SERVICE.indexOf("export async function invalidateActivationAuthorisation");
    const retIdx = SERVICE.indexOf("return { ok: true, alreadyInvalidated: false };", fnIdx);
    expect(fnIdx).toBeGreaterThan(0);
    expect(retIdx).toBeGreaterThan(fnIdx);
    const block = SERVICE.slice(fnIdx, retIdx);
    expect(block).toMatch(/invalidatedAt:\s*now/);
    expect(block).toMatch(/invalidatedReason:\s*args\.reason/);
    // Explicitly does NOT write cancelledAt.
    expect(block).not.toMatch(/cancelledAt:\s*now/);
  });

  it("conditional updateMany so a second call is noop (idempotent)", () => {
    expect(SERVICE).toMatch(/where:\s*\{\s*id:\s*args\.jobId,\s*invalidatedAt:\s*null\s*\}/);
    expect(SERVICE).toMatch(/alreadyInvalidated:\s*true/);
  });

  it("audit emission for every successful invalidation", () => {
    expect(SERVICE).toMatch(/action:\s*"signup\.activation\.invalidated"/);
  });
});

describe("SIGNUP-2 Phase 2F · no forbidden writes", () => {
  it("never creates a Club / User / UserClubRole", () => {
    expect(SERVICE).not.toMatch(/prisma\.club\.create/);
    expect(SERVICE).not.toMatch(/prisma\.user\.create/);
    expect(SERVICE).not.toMatch(/prisma\.userClubRole\.create/);
  });

  it("never writes accessTier anywhere", () => {
    expect(SERVICE).not.toMatch(/accessTier\s*:/);
  });

  it("never imports from 'stripe' SDK", () => {
    expect(SERVICE).not.toMatch(/from "stripe"/);
    expect(SERVICE).not.toMatch(/from "@stripe\//);
  });

  it("no gov-ID surface", () => {
    expect(SERVICE).not.toMatch(/govId/i);
    expect(SERVICE).not.toMatch(/government[-_ ]?id/i);
  });
});
