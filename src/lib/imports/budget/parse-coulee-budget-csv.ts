// BUDGET-HIST-1 (2026-10-04) — Coulee 2026 Budget CSV parser.
//
// Source contract (founder-defined):
//   • No header row.
//   • 15 columns per row.
//   • Column A — line number (ignored for persistence; retained for
//     provenance only).
//   • Column B — Jonas department code ("1".."7", "20").
//   • Column C — GL account number (string, exact match).
//   • Columns D..O — twelve monthly budget amounts (Jan..Dec),
//     signed, decimal-preserving. Zero is a legitimate observation,
//     never collapsed to null.
//
// Pure, no DB access. Deterministic. SHA-256 of input text drives
// idempotency downstream.

import { createHash } from "node:crypto";

const EXPECTED_COLS = 15;
const MONTH_COUNT = 12;
const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
] as const;

export type ParsedBudgetRow = {
  /** 1-indexed source row number (not persisted). */
  sourceLineNumber: number;
  /** Raw department code as it appears in column B. */
  jonasDeptCode: string;
  /** Raw account number as it appears in column C. */
  accountNumber: string;
  /** 12 monthly amounts (Jan..Dec). Signed, decimal-preserving. */
  monthlyAmounts: number[];
  /** Convenience: sum of all 12 months. */
  annualTotal: number;
};

export type BudgetParseResult = {
  rows: ParsedBudgetRow[];
  rowCount: number;
  uniqueAccountNumbers: string[];
  uniqueDeptCodes: string[];
  duplicateDeptAccountKeys: string[];
  monthlyTotals: number[];        // 12 entries, oldest → newest
  annualTotal: number;
  sourceFileHash: string;         // sha256 of normalized text (BOM stripped)
  byteLength: number;
};

export class BudgetParseError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "BudgetParseError";
  }
}

export const MONTH_INDEX_LABELS = MONTH_LABELS;

/** Parse the Coulee 2026 budget CSV. Throws BudgetParseError on any
 *  structural violation; the caller is responsible for turning the
 *  error into a 400 or a Preview rejection. */
export function parseCouleeBudgetCsv(text: string): BudgetParseResult {
  // Strip BOM so the first row isn't off-by-one.
  const normalized = text.replace(/^﻿/, "");
  const sha = createHash("sha256").update(normalized, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(normalized, "utf8");

  const lines = normalized.split(/\r?\n/).filter((l) => l.length > 0);
  const rows: ParsedBudgetRow[] = [];
  const monthlyTotals = Array(MONTH_COUNT).fill(0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(",");
    if (parts.length !== EXPECTED_COLS) {
      throw new BudgetParseError(
        "COLUMN_COUNT_MISMATCH",
        `source row ${i + 1}: expected ${EXPECTED_COLS} columns, got ${parts.length}`,
      );
    }
    const [nStr, deptRaw, acctRaw, ...monthsRaw] = parts;
    const n = Number(nStr);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BudgetParseError(
        "ROW_NUMBER_INVALID",
        `source row ${i + 1}: column A (row number) must be a positive integer; got "${nStr}"`,
      );
    }
    const jonasDeptCode = deptRaw.trim();
    const accountNumber = acctRaw.trim();
    if (!jonasDeptCode) {
      throw new BudgetParseError(
        "DEPT_CODE_EMPTY",
        `source row ${i + 1}: column B (department code) is empty`,
      );
    }
    if (!accountNumber) {
      throw new BudgetParseError(
        "ACCOUNT_NUMBER_EMPTY",
        `source row ${i + 1}: column C (account number) is empty`,
      );
    }
    const monthlyAmounts: number[] = [];
    for (let m = 0; m < MONTH_COUNT; m++) {
      const raw = monthsRaw[m].trim();
      if (raw === "") {
        throw new BudgetParseError(
          "MONTH_EMPTY",
          `source row ${i + 1}, ${MONTH_LABELS[m]} column: empty — budget must have a numeric value for every month (zero is allowed)`,
        );
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) {
        throw new BudgetParseError(
          "MONTH_NON_NUMERIC",
          `source row ${i + 1}, ${MONTH_LABELS[m]} column: non-numeric value "${raw}"`,
        );
      }
      monthlyAmounts.push(v);
      monthlyTotals[m] += v;
    }
    rows.push({
      sourceLineNumber: n,
      jonasDeptCode,
      accountNumber,
      monthlyAmounts,
      annualTotal: monthlyAmounts.reduce((s, v) => s + v, 0),
    });
  }

  const uniqueAccountNumbers = Array.from(new Set(rows.map((r) => r.accountNumber))).sort();
  const uniqueDeptCodes = Array.from(new Set(rows.map((r) => r.jonasDeptCode))).sort(
    (a, b) => Number(a) - Number(b),
  );
  const keyMap = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.jonasDeptCode}|${r.accountNumber}`;
    keyMap.set(k, (keyMap.get(k) ?? 0) + 1);
  }
  const duplicateDeptAccountKeys = Array.from(keyMap.entries())
    .filter(([_, c]) => c > 1)
    .map(([k]) => k);
  const annualTotal = monthlyTotals.reduce((s, v) => s + v, 0);

  return {
    rows,
    rowCount: rows.length,
    uniqueAccountNumbers,
    uniqueDeptCodes,
    duplicateDeptAccountKeys,
    monthlyTotals,
    annualTotal,
    sourceFileHash: sha,
    byteLength,
  };
}
