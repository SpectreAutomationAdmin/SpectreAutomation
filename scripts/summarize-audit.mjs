// Summarises the measurement-audit JSON files into a short report
// the comparison table can be built from. Reads from test-results/
// and writes test-results/audit-summary.json + a markdown table.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "test-results";

function loadJson(name) {
  return JSON.parse(readFileSync(join(ROOT, name), "utf8"));
}

function pickFontFamily(t) {
  const f = (t.fontFamily || "").toLowerCase();
  if (f.includes("source_serif") || f.includes("source serif") || f.includes("serif")) return "serif";
  if (f.includes("playfair")) return "serif";
  if (f.includes("crimson") || f.includes("merriweather") || f.includes("garamond")) return "serif";
  if (f.includes("apple")) return "sans";
  if (f.includes("mono") || f.includes("courier")) return "mono";
  return "sans";
}

function summariseTexts(texts) {
  // Group text fragments by font-size + family + transform.
  const groups = new Map();
  for (const t of texts) {
    const key = `${t.fontSize}|${pickFontFamily(t)}|${t.textTransform}|${t.fontWeight}|${t.color}`;
    if (!groups.has(key)) groups.set(key, { count: 0, samples: [], ...t, family: pickFontFamily(t) });
    const g = groups.get(key);
    g.count++;
    if (g.samples.length < 3) g.samples.push(t.text);
  }
  // Return sorted by visual prominence (size descending).
  return Array.from(groups.values())
    .sort((a, b) => parseFloat(b.fontSize) - parseFloat(a.fontSize))
    .map((g) => ({
      size: g.fontSize,
      family: g.family,
      weight: g.fontWeight,
      transform: g.textTransform,
      color: g.color,
      letterSpacing: g.letterSpacing,
      lineHeight: g.lineHeight,
      count: g.count,
      samples: g.samples,
    }));
}

function summariseCard(c) {
  return {
    dims: c.rect ? `${c.rect.w} × ${c.rect.h}` : null,
    padding: c.padding
      ? `${c.padding.top}/${c.padding.right}/${c.padding.bottom}/${c.padding.left}`
      : (c.styles ? `${c.styles.padTop}/${c.styles.padRight}/${c.styles.padBottom}/${c.styles.padLeft}` : null),
    border: c.borderTop || c.styles?.borderTop,
    borderColor: c.borderColor || c.styles?.borderColor,
    radius: c.borderRadius || c.styles?.borderRadius,
    background: c.background || c.styles?.background,
    shadow: c.boxShadow || c.styles?.boxShadow,
    chart: c.chart ? `${c.chart.w} × ${c.chart.h} (${Math.round((c.chart.h / c.rect.h) * 100)}% of card height)` : null,
    paths: c.paths
      ? c.paths
          .filter((p) => p.tag === "path" || (p.tag === "line" && p.strokeDasharray))
          .map((p) => `${p.tag} stroke=${p.strokeWidth} dash=${p.strokeDasharray ?? "solid"} op=${p.opacity}`)
      : null,
    typography: c.texts ? summariseTexts(c.texts) : null,
  };
}

function summariseSaguaro(file) {
  const data = loadJson(file);
  const groups = {};
  for (const [key, cards] of Object.entries(data.cardsByClass)) {
    groups[key] = {
      count: cards.length,
      cards: cards.map(summariseCard),
    };
  }
  // Discovery: dimensions of all detected card-like elements.
  const discovery = (data.discovery || []).map((d) => ({
    classes: d.classes,
    tag: d.tag,
    dims: `${d.rect.w} × ${d.rect.h}`,
    padding: d.padding,
    border: d.borderTop,
    radius: d.borderRadius,
    background: d.background,
    shadow: d.boxShadow,
  }));
  return { viewport: data.viewport, discovery, groups };
}

function summariseSpectre(file) {
  const data = loadJson(file);
  return {
    viewport: data.viewport,
    cards: (data.cards || []).map((c) => ({
      testid: c.selectorMatched,
      classes: c.classes,
      ...summariseCard(c),
    })),
  };
}

const p03 = summariseSaguaro("audit-saguaro-p03.json");
const p05 = summariseSaguaro("audit-saguaro-p05.json");
const chairs = summariseSpectre("audit-spectre-chairs-dashboard.json");
const stew = summariseSpectre("audit-spectre-stewardship.json");

writeFileSync("test-results/audit-summary.json", JSON.stringify({
  saguaroP03: p03,
  saguaroP05: p05,
  spectreChairs: chairs,
  spectreStewardship: stew,
}, null, 2), "utf8");

console.log("=== Saguaro p03 — discovery (first 12)");
for (const d of p03.discovery.slice(0, 12)) {
  console.log(`  [${d.tag}.${d.classes}]  ${d.dims}  pad=${d.padding}  bdr=${d.border}  rad=${d.radius}  bg=${d.background}`);
}
console.log("");
console.log("=== Saguaro p03 — typography (per class group)");
for (const [key, g] of Object.entries(p03.groups)) {
  if (g.count === 0) continue;
  console.log(`  .${key} (${g.count} matches)`);
  for (const c of g.cards.slice(0, 1)) {
    console.log(`    dims=${c.dims} pad=${c.padding} bdr=${c.border} rad=${c.radius} bg=${c.background}`);
    for (const t of (c.typography || []).slice(0, 6)) {
      console.log(`      ${t.size} ${t.family} ${t.weight} ${t.transform}  color=${t.color}  samples=${(t.samples || []).join(" | ")}`);
    }
  }
}
console.log("");
console.log("=== Spectre Chair's Dashboard cards");
for (const c of chairs.cards) {
  console.log(`  ${c.testid}  ${c.dims}  pad=${c.padding}  bdr=${c.border}  rad=${c.radius}  bg=${c.background}`);
  console.log(`    chart=${c.chart}`);
  for (const t of (c.typography || []).slice(0, 6)) {
    console.log(`      ${t.size} ${t.family} ${t.weight} ${t.transform}  color=${t.color}  samples=${(t.samples || []).join(" | ")}`);
  }
}
