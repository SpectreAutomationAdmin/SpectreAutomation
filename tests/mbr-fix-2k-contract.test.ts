// MBR-FIX-2K (2026-10-11) — AR Current % period-aware precise
// sentinel + policy-threshold guard.
//
// Root cause (staging DB-confirmed 2026-10-11):
//   • `prisma.arAgingImportBatch` holds ONE committed batch for
//     Coulee Ridge: `sourceEffectiveDate = 2026-01-31`.
//   • The AR resolver requires an exact-day match between
//     `sourceEffectiveDate` and the requested `asOf` (no carry-
//     forward).
//   • For Feb 2026 package, `resolveArAgingAsOf(Feb 28)` returns
//     `SOURCE_NOT_LOADED` → ratio-registry metric wraps it as
//     `provenance.availability === "SOURCE_NOT_CONNECTED"` with
//     reason "AR aging source not imported for 2026-02-28".
//
// Pre-fix behaviour: the stewardship adapter's generic fallback
// collapsed every unavailable state into the auxiliary sentinel
// "Source not connected — AR Aging projection pending."  The copy
// is imprecise (projection IS implemented; the operational gap is
// the missing month-end import).
//
// Fix pins:
//   §A  buildArCurrentCard distinguishes SOURCE_NOT_CONNECTED (with
//       a provenance.reason) from a completely-absent metric and
//       emits the resolver's period-aware reason verbatim.
//   §B  No favourable tone unless an approved policy threshold
//       exists (directive §6).  When no threshold is configured,
//       tone === "neutral" + "no policy target configured" copy.
//   §C  MBR-FIX-2J inventory correction: AR Current % is
//       PERIOD-CONDITIONALLY LIVE, not unconditionally LIVE.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-FIX-2K §A — precise period-aware sentinel", () => {
  const src = readFileSync(ADAPTER, "utf8");
  const code = stripComments(src);

  it("buildArCurrentCard detects SOURCE_NOT_CONNECTED with null value", () => {
    const idx = code.indexOf("function buildArCurrentCard");
    expect(idx).toBeGreaterThan(0);
    const body = code.slice(idx, idx + 4500);
    expect(body).toMatch(/provenance\.availability\s*===\s*"SOURCE_NOT_CONNECTED"/);
    expect(body).toMatch(/ar\.metric\.value\s*==\s*null/);
  });

  it("assessment surfaces resolver's provenance.reason verbatim", () => {
    const idx = code.indexOf("function buildArCurrentCard");
    const body = code.slice(idx, idx + 4500);
    expect(body).toMatch(/assessment:\s*ar\.metric\.provenance\.reason\s*\?\?/);
  });

  it("precise unavailable branch returns actual: '—' + tone: 'neutral'", () => {
    const idx = code.indexOf("function buildArCurrentCard");
    const body = code.slice(idx, idx + 4500);
    const branchStart = body.indexOf("SOURCE_NOT_CONNECTED");
    expect(branchStart).toBeGreaterThan(0);
    const branch = body.slice(branchStart, branchStart + 1200);
    expect(branch).toMatch(/actual:\s*"—"/);
    expect(branch).toMatch(/tone:\s*"neutral"/);
  });
});

describe("MBR-FIX-2K §B — policy-threshold guard", () => {
  const src = readFileSync(ADAPTER, "utf8");
  const code = stripComments(src);

  it("extracts threshold from aux budget label (demo convention) + null-checks it", () => {
    const idx = code.indexOf("function buildArCurrentCard");
    const body = code.slice(idx, idx + 4500);
    expect(body).toMatch(/const target = demoTargetMatch \? Number\(demoTargetMatch\[1\]\) \/ 100 : null/);
  });

  it("emits neutral tone + 'no policy target configured' when target is null", () => {
    const idx = code.indexOf("function buildArCurrentCard");
    const body = code.slice(idx, idx + 4500);
    expect(body).toMatch(/target == null[\s\S]{0,80}neutral/);
    expect(body).toMatch(/No policy target configured/);
  });

  it("Live-tenant unavailable auxiliary has NO budget label (so no implicit threshold leaks)", () => {
    // UNAVAILABLE_AUXILIARY_KPI_CARDS.operating.arCurrent should
    // not carry a `budget` field — otherwise the regex would
    // extract a threshold where none is approved.
    const idx = src.indexOf("UNAVAILABLE_AUXILIARY_KPI_CARDS");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 2500);
    const arBlockStart = block.indexOf("arCurrent:");
    expect(arBlockStart).toBeGreaterThan(0);
    const arBlock = block.slice(arBlockStart, arBlockStart + 400);
    // The sentinel row keeps whatIsIt/whyItMatters/assessment/actual/tone
    // but should not define a `budget` string.
    expect(arBlock).not.toMatch(/budget:\s*"Target/);
  });
});
