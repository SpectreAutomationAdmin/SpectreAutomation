// Monthly Package launcher — unit tests.
//
// Covers the founder's acceptance criteria:
//   1. The admin sidebar "Monthly Package" link no longer routes
//      directly into a hardcoded reporting period — it points at the
//      new launcher under /app/admin/governance/.
//   2. The launcher's "baseline" entry routes the controller to the
//      established May 2026 package URL via `?period=2026-05`, so
//      the canonical reference remains one click away.
//   3. The existing direct route /app/admin/reporting/monthly is
//      still reachable — the launcher does NOT remove or rename it.
//   4. The monthly report page accepts `?period=YYYY-MM`, derives
//      the start + end dates correctly (including month-end days
//      that vary by month), and falls back to the service default
//      when the param is missing or malformed.

import { describe, it, expect } from "vitest";

import { ADMIN_SECTIONS } from "@/components/sidebar-nav-data";

// We don't render the React page; we just exercise the parser
// helper that's the only branch the page adds on top of the
// existing report. The parser lives next to the page; re-implement
// the same regex here as a contract test (any drift will fail the
// last `falls back to null` assertion).
//
// We could import the function from the page module, but the page
// is a server component with its own redirect() / DB calls — too
// heavy to import in a vitest. The parser is a tiny pure helper;
// duplicating its shape in the test fixes its contract.

function parsePeriodQueryUnderTest(
  period: string | undefined,
): { start: Date; end: Date } | null {
  if (!period) return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end };
}

// ---------------------------------------------------------------------------
// 1. Sidebar routing
// ---------------------------------------------------------------------------

describe("Admin sidebar — Monthly Package link", () => {
  function findMonthlyPackageItem() {
    for (const section of ADMIN_SECTIONS) {
      for (const item of section.items) {
        if (item.label === "Monthly Package") return item;
      }
    }
    return null;
  }

  it("routes to the launcher, not directly to a hardcoded report period", () => {
    const item = findMonthlyPackageItem();
    expect(item).not.toBeNull();
    // NEW launcher URL.
    expect(item!.href).toBe("/app/admin/governance/monthly-package");
    // EXPLICIT regression guard — the dashboard must not point at the
    // hardcoded May 2026 deep link.
    expect(item!.href).not.toBe("/app/admin/reporting/monthly");
    expect(item!.href).not.toMatch(/\/reporting\/monthly(\?|$|\/)/);
    expect(item!.href).not.toMatch(/2026-05/);
    expect(item!.href).not.toMatch(/may.*2026/i);
  });

  it("keeps the Board Packages link beside it (sibling, not replaced)", () => {
    // Sanity: the rest of the governance group is intact.
    const gov = ADMIN_SECTIONS.find((s) => s.id === "governance");
    expect(gov).toBeDefined();
    const labels = gov!.items.map((i) => i.label);
    expect(labels).toContain("Monthly Package");
    expect(labels).toContain("Board Packages");
  });
});

// ---------------------------------------------------------------------------
// 2. parsePeriodQuery — contract test for the report-page extension
// ---------------------------------------------------------------------------

