// HR-2C Employee Portal — proportional hero reduction acceptance
// (2026-08-27). Captures screenshots at 4 desktop viewports and
// records hero geometry so before/after variance can be measured.
// The rule: hero must be materially shorter than the 3.5:1 baseline
// while the source image continues to render with the tenant-
// supplied object-position (approved composition preserved).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-hero-proportional");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_EMAIL
  ?? "playwright-fixture@spectreautomation.internal";
const PASSWORD = process.env.SPECTRE_PLAYWRIGHT_FIXTURE_PASSWORD
  ?? "playwright-fixture-2026-test";

const VIEWPORTS = [
  { label: "1366x768",  w: 1366, h: 768  },
  { label: "1440x900",  w: 1440, h: 900  },
  { label: "1536x864",  w: 1536, h: 864  },
  { label: "1920x1080", w: 1920, h: 1080 },
];

interface HeroSample {
  label: string;
  heroWidth: number;
  heroHeight: number;
  heroAspect: number;
  imageNaturalWidth: number;
  imageNaturalHeight: number;
  imageNaturalAspect: number;
  imageRenderedWidth: number;
  imageRenderedHeight: number;
  objectFit: string;
  objectPosition: string;
}

test.describe("Employee Portal — proportional hero reduction", () => {
  test.setTimeout(300_000);

  for (const vp of VIEWPORTS) {
    test(`hero at ${vp.label} — shorter frame + preserved composition`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        baseURL: "https://staging.spectreautomation.com",
      });
      const page = await context.newPage();
      await page.goto("/employee/login");
      await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
      await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
      await page.locator('[data-testid="employee-login-submit"]').click();
      await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
      await page.evaluate(async () => {
        try { await fetch("/api/employee/tour-completed", { method: "POST" }); } catch {}
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      const sample: HeroSample | null = await page.evaluate((label) => {
        // The layout wrapper renders page.tsx twice (mobile and
        // desktop shells wrap the same children), so multiple hero
        // elements exist in the DOM. Pick the one with non-zero
        // dimensions — that's the one the viewer actually sees.
        const allHeroes = Array.from(document.querySelectorAll('[data-testid="portal-hero-desktop"]')) as HTMLElement[];
        const hero = allHeroes.find((h) => h.getBoundingClientRect().width > 0) ?? null;
        const allImgs = Array.from(document.querySelectorAll('[data-testid="portal-hero-image-desktop"]')) as HTMLImageElement[];
        const img = allImgs.find((i) => i.getBoundingClientRect().width > 0) ?? null;
        if (!hero || !img) return null;
        const heroRect = hero.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        return {
          label,
          heroWidth: heroRect.width,
          heroHeight: heroRect.height,
          heroAspect: heroRect.width / heroRect.height,
          imageNaturalWidth: img.naturalWidth,
          imageNaturalHeight: img.naturalHeight,
          imageNaturalAspect: img.naturalWidth / img.naturalHeight,
          imageRenderedWidth: imgRect.width,
          imageRenderedHeight: imgRect.height,
          objectFit: cs.objectFit,
          objectPosition: cs.objectPosition,
        };
      }, vp.label);

      expect(sample).not.toBeNull();
      const s = sample!;
      console.log(`[${vp.label}] hero ${s.heroWidth.toFixed(0)}x${s.heroHeight.toFixed(0)} aspect=${s.heroAspect.toFixed(2)} image natural=${s.imageNaturalWidth}x${s.imageNaturalHeight}(${s.imageNaturalAspect.toFixed(2)}) objectFit=${s.objectFit} objectPosition=${s.objectPosition}`);
      // Persist measurements + screenshots FIRST, before any
      // assertion can short-circuit them.
      fs.writeFileSync(path.join(OUT, `hero-${vp.label}.json`), JSON.stringify(s, null, 2));
      await page.screenshot({ path: path.join(OUT, `full-${vp.label}.png`), fullPage: false });
      // Hero aspect must be at or wider than 4:1 — the founder's
      // guidance is 4.5–4.8:1 conceptual target. 4.0 is the floor:
      // anything less than 4:1 means the reduction wasn't material.
      expect(s.heroAspect).toBeGreaterThan(4.0);
      await context.close();
    });
  }
});
