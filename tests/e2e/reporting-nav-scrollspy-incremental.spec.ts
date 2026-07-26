import { test, expect, type Page } from "@playwright/test";

// Founder direction 2026-06-19: the rail's active row must reflect
// which section the reader is VISUALLY READING. The rule:
//
//   - Compute each section's visible-pixel height inside the usable
//     viewport (window.innerHeight − 80 px sticky header).
//   - The new active section is one that exceeds 60% of the usable
//     viewport AND has more visible pixels than the current active.
//   - Otherwise hold the current active, unless it has dropped below
//     10% ("meaningfully visible" floor) — then fall back to the
//     largest-visible section.
//
// This test walks the page in 400-px increments at every supported
// admin viewport. At each stop it computes "expected" using the
// SAME algorithm (with a tracked previous-active for hysteresis)
// and asserts the rail's actual active matches. Screenshot captured
// at the first mismatch.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const HEADER_HEIGHT = 80;
const ACTIVATE_THRESHOLD = 0.60;
const RELEASE_THRESHOLD = 0.10;

const CHAPTER_IDS = [
  "executive-opening",
  "financial-performance",
  "stewardship-dashboard",
  "statement-of-activities",
  "capital-fund",
  "capital-projects",
  "financial-position",
  "ar-aging",
  "operating-statistics",
  "departmental-p-and-l",
  "weather-and-utilization",
  "payroll-analysis",
  "f-and-b-statistics",
  "inventory-analysis",
] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const VIEWPORTS = [
  { label: "1366x768",  width: 1366, height: 768  },
  { label: "1440x900",  width: 1440, height: 900  },
  { label: "1600x900",  width: 1600, height: 900  },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

// Run the same algorithm in the page context. Takes the
// previously-active id (for hysteresis) and returns the next
// expected active id.
async function expectedActiveSection(page: Page, prev: string): Promise<string> {
  return await page.evaluate(
    ({ ids, headerHeight, activate, release, prev }) => {
      const viewportBottom = window.innerHeight;
      const usable = viewportBottom - headerHeight;
      if (usable <= 0) return prev;

      const measures: Array<{ id: string; visible: number; ratio: number }> = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const visibleTop = Math.max(rect.top, headerHeight);
        const visibleBottom = Math.min(rect.bottom, viewportBottom);
        const visible = Math.max(0, visibleBottom - visibleTop);
        measures.push({ id, visible, ratio: visible / usable });
      }

      const currentMeasure = measures.find((m) => m.id === prev);

      let challenger: { id: string; visible: number; ratio: number } | null = null;
      for (const m of measures) {
        if (m.id === prev) continue;
        if (m.ratio <= activate) continue;
        if (currentMeasure && m.visible <= currentMeasure.visible) continue;
        if (!challenger || m.visible > challenger.visible) challenger = m;
      }
      if (challenger) return challenger.id;

      if (!currentMeasure || currentMeasure.ratio < release) {
        let best = measures[0];
        for (const m of measures) {
          if (m.visible > best.visible) best = m;
        }
        return best ? best.id : prev;
      }

      return prev;
    },
    {
      ids: [...CHAPTER_IDS],
      headerHeight: HEADER_HEIGHT,
      activate: ACTIVATE_THRESHOLD,
      release: RELEASE_THRESHOLD,
      prev,
    },
  );
}

for (const vp of VIEWPORTS) {
  test(`scrollspy follows majority-visible algorithm at ${vp.label}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("reporting-shell-chapters").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);

    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const step = 400;
    let tracked = "executive-opening";
    const stops: Array<{ y: number; expected: string; actual: string | null }> = [];

    for (let y = 0; y < pageHeight - vp.height; y += step) {
      await page.evaluate((targetY) => window.scrollTo({ top: targetY, behavior: "instant" as ScrollBehavior }), y);
      await page.waitForTimeout(250);

      const expected = await expectedActiveSection(page, tracked);
      const actual = await page.evaluate(() => {
        const a = document.querySelector('[data-testid^="reporting-chapter-"][data-active="true"]');
        return a ? a.getAttribute("data-testid")?.replace("reporting-chapter-", "") ?? null : null;
      });
      stops.push({ y, expected, actual });
      // Track the EXPECTED active so hysteresis carries forward
      // through the walk (the implementation should match expected
      // at every stop; if it doesn't, that's the bug).
      tracked = expected;
    }

    const mismatches = stops.filter((s) => s.expected !== s.actual);
    if (mismatches.length > 0) {
      const first = mismatches[0];
      await page.evaluate((targetY) => window.scrollTo({ top: targetY, behavior: "instant" as ScrollBehavior }), first.y);
      await page.waitForTimeout(300);
      await page.screenshot({
        path: `test-results/scrollspy-fail-${vp.label}-y${first.y}.png`,
        fullPage: false,
      });
    }

    expect(
      mismatches,
      `at ${vp.label} majority-visible active mismatches at ${mismatches.length}/${stops.length} scroll stops.\n` +
        `First mismatch: scrollY=${mismatches[0]?.y} expected=${mismatches[0]?.expected} actual=${mismatches[0]?.actual}\n` +
        `All stops: ${JSON.stringify(stops, null, 2)}`,
    ).toEqual([]);
  });
}
