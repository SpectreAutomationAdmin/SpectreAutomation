// GOLF-HIST-1 (2026-10-05) — GGGolf PDF parser tests.
//
// §1  Reconciliation against the known January 2026 totals from the
//     founder's source file (reproduced verbatim as text fixture).
// §2  Daily coverage: 31 dates, 23 active days, 8 real-zero days.
// §3  No commit path invoked — pure parser behaviour.
// §4  Per-row Total = Guests + GreenFees + Members for every row.

import { describe, expect, it } from "vitest";
import { parseGgGolfText } from "@/lib/imports/golf-activity/gggolf-pdf-parser";

// Verbatim text extracted from the January 2026 PDF the founder
// supplied — reproduced here as a fixture so tests can run offline.
// The parser must reconcile both daily rows AND the Totals footer to
// the directive-specified totals.
const JANUARY_2026_FIXTURE = `
Silver Springs Golf & Country Club
Daily Report
Date 2026 Weather
Nb.
Guests
Nb.
Grnfees
Nb.
Members Total
Nb.
Juniors
Nb.
Women
Nb.
Corpos
Nb.
Corpos Half Cart
Full 9
Cart
Half 9
Cart Free Cart
Thu, Jan 1 - 0 0 0 0 0 0 0 0 0 0 0 0
Fri, Jan 2 - 0 0 0 0 0 0 0 0 0 0 0 0
Sat, Jan 3 - 0 0 0 0 0 0 0 0 0 0 0 0
Sun, Jan 4 - 0 0 0 0 0 0 0 0 0 0 0 0
Mon, Jan 5 - 0 0 0 0 0 0 0 0 0 0 0 0
Tue, Jan 6 - 0 0 13 13 0 1 0 0 0 0 0 0
Wed, Jan 7 - 0 0 9 9 0 3 0 0 0 0 0 0
Thu, Jan 8 - 0 0 11 11 0 0 0 0 0 0 0 0
Fri, Jan 9 - 0 0 14 14 0 3 0 0 0 0 0 0
Sat, Jan 10 - 0 0 19 19 0 2 0 0 0 0 0 0
Sun, Jan 11 - 0 0 9 9 0 1 0 0 0 0 0 0
Mon, Jan 12 - 0 0 0 0 0 0 0 0 0 0 0 0
Tue, Jan 13 - 0 0 12 12 0 2 0 0 0 0 0 0
Wed, Jan 14 - 0 0 15 15 0 1 0 0 0 0 0 0
Thu, Jan 15 - 0 0 18 18 0 8 0 0 0 0 0 0
Fri, Jan 16 - 0 0 10 10 0 2 0 0 0 0 0 0
Sat, Jan 17 - 0 0 18 18 0 2 0 0 0 0 0 0
Sun, Jan 18 - 0 0 18 18 0 3 0 0 0 0 0 0
Mon, Jan 19 - 0 0 0 0 0 0 0 0 0 0 0 0
Tue, Jan 20 - 0 0 13 13 0 1 0 0 0 0 0 0
Wed, Jan 21 - 2 0 26 28 0 1 0 0 0 0 0 0
Thu, Jan 22 - 0 0 31 31 0 22 0 0 0 0 0 0
Fri, Jan 23 - 0 0 15 15 0 6 0 0 0 0 0 0
Weather : 1=Closed, 2=Very cold, 3=Rain, 4=Thunderstorms, 5=Showers, 6=Cloudy, 7=Partially cloudy, 8=Sunny
Printed Sunday, October 4, 2026 at 22:30:55 1 / 2
Silver Springs Golf & Country Club
Daily Report
Date 2026 Weather
Nb.
Guests
Nb.
Grnfees
Nb.
Members Total
Nb.
Juniors
Nb.
Women
Nb.
Corpos
Nb.
Corpos Half Cart
Full 9
Cart
Half 9
Cart Free Cart
Sat, Jan 24 - 0 0 24 24 2 3 0 0 0 0 0 0
Sun, Jan 25 - 0 0 13 13 0 1 0 0 0 0 0 0
Mon, Jan 26 - 0 0 0 0 0 0 0 0 0 0 0 0
Tue, Jan 27 - 0 0 15 15 0 3 0 0 0 0 0 0
Wed, Jan 28 - 2 0 22 24 0 0 0 0 0 0 0 0
Thu, Jan 29 - 0 0 28 28 0 16 0 0 0 0 0 0
Fri, Jan 30 - 0 0 26 26 0 9 0 0 0 0 0 0
Sat, Jan 31 - 0 0 18 18 0 4 0 0 0 0 0 0
Totals 4 0 397 401 2 94 0 0 0 0 0 0
`;

