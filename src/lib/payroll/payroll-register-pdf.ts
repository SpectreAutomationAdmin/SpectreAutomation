// Slice E (2026-09-19) — Payroll Register PDF renderer (LANDSCAPE).
// Reads only the PayrollRegisterV1 DTO. No DB reads. No sensitive data
// (register DTO already excludes SIN / banking / TD1). Layout is
// deterministic — Helvetica bundled with pdfkit.

import type { PayrollRegisterV1 } from "./payroll-register";

interface TextOpts { align?: "left" | "center" | "right"; continued?: boolean; width?: number; lineGap?: number; }
interface PDFKitInstance {
  on(event: "data", cb: (chunk: Buffer) => void): PDFKitInstance;
  on(event: "end",  cb: () => void): PDFKitInstance;
  fontSize(n: number): PDFKitInstance;
  font(name: string): PDFKitInstance;
  fillColor(color: string): PDFKitInstance;
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
  addPage(): PDFKitInstance;
  end(): void;
  readonly y: number;
  readonly x: number;
  readonly page: { width: number; height: number };
}

const MARGIN = 36;
const HEAD_COLOR = "#111";
const MUTED = "#666";
const GREEN = "#2f5832";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
function usd(n: string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function renderPayrollRegisterPdf(reg: PayrollRegisterV1): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default as unknown as new (opts?: {
    size?: string; margin?: number; bufferPages?: boolean; layout?: "portrait" | "landscape";
  }) => PDFKitInstance;
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, layout: "landscape" });

  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve());
  });

  // Header
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
     .text(reg.clubName.toUpperCase(), { align: "left" });
  doc.font("Helvetica-Bold").fontSize(18).fillColor(HEAD_COLOR).text("Payroll Register");
  doc.moveDown(0.3);
  doc.strokeColor(GREEN).lineWidth(1.5).moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).stroke();
  doc.moveDown(0.6);

  // Meta
  doc.font("Helvetica").fontSize(9).fillColor(HEAD_COLOR);
  const stateLabel = reg.statePosted ? "POSTED — IMMUTABLE" : `Under review · ${reg.state}`;
  doc.text(`Pay date: ${fmtDate(reg.payPeriod.payDateIso)}   ·   Period: ${fmtDate(reg.payPeriod.startIso)} – ${fmtDate(reg.payPeriod.endIso)}   ·   ${stateLabel}`);
  if (reg.posted.journalEntryId) {
    doc.fillColor(MUTED).text(`Journal Entry: ${reg.posted.journalEntryId}   ·   Posted: ${reg.posted.postedAt ? fmtDate(reg.posted.postedAt) : "—"}   ·   calcVersion: ${reg.posted.calculationVersion ?? "—"}`);
  }
  doc.fillColor(MUTED).text(`Generated: ${fmtDate(reg.generatedAtIso)}   ·   Employees: ${reg.employees.length}`);
  doc.moveDown(0.8);

  // Employee table — compact landscape columns.
  const cols: Array<{ label: string; get: (r: typeof reg.employees[number]) => string; align?: "right"; w: number }> = [
    { label: "Employee",     get: (r) => r.employeeName,               w: 130 },
    { label: "Dept",         get: (r) => r.departmentCode,             w: 40  },
    { label: "Type",         get: (r) => r.payTypeLabel,               w: 40  },
    { label: "Gross",        get: (r) => usd(r.grossCashEarnings),  align: "right", w: 70 },
    { label: "CPP+CPP2+EI",  get: (r) => usd((Number(r.cpp)+Number(r.cpp2)+Number(r.ei)).toFixed(2)), align: "right", w: 68 },
    { label: "Fed Tax",      get: (r) => usd(r.federalTax),         align: "right", w: 60 },
    { label: "Prov Tax",     get: (r) => usd(r.provincialTax),      align: "right", w: 60 },
    { label: "Other Ded",    get: (r) => usd(r.otherDeductions),    align: "right", w: 60 },
    { label: "RRSP EE",      get: (r) => usd(r.rrspEmployeeContribution), align: "right", w: 55 },
    { label: "Net Pay",      get: (r) => usd(r.netPay),             align: "right", w: 70 },
    { label: "Employer",     get: (r) => usd((Number(r.employerCpp)+Number(r.employerCpp2)+Number(r.employerEi)+Number(r.employerBenefits)+Number(r.rrspEmployerContribution)).toFixed(2)), align: "right", w: 70 },
    { label: "Total ER Cost", get: (r) => usd(r.totalEmployerCost), align: "right", w: 70 },
  ];

  // Header row
  const startX = MARGIN;
  let x = startX;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(HEAD_COLOR);
  for (const c of cols) {
    doc.text(c.label, x, doc.y, { width: c.w, align: c.align ?? "left" });
    x += c.w;
  }
  doc.moveDown(0.4);
  doc.strokeColor("#ccc").lineWidth(0.5).moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(8).fillColor(HEAD_COLOR);
  for (const r of reg.employees) {
    const rowY = doc.y;
    x = startX;
    for (const c of cols) {
      doc.text(c.get(r), x, rowY, { width: c.w, align: c.align ?? "left" });
      x += c.w;
    }
    doc.moveDown(0.7);
    if (doc.y > doc.page.height - 100) {
      doc.addPage();
    }
  }

  // Totals row
  doc.strokeColor("#999").lineWidth(0.7).moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(HEAD_COLOR);
  const t = reg.totals;
  const totalsRow: string[] = [
    "TOTALS", "", "",
    usd(t.grossCashEarnings),
    usd((Number(t.cpp)+Number(t.cpp2)+Number(t.ei)).toFixed(2)),
    usd(t.federalTax),
    usd(t.provincialTax),
    usd(t.otherDeductions),
    usd(t.rrspEmployeeContribution),
    usd(t.netPay),
    usd((Number(t.employerCpp)+Number(t.employerCpp2)+Number(t.employerEi)+Number(t.employerBenefits)+Number(t.rrspEmployerContribution)).toFixed(2)),
    usd(t.totalEmployerCost),
  ];
  const totRowY = doc.y;
  x = startX;
  for (let i = 0; i < cols.length; i++) {
    doc.text(totalsRow[i]!, x, totRowY, { width: cols[i]!.w, align: cols[i]!.align ?? "left" });
    x += cols[i]!.w;
  }
  doc.moveDown(1.2);

  // Reconciliation block
  doc.font("Helvetica-Bold").fontSize(10).fillColor(HEAD_COLOR).text("GL Reconciliation");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9).fillColor(HEAD_COLOR);
  doc.text(`Gross payroll: ${usd(reg.reconciliation.grossPayroll)}   ·   Employee deductions: ${usd(reg.reconciliation.employeeDeductions)}   ·   Net payroll: ${usd(reg.reconciliation.netPayroll)}   ·   Employer costs: ${usd(reg.reconciliation.employerPayrollCosts)}`);
  doc.text(`GL debits: ${usd(reg.reconciliation.glDebits)}   ·   GL credits: ${usd(reg.reconciliation.glCredits)}   ·   Difference: ${(reg.reconciliation.differenceCents / 100).toFixed(2)}`);

  // Exception summary
  if (reg.exceptionSummary.blockerCount + reg.exceptionSummary.warningCount > 0) {
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(HEAD_COLOR).text("Exceptions");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(8).fillColor(HEAD_COLOR);
    doc.text(`Blockers: ${reg.exceptionSummary.blockerCount}   ·   Warnings: ${reg.exceptionSummary.warningCount}   ·   Info: ${reg.exceptionSummary.infoCount}`);
    for (const b of reg.exceptionSummary.unresolvedBlockers) {
      doc.fillColor("#991b1b").text(`  [BLOCKER] ${b.code}: ${b.message}${b.employeeName ? ` — ${b.employeeName}` : ""}`);
    }
    for (const w of reg.exceptionSummary.warnings) {
      doc.fillColor("#92400e").text(`  [WARNING] ${w.code}: ${w.message}${w.employeeName ? ` — ${w.employeeName}` : ""}`);
    }
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}
