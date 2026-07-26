import { test } from "@playwright/test";
import { writeFileSync } from "fs";

// Locate the Equity Value Over Time + Operating Results panels on
// the Saguaro single-page document. Saguaro #pXX slugs are anchor
// scrolls into one long document — we need the actual y-offsets +
// the .panel container dimensions for each chart card.

const VIEWPORT = { width: 1440, height: 900 };

test("locate Saguaro Equity + Operating panels", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // Find the .panel that contains "Equity Value Over Time" and the
  // .panel that contains "Operating Results". For each, walk UP from
  // the panel-header text node until we hit the .panel container.
  const info = await page.evaluate(() => {
    function nearestPanel(el: Element | null): Element | null {
      let cur = el;
      while (cur) {
        const cls = (cur as HTMLElement).className?.toString?.() ?? "";
        if (cls.split(/\s+/).includes("panel")) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      // Add scrollY because getBoundingClientRect is viewport-relative
      // and we want document-relative coordinates.
      return {
        docX: Math.round((r.x + window.scrollX) * 100) / 100,
        docY: Math.round((r.y + window.scrollY) * 100) / 100,
        w: Math.round(r.width * 100) / 100,
        h: Math.round(r.height * 100) / 100,
      };
    }
    const all = Array.from(document.querySelectorAll(".panel-header"));
    const out: any[] = [];
    for (const ph of all) {
      const txt = (ph.textContent || "").trim().slice(0, 120);
      const panel = nearestPanel(ph);
      if (!panel) continue;
      out.push({
        title: txt.split("\n")[0],
        headerText: txt,
        panelClass: (panel as HTMLElement).className?.toString?.().slice(0, 80) ?? "",
        panelRect: rectOf(panel),
        headerRect: rectOf(ph),
        hasSvg: !!panel.querySelector("svg"),
        hasCanvas: !!panel.querySelector("canvas"),
      });
    }
    return {
      docHeight: document.body.scrollHeight,
      panels: out,
    };
  });

  writeFileSync("test-results/saguaro-survey/panels-located.json", JSON.stringify(info, null, 2), "utf8");

  // Now scroll the equity + operating panels into view and capture
  // them individually with surrounding context.
  const target = (needle: string) =>
    info.panels.find((p) => p.title.startsWith(needle) || p.title.includes(needle));

  const equity = target("Equity Value Over Time");
  const operating = target("Operating Results");

  for (const [name, p] of [["equity", equity], ["operating", operating]] as const) {
    if (!p) continue;
    // Scroll to the panel.
    await page.evaluate(({ y }) => window.scrollTo({ top: y - 80, behavior: "instant" as ScrollBehavior }), {
      y: p.panelRect.docY,
    });
    await page.waitForTimeout(400);
    // Clip-screenshot the panel itself.
    await page.screenshot({
      path: `test-results/saguaro-survey/panel-${name}.png`,
      clip: {
        x: Math.max(0, p.panelRect.docX - 8),
        y: 80,
        width: Math.min(p.panelRect.w + 16, VIEWPORT.width),
        height: Math.min(p.panelRect.h + 16, VIEWPORT.height - 80),
      },
    });
    // Also capture context — full viewport while scrolled to the panel.
    await page.screenshot({
      path: `test-results/saguaro-survey/context-${name}.png`,
    });
  }
});
