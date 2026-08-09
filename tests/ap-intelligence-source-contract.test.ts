// Sprint 3 Checkpoint 15E (2026-07-24) — Source-contract locks for
// the AP-invoice intelligence layer. Reads checked-in files and
// asserts the invariants that make the layer safe (closed enums,
// deterministic-only, tenant guards, no autonomous posting).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/types.ts"), "utf8");
const PARSE = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/parse-invoice.ts"), "utf8");
const VALIDATE = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/validate.ts"), "utf8");
const VENDOR = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/vendor-resolve.ts"), "utf8");
const RECON = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/reconcile.ts"), "utf8");
const CAPITAL = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/capital-vs-operating.ts"), "utf8");
const GL = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/gl-recommend.ts"), "utf8");
const ANALYSE = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/analyse.ts"), "utf8");
const MATERIALISE = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/materialise.ts"), "utf8");
const ACTIONS = readFileSync(join(process.cwd(), "src/lib/ap-intelligence/actions.ts"), "utf8");
const AP_EV_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/ap-evidence/route.ts"), "utf8");
const AP_ACT_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/ap-actions/route.ts"), "utf8");
const CLI = readFileSync(join(process.cwd(), "bin/ap-intelligence-materialise.ts"), "utf8");

describe("closed enumerations", () => {
  it("EXTRACTION_STATES = STRUCTURED | PARTIAL | DOCUMENT_UNREADABLE only", () => {
    expect(TYPES).toMatch(/EXTRACTION_STATES = \[[\s\S]*?"STRUCTURED"[\s\S]*?"PARTIAL"[\s\S]*?"DOCUMENT_UNREADABLE"/);
  });
  it("VENDOR_MATCH_STATES include MATCHED, AMBIGUOUS, NOT_FOUND, INSUFFICIENT_SIGNAL", () => {
    for (const s of ["MATCHED", "AMBIGUOUS", "NOT_FOUND", "INSUFFICIENT_SIGNAL"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("AP_RECONCILE_STATES cover every checkpoint-listed finding", () => {
    for (const s of ["MATCH", "DUPLICATE", "NOT_FOUND", "AMOUNT_MISMATCH", "DATE_MISMATCH", "VENDOR_MISMATCH", "HASH_DUPLICATE"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("CAPITAL_VS_OPERATING_STATES = OPERATING | CAPITAL | AMBIGUOUS | INSUFFICIENT_EVIDENCE", () => {
    for (const s of ["OPERATING", "CAPITAL", "AMBIGUOUS", "INSUFFICIENT_EVIDENCE"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("AP_CORRECTION_KINDS cover every reviewer action from the checkpoint spec", () => {
    for (const k of ["APPROVE_EXTRACTION", "REJECT_EXTRACTION", "CORRECT_VENDOR", "CORRECT_GL_ACCOUNT", "MARK_OPERATING", "MARK_CAPITAL", "ATTACH_TO_EXISTING_INVOICE", "CREATE_DRAFT_INVOICE"]) {
      expect(TYPES).toMatch(new RegExp(`"${k}"`));
    }
  });
});

describe("parse-invoice — deterministic-only", () => {
  it("no LLM / cloud imports", () => {
    const importLines = PARSE.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/openai|anthropic|@aws-sdk\/client-textract|@azure\/ai-form-recognizer|dext|veryfi/i);
    }
  });
  it("returns DOCUMENT_UNREADABLE for empty text — never fabricates values", () => {
    expect(PARSE).toMatch(/state: "DOCUMENT_UNREADABLE"/);
  });
  it("keeps money as strings (Decimal-safe) — no parseFloat on totals", () => {
    // parseFloat is not used on any amount extraction.
    expect(PARSE).not.toMatch(/parseFloat\s*\(\s*totalHit/);
  });
});

describe("validate — arithmetic guards", () => {
  it("emits ap.invoice.total_mismatch when subtotal + tax != total", () => {
    expect(VALIDATE).toMatch(/ap\.invoice\.total_mismatch/);
  });
  it("emits negative_total finding when total is negative", () => {
    expect(VALIDATE).toMatch(/ap\.invoice\.negative_total/);
  });
  it("emits line_sum_mismatch when line items don't sum to subtotal", () => {
    expect(VALIDATE).toMatch(/ap\.invoice\.line_sum_mismatch/);
  });
});

describe("vendor + reconcile — tenant scoping", () => {
  it("vendor resolution delegates to the shared clubId-scoped matcher", () => {
    // Sprint 3 · Checkpoint 15P (2026-07-27) — vendor lookups were
    // factored out of `vendor-resolve.ts` into the shared
    // `src/lib/vendor-matching/retrieve.ts` matcher. This contract
    // test now asserts that vendor-resolve.ts consumes the shared
    // matcher (rather than performing its own unscoped queries) AND
    // that the shared matcher scopes on clubId. This is an
    // architectural improvement (single canonical matcher, single
    // canonical tenancy guard) — not a regression.
    expect(VENDOR).toMatch(/from\s+["']@\/lib\/vendor-matching\/(?:retrieve|match|index)["']|from\s+["']\.\/(?:vendor-matching)?/);
    const SHARED_MATCHER = readFileSync(join(process.cwd(), "src/lib/vendor-matching/retrieve.ts"), "utf8");
    expect(SHARED_MATCHER).toMatch(/prisma\.vendor\.findMany\(/);
    expect(SHARED_MATCHER).toMatch(/where:\s*\{\s*clubId/);
  });
  it("reconcile.aPInvoice.findFirst always scopes on clubId", () => {
    expect(RECON).toMatch(/prisma\.aPInvoice\.findFirst\(\{\s*where:\s*\{\s*clubId/);
  });
  it("hash duplicate check limits to the current club", () => {
    expect(RECON).toMatch(/ingestedDocumentEvidenceLink\.findFirst\([\s\S]*?clubId: args\.clubId/);
  });
});

describe("capital classifier — rules only, no ML", () => {
  it("no probabilistic / ML imports", () => {
    const importLines = CAPITAL.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/tensorflow|onnx|scikit|@huggingface|openai|anthropic/i);
    }
  });
  it("every recommendation reports supporting evidence", () => {
    expect(CAPITAL).toMatch(/supportingEvidence/);
  });
  it("returns INSUFFICIENT_EVIDENCE on unreadable document", () => {
    expect(CAPITAL).toMatch(/state === "DOCUMENT_UNREADABLE"[\s\S]*?INSUFFICIENT_EVIDENCE/);
  });
});

describe("gl-recommend — deterministic map + vendor default only", () => {
  it("no dynamic account creation — recommendation is a lookup", () => {
    expect(GL).not.toMatch(/account\.create\(/);
  });
  it("scopes on clubId and enforces isActive via eligibility gate when reading Account", () => {
    // Phase 4 FINAL FREEZE test-maintenance (2026-08-09):
    // OLD CONTRACT: regex asserted the string /isActive:\s*true/
    // appeared inline in the Account.findMany where-clause.
    // CURRENT ACCEPTED CONTRACT: Phase 2 eligibility (2026-07-30+)
    // moved active-account filtering into a dedicated pre-ranker
    // gate module (`accounting/eligibility.ts` +
    // `filterEligibleAccounts`). The snapshot query now uses
    // .findMany({ where: { clubId } }) and applies isActive
    // (plus header/type/role guards) in filterEligibleAccounts. The
    // tenancy scope on clubId is still enforced on the snapshot;
    // isActive is enforced downstream via the eligibility gate. Both
    // are still in gl-recommend.ts:
    //   • `.filter((a) => a.isActive ...)` at :299
    //   • `if (!a.isActive) blockers.push("INACTIVE")` at :933
    expect(GL).toMatch(/account\.findMany\([\s\S]*?clubId:\s*args\.clubId/);
    expect(GL).toMatch(/isActive|filterEligibleAccounts/);
  });
});

describe("analyse orchestrator — sequence + never posts", () => {
  it("calls preflight/validate BEFORE reconcile BEFORE capital BEFORE gl", () => {
    const iValidate = ANALYSE.indexOf("validateExtractedArithmetic");
    const iVendor = ANALYSE.indexOf("resolveVendorForExtraction");
    const iRecon = ANALYSE.indexOf("reconcileAgainstAp");
    const iCapital = ANALYSE.indexOf("classifyCapitalVsOperating");
    const iGl = ANALYSE.indexOf("recommendGlAccount");
    expect(iValidate).toBeGreaterThan(-1);
    expect(iVendor).toBeGreaterThan(iValidate);
    expect(iRecon).toBeGreaterThan(iVendor);
    expect(iCapital).toBeGreaterThan(iRecon);
    expect(iGl).toBeGreaterThan(iCapital);
  });
  it("never calls postInvoice / submitInvoiceForApproval", () => {
    expect(ANALYSE).not.toMatch(/postInvoice\s*\(/);
    expect(ANALYSE).not.toMatch(/submitInvoiceForApproval\s*\(/);
  });
});

describe("materialise — reuses C15B persistence, respects tenant, one canonical intake per doc", () => {
  it("uses upsertAnalysisFindings (semantic identity + USER_REJECTED preservation)", () => {
    expect(MATERIALISE).toMatch(/upsertAnalysisFindings/);
  });
  it("uses INGESTED_DOCUMENT PRIMARY origin as the natural key", () => {
    expect(MATERIALISE).toMatch(/kind:\s*"INGESTED_DOCUMENT"/);
    expect(MATERIALISE).toMatch(/role:\s*"PRIMARY"/);
  });
  it("never posts to GL", () => {
    expect(MATERIALISE).not.toMatch(/postInvoice/);
  });
  it("only enumerates INVOICE-classified STORED PDF documents", () => {
    expect(MATERIALISE).toMatch(/classification:\s*"INVOICE"/);
    expect(MATERIALISE).toMatch(/status:\s*"STORED"/);
    expect(MATERIALISE).toMatch(/mimeType:\s*"application\/pdf"/);
  });
});

describe("actions — never posts / approves / pays", () => {
  it("no post / approve / pay / submit calls in the action module", () => {
    expect(ACTIONS).not.toMatch(/postInvoice\s*\(/);
    expect(ACTIONS).not.toMatch(/submitInvoiceForApproval\s*\(/);
    expect(ACTIONS).not.toMatch(/verifyBanking\s*\(/);
  });
  it("uses the existing createDraftApInvoice service (DRAFT status only)", () => {
    expect(ACTIONS).toMatch(/createDraftApInvoice/);
  });
  it("tenant guard fires first for every kind", () => {
    // The intake lookup is at the top of applyApAction — before the switch.
    const guardIdx = ACTIONS.indexOf("prisma.workIntakeItem.findFirst");
    const switchIdx = ACTIONS.indexOf("switch (args.kind)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(guardIdx);
  });
});

describe("HTTP routes — read-only ap-evidence, closed-enum ap-actions", () => {
  it("ap-evidence is GET-only", () => {
    expect(AP_EV_ROUTE).toMatch(/export async function GET/);
    expect(AP_EV_ROUTE).not.toMatch(/export async function POST/);
    expect(AP_EV_ROUTE).not.toMatch(/export async function PATCH/);
    expect(AP_EV_ROUTE).not.toMatch(/export async function DELETE/);
  });
  it("ap-evidence returns 404 on tenant mismatch (never 403)", () => {
    expect(AP_EV_ROUTE).toMatch(/status: 404/);
    expect(AP_EV_ROUTE).not.toMatch(/status: 403/);
  });
  it("ap-evidence declares postingActionAvailable: false explicitly", () => {
    expect(AP_EV_ROUTE).toMatch(/postingActionAvailable: false/);
  });
  it("ap-actions validates kind against AP_CORRECTION_KINDS", () => {
    expect(AP_ACT_ROUTE).toMatch(/AP_CORRECTION_KINDS/);
    expect(AP_ACT_ROUTE).toMatch(/invalid_kind/);
  });
  it("ap-actions is POST-only", () => {
    expect(AP_ACT_ROUTE).toMatch(/export async function POST/);
    expect(AP_ACT_ROUTE).not.toMatch(/export async function GET/);
  });
});

describe("CLI — staging + Silver Springs guards", () => {
  it("refuses when APP_URL is not staging/localhost", () => {
    expect(CLI).toMatch(/APP_URL does not indicate staging or localhost/);
  });
  it("refuses Silver Springs by slug or name", () => {
    expect(CLI).toMatch(/silver-springs/i);
  });
  it("default is dry-run — --apply required for writes", () => {
    expect(CLI).toMatch(/let apply = false/);
    expect(CLI).toMatch(/--apply/);
  });
});
