// WEB-1B.2 — local multi-viewport capture (dev server).

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";

const LOCAL = "http://localhost:3000/";

const SECTION_PROBES: Array<[string, string]> = [
  ["Hero",             "The Operating System for Private Clubs."],
  ["Philosophy",       "Software should disappear."],
  ["MissionControl",   "Know what matters before you go looking for it."],
  ["Intelligence",     "notices what you might not"],
  ["ConnectedSystem",  "Information should live once."],
  ["ClubOperations",   "One operating system. Every part of the club."],
  ["Confidence",       "Confidence is more valuable than speed."],
  ["ClubIdentity",     "Your club. Not ours."],
  ["Result",           "how club management software should have always worked"],
  ["Footer",           "Built for the people who run exceptional clubs"],
];

const VIEWPORTS: Array<{ w: number; h: number; tag: string; deviceScaleFactor?: number; mobile?: boolean }> = [
  { w: 1440, h: 900, tag: "1440x900" },
  { w: 1024, h: 900, tag: "1024x900" },
  { w:  900, h: 900, tag: "0900x900" },
  { w:  768, h: 900, tag: "0768x900" },
  { w:  390, h: 844, tag: "0390x844", deviceScaleFactor: 3, mobile: true },
  { w:  375, h: 812, tag: "0375x812", deviceScaleFactor: 3, mobile: true },
];

test("WEB-1B.2 local capture", async ({ browser }) => {
  test.setTimeout(300_000);
  const results: Record<string, any> = {};
  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      isMobile: !!v.mobile,
    });
    const page = await ctx.newPage();
    await page.goto(LOCAL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
    await page.evaluate(() =>
      document.querySelectorAll(".w1b-reveal").forEach((el) => el.classList.add("is-visible")),
    );
    await page.waitForTimeout(600);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const step = Math.floor(v.h * 0.75);
    for (let y = 0; y < scrollHeight; y += step) {
      await page.evaluate((yy: number) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const data = await page.evaluate((probes: string[][]) => {
      const findY = (needle: string): number | null => {
        const wanted = needle.replace(/\s+/g, " ").toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const t = (node.textContent || "").replace(/\s+/g, " ").toLowerCase();
          if (t.includes(wanted)) {
            const parent = node.parentElement as HTMLElement | null;
            if (parent) {
              const r = parent.getBoundingClientRect();
              return Math.round(r.top + window.scrollY);
            }
          }
        }
        return null;
      };
      const out: Record<string, number | null> = {};
      for (const [label, needle] of probes) out[label] = findY(needle);
      return { scrollHeight: document.documentElement.scrollHeight, boundaries: out };
    }, SECTION_PROBES);
    await page.screenshot({ path: `test-results/w1b2-local-${v.tag}-full.png`, fullPage: true });
    results[v.tag] = { ...data, viewport: { w: v.w, h: v.h } };
    await ctx.close();
  }
  fs.writeFileSync("test-results/w1b2-local-report.json", JSON.stringify(results, null, 2));
  expect(results["1440x900"].scrollHeight).toBeGreaterThan(1000);
});
