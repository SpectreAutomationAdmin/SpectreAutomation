// Payroll Admin Phase 1 — static-shell visual acceptance evidence.
//
// Reference: docs/design/payroll/payroll-admin-desktop-1440x900-approved.png
// Dimensions: 1440 x 900
// SHA-256:    d741321543eedbf3fa7991978132956d1f57359c4b01fce9f939c7948e72a7ce
//
// The spec:
//   - fails LOUDLY if the reference file changes (SHA-256 mismatch);
//   - loads /preview/payroll-admin-static at exactly 1440x900 dsf=1;
//   - verifies no horizontal scrollbar;
//   - DOM-asserts each of the 7 regions exists;
//   - writes reference / browser-render / side-by-side / overlay /
//     difference images and 7 region crops.
//
// DOM assertions are regression only — visual acceptance is by the
// founder inspecting the artifacts.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const OUT = path.resolve("test-results/payroll-admin-phase1");
fs.mkdirSync(OUT, { recursive: true });

const REF_SOURCE = path.resolve("docs/design/payroll/payroll-admin-desktop-1440x900-approved.png");
const REF_SHA    = "d741321543eedbf3fa7991978132956d1f57359c4b01fce9f939c7948e72a7ce";
const REF_W = 1440, REF_H = 900;

const REFERENCE  = path.join(OUT, "reference-1440x900.png");
const RENDER     = path.join(OUT, "browser-1440x900.png");
const SIDEBYSIDE = path.join(OUT, "side-by-side-1440x900.png");
const OVERLAY    = path.join(OUT, "overlay-1440x900.png");
const DIFF       = path.join(OUT, "difference-1440x900.png");

// Region crop rectangles (x, y, w, h) — measured off the approved
// reference at 1440x900. The crop box is applied to BOTH images so
// the side-by-side crop remains a fair comparison.
const REGIONS: Array<{ id: string; box: { x: number; y: number; width: number; height: number } }> = [
  { id: "01-chrome",              box: { x: 0,   y: 0,   width: 184,  height: 900 } },
  { id: "02-header-workflow",     box: { x: 184, y: 52,  width: 1256, height: 190 } },
  { id: "03-kpis",                box: { x: 184, y: 245, width: 1256, height: 100 } },
  { id: "04-workspace",           box: { x: 184, y: 350, width: 900,  height: 500 } },
  { id: "05-payroll-actions",     box: { x: 1090, y: 350, width: 350, height: 200 } },
  { id: "06-checklist",           box: { x: 1090, y: 560, width: 350, height: 180 } },
  { id: "07-pay-period-footer",   box: { x: 184, y: 780, width: 1256, height: 120 } },
];

test.use({ viewport: { width: REF_W, height: REF_H } });

