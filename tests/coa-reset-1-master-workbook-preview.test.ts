// COA-RESET-1 — READ-ONLY preview of the founder's Master COA workbook.
//
// Runs the founder's authoritative workbook through Spectre's EXISTING
// XLSX parser + coa-predictor to produce the same predictions the
// admin importer will show at review time. No DB writes. No import.
// SKIPPED when the workbook is absent (CI-safe).

import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseXlsxRows } from "@/lib/imports/xlsx-parse";
import { predictCoaBatch, type CoaPredictorInputRow } from "@/lib/imports/coa-predictor";

const MASTER_PATH = "C:/Users/cturcato/Downloads/Master Chart of Accounts 2.xlsx";
const workbookAvailable = existsSync(MASTER_PATH);
const suite = workbookAvailable ? describe : describe.skip;

suite("COA-RESET-1 · READ-ONLY Master workbook preview through Spectre's existing predictor", () => {
  it("parses the Master workbook and predicts Type + FS Group for every row", async () => {
    const buf = readFileSync(MASTER_PATH);
    // Master workbook uses sheet name "JNS543658", not "Chart of
    // Accounts". parseXlsxRows falls back to the first non-reference
    // tab when the canonical name is absent — that will pick up
    // JNS543658 automatically.
    const rows = await parseXlsxRows(buf, { domain: "COA" });

    // Basic shape sanity.
    expect(rows.length).toBeGreaterThan(0);

    // The founder-authoritative columns are "number" (from "New
    // Account# for Spectre") and "name" (from "Description").
    const parsedRows = rows.filter((r) => r.number && r.number.toString().trim());
    const invalidRows = rows.length - parsedRows.length;

    // Duplicate + blank checks
    const numbers = parsedRows.map((r) => String(r.number).trim());
    const uniqueNumbers = new Set(numbers);
    const duplicateCount = numbers.length - uniqueNumbers.size;
    const blankNames = parsedRows.filter((r) => !r.name || !r.name.toString().trim()).length;

    // Predictor input shape — the coa-predictor uses { number, name,
    // debit?, credit? }. Master workbook has no debit/credit columns.
    const input: CoaPredictorInputRow[] = parsedRows.map((r) => ({
      number: String(r.number).trim(),
      name: String(r.name ?? "").trim(),
    }));

    const predictions = predictCoaBatch(input, new Map());

    // Roll-ups.
    const typeCounts: Record<string, number> = {};
    const fsGroupCounts: Record<string, number> = {};
    const confidenceCounts: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const sourceCounts: Record<string, number> = {};
    const needsReview: Array<{ number: string; name: string; type: string; fsGroupKey: string; source: string }> = [];
    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];
      typeCounts[p.type] = (typeCounts[p.type] ?? 0) + 1;
      fsGroupCounts[p.fsGroupKey] = (fsGroupCounts[p.fsGroupKey] ?? 0) + 1;
      confidenceCounts[p.confidence] = (confidenceCounts[p.confidence] ?? 0) + 1;
      sourceCounts[p.source] = (sourceCounts[p.source] ?? 0) + 1;
      if (p.confidence === "low") {
        needsReview.push({
          number: input[i].number,
          name: input[i].name,
          type: p.type,
          fsGroupKey: p.fsGroupKey,
          source: p.source,
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log("\n== COA-RESET-1 · Master COA workbook preview ==");
    // eslint-disable-next-line no-console
    console.log("Source rows:            ", rows.length);
    // eslint-disable-next-line no-console
    console.log("Valid rows (number set):", parsedRows.length);
    // eslint-disable-next-line no-console
    console.log("Invalid rows:           ", invalidRows);
    // eslint-disable-next-line no-console
    console.log("Blank names:            ", blankNames);
    // eslint-disable-next-line no-console
    console.log("Duplicate account nums: ", duplicateCount);
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Predicted Types:");
    for (const [t, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log("  " + t.padEnd(10), n);
    }
    // eslint-disable-next-line no-console
    console.log("Predicted FS Groups:");
    for (const [g, n] of Object.entries(fsGroupCounts).sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log("  " + g.padEnd(30), n);
    }
    // eslint-disable-next-line no-console
    console.log("Confidence:", JSON.stringify(confidenceCounts));
    // eslint-disable-next-line no-console
    console.log("Sources:   ", JSON.stringify(sourceCounts));
    // eslint-disable-next-line no-console
    console.log("Requires review (confidence=low):", needsReview.length);
    if (needsReview.length > 0 && needsReview.length <= 30) {
      // eslint-disable-next-line no-console
      console.log("Low-confidence rows (first 30):");
      for (const r of needsReview.slice(0, 30)) {
        // eslint-disable-next-line no-console
        console.log("  " + r.number.padEnd(8) + " · " + r.name.padEnd(45).substring(0, 45) + " → " + r.type + " · " + r.fsGroupKey + " · " + r.source);
      }
    }

    // Invariants for the founder report.
    expect(parsedRows.length).toBeGreaterThan(400); // Master workbook has ~562 accounts
    expect(duplicateCount).toBe(0); // Master should have no dup account numbers
    expect(blankNames).toBe(0);
    // Every row got a prediction.
    expect(predictions.length).toBe(input.length);
    // Every prediction has a type + fsGroupKey.
    for (let i = 0; i < predictions.length; i++) {
      expect(predictions[i].type).toBeTruthy();
      expect(predictions[i].fsGroupKey).toBeTruthy();
    }
  });
});
