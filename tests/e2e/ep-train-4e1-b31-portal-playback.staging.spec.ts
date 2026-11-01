// EP-TRAIN-4E-1 §3 (2026-11-01) — verify the RESTORED B31 R2 object
// is reachable via the authenticated portal/admin stream path,
// beyond just a HEAD check.  Reads a Range of bytes, inspects the
// MP4 ftyp signature, and confirms Content-Length matches the
// 49,475,360-byte expected size.

import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { loginAsFounder } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-4e1-b31-portal-playback");
fs.mkdirSync(outDir, { recursive: true });

// B31_STAGING_ACCEPTANCE v2 published versionId on Coulee Ridge.
const B31_VERSION_ID = "cmt7twe5s00029z87bicm8qqb";
const EXPECTED_SIZE = 49475360;

test.describe("EP-TRAIN-4E-1 :: B31 portal playback", () => {
  test.setTimeout(300_000);

  test("the restored shared video streams through the authenticated proxy, with correct size + MP4 signature + partial-content support", async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await loginAsFounder(ctx);
      const url = `${BASE}/api/hr/training/versions/${B31_VERSION_ID}/video`;

      // 1. Range request → expect 206 Partial Content, 1024 bytes
      //    of real body, ftyp signature at bytes 4-8.
      const rangeResp = await page.request.get(url, { headers: { Range: "bytes=0-1023" } });
      expect(rangeResp.status()).toBe(206);
      const rangeBody = Buffer.from(await rangeResp.body());
      expect(rangeBody.length).toBe(1024);
      expect(rangeBody.slice(4, 8).toString("ascii")).toBe("ftyp");

      // 2. HEAD request → expect Content-Length = EXPECTED_SIZE.
      //    (The route's HEAD-equivalent is a 0-byte Range request —
      //    we check Content-Length from the Range response's
      //    Content-Range header instead, which encodes the full size.)
      const contentRange = rangeResp.headers()["content-range"];
      expect(contentRange).toMatch(new RegExp(`^bytes 0-1023\\/${EXPECTED_SIZE}$`));

      // 3. A deeper Range from near the end — proves the object is
      //    fully present + the proxy honors arbitrary ranges
      //    (playback requires seeking, not just a sequential read).
      const nearEndStart = EXPECTED_SIZE - 2048;
      const tailResp = await page.request.get(url, { headers: { Range: `bytes=${nearEndStart}-${EXPECTED_SIZE - 1}` } });
      expect(tailResp.status()).toBe(206);
      const tailBody = Buffer.from(await tailResp.body());
      expect(tailBody.length).toBe(2048);
      // Save a tiny screenshot of the catalogue page proving the
      // tenant context is correct + no error state is visible.
      await page.goto(`${BASE}/app/admin/people/safety-training`, { waitUntil: "domcontentloaded" });
      await page.screenshot({ path: path.join(outDir, "01-admin-catalogue.png"), fullPage: true });
    } finally {
      await ctx.close();
    }
  });
});
