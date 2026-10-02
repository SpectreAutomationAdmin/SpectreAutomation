// TB-HIST-8 (2026-10-02) — source-contract regression guards.
//
// These are source-pin tests that lock in the specific code changes
// this slice ships. End-to-end numeric validation runs separately
// against the committed Dec + Jan snapshots on staging (see
// tests/e2e/tb-hist-8-december-january.staging.spec.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const RESOLVER = readFileSync(path.join(REPO, "src/lib/accounting/reporting-balances.ts"), "utf8");
const REPORTS = readFileSync(path.join(REPO, "src/lib/accounting/reports.ts"), "utf8");
const LIVE_SYNTH = readFileSync(path.join(REPO, "src/lib/reporting/ledger/live-synthesis.ts"), "utf8");
const MONTHLY_PKG = readFileSync(path.join(REPO, "src/lib/reporting/monthly-package.ts"), "utf8");
const MONTHLY_PAGE = readFileSync(path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"), "utf8");

// -------------------------------------------------------------------
// §17.A-D — BS carry-forward resolver semantics
// -------------------------------------------------------------------
describe("TB-HIST-8 §17.A-D — Balance Sheet carry-forward resolver", () => {
  it("defines `findLatestCommittedTbSnapshotOnOrBefore` keyed on asOf: { lte }, ordered desc, limit 1", () => {
    // The new helper must query the latest committed TB snapshot
    // where asOf <= requestedDate, never a future snapshot.
    expect(RESOLVER).toMatch(/async function findLatestCommittedTbSnapshotOnOrBefore\(clubId: string, asOf: Date\)/);
    const fn = RESOLVER.match(/async function findLatestCommittedTbSnapshotOnOrBefore[\s\S]{0,600}?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/asOf:\s*\{\s*lte:/);
    expect(fn).toMatch(/orderBy:\s*\[\s*\{\s*asOf:\s*"desc"\s*\}/);
    expect(fn).toMatch(/entityKind:\s*"trial-balance"/);
    expect(fn).toMatch(/batchState:\s*"committed"/);
  });

  it("`reportingAccountBalances` exposes an `allowCarryForward` opt-in", () => {
    expect(RESOLVER).toMatch(/opts:\s*\{\s*allowCarryForward\?\:\s*boolean\s*\}\s*=\s*\{\s*\}/);
  });

  it("the hasAsOfOnly branch consults the carry-forward helper only when the opt-in is true", () => {
    expect(RESOLVER).toMatch(/const\s+exact\s*=\s*await\s+findExactCommittedTbSnapshot\(clubId,\s*asOf\);/);
    expect(RESOLVER).toMatch(/const\s+snapshot\s*=\s*exact\s*\?\?\s*\(opts\.allowCarryForward\s*\?[\s\S]{0,200}findLatestCommittedTbSnapshotOnOrBefore\(clubId,\s*asOf\)[\s\S]{0,80}:\s*null\)/);
  });

  it("the hasYtdSliceShape branch also honours the opt-in for BS current-year-earnings carry-forward", () => {
    expect(RESOLVER).toMatch(/const\s+exact\s*=\s*await\s+findExactCommittedTbSnapshot\(clubId,\s*filter\.to as Date\)/);
    expect(RESOLVER).toMatch(/exact\s*\?\?\s*\(opts\.allowCarryForward[\s\S]{0,300}findLatestCommittedTbSnapshotOnOrBefore\(clubId,\s*filter\.to as Date\)/);
  });

  it("`balanceSheet` opts into carry-forward; TB and IS do NOT", () => {
    // balanceSheet()
    expect(REPORTS).toMatch(/balanceSheet\(clubId:\s*string,\s*asOf:\s*Date\)[\s\S]{0,1500}reportingAccountBalances\(clubId,\s*\{\s*asOf\s*\},\s*\{\s*allowCarryForward:\s*true\s*\}\)/);
    // Current-year earnings opts in
    expect(REPORTS).toMatch(/reportingAccountBalances\(\s*clubId,\s*\{\s*from:\s*fy\.startDate,\s*to:\s*asOf\s*\},\s*\{\s*allowCarryForward:\s*true\s*\}/);
    // trialBalance() does NOT pass allowCarryForward
    const tbFn = REPORTS.match(/export async function trialBalance[\s\S]{0,800}?\n\}/)?.[0] ?? "";
    expect(tbFn).not.toMatch(/allowCarryForward/);
    // incomeStatement() does NOT pass allowCarryForward
    const isFn = REPORTS.match(/export async function incomeStatement\(clubId:[\s\S]{0,800}?\n\}/)?.[0] ?? "";
    expect(isFn).not.toMatch(/allowCarryForward/);
  });
});

// -------------------------------------------------------------------
// §17.G,H — Board package shared-service wiring
// -------------------------------------------------------------------
describe("TB-HIST-8 §17.G-H — Board package reads the shared IS resolver", () => {
  it("live-synthesis's IS path uses reportingAccountBalances (not raw accountBalances) + consolidation", () => {
    // CRLF-tolerant extractor: match from `export async function
    // synthesizeIncomeStatementSnapshot` through the first subsequent
    // export (or the function's own `^}` line in LF). Works on both
    // Linux (LF) and Windows (CRLF) checkouts.
    const normalized = LIVE_SYNTH.replace(/\r\n/g, "\n");
    const isSynth = normalized.match(/export async function synthesizeIncomeStatementSnapshot[\s\S]*?(?=\nexport |\n$)/)?.[0] ?? "";
    expect(isSynth).toMatch(/reportingAccountBalances\(\s*clubId,\s*\{\s*from:\s*periodStart,\s*to:\s*periodEnd\s*\},\s*\{\s*allowCarryForward:\s*true\s*\}/);
    expect(isSynth).toMatch(/consolidateAccountBalances\(rawBalances\)/);
    // The old direct `accountBalances({from, to})` call shape must not reappear here.
    expect(isSynth).not.toMatch(/const\s+balances\s*=\s*await\s+accountBalances\(clubId,\s*\{\s*\n?\s*from:\s*periodStart/);
  });

  it("live-synthesis imports both reportingAccountBalances and consolidateAccountBalances", () => {
    expect(LIVE_SYNTH).toMatch(/import\s+\{[^}]*reportingAccountBalances[^}]*\}\s*from\s*"@\/lib\/accounting\/reporting-balances"/);
    expect(LIVE_SYNTH).toMatch(/consolidateAccountBalances/);
  });
});

// -------------------------------------------------------------------
// §17.K-L — Live-tenant Exec Summary auxiliary guard (no false budget)
// -------------------------------------------------------------------
describe("TB-HIST-8 §17.K-L — hardcoded Exec Summary auxiliary neutralized on live tenants", () => {
  it("executiveSummary auxiliaryInputs is guarded by hasRealData", () => {
    expect(MONTHLY_PKG).toMatch(/const\s+execAuxiliaryInputs\s*=\s*hasRealData\s*\?\s*undefined\s*:\s*SILVER_SPRINGS_EXEC_SUMMARY_AUX/);
    expect(MONTHLY_PKG).toMatch(/const\s+execDemoFallback\s*=\s*hasRealData\s*\?\s*undefined/);
    // The old unconditional pass must be gone.
    expect(MONTHLY_PKG).not.toMatch(/auxiliaryInputs:\s*SILVER_SPRINGS_EXEC_SUMMARY_AUX,\s*demoFallback:\s*\(\)\s*=>\s*\n\s*buildExecutiveSummary/);
  });
});

// -------------------------------------------------------------------
// §17.M — No Silver Springs branding leakage on tenant-facing surfaces
// -------------------------------------------------------------------
describe("TB-HIST-8 §17.M — tenant branding leakage removed", () => {
  it("the Visual Summary eyebrow renders pkg.club.name, not a Silver Springs literal", () => {
    expect(MONTHLY_PAGE).not.toMatch(/eyebrow="Silver Springs Golf & Country Club · Visual Summary"/);
    expect(MONTHLY_PAGE).toMatch(/eyebrow=\{`\$\{pkg\.club\.name\}\s*·\s*Visual Summary`\}/);
  });

  it("the KPI Dashboard eyebrow renders pkg.club.name, not a Silver Springs literal", () => {
    expect(MONTHLY_PAGE).not.toMatch(/eyebrow="Silver Springs Golf & Country Club · KPI Dashboard"/);
    expect(MONTHLY_PAGE).toMatch(/eyebrow=\{`\$\{pkg\.club\.name\}\s*·\s*KPI Dashboard`\}/);
  });
});

// -------------------------------------------------------------------
// §17.N — Executive heading layout guards against long tenant names
// -------------------------------------------------------------------
describe("TB-HIST-8 §17.N — heading does not collide with Executive Briefing", () => {
  it("the identity column reserves right-side padding so wrapped lines don't bleed into the gutter", () => {
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-identity"[^>]*className="[^"]*lg:pr-10[^"]*xl:pr-14/);
  });

  it("the club-name heading uses a responsive clamp (3xl → 4xl → 5xl) with break-words", () => {
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-club-name"[\s\S]{0,400}text-3xl\/\[1\.15\][\s\S]{0,200}sm:text-4xl\/\[1\.15\][\s\S]{0,200}lg:text-5xl\/\[1\.15\]/);
    expect(MONTHLY_PAGE).toMatch(/data-testid="monthly-cover-club-name"[\s\S]{0,400}break-words/);
  });
});
