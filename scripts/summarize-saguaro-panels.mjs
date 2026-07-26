// Distil panel-measurements.json into a per-section summary the
// rebuild can use as the source of truth.
import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("test-results/saguaro-survey/panel-measurements.json", "utf8"));

function summarisePanel(rows) {
  if (!rows) return null;
  const panel = rows[0];
  // Find named sub-sections by class.
  const find = (frag) => rows.filter((r) => (r.classes ?? "").includes(frag));
  const findFirst = (frag) => find(frag)[0];

  const header = findFirst("panel-header");
  const kpiRow = findFirst("kpi-row");
  const trendNote = findFirst("trend-note");
  // The chart wrapper — find a div that contains a canvas or has class "chart"
  const chartWrap = rows.find((r) => (r.classes ?? "").match(/chart-(area|body|wrap)/));
  // canvas itself
  const canvas = rows.find((r) => r.tag === "canvas");
  // Top-level kpi cells inside the kpi-row
  const kpiCells = rows.filter((r) => (r.classes ?? "").includes("kpi-cell") || (r.classes ?? "").match(/^kpi[ -]/));

  // Text tiers — group by (size, family, weight, transform).
  const allTexts = rows.filter((r) => r.text && r.text.length > 0);
  const tierMap = new Map();
  for (const t of allTexts) {
    const key = `${t.styles.fontSize}|${t.styles.fontFamily}|${t.styles.fontWeight}|${t.styles.fontStyle}|${t.styles.textTransform}|${t.styles.color}`;
    if (!tierMap.has(key)) tierMap.set(key, { ...t.styles, samples: [], count: 0 });
    const g = tierMap.get(key);
    g.count++;
    if (g.samples.length < 4) g.samples.push(t.text);
  }
  const tiers = Array.from(tierMap.values()).sort((a, b) => parseFloat(b.fontSize) - parseFloat(a.fontSize));

  return {
    panel: { rect: panel.rect, styles: panel.styles },
    header: header ? { rect: header.rect, styles: header.styles, height: header.rect.h } : null,
    kpiRow: kpiRow ? { rect: kpiRow.rect, styles: kpiRow.styles, height: kpiRow.rect.h } : null,
    kpiCells: kpiCells.slice(0, 4).map((c) => ({ rect: c.rect, classes: c.classes, padding: c.styles.padding })),
    chartWrap: chartWrap ? { rect: chartWrap.rect, classes: chartWrap.classes, height: chartWrap.rect.h } : null,
    canvas: canvas ? { rect: canvas.rect, height: canvas.rect.h } : null,
    trendNote: trendNote ? { rect: trendNote.rect, styles: trendNote.styles, height: trendNote.rect.h } : null,
    typographyTiers: tiers.map((t) => ({
      size: t.fontSize,
      family: t.fontFamily,
      weight: t.fontWeight,
      style: t.fontStyle,
      transform: t.textTransform,
      letterSpacing: t.letterSpacing,
      color: t.color,
      lineHeight: t.lineHeight,
      count: t.count,
      samples: t.samples,
    })),
  };
}

const eq = summarisePanel(data.equity);
const op = summarisePanel(data.operating);

writeFileSync("test-results/saguaro-survey/panel-summary.json", JSON.stringify({ equity: eq, operating: op }, null, 2), "utf8");

function printPanel(name, p) {
  console.log(`=== ${name}`);
  console.log(`  panel: ${p.panel.rect.w} × ${p.panel.rect.h} px, pad=${p.panel.styles.padding}, bg=${p.panel.styles.background}, border=${p.panel.styles.borderTop}, radius=${p.panel.styles.borderRadius}`);
  if (p.header) console.log(`  header: ${p.header.rect.w} × ${p.header.height} px (${Math.round(p.header.height / p.panel.rect.h * 100)}%), pad=${p.header.styles.padding}, bg=${p.header.styles.background}`);
  if (p.kpiRow) console.log(`  kpi-row: ${p.kpiRow.rect.w} × ${p.kpiRow.height} px (${Math.round(p.kpiRow.height / p.panel.rect.h * 100)}%), pad=${p.kpiRow.styles.padding}, bg=${p.kpiRow.styles.background}`);
  if (p.kpiCells.length) {
    console.log(`  kpi-cells: ${p.kpiCells.length} cells`);
    for (const c of p.kpiCells) console.log(`    ${c.rect.w} × ${c.rect.h} pad=${c.padding} class="${c.classes.slice(0,40)}"`);
  }
  if (p.chartWrap) console.log(`  chart-wrap: ${p.chartWrap.rect.w} × ${p.chartWrap.height} px (${Math.round(p.chartWrap.height / p.panel.rect.h * 100)}%)`);
  if (p.canvas) console.log(`  canvas: ${p.canvas.rect.w} × ${p.canvas.height} px (${Math.round(p.canvas.height / p.panel.rect.h * 100)}%)`);
  if (p.trendNote) console.log(`  trend-note (commentary): ${p.trendNote.rect.w} × ${p.trendNote.height} px (${Math.round(p.trendNote.height / p.panel.rect.h * 100)}%), pad=${p.trendNote.styles.padding}, bg=${p.trendNote.styles.background}`);
  console.log(`  typography tiers (top 12):`);
  for (const t of p.typographyTiers.slice(0, 12)) {
    console.log(`    ${t.size} ${t.family} ${t.weight} ${t.style} ${t.transform}  ls=${t.letterSpacing} color=${t.color}  [${t.count}] samples: ${t.samples.join(" | ").slice(0, 90)}`);
  }
  console.log("");
}

if (eq) printPanel("EQUITY VALUE OVER TIME", eq);
if (op) printPanel("OPERATING RESULTS — 12-MONTH ROLLING TREND", op);
