// COA-MAP-1A (2026-10-06) — closeout contract regressions.
//
//   §A  fs-group-projection consumes the AS-OF batch resolver with
//       asOf = periodEnd (canonical Board reporting is now effective-
//       dated, not Account.fsGroupId-latest).
//   §B  Account.fsGroupId remains in the schema as the compatibility
//       column for the 56 unmigrated consumers.
//   §C  Mapping Studio Preview surfaces the three period-aware
//       effective-date radio choices + the historical-consequence
//       note.
//   §D  AsOfGroupMetadata exposes `sortOrder` so canonical consumers
//       don't need a second DB round-trip for presentation order.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PROJECTION = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");
const RESOLVER   = path.join(REPO, "src/lib/coa-mapping/fs-group-asof-resolver.ts");
const UI         = path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-1A §A — canonical Board projection is effective-dated", () => {
  const src = stripComments(readFileSync(PROJECTION, "utf8"));

  it("imports the AS-OF batch resolver", () => {
    expect(src).toMatch(/import \{ resolveFinancialStatementGroupAsOfBatch \} from "@\/lib\/coa-mapping\/fs-group-asof-resolver"/);
  });

  it("invokes the batch resolver with asOf: periodEnd", () => {
    // The exact call shape used in fs-group-projection.
    expect(src).toMatch(/resolveFinancialStatementGroupAsOfBatch\(\{[\s\S]*?asOf:\s*periodEnd/);
  });

  it("passes every projection account id into the batch resolver", () => {
    expect(src).toMatch(/accountIds:\s*accounts\.map\(\(a\) => a\.id\)/);
  });

  it("prefers the AS-OF resolution over Account.fsGroup (compat fallback only)", () => {
    // AS-OF value is picked first; meta.fsGroup is only the fallback.
    expect(src).toMatch(/asOf\?\.key\s*\?\?\s*meta\.fsGroup\?\.key/);
    expect(src).toMatch(/asOf\?\.name\s*\?\?\s*meta\.fsGroup\?\.name/);
    expect(src).toMatch(/asOf\?\.sortOrder\s*\?\?\s*meta\.fsGroup\?\.sortOrder/);
    expect(src).toMatch(/asOf\?\.statement\s*\?\?\s*meta\.fsGroup\?\.statement/);
  });
});

describe("COA-MAP-1A §B — Account.fsGroupId retained as compat column", () => {
  const sqlite = readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8");
  const pg     = readFileSync(path.join(REPO, "prisma-postgres/schema.prisma"), "utf8");

  for (const [name, src] of [["sqlite", sqlite], ["postgres", pg]] as const) {
    it(`${name}: Account.fsGroupId still present`, () => {
      const idx = src.search(/^model Account \{/m);
      const body = idx >= 0 ? src.slice(idx, idx + 5000) : "";
      expect(body).toMatch(/fsGroupId\s+String\?/);
    });
  }
});

describe("COA-MAP-1A §C — Mapping Studio period-aware UX", () => {
  const src = readFileSync(UI, "utf8");

  it("builds currentPeriodIso from the first of the current month", () => {
    expect(src).toMatch(/currentPeriodStart\s*=\s*new Date\(Date\.UTC\(today\.getUTCFullYear\(\),\s*today\.getUTCMonth\(\),\s*1\)\)/);
    expect(src).toMatch(/currentPeriodIso/);
  });

  it("builds fiscalYearIso from January 1 of the current year", () => {
    expect(src).toMatch(/fiscalYearStart\s*=\s*new Date\(Date\.UTC\(today\.getUTCFullYear\(\),\s*0,\s*1\)\)/);
    expect(src).toMatch(/fiscalYearIso/);
  });

  for (const testid of [
    "coa-mapping-preview-effective-fieldset",
    "coa-mapping-effective-current-period",
    "coa-mapping-effective-fiscal-year",
    "coa-mapping-effective-custom",
    "coa-mapping-historical-note",
  ]) {
    it(`exposes [data-testid="${testid}"]`, () => {
      expect(src).toMatch(new RegExp(`data-testid="${testid.replace(/-/g, "\\-")}"`));
    });
  }

  it("still exposes legacy coa-mapping-preview-effective-from (custom-date input)", () => {
    // Existing E2E tests depend on this testid; the migration must
    // retain it rather than rename it.
    expect(src).toMatch(/data-testid="coa-mapping-preview-effective-from"/);
  });

  it("renders the collapsed current-period/fiscal-year label when both match", () => {
    expect(src).toMatch(/Current reporting period \/ fiscal year/);
  });

  it("historical-note copy is quiet and non-alarming (no modal / destructive language)", () => {
    expect(src).toMatch(/This change will update unpublished reporting from/);
    expect(src).toMatch(/Published Board packages will not change/);
    // The note itself (the historicalNote literal block) must not
    // contain alarming language.  "WARNING: " is used elsewhere in
    // the file for validation BLOCKED/WARNING preamble, which is
    // expected and unrelated to this quiet historical note.
    const noteIdx = src.indexOf("This change will update unpublished reporting");
    const noteBlock = src.slice(noteIdx, noteIdx + 500);
    expect(noteBlock).not.toMatch(/DANGER|⚠|WARNING:/);
  });
});

describe("COA-MAP-1A §D — AsOfGroupMetadata exposes sortOrder", () => {
  const src = stripComments(readFileSync(RESOLVER, "utf8"));

  it("AsOfGroupMetadata type has a sortOrder number field", () => {
    expect(src).toMatch(/export type AsOfGroupMetadata = \{[\s\S]*?sortOrder:\s*number;/);
  });

  it("single resolver selects sortOrder from fsGroup", () => {
    expect(src).toMatch(/sortOrder:\s*true/);
    expect(src).toMatch(/sortOrder:\s*row\.fsGroup\.sortOrder/);
  });

  it("batch resolver also returns sortOrder", () => {
    expect(src).toMatch(/sortOrder:\s*r\.fsGroup\.sortOrder/);
  });
});
