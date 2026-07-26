import { test, expect, type Page } from "@playwright/test";

// Founder-reported scrollspy bug 2026-06-19: after scrolling well
// into Financial Performance, the rail still highlights Executive
// Opening. Active state must update as the reader scrolls through
// each section — at every depth the dominant on-screen section
// should be the one highlighted.
//
// Verification protocol: scroll to each chapter's anchor, wait for
// the IntersectionObserver to settle, assert the corresponding rail
// row carries data-active="true" and that no other row does.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const VIEWPORTS_FOR_SCROLLSPY = [
  { label: "1366x768",  width: 1366, height: 768  },
  { label: "1440x900",  width: 1440, height: 900  },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

// Key landmark chapters from the acceptance-criteria list. Not every
// chapter — that would balloon the test runtime; these cover the
// representative spread (early / mid / late / very-late).
const LANDMARK_CHAPTERS: Array<[string, string]> = [
  ["financial-performance",            "Financial Performance"],
  ["stewardship-dashboard",       "Stewardship Dashboard"],
  ["capital-projects",     "Capital Projects"],
  ["weather-and-utilization",     "Weather & Utilization"],
  ["inventory-analysis",          "Inventory Analysis"],
];

for (const vp of VIEWPORTS_FOR_SCROLLSPY) {
  test(`rail active-state tracks scroll position at ${vp.label}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("reporting-shell-chapters").waitFor({ timeout: 20_000 });

    // Resolve every landmark's offsetTop in one round-trip.
    const targetsY = await page.evaluate((ids) => {
      return ids.map((id) => {
        const el = document.getElementById(id);
        return el ? el.offsetTop + 150 : -1;
      });
    }, LANDMARK_CHAPTERS.map(([id]) => id));

    // ── At scroll=0: cover is active ───────────────────────────
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await page.waitForTimeout(300);
    let active = await page.evaluate(() => {
      const a = document.querySelector('[data-testid^="reporting-chapter-"][data-active="true"]');
      return a ? a.getAttribute("data-testid") : null;
    });
    expect(active, `at ${vp.label} scroll=0 → active should be cover`).toBe("reporting-chapter-executive-opening");

    // ── Single forward sweep through every landmark ────────────
    for (let i = 0; i < LANDMARK_CHAPTERS.length; i++) {
      const [sectionId, label] = LANDMARK_CHAPTERS[i];
      const targetY = targetsY[i];
      expect(targetY, `${sectionId} must exist`).toBeGreaterThanOrEqual(0);

      await page.evaluate((tY) => window.scrollTo({ top: tY, behavior: "instant" as ScrollBehavior }), targetY);
      await page.waitForTimeout(350);

      active = await page.evaluate(() => {
        const a = document.querySelector('[data-testid^="reporting-chapter-"][data-active="true"]');
        return a ? a.getAttribute("data-testid") : null;
      });
      expect(
        active,
        `at ${vp.label} after scrolling to "${label}" (scrollY=${targetY}) the active row should be "reporting-chapter-${sectionId}" — got ${active}`,
      ).toBe(`reporting-chapter-${sectionId}`);
    }

    // ── Scroll back to top: cover becomes active again ─────────
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await page.waitForTimeout(350);
    active = await page.evaluate(() => {
      const a = document.querySelector('[data-testid^="reporting-chapter-"][data-active="true"]');
      return a ? a.getAttribute("data-testid") : null;
    });
    expect(
      active,
      `at ${vp.label} after scrolling back to top, cover should be active again — got ${active}`,
    ).toBe("reporting-chapter-executive-opening");
  });
}
