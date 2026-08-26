// HR mobile-hotfix (2026-08-27) — Chromium vs WebKit real-device
// diagnostic. Launches both browsers via Playwright's engine
// registry (ignoring project defaults), navigates each to the
// staging Employee Portal with ?viewportDebug=1, and captures the
// live viewport metrics from the ViewportDebugOverlay. Reports the
// visualViewport.scale, insets, and any DOM offenders.

import { test, chromium, webkit } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/portal-mobile-webkit-vs-chromium");
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = "c.s.turcato@gmail.com";
const PASSWORD = process.env.SPECTRE_STAGING_CHRIS_PASSWORD ?? "spectre-diagnostic-2026";

interface Sample {
  engine: "chromium" | "webkit";
  innerW: number; innerH: number;
  clientW: number; clientH: number;
  scrollW: number; scrollH: number;
  vvW: number | null; vvH: number | null; vvScale: number | null;
  vvOffL: number | null; vvOffT: number | null;
  dpr: number;
  offenders: Array<{ tag: string; testid: string | null; overflow: number }>;
}

async function measureOn(engine: "chromium" | "webkit"): Promise<Sample | null> {
  const browserType = engine === "chromium" ? chromium : webkit;
  let browser;
  try { browser = await browserType.launch({ headless: true }); }
  catch (err) {
    // WebKit binaries may not be installed on the CI/dev host.
    console.log(`[${engine}] launch failed — is the browser installed? ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true,
    userAgent: engine === "webkit"
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined,
    deviceScaleFactor: 3,
    baseURL: "https://staging.spectreautomation.com",
  });
  const page = await context.newPage();
  await page.goto("/employee/login");
  await page.locator('[data-testid="employee-login-email"]').fill(EMAIL);
  await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL(/\/employee(?!\/login)/, { timeout: 30_000 });
  // Land on the portal with the debug overlay.
  await page.goto("/employee?viewportDebug=1");
  await page.waitForTimeout(2500);

  const s: Sample = await page.evaluate((engineIn) => {
    const vv = (globalThis as unknown as { visualViewport?: VisualViewport }).visualViewport ?? null;
    const vw = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, r };
      })
      .filter(({ el, r }) => r.width > 0 && r.height > 0 && (r.left < -1 || r.right > vw + 1) && el.tagName !== "HTML" && el.tagName !== "BODY")
      .slice(0, 10)
      .map(({ el, r }) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid"),
        overflow: Math.max(0, Math.round(r.right - vw)),
      }));
    return {
      engine: engineIn as "chromium" | "webkit",
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      clientW: document.documentElement.clientWidth,
      clientH: document.documentElement.clientHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      vvW: vv?.width ?? null,
      vvH: vv?.height ?? null,
      vvScale: vv?.scale ?? null,
      vvOffL: vv?.offsetLeft ?? null,
      vvOffT: vv?.offsetTop ?? null,
      dpr: window.devicePixelRatio ?? 1,
      offenders,
    };
  }, engine);

  await page.screenshot({ path: path.join(OUT, `${engine}-390x844.png`), fullPage: true });
  await context.close();
  await browser.close();
  return s;
}

test.describe("Portal mobile — Chromium vs WebKit", () => {
  test.setTimeout(300_000);
  test("compare viewport metrics + capture overlay screenshot from both engines", async () => {
    const chr = await measureOn("chromium");
    const wk = await measureOn("webkit");
    for (const s of [chr, wk]) {
      if (!s) continue;
      console.log(`[${s.engine}] inner=${s.innerW}×${s.innerH} client=${s.clientW}×${s.clientH} scroll=${s.scrollW}×${s.scrollH}`);
      console.log(`  visualViewport=${s.vvW}×${s.vvH} scale=${s.vvScale} off=${s.vvOffL},${s.vvOffT} dpr=${s.dpr}`);
      if (s.offenders.length) {
        console.log(`  offenders (${s.offenders.length}):`);
        for (const o of s.offenders) console.log(`    - +${o.overflow}px  ${o.tag}${o.testid ? " [" + o.testid + "]" : ""}`);
      } else {
        console.log(`  offenders: 0`);
      }
    }
    fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify({ chromium: chr, webkit: wk }, null, 2));
  });
});
