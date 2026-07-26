// Use CSSOM to find which CSS rule is applying border-radius:6px to the td.
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('form:has(input[name="email"][value="super@spectre.app"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");
  // Use Chrome DevTools Protocol to get matched rules
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: "tr[data-account-id] td:first-child" });
  const { matchedCSSRules, inherited } = await client.send("CSS.getMatchedStylesForNode", { nodeId });
  const radius = [];
  for (const m of matchedCSSRules) {
    const rule = m.rule;
    const styleText = rule.style.cssText || "";
    if (styleText.includes("border-radius") || styleText.includes("border")) {
      radius.push({
        selector: rule.selectorList.text,
        styleText,
        origin: rule.origin,
      });
    }
  }
  for (const inh of inherited) {
    for (const m of inh.matchedCSSRules || []) {
      const rule = m.rule;
      const styleText = rule.style.cssText || "";
      if (styleText.includes("border-radius")) {
        radius.push({
          selector: rule.selectorList.text,
          styleText,
          inherited: true,
          origin: rule.origin,
        });
      }
    }
  }
  console.log(JSON.stringify(radius, null, 2));
} finally { await browser.close(); }
