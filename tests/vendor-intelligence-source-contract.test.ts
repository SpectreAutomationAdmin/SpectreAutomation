// Sprint 3 Checkpoint 15F (2026-07-24) — Source-contract locks for
// the vendor-intelligence layer. Reads checked-in files and asserts
// the invariants that make the layer safe.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/types.ts"), "utf8");
const NORM = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/normalize.ts"), "utf8");
const DETECT = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/duplicate-detect.ts"), "utf8");
const CANONICAL = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/canonical.ts"), "utf8");
const RESOLVE = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/resolve.ts"), "utf8");
const SIMULATE = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/simulate.ts"), "utf8");
const CONSOLIDATE = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/consolidate.ts"), "utf8");
const MATERIALISE = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/materialise.ts"), "utf8");
const ACTIONS = readFileSync(join(process.cwd(), "src/lib/vendor-intelligence/actions.ts"), "utf8");
const EV_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/vendor-evidence/route.ts"), "utf8");
const ACT_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/vendor-actions/route.ts"), "utf8");
const AP_VENDORS = readFileSync(join(process.cwd(), "src/lib/ap/vendors.ts"), "utf8");
const CLI = readFileSync(join(process.cwd(), "bin/vendor-intelligence-materialise.ts"), "utf8");

describe("closed enumerations", () => {
  it("VENDOR_DUPLICATE_STATES cover exactly the 5 approved values", () => {
    for (const s of ["CONFIRMED_DUPLICATE", "LIKELY_DUPLICATE", "POSSIBLE_DUPLICATE", "DISTINCT_VENDOR", "CONFLICT_REQUIRES_REVIEW"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("CANONICAL_STATES = RECOMMENDED | AMBIGUOUS | INSUFFICIENT_EVIDENCE", () => {
    for (const s of ["RECOMMENDED", "AMBIGUOUS", "INSUFFICIENT_EVIDENCE"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("VENDOR_ALIAS_KINDS cover Jonas + legacy + names + tax", () => {
    for (const s of ["JONAS_VENDOR_CODE", "LEGACY_INVOICE_NUMBER", "LEGAL_NAME", "OPERATING_NAME", "TAX_NUMBER", "OTHER"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("VENDOR_CONSOLIDATION_ACTIONS cover 6 reviewer actions", () => {
    for (const s of ["APPROVE_CONSOLIDATION", "REJECT_CONSOLIDATION", "CHOOSE_DIFFERENT_CANONICAL", "MARK_VENDORS_DISTINCT", "DEFER_REVIEW", "EXECUTE_CONSOLIDATION"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("MERGE_STATUSES = COMMITTED | REVERSED", () => {
    expect(TYPES).toMatch(/MERGE_STATUSES = \[\s*"COMMITTED"[,\s]+"REVERSED"/);
  });
});

describe("normalize — pure functions only", () => {
  it("has no runtime side-effects (no prisma / fetch / fs imports)", () => {
    const importLines = NORM.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/prisma|node:fs|node-fetch|\bfetch\b/);
    }
  });
});

describe("duplicate-detect — no LLM / no probabilistic scoring", () => {
  it("no ML / LLM / cloud imports", () => {
    const importLines = DETECT.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/openai|anthropic|tensorflow|onnx|@huggingface/i);
    }
  });
  it("no dynamic scoring — SIGNAL_STRENGTHS is imported from types.ts", () => {
    expect(DETECT).toMatch(/SIGNAL_STRENGTHS/);
    expect(DETECT).not.toMatch(/Math\.random/);
    expect(DETECT).not.toMatch(/probability/i);
  });
  it("every recommendation returns matchSignals + conflictSignals + explanation", () => {
    expect(DETECT).toMatch(/matchSignals: DuplicateSignal\[\]/);
    expect(DETECT).toMatch(/conflictSignals: DuplicateSignal\[\]/);
    expect(DETECT).toMatch(/explanation: string/);
  });
});

describe("simulate — read-only", () => {
  it("no writes to Prisma in the simulate module", () => {
    expect(SIMULATE).not.toMatch(/\.update\(/);
    expect(SIMULATE).not.toMatch(/\.updateMany\(/);
    expect(SIMULATE).not.toMatch(/\.create\(/);
    expect(SIMULATE).not.toMatch(/\.delete\(/);
    expect(SIMULATE).not.toMatch(/\.deleteMany\(/);
  });
  it("returns a blockingReasons array so reviewer can see why merge is unsafe", () => {
    expect(SIMULATE).toMatch(/blockingReasons: string\[\]/);
  });
});

describe("consolidate — transactional, immutable, tenant-safe", () => {
  it("uses the callback-form transaction with explicit timeout", () => {
    expect(CONSOLIDATE).toMatch(/prisma\.\$transaction<[\s\S]*?>\(async \(tx\)/);
    expect(CONSOLIDATE).toMatch(/timeout:\s*MERGE_TXN_TIMEOUT_MS/);
  });
  it("re-verifies both vendors are in the same club inside the txn", () => {
    // Inside the transaction body, the vendor lookup includes clubId scoping.
    const txBody = CONSOLIDATE.slice(CONSOLIDATE.indexOf("$transaction"));
    expect(txBody).toMatch(/where:\s*\{\s*id:\s*args\.winnerVendorId,\s*clubId:\s*args\.clubId/);
    expect(txBody).toMatch(/where:\s*\{\s*id:\s*args\.loserVendorId,\s*clubId:\s*args\.clubId/);
  });
  it("marks loser status='MERGED' instead of deleting", () => {
    expect(CONSOLIDATE).toMatch(/status:\s*"MERGED"/);
    expect(CONSOLIDATE).not.toMatch(/vendor\.delete\(/);
  });
  it("writes an immutable VendorMergeRecord including the simulation JSON", () => {
    expect(CONSOLIDATE).toMatch(/vendorMergeRecord\.create/);
    expect(CONSOLIDATE).toMatch(/simulationJson:\s*JSON\.stringify\(simulation\)/);
  });
  it("cancels open approvals rather than leaving orphans", () => {
    expect(CONSOLIDATE).toMatch(/approvalRequest\.findMany/);
    expect(CONSOLIDATE).toMatch(/status:\s*"REJECTED"/);
  });
  it("refuses merge on blocking conflicts unless reviewer accepts collisions", () => {
    expect(CONSOLIDATE).toMatch(/acceptInvoiceReferenceCollisions/);
    expect(CONSOLIDATE).toMatch(/VendorIntelligenceError\(\s*"CONFLICT_BLOCKING"/);
  });
});

describe("actions — never auto-merges", () => {
  it("EXECUTE_CONSOLIDATION is the ONLY kind that triggers a merge", () => {
    // A reviewer action must explicitly select EXECUTE_CONSOLIDATION.
    // No other kind calls executeMerge.
    const executeIdx = ACTIONS.indexOf("executeMerge(");
    expect(executeIdx).toBeGreaterThan(-1);
    // The executeMerge call must appear inside the EXECUTE_CONSOLIDATION case block.
    const caseIdx = ACTIONS.indexOf("case \"EXECUTE_CONSOLIDATION\":");
    expect(caseIdx).toBeGreaterThan(-1);
    expect(caseIdx).toBeLessThan(executeIdx);
  });
});

describe("HTTP routes — tenant-safe, 404-on-mismatch", () => {
  it("vendor-evidence route is GET-only", () => {
    expect(EV_ROUTE).toMatch(/export async function GET/);
    expect(EV_ROUTE).not.toMatch(/export async function POST/);
    expect(EV_ROUTE).not.toMatch(/export async function PATCH/);
    expect(EV_ROUTE).not.toMatch(/export async function DELETE/);
  });
  it("vendor-evidence explicitly declares autoMergeAvailable: false", () => {
    expect(EV_ROUTE).toMatch(/autoMergeAvailable:\s*false/);
  });
  it("vendor-evidence never exposes bank account numbers (only hasActiveBanking bool)", () => {
    expect(EV_ROUTE).toMatch(/hasActiveBanking/);
    expect(EV_ROUTE).not.toMatch(/accountLastFour/);
    expect(EV_ROUTE).not.toMatch(/processorToken/);
  });
  it("vendor-actions validates kind against VENDOR_CONSOLIDATION_ACTIONS", () => {
    expect(ACT_ROUTE).toMatch(/VENDOR_CONSOLIDATION_ACTIONS/);
    expect(ACT_ROUTE).toMatch(/invalid_kind/);
  });
  it("both routes return 404 (never 403) on tenant mismatch", () => {
    expect(EV_ROUTE).toMatch(/status: 404/);
    expect(EV_ROUTE).not.toMatch(/status: 403/);
    expect(ACT_ROUTE).toMatch(/status: 404/);
    expect(ACT_ROUTE).not.toMatch(/status: 403/);
  });
});

describe("import integration hook — createVendor calls resolveAnyAlias", () => {
  it("createVendor imports resolveAnyAlias from vendor-intelligence", () => {
    expect(AP_VENDORS).toMatch(/resolveAnyAlias/);
    expect(AP_VENDORS).toMatch(/from "\.\.\/vendor-intelligence\/resolve"/);
  });
  it("createVendor throws ConflictError when alias resolves", () => {
    expect(AP_VENDORS).toMatch(/aliasHit[\s\S]*?ConflictError/);
  });
});

describe("materialise — reuses C15B persistence + never merges automatically", () => {
  it("uses upsertAnalysisFindings (semantic identity)", () => {
    expect(MATERIALISE).toMatch(/upsertAnalysisFindings/);
  });
  it("never calls executeMerge", () => {
    expect(MATERIALISE).not.toMatch(/executeMerge\(/);
  });
});

describe("resolver — read-only + tenant-scoped writes", () => {
  it("resolveVendorAlias always scopes on clubId", () => {
    expect(RESOLVE).toMatch(/vendorAlias\.findFirst\(\{\s*where:\s*\{\s*clubId/);
  });
  it("createAlias refuses to overwrite an existing (kind, normalized) → different canonical", () => {
    expect(RESOLVE).toMatch(/VendorAlias conflict/);
  });
});

describe("CLI — staging + Silver Springs guards", () => {
  it("refuses non-staging URLs", () => {
    expect(CLI).toMatch(/APP_URL is not staging\/localhost/);
  });
  it("refuses Silver Springs", () => {
    expect(CLI).toMatch(/silver-springs/i);
  });
  it("default is dry-run; --apply required for writes", () => {
    expect(CLI).toMatch(/let apply = false/);
  });
});

describe("canonical scoring — deterministic + explainable", () => {
  it("returns a per-candidate breakdown with reasons[]", () => {
    expect(CANONICAL).toMatch(/breakdown: CanonicalScoreBreakdown\[\]/);
    expect(CANONICAL).toMatch(/reasons: string\[\]/);
  });
});
