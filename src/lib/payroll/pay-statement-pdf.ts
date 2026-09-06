// Payroll-3C-5B (2026-09-04) — pay statement PDF generator.
//
// Renders a PayStatementV2 DTO to a PDF byte buffer using pdfkit
// (pure Node — no headless browser, no client-side rendering).
//
// Design principles:
//   • Reads only the frozen PayStatementV2 DTO — no direct DB reads
//     in this file. That guarantees web/PDF parity by construction:
//     both surfaces render the same DTO shape from the same loader.
//   • Historical immutability follows from the loader — a POSTED
//     batch's PayStatementV2 does not change when live catalogue
//     values change, so the PDF doesn't either.
//   • Never renders sensitive data. The DTO already excludes SIN,
//     TD1 secure payloads, banking details, and password hashes;
//     this renderer only reads DTO fields.
//   • Deterministic layout. Font: Helvetica (bundled with pdfkit).
//
// Access control lives at the route layer, not here.

import type { PayStatementV2 } from "./pay-statement";

// -------------------------------------------------------------------
// pdfkit minimal type surface (avoid pulling every declared method).
// -------------------------------------------------------------------
type TextOpts = {
  align?: "left" | "center" | "right";
  continued?: boolean;
  width?: number;
  lineGap?: number;
};
interface PDFKitInstance {
  on(event: "data", cb: (chunk: Buffer) => void): PDFKitInstance;
  on(event: "end",  cb: () => void): PDFKitInstance;
  fontSize(n: number): PDFKitInstance;
  font(name: string): PDFKitInstance;
  fillColor(color: string): PDFKitInstance;
  // pdfkit's text() supports (text, opts?), (text, x, y, opts?),
  // and (text, x, y). Model the union so callers don't need casts.
  text(text: string, opts?: TextOpts): PDFKitInstance;
  text(text: string, x: number, y: number, opts?: TextOpts): PDFKitInstance;
  moveDown(n?: number): PDFKitInstance;
  moveTo(x: number, y: number): PDFKitInstance;
  lineTo(x: number, y: number): PDFKitInstance;
  strokeColor(color: string): PDFKitInstance;
  lineWidth(n: number): PDFKitInstance;
  stroke(): PDFKitInstance;
  rect(x: number, y: number, w: number, h: number): PDFKitInstance;
  fill(): PDFKitInstance;
  end(): void;
  readonly y: number;
  readonly x: number;
}

const PAGE_WIDTH  = 612; // US Letter
const MARGIN      = 54;
const CONTENT_W   = PAGE_WIDTH - MARGIN * 2;
const LABEL_COL_W = 260;
const CURRENT_COL_W = 120;
const YTD_COL_W   = 120;

