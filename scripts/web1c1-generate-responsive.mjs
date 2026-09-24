// WEB-1C.1 — pre-generate responsive photograph variants.
// Runs at build time (or manually); outputs to
// public/marketing/photography/responsive/{basename}-{width}.jpg
// and .webp for modern-browser delivery.

import sharp from "sharp";
import { mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve("public/marketing/photography");
const OUT_DIR = path.resolve("public/marketing/photography/responsive");

const PLAN = {
  // WEB-1C.3: cliffside clubhouse promoted to hero. Landscape composition
  // needs full width variants. Larger image, wider tonal range — bumped
  // quality since detail (clubhouse edges, coastline, sky gradient) matters.
  "spectre-clubhouse.jpg":          { widths: [480, 768, 1024, 1440, 1920, 2560], jpegQ: 82, webpQ: 76, avifQ: 62 },
  // WEB-1C.2: tree-framed image serves as Private Club Identity backdrop
  // (kept or removed per WEB-1C.3 §24 decision — implementation retains
  // the variants either way; MANIFEST records the rendering choice).
  "spectre-hero-club-flag.jpg":     { widths: [480, 768, 1024, 1440, 1920], jpegQ: 78, webpQ: 72, avifQ: 62 },
  // Retained for provenance only; NOT rendered on WEB-1C.3 homepage.
  "spectre-18-flag.jpg":            { widths: [480, 768, 1024, 1440, 1920], jpegQ: 70, webpQ: 62, avifQ: 55 },
  "spectre-course-atmosphere.jpg":  { widths: [320, 480, 640, 800, 1200],   jpegQ: 78, webpQ: 72 },
  "spectre-irons-detail.jpg":       { widths: [200, 320, 480, 640],         jpegQ: 78, webpQ: 72 },
};

await mkdir(OUT_DIR, { recursive: true });
for (const [file, cfg] of Object.entries(PLAN)) {
  const src = path.join(SRC_DIR, file);
  if (!existsSync(src)) {
    console.log(`SKIP (missing): ${file}`);
    continue;
  }
  const base = file.replace(/\.jpg$/, "");
  const meta = await sharp(src).metadata();
  console.log(`\n== ${file} (${meta.width}x${meta.height}, ${(await stat(src)).size} bytes) ==`);
  for (const w of cfg.widths) {
    if (meta.width && w > meta.width) continue;
    const outJpg  = path.join(OUT_DIR, `${base}-${w}.jpg`);
    const outWebp = path.join(OUT_DIR, `${base}-${w}.webp`);
    const outAvif = path.join(OUT_DIR, `${base}-${w}.avif`);
    await sharp(src).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: cfg.jpegQ, progressive: true, mozjpeg: true }).toFile(outJpg);
    await sharp(src).resize({ width: w, withoutEnlargement: true }).webp({ quality: cfg.webpQ, effort: 5 }).toFile(outWebp);
    let avifSize = "-";
    if (cfg.avifQ) {
      await sharp(src).resize({ width: w, withoutEnlargement: true }).avif({ quality: cfg.avifQ, effort: 5 }).toFile(outAvif);
      avifSize = `${((await stat(outAvif)).size / 1024).toFixed(0).padStart(4)}KB`;
    }
    const [jStat, wStat] = await Promise.all([stat(outJpg), stat(outWebp)]);
    console.log(`  ${String(w).padStart(4)}w  jpg=${(jStat.size / 1024).toFixed(0).padStart(4)}KB  webp=${(wStat.size / 1024).toFixed(0).padStart(4)}KB  avif=${avifSize}`);
  }
}

const files = await readdir(OUT_DIR);
console.log(`\n${files.length} variants generated.`);
