// DIM-2 (2026-09-29) — Integration source-contract tests.
//
// These are cheap, deterministic guards against regression of the
// DIM-2 wiring across coa-predictor + coa-mapping + imports/index +
// journal + ap/invoices + ap/ap-events + reports + reporting-balances.
// Full DB-driven end-to-end coverage is deferred to the tenant-fixture
// suite (which requires spinning up a per-worker DB); these tests
// prove the DIM-2 code paths exist and are structurally correct.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { predictCoaRow } from "@/lib/imports/coa-predictor";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const IMPORTS = readFileSync(path.join(REPO, "src", "lib", "imports", "index.ts"), "utf8");
const JOURNAL = readFileSync(path.join(REPO, "src", "lib", "accounting", "journal.ts"), "utf8");
const AP_INVOICES = readFileSync(path.join(REPO, "src", "lib", "ap", "invoices.ts"), "utf8");
const AP_EVENTS = readFileSync(path.join(REPO, "src", "lib", "ap", "ap-events.ts"), "utf8");
const REPORTS = readFileSync(path.join(REPO, "src", "lib", "accounting", "reports.ts"), "utf8");
const REPORTING_BAL = readFileSync(path.join(REPO, "src", "lib", "accounting", "reporting-balances.ts"), "utf8");
const BALANCE = readFileSync(path.join(REPO, "src", "lib", "accounting", "balance.ts"), "utf8");

describe("DIM-2 · predictor emits the DIM-2 shape", () => {
  it("predictCoaRow returns departmentPolicy + fundPolicy + fundApplicabilityKeys per row", () => {
    // Cash — 1010 → BS_CASH_EQUIVALENTS → NOT_APPLICABLE / NOT_APPLICABLE
    const cash = predictCoaRow({ number: "1010", name: "Cash - Operating" });
    expect(cash.departmentPolicy).toBe("NOT_APPLICABLE");
    expect(cash.fundPolicy).toBe("NOT_APPLICABLE");
    expect(cash.fundApplicabilityKeys).toEqual([]);

    // Operating expense — 6098 Licenses → REQUIRED / REQUIRED
    const licenses = predictCoaRow({ number: "6098", name: "Licenses" });
    expect(licenses.departmentPolicy).toBe("REQUIRED");
    expect(licenses.fundPolicy).toBe("REQUIRED");
    expect(licenses.fundApplicabilityKeys.length).toBeGreaterThan(0);

    // Membership dues — 4000 → REQUIRED
    const dues = predictCoaRow({ number: "4000", name: "Membership Dues" });
    expect(dues.departmentPolicy).toBe("REQUIRED");
    expect(dues.fundPolicy).toBe("REQUIRED");
  });
});

