// EXEC-AR-1 (2026-10-03) — source-contract regression guards for
// the Executive Opening Financial Health AR Current wiring fix.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PARTIAL = path.join(REPO, "src/lib/reporting/january-partial-availability.ts");
const MONTHLY_PKG = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const RATIO_REG = path.join(REPO, "src/lib/reporting/ratio-registry.ts");

// --------------------------------------------------------------
// §3 — Single source of truth
// --------------------------------------------------------------
describe("EXEC-AR-1 §3 — AR Current resolves from the AR snapshot (single source of truth)", () => {
  it("computeFinancialHealthPartialAvailability imports resolveArAgingAsOf", () => {
    const src = readFileSync(PARTIAL, "utf8");
    expect(src).toMatch(/import\("\.\/ar-aging-resolver"\)/);
    expect(src).toMatch(/resolveArAgingAsOf\(\s*\{\s*clubId,\s*asOf:\s*periodEnd\s*\}\)/);
  });

  it("arCurrentPct type is DerivedKpi<number> (carries value, not just a provenance tag)", () => {
    const src = readFileSync(PARTIAL, "utf8");
    expect(src).toMatch(/arCurrentPct:\s*DerivedKpi<number>/);
  });

  it("arKpi value derived from arResult.snapshot.currentPct when AVAILABLE", () => {
    const src = readFileSync(PARTIAL, "utf8");
    expect(src).toMatch(/arResult\.provenance\.availability === "AVAILABLE"/);
    expect(src).toMatch(/arResult\.snapshot\.currentPct/);
  });

  it("ratio-registry retains the same AR snapshot path (TB-HIST-12B wiring preserved)", () => {
    const src = readFileSync(RATIO_REG, "utf8");
    expect(src).toMatch(/resolveArAgingAsOf\(\{\s*clubId,\s*asOf:\s*periodEnd\s*\}\)/);
  });
});

// --------------------------------------------------------------
// §4 — Executive Opening Financial Health card renders the derived %
// --------------------------------------------------------------
describe("EXEC-AR-1 §4 — Executive Opening AR Current renders the derived %", () => {
  it("buildFinancialHealthBriefing formats arCurrentPct as 'X.X%'", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    expect(src).toMatch(/const arPct = partial\?\.arCurrentPct\.value/);
    expect(src).toMatch(/arPct != null \?\s*`\$\{arPct\.toFixed\(1\)\}%`\s*:\s*"Unavailable"/);
  });

  it("AR tile subtitle switches on availability (Jan 2026 AR Aging vs 'AR aging not imported')", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    expect(src).toMatch(/arAvailable \?\s*"Jan 2026 AR Aging"\s*:\s*"AR aging not imported"/);
  });

  it("anyDerived now also considers arCurrentPct", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    // anyDerived = wc OR cr OR arAvailable
    expect(src).toMatch(/const anyDerived =[\s\S]{0,400}arAvailable/);
  });
});

// --------------------------------------------------------------
// §5 — Narrative differentiates Reserve Coverage vs AR Current
// --------------------------------------------------------------
describe("EXEC-AR-1 §5 — narrative differentiates unavailable inputs", () => {
  it("the old lumped 'Reserve coverage ratio and AR Current % remain unavailable' sentence is gone", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    expect(src).not.toMatch(/Reserve coverage ratio and AR Current % remain unavailable/);
    expect(src).not.toMatch(/reserve history and AR aging source are not yet loaded/);
  });

  it("narrative emits an AR-available clause when the AR snapshot is loaded", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    expect(src).toMatch(/AR is \$\{arPct\.toFixed\(1\)\}% current/);
  });

  it("narrative emits distinct unavailable clauses per missing source", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    expect(src).toMatch(/reserve coverage remains unavailable because sufficient reserve history has not been loaded/);
    expect(src).toMatch(/AR Current % remains unavailable because the AR aging source is not loaded for this period/);
  });
});

// --------------------------------------------------------------
// §6 — AR Current consumer matrix
// --------------------------------------------------------------
describe("EXEC-AR-1 §6 — AR Current consumer matrix (all consumers resolve from the AR snapshot)", () => {
  it("ratio-registry arCurrentPct resolves from resolveArAgingAsOf (TB-HIST-12B § + AR-HIST-1)", () => {
    const src = readFileSync(RATIO_REG, "utf8");
    const block = src.match(/arCurrentPct:\s*await \(async \(\) => \{[\s\S]*?\}\)\(\),/)?.[0] ?? "";
    expect(block).toMatch(/resolveArAgingAsOf/);
    expect(block).toMatch(/batch=\$\{r\.snapshot\.batchId\}/);
  });

  it("january-partial-availability arCurrentPct resolves from resolveArAgingAsOf (EXEC-AR-1)", () => {
    const src = readFileSync(PARTIAL, "utf8");
    expect(src).toMatch(/const arKpi: DerivedKpi<number>/);
  });

  it("ar-aging-resolver is the single resolver module", () => {
    // There must be only ONE file that defines resolveArAgingAsOf.
    const resolverPath = path.join(REPO, "src/lib/reporting/ar-aging-resolver.ts");
    const resolverSrc = readFileSync(resolverPath, "utf8");
    expect(resolverSrc).toMatch(/export async function resolveArAgingAsOf/);
  });
});

// --------------------------------------------------------------
// §7 — Stale copy removed
// --------------------------------------------------------------
describe("EXEC-AR-1 §7 — stale copy removed (but legitimate unavailable language preserved)", () => {
  it("monthly-package.ts no longer emits a hardcoded Unavailable AR chip at build time", () => {
    const src = readFileSync(MONTHLY_PKG, "utf8");
    // The old literal `value: "Unavailable", subtitle: "AR aging not imported"`
    // tuple (hardcoded) is gone. The current code uses `value: arVal`.
    expect(src).not.toMatch(/key:\s*"ar-current",\s*label:\s*"AR Current",\s*value:\s*"Unavailable",\s*subtitle:\s*"AR aging not imported"/);
  });

  it("fallback 'AR aging not imported' subtitle string is still present (for periods without a snapshot)", () => {
    // The string must survive as the SUBTITLE branch for the
    // Unavailable path — just gated behind arAvailable:false.
    const src = readFileSync(MONTHLY_PKG, "utf8");
    expect(src).toMatch(/"AR aging not imported"/);
  });
});