describe("GOLF-HIST-1 §1 — January 2026 reconciliation", () => {
  const parse = parseGgGolfText(JANUARY_2026_FIXTURE, "test-sha-256");

  it("parses all 31 daily rows for January 2026", () => {
    expect(parse.rows).toHaveLength(31);
    expect(parse.reportYear).toBe(2026);
    expect(parse.reportingPeriodStart.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(parse.reportingPeriodEnd.toISOString().slice(0, 10)).toBe("2026-01-31");
  });

  it("reconciles parsed daily sums to the directive-specified totals", () => {
    expect(parse.parsedTotals.guests).toBe(4);
    expect(parse.parsedTotals.greenFees).toBe(0);
    expect(parse.parsedTotals.members).toBe(397);
    expect(parse.parsedTotals.totalRounds).toBe(401);
    expect(parse.parsedTotals.juniors).toBe(2);
    expect(parse.parsedTotals.women).toBe(94);
    // Cart / corpo columns all zero in January.
    expect(parse.parsedTotals.corpos).toBe(0);
    expect(parse.parsedTotals.corposHalf).toBe(0);
    expect(parse.parsedTotals.fullCart).toBe(0);
    expect(parse.parsedTotals.nineCart).toBe(0);
    expect(parse.parsedTotals.halfCart).toBe(0);
    expect(parse.parsedTotals.freeCart).toBe(0);
  });

  it("extracts the source Totals footer with the same values", () => {
    expect(parse.sourceTotals).toBeTruthy();
    expect(parse.sourceTotals!.guests).toBe(4);
    expect(parse.sourceTotals!.members).toBe(397);
    expect(parse.sourceTotals!.totalRounds).toBe(401);
    expect(parse.sourceTotals!.juniors).toBe(2);
    expect(parse.sourceTotals!.women).toBe(94);
  });

  it("flags reconciliation as RECONCILED when parsed sums match the footer", () => {
    expect(parse.reconciliationStatus).toBe("RECONCILED");
  });
});

describe("GOLF-HIST-1 §2 — Daily coverage", () => {
  const parse = parseGgGolfText(JANUARY_2026_FIXTURE, "test-sha-256");

  it("preserves 23 active days + 8 real-zero days (Jan 1-5, 12, 19, 26)", () => {
    const activeDays = parse.rows.filter((r) => r.totalRounds > 0).length;
    const zeroDays = parse.rows.filter((r) => r.totalRounds === 0).length;
    expect(activeDays).toBe(23);
    expect(zeroDays).toBe(8);
    const zeroDateIsos = parse.rows
      .filter((r) => r.totalRounds === 0)
      .map((r) => r.activityDate.toISOString().slice(0, 10));
    expect(zeroDateIsos).toEqual([
      "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
      "2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26",
    ]);
  });

  it("stores all weather codes as the literal source token (all '-' for January)", () => {
    for (const r of parse.rows) {
      expect(r.rawWeatherCode).toBe("-");
    }
  });

  it("produces per-row Total == Guests + GreenFees + Members for every row", () => {
    for (const r of parse.rows) {
      expect(r.totalRounds).toBe(r.guests + r.greenFees + r.members);
    }
  });
});

describe("GOLF-HIST-1 §3 — Detects source-level problems", () => {
  it("flags MISMATCH when the Totals row is missing", () => {
    const noFooter = JANUARY_2026_FIXTURE.replace(
      /Totals 4 0 397 401 2 94 0 0 0 0 0 0/,
      "",
    );
    const parse = parseGgGolfText(noFooter, "test-sha-256");
    expect(parse.sourceTotals).toBeNull();
    expect(parse.reconciliationStatus).toBe("MISMATCH");
    expect(parse.warnings.some((w) => w.kind === "TOTALS_RECONCILIATION")).toBe(true);
  });

  it("flags MISMATCH when a row total disagrees with its components", () => {
    const tampered = JANUARY_2026_FIXTURE.replace(
      /Thu, Jan 22 - 0 0 31 31 0 22 0 0 0 0 0 0/,
      "Thu, Jan 22 - 0 0 31 42 0 22 0 0 0 0 0 0", // bogus Total
    );
    const parse = parseGgGolfText(tampered, "test-sha-256");
    expect(parse.reconciliationStatus).toBe("MISMATCH");
    expect(parse.warnings.some((w) => w.kind === "ROW_TOTAL_MISMATCH")).toBe(true);
  });

  it("flags duplicate dates in the source", () => {
    const duplicated = JANUARY_2026_FIXTURE.replace(
      /Fri, Jan 23 - 0 0 15 15 0 6 0 0 0 0 0 0/,
      "Fri, Jan 23 - 0 0 15 15 0 6 0 0 0 0 0 0\nFri, Jan 23 - 0 0 15 15 0 6 0 0 0 0 0 0",
    );
    const parse = parseGgGolfText(duplicated, "test-sha-256");
    expect(parse.warnings.some((w) => w.kind === "DUPLICATE_DATE")).toBe(true);
  });
});

describe("GOLF-HIST-1 §4 — Idempotency", () => {
  it("the file hash is stable across identical fixture parses", () => {
    const a = parseGgGolfText(JANUARY_2026_FIXTURE, "fixed-hash-123");
    const b = parseGgGolfText(JANUARY_2026_FIXTURE, "fixed-hash-123");
    // Same input, same hash — the commit service uses this as the
    // idempotency key with (clubId, sourceSystem, hash, period).
    expect(a.sourceFileHash).toBe(b.sourceFileHash);
    expect(a.rows.length).toBe(b.rows.length);
  });
});
