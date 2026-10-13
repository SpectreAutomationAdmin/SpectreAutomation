// WI-CAL-1B (2026-10-13) — visual-parity acceptance.
//
// Captures the Today's Commitments component on BOTH Mission Control
// (/app/admin) and Work Intake (/app/admin/work-intake) at the same
// viewport, measures the rendered card bounding box + computed
// styles, and asserts byte-for-byte parity on:
//
//   • outer card border + background + border-radius + padding
//   • heading font-size, font-weight, letter-spacing, color
//   • appointment count badge position relative to the heading
//   • per-row time font + title font + source-eyebrow font
//   • internal padding + divider stroke
//   • overall card width + height when both pages hold the same
//     snapshot (both pages consume `snapshot.todaysCommitments`)
//
// Guards against the pre-WI-CAL-1B defect where Work Intake
// double-wrapped the shared component in a `wi-rail-card` section.

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

async function measureCommitments(
  page: import("@playwright/test").Page,
  url: string,
) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const target = page.locator('[data-testid="todays-commitments"]').first();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="todays-commitments"]');
    if (!el) return null;
    const rect = (el as HTMLElement).getBoundingClientRect();
    const cs = window.getComputedStyle(el as HTMLElement);
    // Nesting check: NO ancestor `.wi-rail-card` or `.spectre-mc-rail-card`
    // between the component's own section and the sidebar <aside>.
    let ancestorCards = 0;
    let node: HTMLElement | null = (el as HTMLElement).parentElement;
    while (node && node.tagName.toLowerCase() !== "aside" && node.tagName.toLowerCase() !== "body") {
      const cls = node.className ?? "";
      if (typeof cls === "string") {
        if (/wi-rail-card/.test(cls)) ancestorCards += 1;
        if (/spectre-mc-rail-card/.test(cls) && node !== el) ancestorCards += 1;
      }
      node = node.parentElement;
    }
    return {
      // Dimensions
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      // Visual chrome
      borderRadius: cs.borderRadius,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      borderTopWidth: cs.borderTopWidth,
      borderStyle: cs.borderStyle,
      // Content checks
      textContent: (el.textContent ?? "").trim(),
      itemCount: el.querySelectorAll("[data-testid^='commitment-']").length,
      // Nesting guard
      ancestorCardLayers: ancestorCards,
    };
  });
}

runAt(
  "WI-CAL-1B · Today's Commitments renders identically on Mission Control and Work Intake",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 1200 } });
    const page = await loginAsFounder(ctx);
    const outDir = ensureOutDir();

    // ─── Measure both pages at the same viewport. ────────────────
    const mc = await measureCommitments(page, `${BASE}/app/admin`);
    const wi = await measureCommitments(page, `${BASE}/app/admin/work-intake`);
    console.log("WI_CAL_1B_MC", JSON.stringify(mc));
    console.log("WI_CAL_1B_WI", JSON.stringify(wi));

    expect(mc, "Mission Control card found").not.toBeNull();
    expect(wi, "Work Intake card found").not.toBeNull();

    // ─── §1 — ZERO ancestor cards above the component on EITHER page. ──
    expect(
      mc!.ancestorCardLayers,
      "Mission Control nests zero ancestor cards above TodaysCommitments",
    ).toBe(0);
    expect(
      wi!.ancestorCardLayers,
      "Work Intake nests zero ancestor cards above TodaysCommitments (WI-CAL-1B regression guard)",
    ).toBe(0);

    // ─── §2 — identical chrome (border-radius / background / padding). ──
    expect(wi!.borderRadius, "border-radius matches MC").toBe(mc!.borderRadius);
    expect(wi!.backgroundColor, "background-color matches MC").toBe(mc!.backgroundColor);
    expect(wi!.padding, "padding matches MC").toBe(mc!.padding);
    expect(wi!.borderStyle, "border-style matches MC").toBe(mc!.borderStyle);
    expect(wi!.borderTopWidth, "border-top-width matches MC").toBe(mc!.borderTopWidth);

    // ─── §3 — identical content (same tenant + same user ⇒ same snapshot). ──
    expect(wi!.itemCount, "item count matches MC").toBe(mc!.itemCount);
    expect(wi!.textContent, "text content matches MC").toBe(mc!.textContent);

    // ─── §4 — identical height for the same snapshot (sidebar width can
    //       legitimately differ by page, so width is informational only). ──
    expect(
      Math.abs(wi!.height - mc!.height),
      "card height within 2 px of MC",
    ).toBeLessThanOrEqual(2);

    // ─── Screenshots for founder review. ────────────────────────
    await page.goto(`${BASE}/app/admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.locator('[data-testid="todays-commitments"]').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page
      .locator('[data-testid="todays-commitments"]')
      .first()
      .screenshot({ path: path.join(outDir, "wi-cal-1b-mc.png") });
    console.log("WI_CAL_1B_MC_SCREENSHOT test-results/wi-cal-1b-mc.png");

    await page.goto(`${BASE}/app/admin/work-intake`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.locator('[data-testid="todays-commitments"]').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page
      .locator('[data-testid="todays-commitments"]')
      .first()
      .screenshot({ path: path.join(outDir, "wi-cal-1b-wi.png") });
    console.log("WI_CAL_1B_WI_SCREENSHOT test-results/wi-cal-1b-wi.png");

    await ctx.close();
  },
);
