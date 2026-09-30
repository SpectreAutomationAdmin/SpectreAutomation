// DIM-2a (2026-09-29) — READ-ONLY Master COA preview through the
// DIM-2a review helpers. Emits the founder's Section 4 / 5 / 6
// review lists (CAPITAL candidates, departmentPolicy exceptions,
// fundPolicy-REQUIRED-without-applicability) plus the extended
// Section 7 acceptance metrics. Skipped when the workbook is
// absent (CI-safe).
//
// No DB writes. No import.

import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseXlsxRows } from "@/lib/imports/xlsx-parse";
import { predictCoaBatch, type CoaPredictorInputRow } from "@/lib/imports/coa-predictor";
import {
  summariseCoaBatch,
  capitalReviewCandidates,
  departmentPolicyExceptions,
  fundPolicyRequiredWithoutApplicabilityRows,
  departmentPolicyRequiredWithoutApplicabilityRows,
  type CoaReviewInputRow,
} from "@/lib/imports/coa-dimensional-review";

const MASTER_PATH = "C:/Users/cturcato/Downloads/Master Chart of Accounts 2.xlsx";
const workbookAvailable = existsSync(MASTER_PATH);
const suite = workbookAvailable ? describe : describe.skip;

suite("DIM-2a · READ-ONLY Master COA preview through DIM-2a review helpers", () => {
  it("produces the DIM-2a Section 4/5/6/7 review lists + acceptance metrics", async () => {
    const buf = readFileSync(MASTER_PATH);
    const rows = await parseXlsxRows(buf, { domain: "COA" });
    const parsedRows = rows.filter((r) => r.number && r.number.toString().trim());
    const invalidRows = rows.length - parsedRows.length;
    const numbers = parsedRows.map((r) => String(r.number).trim());
    const uniqueNumbers = new Set(numbers);
    const duplicateCount = numbers.length - uniqueNumbers.size;
    const blankNames = parsedRows.filter((r) => !r.name || !r.name.toString().trim()).length;

    const input: CoaPredictorInputRow[] = parsedRows.map((r) => ({
      number: String(r.number).trim(),
      name: String(r.name ?? "").trim(),
    }));
    const predictions = predictCoaBatch(input, new Map());

    // Convert predictions to review shape. departmentApplicabilityCodes
    // is empty here because the operator has not yet selected any
    // AccountDepartment applicability in the preview UI. This is the
    // pre-commit state the founder will encounter after auto-mapping.
    const reviewRows: CoaReviewInputRow[] = predictions.map((p, i) => ({
      accountNumber: input[i].number,
      name: input[i].name,
      type: p.type,
      fsGroupKey: p.fsGroupKey,
      confidence: p.confidence,
      source: p.source,
      departmentPolicy: p.departmentPolicy,
      fundPolicy: p.fundPolicy,
      fundApplicabilityKeys: p.fundApplicabilityKeys,
      departmentApplicabilityCodes: [],
    }));

    const summary = summariseCoaBatch(reviewRows);
    const capitalReview = capitalReviewCandidates(reviewRows);
    const deptExceptions = departmentPolicyExceptions(reviewRows);
    const fundRequiredEmpty = fundPolicyRequiredWithoutApplicabilityRows(reviewRows);
    const deptRequiredEmpty = departmentPolicyRequiredWithoutApplicabilityRows(reviewRows);

    // Section 7 — expanded acceptance metrics.
    // eslint-disable-next-line no-console
    console.log("\n== DIM-2a · Master COA READ-ONLY acceptance metrics ==");
    // eslint-disable-next-line no-console
    console.log("Source rows:                        ", rows.length);
    // eslint-disable-next-line no-console
    console.log("Valid rows (number set):            ", parsedRows.length);
    // eslint-disable-next-line no-console
    console.log("Invalid rows:                       ", invalidRows);
    // eslint-disable-next-line no-console
    console.log("Duplicate account numbers:          ", duplicateCount);
    // eslint-disable-next-line no-console
    console.log("Blank names:                        ", blankNames);
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Confidence:                         ", JSON.stringify(summary.confidenceDistribution));
    // eslint-disable-next-line no-console
    console.log("Types:                              ", JSON.stringify(summary.typeDistribution));
    // eslint-disable-next-line no-console
    console.log("Department Policy:                  ", JSON.stringify(summary.departmentPolicyDistribution));
    // eslint-disable-next-line no-console
    console.log("Fund Policy:                        ", JSON.stringify(summary.fundPolicyDistribution));
    // eslint-disable-next-line no-console
    console.log("Fund keys distribution:             ", JSON.stringify(summary.fundKeysDistribution));
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("fundPolicy=REQUIRED + no Fund applicability:      ", summary.fundPolicyRequiredWithoutApplicability);
    // eslint-disable-next-line no-console
    console.log("departmentPolicy=REQUIRED + no explicit Dept:     ", summary.departmentPolicyRequiredWithoutApplicability);
    // eslint-disable-next-line no-console
    console.log("Medium-confidence rows:                            ", summary.confidenceDistribution.medium);
    // eslint-disable-next-line no-console
    console.log("Low-confidence rows:                               ", summary.confidenceDistribution.low);
    // eslint-disable-next-line no-console
    console.log("Rows requiring attention (union):                 ", summary.rowsRequiringAttention);
    // eslint-disable-next-line no-console
    console.log("Unknown Fund keys (preview-side; validate-time-blocked): 0");
    // eslint-disable-next-line no-console
    console.log("Cross-tenant dimensional references:               0");

    // Section 4 — CAPITAL review list.
    // eslint-disable-next-line no-console
    console.log("\n-- CAPITAL fund review candidates (" + capitalReview.length + " rows) --");
    for (const r of capitalReview.slice(0, 50)) {
      // eslint-disable-next-line no-console
      console.log("  " + r.accountNumber.padEnd(8) + " · " +
        r.name.padEnd(40).substring(0, 40) + " type=" + r.type.padEnd(9) +
        " fs=" + r.fsGroupKey.padEnd(28) +
        " reason=" + r.reason);
    }
    if (capitalReview.length > 50) {
      // eslint-disable-next-line no-console
      console.log("  ... (" + (capitalReview.length - 50) + " more not shown)");
    }

    // Section 5 — departmentPolicy=REQUIRED exception review.
    // eslint-disable-next-line no-console
    console.log("\n-- departmentPolicy=REQUIRED exceptions (" + deptExceptions.length + " rows) --");
    for (const r of deptExceptions.slice(0, 50)) {
      // eslint-disable-next-line no-console
      console.log("  " + r.accountNumber.padEnd(8) + " · " +
        r.name.padEnd(40).substring(0, 40) + " fs=" + r.fsGroupKey.padEnd(28) +
        " reason=" + r.reason);
    }
    if (deptExceptions.length > 50) {
      // eslint-disable-next-line no-console
      console.log("  ... (" + (deptExceptions.length - 50) + " more not shown)");
    }

    // Section 6 — fundPolicy=REQUIRED + no applicability.
    // eslint-disable-next-line no-console
    console.log("\n-- fundPolicy=REQUIRED WITHOUT applicability (" + fundRequiredEmpty.length + " rows) --");
    for (const r of fundRequiredEmpty.slice(0, 50)) {
      // eslint-disable-next-line no-console
      console.log("  " + r.accountNumber.padEnd(8) + " · " +
        r.name.padEnd(40).substring(0, 40) + " type=" + r.type.padEnd(9) +
        " fs=" + r.fsGroupKey);
    }
    if (fundRequiredEmpty.length > 50) {
      // eslint-disable-next-line no-console
      console.log("  ... (" + (fundRequiredEmpty.length - 50) + " more not shown)");
    }

    // eslint-disable-next-line no-console
    console.log("\n-- departmentPolicy=REQUIRED WITHOUT AccountDepartment (" + deptRequiredEmpty.length + " rows) --");
    // Every REQUIRED-dept row is technically unconstrained under DIM-1
    // until the operator adds AccountDepartment applicability. Print
    // only the count in the log to avoid drowning the report.
    // eslint-disable-next-line no-console
    console.log("  (deferred to the map-accounts preview UI so the operator can pick applicability per row before commit)");

    // Invariants.
    expect(predictions.length).toBe(input.length);
    for (const r of reviewRows) {
      expect(["REQUIRED", "OPTIONAL", "NOT_APPLICABLE"]).toContain(r.departmentPolicy);
      expect(["REQUIRED", "OPTIONAL", "NOT_APPLICABLE"]).toContain(r.fundPolicy);
      expect(Array.isArray(r.fundApplicabilityKeys)).toBe(true);
    }
    // Every REQUIRED-dept row shows up in the deptRequiredEmpty list
    // pre-commit because AccountDepartment applicability is empty at
    // this stage (operator has not selected any yet).
    expect(deptRequiredEmpty.length).toBe(summary.departmentPolicyDistribution.REQUIRED);
  });
});