// Deterministic ISO → "Aug 31, 2026".
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
}
function usd(n: string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-CA", {
    style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

export async function renderPayStatementPdf(stmt: PayStatementV2): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default as unknown as new (opts?: {
    size?: string; margin?: number; bufferPages?: boolean;
  }) => PDFKitInstance;
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true });

  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve());
  });

  // -----------------------------------------------------------------
  // Header — Club identity + document label
  // -----------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#666")
     .text(stmt.header.clubName.toUpperCase(), { align: "left" });
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111")
     .text("Pay Statement");

  doc.moveDown(0.3);
  doc.strokeColor("#2f5832").lineWidth(1.5)
     .moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).stroke();
  doc.moveDown(0.8);

  // -----------------------------------------------------------------
  // Header meta — employee + period
  // -----------------------------------------------------------------
  doc.font("Helvetica").fontSize(10).fillColor("#111");
  const metaTop = doc.y;
  doc.font("Helvetica-Bold").text("Employee", MARGIN, metaTop);
  doc.font("Helvetica").text(stmt.header.employeeName);
  if (stmt.header.employeeNumber) doc.text(`No. ${stmt.header.employeeNumber}`);

  doc.font("Helvetica-Bold").text("Pay Group", MARGIN + 200, metaTop);
  doc.font("Helvetica").text(stmt.header.payGroupName, MARGIN + 200, doc.y);
  if (stmt.header.payFrequency) {
    doc.text(stmt.header.payFrequency.replace(/_/g, " ").toLowerCase(), MARGIN + 200, doc.y);
  }

  doc.font("Helvetica-Bold").text("Pay Date", MARGIN + 400, metaTop);
  doc.font("Helvetica").text(fmtDate(stmt.header.payDateIso), MARGIN + 400, doc.y);
  doc.font("Helvetica-Bold").fontSize(9).text("Pay Period", MARGIN + 400, doc.y + 4);
  doc.font("Helvetica").fontSize(10).text(
    `${fmtDate(stmt.header.payPeriodStartIso)} – ${fmtDate(stmt.header.payPeriodEndInclusiveIso)}`,
    MARGIN + 400, doc.y,
  );

  doc.moveDown(1.2);

  // -----------------------------------------------------------------
  // Section rendering helper
  // -----------------------------------------------------------------
  function drawSection(title: string, section: PayStatementV2["sections"][number]) {
    if (section.lines.length === 0) return;
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text(title, MARGIN, doc.y);
    doc.moveDown(0.2);

    // Column header row
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666");
    doc.text("Description", MARGIN, y);
    doc.text("Current", MARGIN + LABEL_COL_W, y, { width: CURRENT_COL_W, align: "right" });
    doc.text("Year to Date", MARGIN + LABEL_COL_W + CURRENT_COL_W, y, { width: YTD_COL_W, align: "right" });
    doc.moveDown(0.5);
    doc.strokeColor("#ddd").lineWidth(0.5)
       .moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).stroke();
    doc.moveDown(0.2);

    doc.font("Helvetica").fontSize(10).fillColor("#111");
    for (const line of section.lines) {
      const rowY = doc.y;
      const label = line.isOneTime ? `${line.label} (one-time)` : line.label;
      doc.text(label, MARGIN, rowY, { width: LABEL_COL_W - 8 });
      doc.text(usd(line.current), MARGIN + LABEL_COL_W, rowY, { width: CURRENT_COL_W, align: "right" });
      doc.text(usd(line.ytd),     MARGIN + LABEL_COL_W + CURRENT_COL_W, rowY, { width: YTD_COL_W, align: "right" });
      doc.moveDown(0.3);
    }

    // Section total
    doc.moveDown(0.1);
    doc.strokeColor("#ddd").lineWidth(0.5)
       .moveTo(MARGIN + LABEL_COL_W, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).stroke();
    doc.moveDown(0.1);
    const totalY = doc.y;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Total", MARGIN + 120, totalY, { width: LABEL_COL_W - 128, align: "right" });
    doc.text(usd(section.currentTotal), MARGIN + LABEL_COL_W, totalY, { width: CURRENT_COL_W, align: "right" });
    doc.text(usd(section.ytdTotal),     MARGIN + LABEL_COL_W + CURRENT_COL_W, totalY, { width: YTD_COL_W, align: "right" });
    doc.moveDown(1);
  }

  drawSection("Earnings",                       stmt.sections.find((s) => s.kind === "EARNINGS")!);
  drawSection("Reimbursements",                 stmt.sections.find((s) => s.kind === "REIMBURSEMENTS")!);
  drawSection("Taxable benefits",               stmt.sections.find((s) => s.kind === "TAXABLE_BENEFITS")!);
  drawSection("Statutory deductions",           stmt.sections.find((s) => s.kind === "STATUTORY_DEDUCTIONS")!);
  drawSection("Other deductions",               stmt.sections.find((s) => s.kind === "OTHER_DEDUCTIONS")!);
  drawSection("Employer benefits & contributions", stmt.sections.find((s) => s.kind === "EMPLOYER_CONTRIBUTIONS")!);

  // -----------------------------------------------------------------
  // Totals + net pay
  // -----------------------------------------------------------------
  doc.moveDown(0.5);
  doc.strokeColor("#2f5832").lineWidth(1)
     .moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).stroke();
  doc.moveDown(0.3);

  const netY = doc.y;
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111");
  doc.text("Net pay", MARGIN, netY);
  doc.text(usd(stmt.totals.netPayCurrent), MARGIN + LABEL_COL_W, netY, { width: CURRENT_COL_W, align: "right" });
  doc.text(usd(stmt.totals.netPayYtd),     MARGIN + LABEL_COL_W + CURRENT_COL_W, netY, { width: YTD_COL_W, align: "right" });

  doc.moveDown(1);

  // -----------------------------------------------------------------
  // Statutory bases (small print)
  // -----------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#666").text("Statutory bases", MARGIN, doc.y);
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(8).fillColor("#555");
  doc.text(`Taxable income   current ${usd(stmt.statutoryBases.taxableCurrent)}   YTD ${usd(stmt.statutoryBases.taxableYtd)}`);
  doc.text(`CPP pensionable  current ${usd(stmt.statutoryBases.pensionableCurrent)}   YTD ${usd(stmt.statutoryBases.pensionableYtd)}`);
  doc.text(`EI insurable     current ${usd(stmt.statutoryBases.insurableCurrent)}   YTD ${usd(stmt.statutoryBases.insurableYtd)}`);

  doc.moveDown(0.8);

  // -----------------------------------------------------------------
  // Disbursement
  // -----------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#666").text("Disbursement", MARGIN, doc.y);
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(8).fillColor("#555");
  const dest = stmt.disbursement.accountLast4 != null
    ? `Payment destination: •••• ${stmt.disbursement.accountLast4}`
    : "Payment destination: on file (not shown)";
  doc.text(dest);
  doc.text(
    stmt.disbursement.transmitted
      ? "Transmitted."
      : "Payment transmission is not managed by this Spectre release.",
  );

  // -----------------------------------------------------------------
  // Footer
  // -----------------------------------------------------------------
  doc.moveDown(1.5);
  doc.font("Helvetica").fontSize(7).fillColor("#888");
  const postedNote = stmt.posted.postedAtIso
    ? `Posted ${fmtDate(stmt.posted.postedAtIso)}`
    : "Not yet posted";
  doc.text(`${postedNote}  ·  ${stmt.header.clubName}`, MARGIN, doc.y, { align: "center", width: CONTENT_W });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}
