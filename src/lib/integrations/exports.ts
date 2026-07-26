// Phase 7A — Production export renderers (PDF, XLSX, PPTX).
//
// Each renderer takes a normalized export bundle (definitionKey, parameters,
// rows, meta, club, exportedAt, exportedBy) and produces a Buffer + mimeType.
// The bundle is built by the reporting service before invoking the renderer.

import type { ExportAdapter } from "../enterprise/exports";

export type ExportBundle = {
  reportKey: string;
  reportName: string;
  parameters: Record<string, unknown>;
  rows: unknown[];
  meta?: Record<string, unknown>;
  club: { name: string; primaryColor: string | null; logoUrl: string | null };
  generatedAt: Date;
  generatedBy?: string | null;
  packageContext?: {
    packageName: string;
    periodLabel: string;
    version: number;
    audience: string;
    executiveSummary?: string | null;
    commentaries: Array<{ subject: string; scope: string; body: string }>;
    sectionTitle?: string;
  } | null;
};

// ---------------------------------------------------------------------------
// PDF renderer (pdfkit) — produces a real PDF with cover, headers, footers,
// page numbers, and the report rows.
// ---------------------------------------------------------------------------
export async function renderPDF(bundle: ExportBundle): Promise<{ body: Buffer; mimeType: string }> {
  // Dynamic import to keep the client bundle small.
  const PDFDocument = (await import("pdfkit")).default as unknown as new (opts?: { size?: string; margin?: number; bufferPages?: boolean }) => PDFKitInstance;
  const doc = new PDFDocument({ size: "LETTER", margin: 54, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done: Promise<void> = new Promise((res) => doc.on("end", () => res()));

  // Header / cover.
  const accent = bundle.club.primaryColor ?? "#2f5832";
  doc.fontSize(10).fillColor("#666").text(bundle.club.name, { align: "left" });
  doc.fillColor(accent).rect(54, 80, 504, 4).fill();
  doc.moveDown(2);
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(22).text(bundle.reportName);
  if (bundle.packageContext) {
    doc.font("Helvetica").fontSize(11).fillColor("#666").text(
      `${bundle.packageContext.packageName} · v${bundle.packageContext.version} · ${bundle.packageContext.periodLabel}`
    );
  }
  doc.font("Helvetica").fontSize(10).fillColor("#666").text(`Generated ${bundle.generatedAt.toISOString().slice(0, 16).replace("T", " ")}${bundle.generatedBy ? ` by ${bundle.generatedBy}` : ""}`);
  doc.moveDown(1);

  if (bundle.packageContext?.executiveSummary) {
    doc.font("Helvetica-Bold").fillColor("#111").fontSize(13).text("Executive Summary");
    doc.font("Helvetica").fillColor("#222").fontSize(10).text(bundle.packageContext.executiveSummary, { lineGap: 2 });
    doc.moveDown(1);
  }

  // Parameters block (small print).
  const paramEntries = Object.entries(bundle.parameters).filter(([, v]) => v != null);
  if (paramEntries.length > 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#666").text(
      paramEntries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ·  ")
    );
    doc.moveDown(0.5);
  }

  // Table rendering. Heuristic: flatten the first row into headers.
  if (bundle.rows.length > 0) {
    const headers = inferHeaders(bundle.rows);
    const colWidth = (504 - (headers.length - 1) * 8) / headers.length;
    doc.font("Helvetica-Bold").fillColor("#111").fontSize(10);
    let x = 54;
    for (const h of headers) {
      doc.text(h, x, doc.y, { width: colWidth, continued: false });
      x += colWidth + 8;
    }
    // Reset to a single line after the header row.
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    let rowsRendered = 0;
    for (const row of bundle.rows.slice(0, 200)) {
      const flat = flattenRow(row as Record<string, unknown>);
      const startY = doc.y;
      let cx = 54;
      let maxBottom = startY;
      for (const h of headers) {
        const v = flat[h];
        const text = renderCell(v);
        doc.text(text, cx, startY, { width: colWidth, continued: false });
        if (doc.y > maxBottom) maxBottom = doc.y;
        cx += colWidth + 8;
      }
      doc.y = maxBottom;
      doc.moveDown(0.25);
      rowsRendered++;
      if (doc.y > 720) {
        doc.addPage();
        doc.font("Helvetica").fontSize(9).fillColor("#222");
      }
    }
    if (rowsRendered === bundle.rows.length) {
      doc.moveDown(1);
      doc.fontSize(9).fillColor("#666").text(`${rowsRendered} row(s).`);
    } else {
      doc.moveDown(1);
      doc.fontSize(9).fillColor("#a36116").text(`Showing first ${rowsRendered} of ${bundle.rows.length} rows. Use CSV or XLSX for the full dataset.`);
    }
  } else {
    doc.font("Helvetica-Oblique").fontSize(11).fillColor("#666").text("No rows.");
  }

  // Commentaries (if part of a package).
  if (bundle.packageContext?.commentaries.length) {
    doc.addPage();
    doc.font("Helvetica-Bold").fillColor("#111").fontSize(16).text("Management Commentary");
    for (const c of bundle.packageContext.commentaries) {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fillColor("#111").fontSize(11).text(`${c.subject} (${c.scope})`);
      doc.font("Helvetica").fillColor("#222").fontSize(10).text(c.body, { lineGap: 1.5 });
    }
  }

  // Page numbers + footer.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fontSize(8).fillColor("#888").text(
      `${bundle.club.name}   ·   ${bundle.reportName}   ·   Page ${i + 1} of ${range.count}`,
      54, 750, { align: "center", width: 504 }
    );
  }

  doc.end();
  await done;
  return { body: Buffer.concat(chunks), mimeType: "application/pdf" };
}

