// WEB-1C.1 — LIVE DOM audit against deployed staging.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";

const STAGING = "https://staging.spectreautomation.com/";

const EXPECTED_INTEL = ["INVOICE RECEIVED", "CONTEXT RECOGNIZED", "READY FOR REVIEW"];
const FORBIDDEN_INTEL = ["GL PREPARED", "EXCEPTIONS FLAGGED", "RECOMMENDATION READY"];

test("WEB-1C.1 live content audit", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(STAGING, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  await page.waitForTimeout(800);
  const audit = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const intelRows = document.querySelectorAll(".w1b-intel-row");
    const intelLabels = Array.from(document.querySelectorAll(".w1b-intel-row-label"))
      .map((el) => (el as HTMLElement).innerText.trim());
    const sectionCount = document.querySelectorAll("section, footer").length;
    const findText = (needle: string) => bodyText.includes(needle);
    return {
      intelRowCount: intelRows.length,
      intelLabels,
      sectionCount,
      contentChecks: {
        heroHeadline: findText("The Operating System for Private Clubs."),
        philosophyHeadline: findText("Software should disappear."),
        mcHeadline: findText("Know what matters before you go looking for it."),
        mcTenantHillsborough: findText("HILLSBOROUGH"),
        mcGreeting: findText("Good morning, Alex."),
        mcStatus: findText("17:42"),
        mcCalloutAmount: findText("$42,680"),
        mcPriority03: findText("Payroll exceptions to confirm"),
        mcPriority02: findText("Member account approvals"),
        mcPriority01: findText("Banquet event staffing variance"),
        intelHeadline: findText("A colleague who notices what you might not"),
        infoHeadline: findText("Information should live once."),
        opsHeadline: findText("One operating system. Every part of the club."),
        confidenceHeadline: findText("Confidence is more valuable than speed."),
        confidenceBodyAnd: findText("And what happens if I do it?"),
        clubIdentityHeadline: findText("Your club. Not ours."),
        clubCedar: findText("CEDAR RIDGE"),
        clubLakes: findText("THE LAKES"),
        clubNorthfield: findText("NORTHFIELD"),
        resultEyebrow: findText("THE RESULT"),
        resultHeadline: findText("Finally."),
        footerLead: findText("Built for the people who run exceptional clubs"),
      },
    };
  });
  fs.writeFileSync("test-results/w1c1-live-audit.json", JSON.stringify(audit, null, 2));
  await ctx.close();

  expect(audit.intelRowCount).toBe(3);
  expect(audit.intelLabels).toEqual(EXPECTED_INTEL);
  for (const forbidden of FORBIDDEN_INTEL) {
    expect(audit.intelLabels).not.toContain(forbidden);
  }
  for (const [k, v] of Object.entries(audit.contentChecks)) {
    if (!v) console.warn("FAIL:", k);
  }
});
