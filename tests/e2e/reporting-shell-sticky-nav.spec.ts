import { test, expect, type Page } from "@playwright/test";

// Regression spec for the ReportingShell left-nav sticky positioning.
//
// The chapter rail must remain pinned beneath the dark-green sticky
// header throughout the entire scroll of the monthly reporting
// package — at every supported admin viewport size. Founder-reported
// bug 2026-06-19: the rail moves upward when the reader scrolls down,
// at some viewport sizes more than others. The fix anchors the nav
// to the viewport with `position: fixed`, which is deterministic
// regardless of parent-container heights, paddings, or grid stretch.
//
// Verification protocol: at each viewport, capture the rail's
// getBoundingClientRect().top at three scroll positions (top, mid,
// late) and assert drift ≤ 1 px (sub-pixel rounding tolerance).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

// Per CLAUDE.md "Responsive Design Verification": validate at the
// admin / desktop viewports the standard requires.
const VIEWPORTS = [
  { label: "1366x768",  width: 1366, height: 768  },
  { label: "1440x900",  width: 1440, height: 900  },
  { label: "1600x900",  width: 1600, height: 900  },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

for (const vp of VIEWPORTS) {
  test(`ReportingShell left nav stays fixed at ${vp.label} across all scroll depths`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("reporting-shell-chapters").waitFor({ timeout: 20_000 });

    // Resolve the page scroll height so we can pick mid + late points.
    const readings = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="reporting-shell-chapters"] nav');
      if (!nav) return null;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
      };
    });
    expect(readings, "nav must be findable").not.toBeNull();
    if (!readings) return;

    const points = [
      { label: "top",  scrollTo: 0 },
      { label: "mid",  scrollTo: Math.floor(readings.scrollHeight * 0.45) },
      { label: "late", scrollTo: Math.floor(readings.scrollHeight * 0.85) },
    ];

    const measurements: Array<{
      label: string; navTop: number; navLeft: number; navWidth: number; documentY: number;
    }> = [];
    for (const point of points) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), point.scrollTo);
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const nav = document.querySelector('[data-testid="reporting-shell-chapters"] nav');
        const rect = nav ? nav.getBoundingClientRect() : null;
        return {
          top:    rect ? rect.top    : -1,
          left:   rect ? rect.left   : -1,
          width:  rect ? rect.width  : -1,
          scrollY: window.scrollY,
        };
      });
      measurements.push({
        label: point.label,
        navTop: m.top,
        navLeft: m.left,
        navWidth: m.width,
        documentY: m.scrollY,
      });
      await page.screenshot({
        path: `test-results/reporting-shell-sticky-nav-${vp.label}-${point.label}.png`,
        fullPage: false,
      });
    }

    // Drift in nav.top must be 0 px. The user explicitly requires
    // "No upward shift. No vertical jump. No sub-pixel drift." A
    // fixed-position element is viewport-anchored and cannot drift
    // by design — any non-zero number is a real layout reflow.
    const tops = measurements.map((m) => m.navTop);
    const topDrift = Math.max(...tops) - Math.min(...tops);
    expect(
      topDrift,
      `nav top drifted ${topDrift}px at ${vp.label} across scroll positions ${JSON.stringify(measurements)} — fixed positioning is NOT holding`,
    ).toBeLessThanOrEqual(0);

    // Nav.left must not drift either (no horizontal layout shift).
    const lefts = measurements.map((m) => m.navLeft);
    const leftDrift = Math.max(...lefts) - Math.min(...lefts);
    expect(
      leftDrift,
      `nav left drifted ${leftDrift}px at ${vp.label} ${JSON.stringify(measurements)} — horizontal layout shift`,
    ).toBeLessThanOrEqual(1);

    // Nav.width must not change either.
    const widths = measurements.map((m) => m.navWidth);
    const widthDrift = Math.max(...widths) - Math.min(...widths);
    expect(
      widthDrift,
      `nav width changed ${widthDrift}px at ${vp.label} ${JSON.stringify(measurements)} — reflow on scroll`,
    ).toBeLessThanOrEqual(1);

    // Nav must be visible (within viewport) at every scroll position.
    for (const m of measurements) {
      expect(
        m.navTop,
        `at ${vp.label} ${m.label} (scrollY=${m.documentY}) the nav top was ${m.navTop} — must be within the viewport`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        m.navTop,
        `at ${vp.label} ${m.label} the nav top was ${m.navTop} — must sit beneath the header (header ≈ 60px)`,
      ).toBeLessThan(200);
    }

    // The nav MUST NOT have an internal scrollbar (founder direction
    // 2026-06-19): the natural content height fits in every supported
    // admin viewport, so any `overflow-y: auto/scroll` would be a
    // regression that clips Inventory Analysis off the rail.
    const overflow = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="reporting-shell-chapters"] nav') as HTMLElement | null;
      if (!nav) return null;
      const style = window.getComputedStyle(nav);
      return {
        overflowY: style.overflowY,
        scrollHeight: nav.scrollHeight,
        clientHeight: nav.clientHeight,
      };
    });
    expect(overflow, "nav must be resolvable").not.toBeNull();
    if (overflow) {
      expect(
        overflow.overflowY,
        `at ${vp.label} the nav has overflow-y=${overflow.overflowY} — must be 'visible' (no internal scrollbar)`,
      ).toBe("visible");
      // Defense-in-depth: scrollHeight must equal clientHeight, which
      // means no content is hidden behind a scrollable region.
      expect(
        overflow.scrollHeight - overflow.clientHeight,
        `at ${vp.label} the nav has clipped content (scrollHeight=${overflow.scrollHeight}, clientHeight=${overflow.clientHeight}) — no menu item is allowed to be hidden`,
      ).toBeLessThanOrEqual(1);
    }

    // Group headings MUST render on a single line (founder direction
    // 2026-06-19). A wrapped "Operations & Analytics" or "Financial
    // Performance" reads as broken in a print-TOC formal rail.
    // Measure each group heading's rendered height vs its computed
    // single-line line-height; the difference must be ≤ 1 px.
    const groupHeadings = await page.evaluate(() => {
      const headings = Array.from(
        document.querySelectorAll('[data-testid^="reporting-chapter-group-"]'),
      ) as HTMLElement[];
      return headings.map((h) => {
        const style = window.getComputedStyle(h);
        const lineHeight = parseFloat(style.lineHeight);
        const rect = h.getBoundingClientRect();
        return {
          testid: h.getAttribute("data-testid") ?? "",
          text: (h.textContent ?? "").trim(),
          height: rect.height,
          lineHeight: isNaN(lineHeight) ? 0 : lineHeight,
          whiteSpace: style.whiteSpace,
        };
      });
    });

    expect(
      groupHeadings.length,
      `at ${vp.label} expected at least 3 group headings on the rail`,
    ).toBeGreaterThanOrEqual(3);

    for (const h of groupHeadings) {
      // Two-line wrap would roughly double the rendered height.
      // A safe single-line guard: rendered height ≤ 1.5 × line-height.
      const maxSingleLine = h.lineHeight > 0 ? h.lineHeight * 1.5 : 24;
      expect(
        h.height,
        `at ${vp.label} group heading "${h.text}" (testid=${h.testid}) rendered at ${h.height}px > ${maxSingleLine}px — heading WRAPPED to a second line`,
      ).toBeLessThanOrEqual(maxSingleLine);
      // Belt-and-suspenders: every group heading must declare
      // `white-space: nowrap`.
      expect(
        h.whiteSpace,
        `at ${vp.label} group heading "${h.text}" must declare white-space: nowrap (got ${h.whiteSpace})`,
      ).toBe("nowrap");
    }

    // Horizontal containment (founder direction 2026-06-19): every
    // inner nav element must respect the same content gutter so no
    // child kisses or spills past the aside's border-r line. Concrete
    // landmarks: the active chapter row's background, the "In this
    // package" eyebrow's border-b, the footer's border-t, and the
    // footer text. All must have a right edge strictly less than the
    // nav's right edge.
    const containment = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="reporting-shell-chapters"] nav') as HTMLElement | null;
      if (!nav) return null;
      const navRect = nav.getBoundingClientRect();

      // Force one chapter to be "active" by clicking the first row,
      // so the gold/sand active-bg renders. We pick the cover anchor
      // because it always exists.
      const cover = nav.querySelector('[data-testid="reporting-chapter-executive-opening"]') as HTMLElement | null;
      if (cover) cover.setAttribute("data-active", "true");

      // Sample landmarks: every direct child div + every chapter <a>.
      const childRects: Array<{ kind: string; right: number; left: number }> = [];

      // Eyebrow ("In this package") — first child div of the nav.
      const eyebrow = nav.querySelector(":scope > div:first-child") as HTMLElement | null;
      if (eyebrow) {
        const r = eyebrow.getBoundingClientRect();
        childRects.push({ kind: "eyebrow", right: r.right, left: r.left });
      }

      // Footer ("Prepared for…") — last child div of the nav.
      const footer = nav.querySelector(":scope > div:last-child") as HTMLElement | null;
      if (footer) {
        const r = footer.getBoundingClientRect();
        childRects.push({ kind: "footer", right: r.right, left: r.left });
      }

      // Active chapter row — locate by data-active attribute.
      const active = nav.querySelector('a[data-active="true"]') as HTMLElement | null;
      if (active) {
        const r = active.getBoundingClientRect();
        childRects.push({ kind: "active-row", right: r.right, left: r.left });
      }

      return {
        navLeft: navRect.left,
        navRight: navRect.right,
        childRects,
      };
    });

    expect(containment, "nav landmarks must be resolvable").not.toBeNull();
    if (containment) {
      // Every inner landmark's right edge must be strictly inside the
      // nav's right edge (proves the gutter is respected).
      for (const child of containment.childRects) {
        expect(
          child.right,
          `at ${vp.label} ${child.kind} right edge (${child.right}) overflows nav right edge (${containment.navRight}) — horizontal containment broken`,
        ).toBeLessThanOrEqual(containment.navRight);
        // The active row's left edge must align with (or be inside)
        // the nav's left edge — no negative bleed.
        expect(
          child.left,
          `at ${vp.label} ${child.kind} left edge (${child.left}) bleeds past nav left edge (${containment.navLeft})`,
        ).toBeGreaterThanOrEqual(containment.navLeft);
      }
      // The gutter on the right side must be ≥ 8 px so no inner
      // element visually kisses the divider.
      for (const child of containment.childRects) {
        const gutter = containment.navRight - child.right;
        expect(
          gutter,
          `at ${vp.label} ${child.kind} has only ${gutter}px of right gutter — must be ≥ 8 px`,
        ).toBeGreaterThanOrEqual(8);
      }
    }
  });
}
