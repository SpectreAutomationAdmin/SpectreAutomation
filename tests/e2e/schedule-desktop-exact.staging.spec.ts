// STAGING mirror of the local exact 1:1 comparison spec.
// Captures the real /employee/schedule page as Taylor on staging
// at 1440x900 and produces the same 5 artifacts against the
// authoritative reference at docs/design/scheduling/
// employee-schedule-desktop-1440x900-approved.png.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.resolve("test-results/schedule-desktop-exact");
fs.mkdirSync(OUT, { recursive: true });
const REF_SOURCE = path.resolve("docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png");
const REFERENCE  = path.join(OUT, "reference.png");
const RENDER     = path.join(OUT, "staging-render.png");
const SIDEBYSIDE = path.join(OUT, "staging-side-by-side.png");
const OVERLAY    = path.join(OUT, "staging-overlay.png");
const DIFF       = path.join(OUT, "staging-diff.png");

const STAGING = "https://staging.spectreautomation.com";

async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

test.describe.serial("Staging desktop schedule — exact 1440x900 capture", () => {
  test.setTimeout(180_000);

  test("capture staging render + build artifacts", async ({ browser }) => {
    if (!fs.existsSync(REF_SOURCE)) throw new Error(`Reference missing at ${REF_SOURCE}`);
    fs.copyFileSync(REF_SOURCE, REFERENCE);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    await page.getByTestId('portal-desktop-shell').getByTestId('portal-schedule-week-grid').waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: RENDER, fullPage: false });
    await ctx.close();

    const refB64 = fs.readFileSync(REFERENCE).toString("base64");
    const rendB64 = fs.readFileSync(RENDER).toString("base64");

    const sideHtml = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:12px;padding:12px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE 1440x900 (authoritative repo PNG)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">STAGING RENDER 1440x900 (Playwright)</div>
    <img src="data:image/png;base64,${rendB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
</div>
</body></html>`;
    const ctx1 = await browser.newContext({ viewport: { width: 2920, height: 940 } });
    const page1 = await ctx1.newPage();
    await page1.setContent(sideHtml);
    await page1.waitForLoadState("networkidle");
    await page1.screenshot({ path: SIDEBYSIDE, fullPage: true });
    await ctx1.close();

    const overlayHtml = `<!doctype html><html><body style="margin:0;background:#fff;">
<div style="position:relative;width:1440px;height:900px;">
  <img src="data:image/png;base64,${refB64}"
       style="position:absolute;top:0;left:0;width:1440px;height:900px;image-rendering:pixelated;"/>
  <img src="data:image/png;base64,${rendB64}"
       style="position:absolute;top:0;left:0;width:1440px;height:900px;image-rendering:pixelated;opacity:0.5;mix-blend-mode:multiply;"/>
  <div style="position:absolute;top:6px;left:8px;background:rgba(255,255,255,0.85);padding:4px 8px;font:600 12px system-ui;color:#222;">
    STAGING overlay 1440x900 (reference base + staging render 50% multiply — no scaling)
  </div>
</div>
</body></html>`;
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    await page2.setContent(overlayHtml);
    await page2.waitForLoadState("networkidle");
    await page2.screenshot({ path: OVERLAY, fullPage: false });
    await ctx2.close();

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
    console.log(`\n=== STAGING DIFF STATS ===`);
    console.log(`Differing pixels: ${diffPixelCount.toLocaleString()} / ${(W*H).toLocaleString()} (${(diffPixelCount/(W*H)*100).toFixed(2)}%)`);
    console.log(`Mean absolute error (max channel per pixel): ${(sumAbsError/(W*H)).toFixed(2)}`);

    expect(fs.existsSync(RENDER)).toBe(true);
    expect(fs.existsSync(SIDEBYSIDE)).toBe(true);
    expect(fs.existsSync(OVERLAY)).toBe(true);
    expect(fs.existsSync(DIFF)).toBe(true);
    console.log(`\nSTAGING RENDER:   ${RENDER}`);
    console.log(`STAGING SIDEBYSIDE: ${SIDEBYSIDE}`);
    console.log(`STAGING OVERLAY:  ${OVERLAY}`);
    console.log(`STAGING DIFF:     ${DIFF}`);
  });
});

// ---------- shared PNG decode/encode (mirrored from local spec) ----------
function decodePng(filepath: string): { width: number; height: number; data: Buffer } {
  const buf = fs.readFileSync(filepath);
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks: Buffer[] = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos); pos += 4;
    const type = buf.slice(pos, pos + 4).toString("ascii"); pos += 4;
    const data = buf.slice(pos, pos + length); pos += length;
    pos += 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9);
    } else if (type === "IDAT") { idatChunks.push(data); }
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const scanlineBytes = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(scanlineBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const line = Buffer.from(inflated.slice(src, src + scanlineBytes));
    src += scanlineBytes;
    for (let x = 0; x < scanlineBytes; x++) {
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
      } else if (colorType === 4) {
        rgba[off]=line[x*2]; rgba[off+1]=line[x*2]; rgba[off+2]=line[x*2]; rgba[off+3]=line[x*2+1];
      }
    }
  }
  return { width, height, data: rgba };
}
function encodePng(filepath: string, width: number, height: number, rgba: Buffer): void {
  const scanlineBytes = width * 4;
  const raw = Buffer.alloc(height * (scanlineBytes + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (scanlineBytes + 1)] = 0;
    rgba.copy(raw, y * (scanlineBytes + 1) + 1, y * scanlineBytes, (y + 1) * scanlineBytes);
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