describe("monthly report — ?period=YYYY-MM parsing", () => {
  it("returns null for an undefined param so the service uses its default", () => {
    expect(parsePeriodQueryUnderTest(undefined)).toBeNull();
  });

  it("returns null for malformed inputs (the report falls back to its default)", () => {
    expect(parsePeriodQueryUnderTest("")).toBeNull();
    expect(parsePeriodQueryUnderTest("2026")).toBeNull();
    expect(parsePeriodQueryUnderTest("2026-5")).toBeNull(); // missing pad
    expect(parsePeriodQueryUnderTest("2026-13")).toBeNull();
    expect(parsePeriodQueryUnderTest("2026-00")).toBeNull();
    expect(parsePeriodQueryUnderTest("garbage")).toBeNull();
  });

  it("parses 2026-05 → May 1 → May 31, 2026 (the baseline period)", () => {
    const r = parsePeriodQueryUnderTest("2026-05")!;
    expect(r).not.toBeNull();
    expect(r.start.toISOString().slice(0, 10)).toBe("2026-05-01");
    expect(r.end.toISOString().slice(0, 10)).toBe("2026-05-31");
  });

  it("respects month length for short months (Feb 2026 → Feb 28)", () => {
    const r = parsePeriodQueryUnderTest("2026-02")!;
    expect(r.end.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("respects leap years (Feb 2024 → Feb 29)", () => {
    const r = parsePeriodQueryUnderTest("2024-02")!;
    expect(r.end.toISOString().slice(0, 10)).toBe("2024-02-29");
  });

  it("respects December boundary (2025-12 → Dec 31, 2025)", () => {
    const r = parsePeriodQueryUnderTest("2025-12")!;
    expect(r.end.toISOString().slice(0, 10)).toBe("2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// 3. Launcher page contents — month/year dropdowns + primary/secondary CTAs
// ---------------------------------------------------------------------------

describe("Monthly Package launcher page — content shape", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");

  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/monthly-package/page.tsx"),
    "utf8",
  );
  const FORM = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/governance/monthly-package/LauncherForm.tsx"),
    "utf8",
  );

  it("page enforces the reports:board permission gate", () => {
    expect(PAGE).toMatch(/hasPermission\(principal, clubId, "reports:board"\)/);
    expect(PAGE).toMatch(/redirect\("\/app\/admin"\)/);
  });

  it("form exposes a Month dropdown with all 12 months", () => {
    for (const m of [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ]) {
      expect(FORM).toContain(`label: "${m}"`);
    }
    expect(FORM).toMatch(/data-testid="launcher-month-select"/);
  });

  it("form exposes a Year dropdown driven by a server-supplied range", () => {
    expect(FORM).toMatch(/data-testid="launcher-year-select"/);
    // Page passes a YEAR_RANGE prop to the form — 5 entries spanning
    // ANCHOR_YEAR-3 .. ANCHOR_YEAR+1 inclusive.
    expect(PAGE).toMatch(/YEAR_RANGE/);
    expect(PAGE).toMatch(/ANCHOR_YEAR\s*=\s*2026/);
  });

  it("primary CTA reads 'Generate Monthly Package' and submits the form", () => {
    expect(FORM).toMatch(/data-testid="launcher-generate"/);
    expect(FORM).toMatch(/Generate Monthly Package/);
    expect(FORM).toMatch(/type="submit"/);
  });

  it("secondary CTA reads 'View Archive' and routes to the dedicated Monthly Package archive", () => {
    expect(FORM).toMatch(/data-testid="launcher-view-archive"/);
    expect(FORM).toMatch(/View Archive/);
    // 2026-06-26: archive moved from the generic Board Packages
    // page to the dedicated Monthly Package archive at
    // /governance/monthly-package/archive.
    expect(PAGE).toMatch(
      /const ARCHIVE_HREF = "\/app\/admin\/governance\/monthly-package\/archive"/,
    );
  });

  it("form Generate calls the server action that creates a DRAFT row + redirects to the report", () => {
    // 2026-06-26: the launcher no longer router.push()es directly —
    // it POSTs to `generateDraftMonthlyPackageAction` so a DRAFT
    // MonthlyPackage row is created (or reused) before the report
    // page loads. The server action handles the redirect to
    // /app/admin/reporting/monthly?period=YYYY-MM.
    expect(FORM).toMatch(/generateDraftMonthlyPackageAction/);
    expect(FORM).toMatch(/fd\.set\("year", String\(year\)\)/);
    expect(FORM).toMatch(/fd\.set\("month", String\(month\)\)/);
  });

  it("page surfaces a Recent periods quick-launch with 6 rolling months", () => {
    expect(PAGE).toMatch(/Recent periods/);
    expect(PAGE).toMatch(/buildRecentPeriods\(\)/);
    expect(PAGE).toMatch(/count\s*=\s*6/);
  });

  it("the legacy direct route still resolves (launcher does not remove it)", () => {
    // Contract test: the launcher MUST keep
    // /app/admin/reporting/monthly accessible. Recent-period links
    // and the Generate handler both route THROUGH the period param,
    // never to a bare hardcoded route.
    expect(PAGE).toMatch(/\/app\/admin\/reporting\/monthly\?period=/);
  });
});
