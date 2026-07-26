// Monthly Reporting Package — close-button + launcher-preservation
// tests.
//
// Founder's spec:
//   • Closing the report from the admin ReportingShell routes the
//     controller back to the Monthly Package launcher
//     (/app/admin/governance/monthly-package), NOT the main admin
//     dashboard at /app/admin.
//   • If the report URL carried `?period=YYYY-MM`, the close link
//     forwards that as `?month=X&year=Y` so the launcher pre-
//     selects the period the controller was just viewing.
//   • The launcher page reads those query params and uses them as
//     LauncherForm defaults; malformed values fall back to the most
//     recently completed month.
//   • The Board / member view at /app/reports/monthly-package/[id]
//     has its OWN back link (to /app) and doesn't use the
//     ReportingShell — board behavior is unaffected.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 1. ReportingShell close link — routes to launcher, preserves period
// ---------------------------------------------------------------------------

describe("ReportingShell close link", () => {
  const SHELL = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/reporting/ReportingShell.tsx"),
    "utf8",
  );

  it("targets the Monthly Package launcher (not the admin dashboard)", () => {
    // Build the close href dynamically; the JSX references it as
    // `href={closeHref}`. The closeHref logic must include the
    // launcher path.
    expect(SHELL).toMatch(
      /closeHref\s*=\s*[\s\S]*?\/app\/admin\/governance\/monthly-package/,
    );
    // The legacy hardcoded `href="/app/admin"` literal must not
    // appear on the close <Link>. (The path may still appear in
    // unrelated lines — comments, neighbour links — so we scope to
    // the exit element.)
    const exitMatch = SHELL.match(
      /<Link[^>]+data-testid="reporting-shell-exit"[\s\S]+?<\/Link>/,
    );
    expect(exitMatch, "found the exit <Link>").not.toBeNull();
    expect(exitMatch![0]).not.toMatch(/href="\/app\/admin"/);
    expect(exitMatch![0]).toMatch(/href=\{closeHref\}/);
  });

  it("forwards the current ?period=YYYY-MM as ?year=Y&month=X to the launcher", () => {
    expect(SHELL).toMatch(
      /\/app\/admin\/governance\/monthly-package\?year=\$\{periodMatch\[1\]\}&month=\$\{Number\(periodMatch\[2\]\)\}/,
    );
  });

  it("falls back to no query string when the period param is missing / malformed", () => {
    // Plain launcher URL is referenced in the else branch.
    expect(SHELL).toMatch(/: "\/app\/admin\/governance\/monthly-package"/);
  });

  it("ARIA label reflects the new behavior (return to launcher)", () => {
    expect(SHELL).toMatch(/aria-label="Close report — return to Monthly Package launcher"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Launcher page — reads ?month=X&year=Y as form defaults
// ---------------------------------------------------------------------------

describe("MonthlyPackageLauncherPage — period preservation via searchParams", () => {
  const PAGE = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/admin/governance/monthly-package/page.tsx",
    ),
    "utf8",
  );

  it("page signature accepts searchParams.month + searchParams.year", () => {
    expect(PAGE).toMatch(/searchParams\?: \{ month\?: string; year\?: string \}/);
    expect(PAGE).toMatch(/MonthlyPackageLauncherPage\(\{\s*searchParams,?\s*\}/);
  });

  it("parseLauncherDefaults validates 1..12 / 1900..9999 ranges before accepting", () => {
    expect(PAGE).toMatch(/monthOk = Number\.isInteger\(m\) && m >= 1 && m <= 12/);
    expect(PAGE).toMatch(/yearOk = Number\.isInteger\(y\) && y >= 1900 && y <= 9999/);
  });

  it("LauncherForm receives the parsed defaults (not the hardcoded recents[0])", () => {
    // The page derives `defaultMonth` / `defaultYear` from
    // parseLauncherDefaults and threads them straight into the form.
    expect(PAGE).toMatch(/parseLauncherDefaults\(searchParams, fallbackDefault\)/);
    expect(PAGE).toMatch(/defaultMonth=\{defaultMonth\}/);
    expect(PAGE).toMatch(/defaultYear=\{defaultYear\}/);
    // The old hardcoded `Number(defaultRecent.periodKey.split("-")[1])`
    // is gone.
    expect(PAGE).not.toMatch(/defaultRecent\.periodKey\.split/);
  });

  it("fallback uses the most-recently-completed month (recents[0])", () => {
    expect(PAGE).toMatch(/fallbackDefault\s*=\s*\{[\s\S]*recents\[0\]/);
  });

  // Pure-function contract test of the parser (re-implemented inline
  // because the page module imports server-only code).
  function parseLauncherDefaults(
    searchParams: { month?: string; year?: string } | undefined,
    fallback: { reportingMonth: number; reportingYear: number },
  ): { defaultMonth: number; defaultYear: number } {
    const m = Number(searchParams?.month);
    const y = Number(searchParams?.year);
    const monthOk = Number.isInteger(m) && m >= 1 && m <= 12;
    const yearOk = Number.isInteger(y) && y >= 1900 && y <= 9999;
    return {
      defaultMonth: monthOk ? m : fallback.reportingMonth,
      defaultYear: yearOk ? y : fallback.reportingYear,
    };
  }

  const FB = { reportingMonth: 5, reportingYear: 2026 };

  it("parser: { month=6, year=2027 } → { 6, 2027 }", () => {
    expect(parseLauncherDefaults({ month: "6", year: "2027" }, FB)).toEqual({
      defaultMonth: 6,
      defaultYear: 2027,
    });
  });
  it("parser: missing values → fallback", () => {
    expect(parseLauncherDefaults(undefined, FB)).toEqual({
      defaultMonth: 5,
      defaultYear: 2026,
    });
    expect(parseLauncherDefaults({}, FB)).toEqual({
      defaultMonth: 5,
      defaultYear: 2026,
    });
  });
  it("parser: out-of-range / NaN → fallback", () => {
    expect(parseLauncherDefaults({ month: "0", year: "2027" }, FB).defaultMonth).toBe(5);
    expect(parseLauncherDefaults({ month: "13", year: "2027" }, FB).defaultMonth).toBe(5);
    expect(parseLauncherDefaults({ month: "abc", year: "2027" }, FB).defaultMonth).toBe(5);
    expect(parseLauncherDefaults({ month: "5", year: "1800" }, FB).defaultYear).toBe(2026);
    expect(parseLauncherDefaults({ month: "5", year: "junk" }, FB).defaultYear).toBe(2026);
  });
  it("parser: each field validates independently (one bad value still uses the other)", () => {
    expect(parseLauncherDefaults({ month: "7", year: "junk" }, FB)).toEqual({
      defaultMonth: 7,
      defaultYear: 2026,
    });
    expect(parseLauncherDefaults({ month: "junk", year: "2027" }, FB)).toEqual({
      defaultMonth: 5,
      defaultYear: 2027,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Board view — own back link unaffected by ReportingShell change
// ---------------------------------------------------------------------------

describe("Board view close behavior — unaffected", () => {
  const VIEW = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/app/app/reports/monthly-package/[id]/page.tsx",
    ),
    "utf8",
  );

  it("board view does NOT use ReportingShell (own surface, separate from the admin route)", () => {
    expect(VIEW).not.toMatch(/import.*ReportingShell/);
  });

  it("board view has its own back-to-dashboard link (target unchanged)", () => {
    expect(VIEW).toMatch(/data-testid="board-package-view-back"/);
    // The board page's back link points back to /app — appropriate
    // for both admin and member contexts (members land on
    // /app/member; admins land on /app/admin via redirects). The
    // launcher-routing change applies only to the admin
    // ReportingShell-rendered surface.
    expect(VIEW).toMatch(/href="\/app"/);
  });
});
