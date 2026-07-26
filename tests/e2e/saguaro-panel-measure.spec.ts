import { test } from "@playwright/test";
import { writeFileSync } from "fs";

// Deep measurement of the Saguaro Equity Value Over Time + Operating
// Results panels — the two specific cards being rebuilt. Walks each
// .panel's DOM, extracts every distinct text tier (font-size, family,
// weight, transform, color, line-height), every direct child
// container's bounding rect + computed style (padding, background,
// border), and the canvas chart's dimensions.

const VIEWPORT = { width: 1440, height: 900 };

test("measure Saguaro Equity + Operating panels", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const measurements = await page.evaluate(() => {
    function round(n: number) { return Math.round(n * 100) / 100; }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }
    function stylesOf(el: Element) {
      const s = window.getComputedStyle(el as HTMLElement);
      return {
        padding: `${s.paddingTop}/${s.paddingRight}/${s.paddingBottom}/${s.paddingLeft}`,
        background: s.backgroundColor,
        borderTop: `${s.borderTopWidth} ${s.borderTopColor}`,
        borderBottom: `${s.borderBottomWidth} ${s.borderBottomColor}`,
        borderRadius: s.borderTopLeftRadius,
        color: s.color,
        fontSize: s.fontSize,
        fontFamily: s.fontFamily.split(",")[0].replace(/['"]/g, ""),
        fontWeight: s.fontWeight,
        fontStyle: s.fontStyle,
        textTransform: s.textTransform,
        letterSpacing: s.letterSpacing,
        lineHeight: s.lineHeight,
        display: s.display,
        flexDirection: s.flexDirection,
        gap: s.gap,
        marginTop: s.marginTop,
        marginBottom: s.marginBottom,
      };
    }

    // Walk all direct + grandchild elements with their geometry +
    // styles. Skip non-renderable nodes.
    function walkPanel(panel: Element) {
      const out: any[] = [];
      // Snapshot the panel itself
      const panelRect = rectOf(panel);
      const panelStyles = stylesOf(panel);
      out.push({ depth: 0, tag: panel.tagName.toLowerCase(), classes: (panel as HTMLElement).className?.toString?.() ?? "", rect: panelRect, styles: panelStyles });
      // Walk descendants up to depth 4.
      function recurse(el: Element, depth: number) {
        if (depth > 5) return;
        for (const child of Array.from(el.children)) {
          const r = rectOf(child);
          if (r.w < 10 || r.h < 5) { recurse(child, depth + 1); continue; }
          const cls = (child as HTMLElement).className?.toString?.() ?? "";
          out.push({
            depth,
            tag: child.tagName.toLowerCase(),
            classes: cls.slice(0, 100),
            rect: r,
            styles: stylesOf(child),
            childCount: child.children.length,
            text: (child.children.length === 0 ? (child.textContent || "").trim().slice(0, 80) : null),
          });
          recurse(child, depth + 1);
        }
      }
      recurse(panel, 1);
      return out;
    }

    // Find the Equity + Operating panels.
    const panels = Array.from(document.querySelectorAll(".panel"));
    let equity: Element | null = null;
    let operating: Element | null = null;
    for (const p of panels) {
      const hdr = p.querySelector(".panel-header");
      const txt = (hdr?.textContent || "").trim();
      if (txt.startsWith("Equity Value Over Time")) equity = p;
      if (txt.startsWith("Operating Results")) operating = p;
    }
    return {
      equity: equity ? walkPanel(equity) : null,
      operating: operating ? walkPanel(operating) : null,
      docHeight: document.body.scrollHeight,
    };
  });

  writeFileSync(
    "test-results/saguaro-survey/panel-measurements.json",
    JSON.stringify(measurements, null, 2),
    "utf8",
  );
});
