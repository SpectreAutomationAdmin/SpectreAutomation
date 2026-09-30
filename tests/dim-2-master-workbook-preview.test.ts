// DIM-2 (2026-09-29) — READ-ONLY Master COA preview through the
// extended DIM-2 predictor. Reports departmentPolicy + fundPolicy +
// fundApplicability distributions for the founder's acceptance
// package. SKIPPED when the workbook is absent (CI-safe).
//
// This test does NOT commit. It does NOT import. It runs the same
// predictor the admin importer will call at review time.

import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseXlsxRows } from "@/lib/imports/xlsx-parse";
import { predictCoaBatch, type CoaPredictorInputRow } from "@/lib/imports/coa-predictor";

const MASTER_PATH = "C:/Users/cturcato/Downloads/Master Chart of Accounts 2.xlsx";
const workbookAvailable = existsSync(MASTER_PATH);
const suite = workbookAvailable ? describe : describe.skip;

suite("DIM-2 · READ-ONLY Master COA preview through the DIM-2 predictor", () => {
  it("produces DIM-2 policy + fund applicability distributions per row", async () => {
    const buf = readFileSync(MASTER_PATH);
    const rows = await parseXlsxRows(buf, { domain: "COA" });
    const parsedRows = rows.filter((r) => r.number && r.number.toString().trim());
    const input: CoaPredictorInputRow[] = parsedRows.map((r) => ({
      number: String(r.number).trim(),
      name: String(r.name ?? "").trim(),
    }));
    const predictions = predictCoaBatch(input, new Map());

    // Roll-ups (Section 16 report).
    const typeCounts: Record<string, number> = {};
    const fsGroupCounts: Record<string, number> = {};
    const confidenceCounts: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const departmentPolicyCounts: Record<string, number> = { REQUIRED: 0, OPTIONAL: 0, NOT_APPLICABLE: 0 };
    const fundPolicyCounts: Record<string, number> = { REQUIRED: 0, OPTIONAL: 0, NOT_APPLICABLE: 0 };
    const fundKeysDistribution: Record<string, number> = {};
    let withFundKeys = 0;
    let withoutFundKeys = 0;
    const dimNeedsReview: Array<{ number: string; name: string; deptPolicy: string; fundPolicy: string; fundKeys: string[]; confidence: string }> = [];

    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];
      typeCounts[p.type] = (typeCounts[p.type] ?? 0) + 1;
      fsGroupCounts[p.fsGroupKey] = (fsGroupCounts[p.fsGroupKey] ?? 0) + 1;
      confidenceCounts[p.confidence] = (confidenceCounts[p.confidence] ?? 0) + 1;
      departmentPolicyCounts[p.departmentPolicy] = (departmentPolicyCounts[p.departmentPolicy] ?? 0) + 1;
      fundPolicyCounts[p.fundPolicy] = (fundPolicyCounts[p.fundPolicy] ?? 0) + 1;
      if (p.fundApplicabilityKeys.length > 0) {
        withFundKeys++;
        const key = p.fundApplicabilityKeys.join(",");
        fundKeysDistribution[key] = (fundKeysDistribution[key] ?? 0) + 1;
      } else {
        withoutFundKeys++;
      }
      // DIM-2 review candidates: fund REQUIRED but no proposed fund
      // keys (means the FS Group mapping suggests fund attribution
      // but the CSV came back empty — a hint for operator review).
      if (
        p.confidence === "low" ||
        (p.fundPolicy === "REQUIRED" && p.fundApplicabilityKeys.length === 0)
      ) {
        dimNeedsReview.push({
          number: input[i].number,
          name: input[i].name,
          deptPolicy: p.departmentPolicy,
          fundPolicy: p.fundPolicy,
          fundKeys: p.fundApplicabilityKeys,
          confidence: p.confidence,
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log("\n== DIM-2 · Master COA preview (READ-ONLY, not imported) ==");
    // eslint-disable-next-line no-console
    console.log("Source rows:                    ", rows.length);
    // eslint-disable-next-line no-console
    console.log("Valid rows (number set):        ", parsedRows.length);
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Predicted Types:");
    for (const [t, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log("  " + t.padEnd(10), n);
    }
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Confidence:                     ", JSON.stringify(confidenceCounts));
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("DIM-2 Department Policy proposals:");
    for (const [p, n] of Object.entries(departmentPolicyCounts).sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log("  " + p.padEnd(16), n);
    }
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("DIM-2 Fund Policy proposals:");
    for (const [p, n] of Object.entries(fundPolicyCounts).sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log("  " + p.padEnd(16), n);
    }
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Fund applicability keys distribution:");
    // eslint-disable-next-line no-console
    console.log("  with fund keys:   ", withFundKeys);
    // eslint-disable-next-line no-console
    console.log("  without fund keys:", withoutFundKeys);
    for (const [k, n] of Object.entries(fundKeysDistribution).sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log("  " + (k || "(none)").padEnd(30), n);
    }
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Rows requiring manual review:   ", dimNeedsReview.length);
    if (dimNeedsReview.length > 0 && dimNeedsReview.length <= 50) {
      // eslint-disable-next-line no-console
      console.log("Review rows (first 50):");
      for (const r of dimNeedsReview.slice(0, 50)) {
        // eslint-disable-next-line no-console
        console.log(
          "  " + r.number.padEnd(8) + " · " +
          r.name.padEnd(40).substring(0, 40) +
          " deptPol=" + r.deptPolicy.padEnd(14) +
          " fundPol=" + r.fundPolicy.padEnd(14) +
          " funds=[" + r.fundKeys.join(",") + "]" +
          " conf=" + r.confidence,
        );
      }
    }

    // Invariants.
    expect(predictions.length).toBe(input.length);
    // Every row got the DIM-2 fields.
    for (const p of predictions) {
      expect(["REQUIRED", "OPTIONAL", "NOT_APPLICABLE"]).toContain(p.departmentPolicy);
      expect(["REQUIRED", "OPTIONAL", "NOT_APPLICABLE"]).toContain(p.fundPolicy);
      expect(Array.isArray(p.fundApplicabilityKeys)).toBe(true);
    }
    // NOT_APPLICABLE + OPTIONAL + REQUIRED sums to total rows.
    const totalDept = Object.values(departmentPolicyCounts).reduce((a, b) => a + b, 0);
    expect(totalDept).toBe(predictions.length);
    const totalFund = Object.values(fundPolicyCounts).reduce((a, b) => a + b, 0);
    expect(totalFund).toBe(predictions.length);
  });
});