// ---------------------------------------------------------------------------
// XLSX renderer (exceljs)
// ---------------------------------------------------------------------------
export async function renderXLSX(bundle: ExportBundle): Promise<{ body: Buffer; mimeType: string }> {
  const ExcelJS = (await import("exceljs")).default as unknown as ExcelJSNamespace;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = bundle.club.name;
  workbook.created = bundle.generatedAt;

  // Data sheet.
  const sheet = workbook.addWorksheet("Report");
  if (bundle.rows.length > 0) {
    const headers = inferHeaders(bundle.rows);
    sheet.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(14, h.length + 2) }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of bundle.rows) {
      const flat = flattenRow(row as Record<string, unknown>);
      sheet.addRow(headers.reduce<Record<string, unknown>>((acc, h) => { acc[h] = formatCell(flat[h]); return acc; }, {}));
    }
    // Money / number column inference (light touch): columns whose header
    // hints at $ get currency format.
    for (let col = 1; col <= headers.length; col++) {
      const header = headers[col - 1].toLowerCase();
      if (/amount|balance|total|cost|price|debit|credit|valuation|fee/.test(header)) {
        sheet.getColumn(col).numFmt = '"$"#,##0.00';
      } else if (/pct|percent|%/.test(header)) {
        sheet.getColumn(col).numFmt = "0.0%";
      } else if (/date|at$/.test(header)) {
        sheet.getColumn(col).numFmt = "yyyy-mm-dd";
      }
    }
  } else {
    sheet.addRow(["No rows"]);
  }

  // Metadata sheet.
  const meta = workbook.addWorksheet("Metadata");
  meta.addRows([
    ["Report", bundle.reportName],
    ["Report key", bundle.reportKey],
    ["Generated at", bundle.generatedAt.toISOString()],
    ["Generated by", bundle.generatedBy ?? ""],
    ["Club", bundle.club.name],
    [],
    ["Parameters"],
    ...Object.entries(bundle.parameters).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]),
    [],
    ["Result meta"],
    ...Object.entries(bundle.meta ?? {}).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]),
  ]);
  meta.getColumn(1).font = { bold: true };
  meta.getColumn(1).width = 24;
  meta.getColumn(2).width = 60;

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return { body: Buffer.from(arrayBuffer as ArrayBuffer), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

// ---------------------------------------------------------------------------
// PPTX renderer (pptxgenjs)
// ---------------------------------------------------------------------------
export async function renderPPTX(bundle: ExportBundle): Promise<{ body: Buffer; mimeType: string }> {
  const PptxGen = ((await import("pptxgenjs")).default ?? (await import("pptxgenjs"))) as unknown as new () => PptxGenInstance;
  const pres = new PptxGen();
  const accent = bundle.club.primaryColor ?? "#2f5832";

  // Cover slide.
  const cover = pres.addSlide();
  cover.addText(bundle.club.name, { x: 0.5, y: 0.4, w: 9, h: 0.4, fontSize: 14, color: "666666" });
  cover.addShape("rect", { x: 0.5, y: 0.9, w: 9, h: 0.08, fill: { color: accent.replace("#", "") } });
  cover.addText(bundle.reportName, { x: 0.5, y: 1.2, w: 9, h: 1.0, fontSize: 32, bold: true, color: "111111" });
  if (bundle.packageContext) {
    cover.addText(`${bundle.packageContext.packageName} · v${bundle.packageContext.version} · ${bundle.packageContext.periodLabel}`, { x: 0.5, y: 2.2, w: 9, h: 0.5, fontSize: 14, color: "666666" });
  }
  cover.addText(`Generated ${bundle.generatedAt.toISOString().slice(0, 16).replace("T", " ")}`, { x: 0.5, y: 6.5, w: 9, h: 0.3, fontSize: 10, color: "888888" });

  // Executive summary slide.
  if (bundle.packageContext?.executiveSummary) {
    const slide = pres.addSlide();
    slide.addText("Executive Summary", { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 22, bold: true, color: "111111" });
    slide.addText(bundle.packageContext.executiveSummary, { x: 0.5, y: 1.0, w: 9, h: 5.5, fontSize: 12, color: "222222" });
  }

  // Data slide(s).
  if (bundle.rows.length > 0) {
    const slide = pres.addSlide();
    slide.addText(bundle.reportName, { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 22, bold: true, color: "111111" });
    const headers = inferHeaders(bundle.rows);
    const table: Array<Array<{ text: string; options?: { bold?: boolean; fill?: { color: string } } }>> = [
      headers.map((h) => ({ text: h, options: { bold: true, fill: { color: "EEEEEE" } } })),
    ];
    for (const row of bundle.rows.slice(0, 16)) {
      const flat = flattenRow(row as Record<string, unknown>);
      table.push(headers.map((h) => ({ text: renderCell(flat[h]) })));
    }
    slide.addTable(table, { x: 0.4, y: 1.0, w: 9.2, fontSize: 10, autoPage: true });
  }

  // Commentary slides.
  if (bundle.packageContext?.commentaries.length) {
    for (const c of bundle.packageContext.commentaries.slice(0, 6)) {
      const slide = pres.addSlide();
      slide.addText(c.subject, { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 20, bold: true, color: "111111" });
      slide.addText(c.scope, { x: 0.5, y: 0.9, w: 9, h: 0.3, fontSize: 10, color: "888888" });
      slide.addText(c.body, { x: 0.5, y: 1.3, w: 9, h: 5.5, fontSize: 13, color: "222222" });
    }
  }

  const buf = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return { body: buf, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
}

// ---------------------------------------------------------------------------
// ExportAdapter wrappers — the enterprise export pipeline uses these.
// ---------------------------------------------------------------------------
export const pdfProductionAdapter: ExportAdapter = {
  format: "PDF",
  async render() { throw new Error("pdfProductionAdapter requires bundle; call renderPDF()"); },
};
export const xlsxProductionAdapter: ExportAdapter = {
  format: "XLSX",
  async render() { throw new Error("xlsxProductionAdapter requires bundle; call renderXLSX()"); },
};
export const pptxProductionAdapter: ExportAdapter = {
  format: "PPTX",
  async render() { throw new Error("pptxProductionAdapter requires bundle; call renderPPTX()"); },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function inferHeaders(rows: unknown[]): string[] {
  const all = new Set<string>();
  for (const r of rows.slice(0, 20)) {
    const flat = flattenRow(r as Record<string, unknown>);
    for (const k of Object.keys(flat)) all.add(k);
  }
  return Array.from(all);
}

function flattenRow(row: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(out, flattenRow(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function renderCell(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function formatCell(v: unknown): unknown {
  if (v == null) return "";
  if (v instanceof Date) return v;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

// ---------------------------------------------------------------------------
// Minimal type stubs for the renderer libs (kept local so we don't need full
// @types if upstream typings drift).
// ---------------------------------------------------------------------------
interface PDFKitInstance {
  pipe(stream: unknown): unknown;
  on(event: string, cb: (chunk: Buffer) => void): unknown;
  end(): void;
  fontSize(size: number): PDFKitInstance;
  font(name: string): PDFKitInstance;
  fillColor(color: string): PDFKitInstance;
  text(content: string, x?: number | { align?: string; width?: number; continued?: boolean; lineGap?: number }, y?: number | { align?: string; width?: number; continued?: boolean; lineGap?: number }, opts?: { align?: string; width?: number; continued?: boolean; lineGap?: number }): PDFKitInstance;
  moveDown(lines?: number): PDFKitInstance;
  addPage(): PDFKitInstance;
  rect(x: number, y: number, w: number, h: number): { fill(): unknown };
  bufferedPageRange(): { start: number; count: number };
  switchToPage(n: number): PDFKitInstance;
  y: number;
}
interface ExcelJSNamespace {
  Workbook: new () => ExcelJSWorkbook;
}
interface ExcelJSWorkbook {
  creator: string;
  created: Date;
  addWorksheet(name: string): ExcelJSWorksheet;
  xlsx: { writeBuffer(): Promise<ArrayBuffer> };
}
interface ExcelJSWorksheet {
  columns: Array<{ header: string; key: string; width: number }>;
  views: Array<{ state: string; ySplit: number }>;
  getRow(n: number): { font: { bold?: boolean } };
  getColumn(n: number): { numFmt?: string; font?: { bold?: boolean }; width?: number };
  addRow(data: Record<string, unknown> | unknown[]): unknown;
  addRows(rows: unknown[][]): unknown;
}
interface PptxGenInstance {
  addSlide(): PptxGenSlide;
  write(opts: { outputType: "nodebuffer" | "base64" }): Promise<Buffer | string>;
}
interface PptxGenSlide {
  addText(text: string, opts: Record<string, unknown>): unknown;
  addShape(shape: string, opts: Record<string, unknown>): unknown;
  addTable(rows: unknown[][], opts: Record<string, unknown>): unknown;
}