test.describe.serial("Payroll Admin Phase 1 static-shell visual", () => {
  test.setTimeout(180_000);

  test("A. reference SHA-256 + dimensions immutable", async () => {
    expect(fs.existsSync(REF_SOURCE)).toBeTruthy();
    const bytes = fs.readFileSync(REF_SOURCE);
    const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
    expect(actualSha, "reference PNG SHA-256 has changed — stop and reconcile with the founder").toBe(REF_SHA);
    // Read IHDR to confirm dimensions.
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    expect({ w, h }).toEqual({ w: REF_W, h: REF_H });
  });

  test("B. static shell renders at 1440x900, no horizontal overflow, all 7 regions in DOM", async ({ page }) => {
    await page.goto("http://localhost:3000/preview/payroll-admin-static", { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, "horizontal overflow at 1440").toBeLessThanOrEqual(REF_W);
    // Region 1 chrome
    await expect(page.getByText("SPECTRE").first()).toBeVisible();
    await expect(page.getByText("Coulee Ridge Golf & Country Club").first()).toBeVisible();
    await expect(page.getByText("Jennifer Smith").first()).toBeVisible();
    // Region 2 header + workflow
    await expect(page.getByRole("heading", { name: "Weekly Payroll" })).toBeVisible();
    await expect(page.getByText("IN PROGRESS")).toBeVisible();
    for (const n of ["Prepare", "Review", "Approvals", "Calculate", "Review & Adjust", "Submit", "Approved", "Posted"]) {
      await expect(page.getByText(n, { exact: true }).first()).toBeVisible();
    }
    // Region 3 KPI
    for (const l of ["Employees", "Total Hours", "Estimated Gross Pay", "Adjustments", "Exceptions"]) {
      await expect(page.getByText(l, { exact: true }).first()).toBeVisible();
    }
    // Region 4 workspace
    for (const l of ["Employees", "Exceptions (3)", "Adjustments (7)", "Approvals", "Summary"]) {
      await expect(page.getByText(l, { exact: true }).first()).toBeVisible();
    }
    for (const emp of ["Taylor Hourly", "Riley Preview", "Casey Preview", "Devon Preview", "Chris Turcato", "Lise Montsion", "Alex Chen", "Jordan Keller", "Morgan West", "Jamie Park"]) {
      await expect(page.getByText(emp, { exact: true }).first()).toBeVisible();
    }
    // Region 5-6-7
    await expect(page.getByRole("heading", { name: "Payroll Actions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pre-Calculation Checklist" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pay Period Information" })).toBeVisible();
    await expect(page.getByText("© 2026 Spectre Automation. All rights reserved.")).toBeVisible();
  });

  test("C. capture browser render + build reference/side-by-side/overlay/difference", async ({ browser, page }) => {
    // Copy reference for evidence.
    fs.copyFileSync(REF_SOURCE, REFERENCE);

    await page.goto("http://localhost:3000/preview/payroll-admin-static", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: RENDER, fullPage: false, clip: { x: 0, y: 0, width: REF_W, height: REF_H } });

    // ---------------- side-by-side ----------------
    const refB64 = fs.readFileSync(REFERENCE).toString("base64");
    const rendB64 = fs.readFileSync(RENDER).toString("base64");
    const sideHtml = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:12px;padding:12px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE 1440x900 (approved)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">BROWSER 1440x900 (/preview/payroll-admin-static)</div>
    <img src="data:image/png;base64,${rendB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
</div>
</body></html>`;
    let ctx = await browser.newContext({ viewport: { width: 2920, height: 940 } });
    let p2 = await ctx.newPage();
    await p2.setContent(sideHtml);
    await p2.waitForLoadState("networkidle");
    await p2.screenshot({ path: SIDEBYSIDE, fullPage: true });
    await ctx.close();

    // ---------------- overlay ----------------
    const overlayHtml = `<!doctype html><html><body style="margin:0;background:#fff;">
<div style="position:relative;width:1440px;height:900px;">
  <img src="data:image/png;base64,${refB64}" style="position:absolute;top:0;left:0;width:1440px;height:900px;image-rendering:pixelated;"/>
  <img src="data:image/png;base64,${rendB64}" style="position:absolute;top:0;left:0;width:1440px;height:900px;image-rendering:pixelated;opacity:0.5;mix-blend-mode:multiply;"/>
  <div style="position:absolute;top:6px;left:8px;background:rgba(255,255,255,0.85);padding:4px 8px;font:600 12px system-ui;color:#222;">
    OVERLAY 1440x900 (reference base + browser render 50% multiply)
  </div>
</div>
</body></html>`;
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    p2 = await ctx.newPage();
    await p2.setContent(overlayHtml);
    await p2.waitForLoadState("networkidle");
    await p2.screenshot({ path: OVERLAY, fullPage: false });
    await ctx.close();

    // ---------------- difference (pixel-diff) ----------------
    const refPixels = decodePng(REFERENCE);
    const rendPixels = decodePng(RENDER);
    if (refPixels.width !== rendPixels.width || refPixels.height !== rendPixels.height) {
      throw new Error(`Dimension mismatch: ${refPixels.width}x${refPixels.height} vs ${rendPixels.width}x${rendPixels.height}`);
    }
    const { width: W, height: H } = refPixels;
    const diffData = Buffer.alloc(W * H * 4);
    let diffPixelCount = 0, sumAbsError = 0;
    for (let i = 0; i < refPixels.data.length; i += 4) {
      const dr = Math.abs(refPixels.data[i]     - rendPixels.data[i]);
      const dg = Math.abs(refPixels.data[i + 1] - rendPixels.data[i + 1]);
      const db = Math.abs(refPixels.data[i + 2] - rendPixels.data[i + 2]);
      const maxDelta = Math.max(dr, dg, db);
      if (maxDelta < 8) {
        diffData[i] = 240; diffData[i+1] = 240; diffData[i+2] = 240; diffData[i+3] = 255;
      } else {
        diffPixelCount++;
        sumAbsError += maxDelta;
        const intensity = Math.min(255, maxDelta * 2);
        diffData[i] = 255; diffData[i+1] = 255 - intensity; diffData[i+2] = 255 - intensity; diffData[i+3] = 255;
      }
    }
    encodePng(DIFF, W, H, diffData);
    console.log(`[phase1] differing pixels: ${diffPixelCount.toLocaleString()} / ${(W*H).toLocaleString()} (${(diffPixelCount/(W*H)*100).toFixed(2)}%)`);
    console.log(`[phase1] mean absolute error (max channel per pixel): ${(sumAbsError/(W*H)).toFixed(2)}`);

    expect(fs.existsSync(RENDER)).toBe(true);
    expect(fs.existsSync(SIDEBYSIDE)).toBe(true);
    expect(fs.existsSync(OVERLAY)).toBe(true);
    expect(fs.existsSync(DIFF)).toBe(true);
  });

  test("D. 7 region-crop side-by-sides", async ({ browser }) => {
    for (const region of REGIONS) {
      const refCrop = await cropPngToBase64(REFERENCE, region.box);
      const rendCrop = await cropPngToBase64(RENDER, region.box);
      const box = region.box;
      const html = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:8px;padding:8px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:4px 8px;background:#eef;color:#123;font:600 11px system-ui;">REFERENCE ${region.id} ${box.width}x${box.height}</div>
    <img src="data:image/png;base64,${refCrop}" style="display:block;width:${box.width}px;height:${box.height}px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:4px 8px;background:#efe;color:#123;font:600 11px system-ui;">BROWSER ${region.id} ${box.width}x${box.height}</div>
    <img src="data:image/png;base64,${rendCrop}" style="display:block;width:${box.width}px;height:${box.height}px;image-rendering:pixelated;"/>
  </div>
</div>
</body></html>`;
      const ctx = await browser.newContext({ viewport: { width: box.width * 2 + 40, height: box.height + 60 } });
      const p2 = await ctx.newPage();
      await p2.setContent(html);
      await p2.waitForLoadState("networkidle");
      await p2.screenshot({ path: path.join(OUT, `region-${region.id}-side-by-side.png`), fullPage: true });
      await ctx.close();
    }
  });
});

// -------- helpers --------
async function cropPngToBase64(sourcePath: string, box: { x: number; y: number; width: number; height: number }): Promise<string> {
  const img = decodePng(sourcePath);
  const buf = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const srcOff = ((box.y + y) * img.width + (box.x + x)) * 4;
      const dstOff = (y * box.width + x) * 4;
      buf[dstOff]   = img.data[srcOff];
      buf[dstOff+1] = img.data[srcOff+1];
      buf[dstOff+2] = img.data[srcOff+2];
      buf[dstOff+3] = img.data[srcOff+3];
    }
  }
  const tmp = path.join(OUT, "._crop.png");
  encodePng(tmp, box.width, box.height, buf);
  const b64 = fs.readFileSync(tmp).toString("base64");
  fs.unlinkSync(tmp);
  return b64;
}
function decodePng(filepath: string): { width: number; height: number; data: Buffer } {
  const buf = fs.readFileSync(filepath);
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idats: Buffer[] = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos); pos += 4;
    const type = buf.slice(pos, pos + 4).toString("ascii"); pos += 4;
    const data = buf.slice(pos, pos + length); pos += length;
    pos += 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9);
    } else if (type === "IDAT") { idats.push(data); }
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const inflated = zlib.inflateSync(Buffer.concat(idats));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const sl = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(sl);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const line = Buffer.from(inflated.slice(src, src + sl));
    src += sl;
    for (let x = 0; x < sl; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[x] = (line[x] + a) & 0xFF; break;
        case 2: line[x] = (line[x] + b) & 0xFF; break;
        case 3: line[x] = (line[x] + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pr) & 0xFF; break;
        }
      }
      prev[x] = line[x];
    }
    for (let x = 0; x < width; x++) {
      const off = y * width * 4 + x * 4;
      if (colorType === 6) {
        rgba[off]=line[x*4]; rgba[off+1]=line[x*4+1]; rgba[off+2]=line[x*4+2]; rgba[off+3]=line[x*4+3];
      } else if (colorType === 2) {
        rgba[off]=line[x*3]; rgba[off+1]=line[x*3+1]; rgba[off+2]=line[x*3+2]; rgba[off+3]=255;
      } else if (colorType === 0) {
        rgba[off]=line[x]; rgba[off+1]=line[x]; rgba[off+2]=line[x]; rgba[off+3]=255;
      }
    }
  }
  return { width, height, data: rgba };
}
function encodePng(filepath: string, width: number, height: number, rgba: Buffer): void {
  const sl = width * 4;
  const raw = Buffer.alloc(height * (sl + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (sl + 1)] = 0;
    rgba.copy(raw, y * (sl + 1) + 1, y * sl, (y + 1) * sl);
  }
  const idat = zlib.deflateSync(raw);
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  chunks.push(pngChunk("IHDR", ihdr));
  chunks.push(pngChunk("IDAT", idat));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  fs.writeFileSync(filepath, Buffer.concat(chunks));
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