describe("DIM-2 · COA importer wires the DIM-2 fields into commit", () => {
  it("imports/index.ts commit path persists departmentPolicy + fundPolicy on Account.upsert", () => {
    // Both commit paths (main + replacement) set the policies.
    const policyOccurrences = (IMPORTS.match(/departmentPolicy,/g) ?? []).length;
    expect(policyOccurrences, "departmentPolicy shorthand appears in Account.upsert data blocks").toBeGreaterThanOrEqual(4);
    const fundPolicyOccurrences = (IMPORTS.match(/fundPolicy,/g) ?? []).length;
    expect(fundPolicyOccurrences, "fundPolicy shorthand appears in Account.upsert data blocks").toBeGreaterThanOrEqual(4);
  });

  it("imports/index.ts commit path RECONCILES AccountFund rows (deleteMany + createMany)", () => {
    expect(IMPORTS).toMatch(/accountFund\.deleteMany/);
    expect(IMPORTS).toMatch(/accountFund\.createMany/);
    // And both commit paths use it (main + replacement) — count at least 2 occurrences of each.
    expect((IMPORTS.match(/accountFund\.deleteMany/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((IMPORTS.match(/accountFund\.createMany/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("Section 4 — defaultDepartmentId is NOT auto-populated from departmentIds[0]", () => {
    // The pre-DIM-2 pattern was:
    //   const primaryDepartmentId = departmentIds[0] ?? null;
    // Under DIM-2 both commit paths use `explicitDefaultDepartmentId`
    // resolved from `normalized.explicitDefaultDepartmentId` only.
    expect(IMPORTS).not.toMatch(/const\s+primaryDepartmentId\s*=\s*departmentIds\[0\]/);
    expect((IMPORTS.match(/explicitDefaultDepartmentId/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("applyCoaAutoMapping stamps departmentPolicy + fundPolicy + fundApplicabilityKeys into rawJson._prediction", () => {
    expect(IMPORTS).toMatch(/departmentPolicy: p\.departmentPolicy/);
    expect(IMPORTS).toMatch(/fundPolicy: p\.fundPolicy/);
    expect(IMPORTS).toMatch(/fundApplicabilityKeys: p\.fundApplicabilityKeys/);
  });

  it("applyCoaAutoMapping does NOT auto-populate departmentCodes from the predictor's suggestion", () => {
    // The pre-DIM-2 pattern was:
    //   departmentCodes: predictions[i].defaultDepartmentCode ? [...] : []
    // Under DIM-2 Section 4 the auto-map ships departmentCodes: [] so
    // AccountDepartment applicability is populated only when the
    // operator selects departments explicitly in the preview UI.
    expect(IMPORTS).not.toMatch(/departmentCodes:\s*predictions\[i\]\.defaultDepartmentCode/);
  });
});

describe("DIM-2 · Manual JE wires central validation + persists fundId", () => {
  it("journal.ts imports validateManyLineDimensions", () => {
    expect(JOURNAL).toMatch(/import\s*\{\s*validateManyLineDimensions\s*\}\s*from\s*["']\.\/dimensional-validation["']/);
  });

  it("journal.ts calls validateManyLineDimensions in the resolve path", () => {
    expect(JOURNAL).toMatch(/validateManyLineDimensions\(/);
    expect(JOURNAL).toMatch(/Journal entry dimensional validation failed/);
  });

  it("journal.ts accepts fundCode in the line schema and resolves it via prisma.fund.findMany", () => {
    expect(JOURNAL).toMatch(/fundCode: z\.string\(\)/);
    expect(JOURNAL).toMatch(/prisma\.fund\.findMany/);
  });

  it("journal.ts persists fundId on every JournalEntryLine.createMany", () => {
    // Three createMany sites (create draft, direct-post adapter, reversal).
    // All three must set fundId now.
    const occurrences = (JOURNAL.match(/fundId: l\.fundId/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});

describe("DIM-2 · AP wires central validation + fund propagation", () => {
  it("ap/invoices.ts imports validateManyLineDimensions from accounting/dimensional-validation", () => {
    expect(AP_INVOICES).toMatch(/from\s*["']\.\.\/accounting\/dimensional-validation["']/);
  });

  it("ap/invoices.ts calls validateManyLineDimensions before persisting the invoice", () => {
    expect(AP_INVOICES).toMatch(/validateManyLineDimensions\(/);
    expect(AP_INVOICES).toMatch(/AP invoice dimensional validation failed/);
  });

  it("ap/invoices.ts accepts fundCode + resolves via prisma.fund.findMany + persists fundId on APInvoiceLine", () => {
    expect(AP_INVOICES).toMatch(/fundCode: z\.string\(\)/);
    expect(AP_INVOICES).toMatch(/prisma\.fund\.findMany/);
    expect(AP_INVOICES).toMatch(/fundId: l\.fundId/);
  });

  it("ap/ap-events.ts propagates fundId from APInvoiceLine → JE adapter fundCode", () => {
    // Adapter line type carries fundCode; expense line pushes fundCode
    // from the resolved fund key.
    expect(AP_EVENTS).toMatch(/fundCode\?:\s*string\s*\|\s*null/);
    expect(AP_EVENTS).toMatch(/fund\.findMany/);
    expect(AP_EVENTS).toMatch(/fundIdToKey\.get\(l\.fundId\)/);
  });
});

describe("DIM-2 · Reporting engine gains fund filter + incomeStatementByFund", () => {
  it("balance.ts BalanceFilter accepts fundId", () => {
    expect(BALANCE).toMatch(/fundId\?:\s*string/);
    // And the WHERE clause spreads it into the JournalEntryLine query.
    expect(BALANCE).toMatch(/filter\.fundId\s*\?\s*\{\s*fundId:\s*filter\.fundId\s*\}\s*:\s*\{\}/);
  });

  it("reports.ts trialBalance + incomeStatement accept opts.fundId", () => {
    expect(REPORTS).toMatch(/trialBalance\([^)]*fundId\?/);
    expect(REPORTS).toMatch(/incomeStatement\([^)]*fundId\?/);
  });

  it("reports.ts exports incomeStatementByFund with the DIM-2 shape", () => {
    expect(REPORTS).toMatch(/export async function incomeStatementByFund\(/);
    expect(REPORTS).toMatch(/type FundISRow\s*=/);
    // Unassigned Fund bucket is present (line-level authoritative;
    // no fundApplicability CSV inference).
    expect(REPORTS).toMatch(/Unassigned Fund/);
  });

  it("reporting-balances.ts includes fundId in the sliced-read check (fund-scoped TB does NOT return snapshot totals)", () => {
    expect(REPORTING_BAL).toMatch(/filter\.fundId != null/);
  });
});

describe("DIM-2 · Historical TB payload contract extension (Section 12)", () => {
  it("docs/dim-2-historical-tb-payload-contract.md exists and defines the extended payload shape", () => {
    const p = path.join(REPO, "docs", "dim-2-historical-tb-payload-contract.md");
    const md = readFileSync(p, "utf8");
    expect(md).toMatch(/account/);
    expect(md).toMatch(/department/);
    expect(md).toMatch(/fund/);
    expect(md).toMatch(/debit/);
    expect(md).toMatch(/credit/);
  });
});
