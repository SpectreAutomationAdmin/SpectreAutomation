// GOLF-HIST-1A (2026-10-06) — real-PDF parser tests.
//
// GOLF-HIST-1 shipped a parser that passed its own tests but failed
// on real uploads because the tests fed pre-normalized text — not
// the output of `pdf-parse` on real PDF bytes. See the acceptance
// package §A for the root-cause write-up.
//
// This file is REWRITTEN to exercise the full production path:
//
//   tests/fixtures/golf-hist-1/january-2026.pdf
//     → parseGgGolfPdf(buffer)
//       → extractGgGolfLayout(buffer)        — positional pdfjs
//       → parseGgGolfLayout(layout, hash)    — row/column assembly
//
// Synthetic `parseGgGolfLayout` cases cover the parser edge cases
// (missing totals row, duplicate dates, malformed cells) without
// needing real PDF binaries.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseGgGolfPdf,
  parseGgGolfLayout,
  type GgGolfLayout,
  type GgGolfLayoutItem,
} from "@/lib/imports/golf-activity/gggolf-pdf-parser";

const FIXTURE_PATH = path.resolve(
  __dirname,
  "fixtures/golf-hist-1/january-2026.pdf",
);
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH);

describe("GOLF-HIST-1A §1 — Real January 2026 PDF (full ingestion path)", () => {
  it("parseGgGolfPdf(buffer) reconciles to the known January 2026 totals", async () => {
    const parse = await parseGgGolfPdf(FIXTURE_BYTES);

    expect(parse.rows).toHaveLength(31);
    expect(parse.reportYear).toBe(2026);
    expect(parse.reportingPeriodStart!.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(parse.reportingPeriodEnd!.toISOString().slice(0, 10)).toBe("2026-01-31");

    expect(parse.parsedTotals.guests).toBe(4);
    expect(parse.parsedTotals.greenFees).toBe(0);
    expect(parse.parsedTotals.members).toBe(397);
    expect(parse.parsedTotals.totalRounds).toBe(401);
    expect(parse.parsedTotals.juniors).toBe(2);
    expect(parse.parsedTotals.women).toBe(94);
    expect(parse.parsedTotals.corpos).toBe(0);
    expect(parse.parsedTotals.corposHalf).toBe(0);
    expect(parse.parsedTotals.fullCart).toBe(0);
    expect(parse.parsedTotals.nineCart).toBe(0);
    expect(parse.parsedTotals.halfCart).toBe(0);
    expect(parse.parsedTotals.freeCart).toBe(0);

    expect(parse.sourceTotals).not.toBeNull();
    expect(parse.sourceTotals!.guests).toBe(4);
    expect(parse.sourceTotals!.members).toBe(397);
    expect(parse.sourceTotals!.totalRounds).toBe(401);
    expect(parse.sourceTotals!.juniors).toBe(2);
    expect(parse.sourceTotals!.women).toBe(94);

    expect(parse.reconciliationStatus).toBe("RECONCILED");
    // Zero warnings — the real PDF is clean when parsed positionally.
    const nonInfoWarnings = parse.warnings.filter(
      (w) => w.kind !== "YEAR_UNRESOLVED",
    );
    expect(nonInfoWarnings).toEqual([]);
  });

  it("preserves 23 active days + 8 real-zero days with the correct zero-day dates", async () => {
    const parse = await parseGgGolfPdf(FIXTURE_BYTES);
    const active = parse.rows.filter((r) => r.totalRounds > 0).length;
    const zero = parse.rows.filter((r) => r.totalRounds === 0).length;
    expect(active).toBe(23);
    expect(zero).toBe(8);
    const zeroDateIsos = parse.rows
      .filter((r) => r.totalRounds === 0)
      .map((r) => r.activityDate.toISOString().slice(0, 10));
    expect(zeroDateIsos).toEqual([
      "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
      "2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26",
    ]);
  });

  it("per-row cell values match the directive-specified samples", async () => {
    const parse = await parseGgGolfPdf(FIXTURE_BYTES);
    const byDate = new Map(parse.rows.map((r) => [r.activityDate.toISOString().slice(0, 10), r]));

    const jan1 = byDate.get("2026-01-01")!;
    expect(jan1.totalRounds).toBe(0);
    expect(jan1.rawWeatherCode).toBe("-");

    const jan6 = byDate.get("2026-01-06")!;
    expect(jan6.totalRounds).toBe(13);
    expect(jan6.members).toBe(13);
    expect(jan6.guests).toBe(0);
    expect(jan6.greenFees).toBe(0);

    const jan21 = byDate.get("2026-01-21")!;
    expect(jan21.totalRounds).toBe(28);
    expect(jan21.guests).toBe(2);
    expect(jan21.members).toBe(26);

    const jan22 = byDate.get("2026-01-22")!;
    expect(jan22.totalRounds).toBe(31);
    expect(jan22.members).toBe(31);
    expect(jan22.women).toBe(22);

    const jan28 = byDate.get("2026-01-28")!;
    expect(jan28.totalRounds).toBe(24);
    expect(jan28.guests).toBe(2);
    expect(jan28.members).toBe(22);

    const jan31 = byDate.get("2026-01-31")!;
    expect(jan31.totalRounds).toBe(18);
    expect(jan31.members).toBe(18);
    expect(jan31.women).toBe(4);
  });

  it("per-row invariant: Total == Guests + GreenFees + Members for every row", async () => {
    const parse = await parseGgGolfPdf(FIXTURE_BYTES);
    for (const r of parse.rows) {
      expect(r.totalRounds).toBe(r.guests + r.greenFees + r.members);
    }
  });

  it("stable sha-256 across identical bytes", async () => {
    const a = await parseGgGolfPdf(FIXTURE_BYTES);
    const b = await parseGgGolfPdf(FIXTURE_BYTES);
    expect(a.sourceFileHash).toBe(b.sourceFileHash);
    expect(a.sourceFileHash).toBe(
      // SHA-256 of the real fixture bytes (captured via the dump
      // helper during GOLF-HIST-1A diagnosis).
      "1095f799a650046daced108349397681630a3a77eb5ad4de6d613de9ee96b3b5",
    );
  });
});

// ----------------------------------------------------------------------------
// Fail-closed semantics via synthetic layouts.
// ----------------------------------------------------------------------------

/** Build a minimal GgGolfLayout from an array of row shapes. */
function makeLayout(rowSpecs: Array<{ y: number; items: Array<{ x: number; text: string }> }>): GgGolfLayout {
  const items: GgGolfLayoutItem[] = [];
  for (const r of rowSpecs) {
    for (const it of r.items) {
      items.push({ text: it.text, page: 1, x: it.x, yBaseline: r.y });
    }
  }
  return { items };
}

describe("GOLF-HIST-1A §2 — Fail-closed semantics", () => {
  it("empty layout → PARSE_FAILED, no period, no fabricated Jan-1-to-Dec-31 fallback", () => {
    const parse = parseGgGolfLayout({ items: [] }, "hash-empty");
    expect(parse.reconciliationStatus).toBe("PARSE_FAILED");
    expect(parse.rows).toHaveLength(0);
    expect(parse.reportingPeriodStart).toBeNull();
    expect(parse.reportingPeriodEnd).toBeNull();
    expect(parse.warnings.some((w) => w.kind === "NO_DAILY_ROWS")).toBe(true);
  });

  it("layout with headers but zero daily rows → PARSE_FAILED (no false RECONCILED)", () => {
    const layout = makeLayout([
      { y: 500, items: [{ x: 40, text: "Date 2026" }, { x: 105, text: "Weather" }, { x: 157, text: "Guests" }] },
    ]);
    const parse = parseGgGolfLayout(layout, "hash-headers-only");
    expect(parse.reconciliationStatus).toBe("PARSE_FAILED");
    expect(parse.reportYear).toBe(2026);  // we did find the year
    expect(parse.reportingPeriodStart).toBeNull();  // but refuse to fabricate a period
    expect(parse.reportingPeriodEnd).toBeNull();
  });

  it("rows but no totals footer → MISMATCH + explicit TOTALS_RECONCILIATION warning", () => {
    const layout = makeLayout([
      { y: 487, items: [{ x: 40, text: "Date 2026" }, { x: 105, text: "Weather" }] },
      {
        y: 470,
        items: [
          { x: 40, text: "Thu, Jan 1" }, { x: 125, text: "-" },
          { x: 173, text: "0" }, { x: 224, text: "0" }, { x: 275, text: "0" }, { x: 326, text: "0" },
          { x: 377, text: "0" }, { x: 428, text: "0" }, { x: 479, text: "0" }, { x: 530, text: "0" },
          { x: 581, text: "0" }, { x: 632, text: "0" }, { x: 683, text: "0" }, { x: 734, text: "0" },
        ],
      },
    ]);
    const parse = parseGgGolfLayout(layout, "hash-no-totals");
    expect(parse.reconciliationStatus).toBe("MISMATCH");
    expect(parse.sourceTotals).toBeNull();
    expect(parse.rows).toHaveLength(1);
    expect(parse.warnings.some((w) => w.kind === "TOTALS_RECONCILIATION")).toBe(true);
  });

  it("duplicate date in source → DUPLICATE_DATE warning + drops second occurrence", () => {
    const date = (yBase: number, label: string, nums: number[]) => ({
      y: yBase,
      items: [
        { x: 40, text: label }, { x: 125, text: "-" },
        ...nums.map((n, i) => ({ x: 173 + i * 51, text: String(n) })),
      ],
    });
    const layout = makeLayout([
      { y: 487, items: [{ x: 40, text: "Date 2026" }] },
      date(470, "Thu, Jan 1", [0, 0, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0]),
      date(453, "Thu, Jan 1", [0, 0, 20, 20, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    const parse = parseGgGolfLayout(layout, "hash-dup");
    expect(parse.rows).toHaveLength(1); // first wins
    expect(parse.warnings.some((w) => w.kind === "DUPLICATE_DATE")).toBe(true);
  });

  it("row Total ≠ Guests + GreenFees + Members → ROW_TOTAL_MISMATCH warning + MISMATCH", () => {
    const layout = makeLayout([
      { y: 487, items: [{ x: 40, text: "Date 2026" }] },
      {
        y: 470,
        items: [
          { x: 40, text: "Thu, Jan 1" }, { x: 125, text: "-" },
          { x: 173, text: "0" }, { x: 224, text: "0" }, { x: 275, text: "10" }, { x: 326, text: "99" }, // bogus total
          { x: 377, text: "0" }, { x: 428, text: "0" }, { x: 479, text: "0" }, { x: 530, text: "0" },
          { x: 581, text: "0" }, { x: 632, text: "0" }, { x: 683, text: "0" }, { x: 734, text: "0" },
        ],
      },
      {
        y: 400,
        items: [
          { x: 40, text: "Totals" },
          { x: 173, text: "0" }, { x: 224, text: "0" }, { x: 275, text: "10" }, { x: 326, text: "99" },
          { x: 377, text: "0" }, { x: 428, text: "0" }, { x: 479, text: "0" }, { x: 530, text: "0" },
          { x: 581, text: "0" }, { x: 632, text: "0" }, { x: 683, text: "0" }, { x: 734, text: "0" },
        ],
      },
    ]);
    const parse = parseGgGolfLayout(layout, "hash-bad-row-total");
    expect(parse.reconciliationStatus).toBe("MISMATCH");
    expect(parse.warnings.some((w) => w.kind === "ROW_TOTAL_MISMATCH")).toBe(true);
  });

  it("corrupt / image-only PDF → extractor returns empty items → PARSE_FAILED", async () => {
    // Not a PDF — pdf-parse rejects, our extractor swallows and
    // returns an empty layout, so the parser emits PARSE_FAILED.
    const parse = await parseGgGolfPdf(Buffer.from("not a pdf"));
    expect(parse.reconciliationStatus).toBe("PARSE_FAILED");
    expect(parse.rows).toHaveLength(0);
    expect(parse.reportingPeriodStart).toBeNull();
    expect(parse.reportingPeriodEnd).toBeNull();
    expect(parse.warnings.some((w) => w.kind === "NO_DAILY_ROWS")).toBe(true);
  });
});
