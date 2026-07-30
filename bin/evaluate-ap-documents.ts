#!/usr/bin/env tsx
// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — AP document
// benchmark evaluator.
//
// Founder §11+§16 rules covered:
//   * Read a manifest of eligible documents (curator-approved).
//   * Run each document through the same production analyser path
//     (analyseIngestedInvoice) and record per-doc metrics.
//   * Emit BOTH a machine-readable JSON report AND a human-readable
//     summary.
//   * Never commit raw invoice bytes, PII, tax numbers, banking, or
//     supplier addresses into the report — only redacted counters
//     and hash-suffix identifiers.
//   * Report the CORPUS SHORTFALL so the founder can see what's
//     missing before every checkpoint is judged done.
//
// Usage:
//   npm run evaluate:ap-documents -- --clubId <id> --manifest config/ap-document-benchmark.json
//
// The manifest lives at config/ap-document-benchmark.json (or a
// path passed via --manifest). Format:
//
//   {
//     "documents": [
//       {
//         "documentId": "cmxxxx...",         // IngestedDocument.id (must exist for the club)
//         "expectedClass": "IMAGE_ONLY",     // TEXT_HEALTHY | TEXT_FRAGMENTED | IMAGE_ONLY | MIXED | ENCRYPTED | UNSUPPORTED
//         "expectations": {                  // optional truth-table (redacted labels — never PII)
//           "hasSupplier": true,
//           "hasPayableReference": true,
//           "hasTotal": true,
//           "documentApproved": true         // has the founder approved this doc for benchmarking?
//         }
//       },
//       ...
//     ]
//   }
//
// The current corpus shortfall calculation compares the manifest
// size (approved docs only) against the founder's stated target
// of 40 representative documents.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { prisma } from "../src/lib/prisma";
import { analyseIngestedInvoice } from "../src/lib/ap-intelligence/analyse";
import { assessPdfExtraction } from "../src/lib/ap-intelligence/document-class";
import type { DocumentClass } from "../src/lib/ap-intelligence/document-class";

const CORPUS_TARGET = 40;
const REPORT_DIR = pathResolve(process.cwd(), "test-results", "ap-document-benchmark");

interface ManifestDoc {
  documentId: string;
  expectedClass?: DocumentClass;
  expectations?: {
    hasSupplier?: boolean;
    hasPayableReference?: boolean;
    hasTotal?: boolean;
    documentApproved?: boolean;
  };
  notes?: string;
}

interface Manifest {
  clubId?: string;
  documents: ManifestDoc[];
}

interface EvalRow {
  documentIdTail: string;
  shaTail: string;
  expectedClass: DocumentClass | "UNKNOWN";
  observedClass: DocumentClass | "UNKNOWN";
  extraction: {
    hasSupplier: boolean;
    hasPayableReference: boolean;
    hasTotal: boolean;
    lineItemCount: number;
    ocrStrategy: string;
    ocrStatus: string;
  };
  expectations: {
    hasSupplier?: boolean;
    hasPayableReference?: boolean;
    hasTotal?: boolean;
    documentApproved?: boolean;
  };
  matches: {
    classMatch: boolean | null;
    supplierMatch: boolean | null;
    payableRefMatch: boolean | null;
    totalMatch: boolean | null;
  };
  errorMessage: string | null;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1]?.startsWith("--") ? "true" : argv[i + 1];
      out[key] = val ?? "true";
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest
    ? pathResolve(process.cwd(), args.manifest)
    : pathResolve(process.cwd(), "config/ap-document-benchmark.json");
  if (!existsSync(manifestPath)) {
    console.error(`[evaluate:ap-documents] Manifest not found at ${manifestPath}.`);
    console.error(`Create one — see docs/ap-ocr-textract-runbook.md`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const clubId = args.clubId ?? manifest.clubId;
  if (!clubId) {
    console.error("[evaluate:ap-documents] --clubId required (or set clubId in the manifest)");
    process.exit(1);
  }

  const total = manifest.documents.length;
  const approved = manifest.documents.filter((d) => d.expectations?.documentApproved !== false).length;
  const shortfall = Math.max(0, CORPUS_TARGET - approved);

  console.log(`\n=== AP document benchmark evaluator ===`);
  console.log(`Manifest:        ${manifestPath}`);
  console.log(`Club:            ${clubId}`);
  console.log(`Docs (total):    ${total}`);
  console.log(`Docs (approved): ${approved}`);
  console.log(`Target corpus:   ${CORPUS_TARGET}`);
  console.log(`Corpus shortfall: ${shortfall}`);
  console.log(``);

  if (approved === 0) {
    console.log(`[evaluate:ap-documents] No approved documents — nothing to evaluate.`);
    console.log(`Add docs to the manifest with expectations.documentApproved=true.`);
    process.exit(0);
  }

  const rows: EvalRow[] = [];
  for (const md of manifest.documents) {
    if (md.expectations?.documentApproved === false) continue;
    const row = await evaluateOne(clubId, md);
    rows.push(row);
    printRow(row);
  }

  const summary = summarize(rows, approved, shortfall);
  const report = { generatedAt: new Date().toISOString(), clubIdTail: clubId.slice(-6), summary, rows };

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const stampedName = `report-${Date.now()}`;
  const jsonPath = pathResolve(REPORT_DIR, `${stampedName}.json`);
  const humanPath = pathResolve(REPORT_DIR, `${stampedName}.txt`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(humanPath, humanReport(report));

  console.log(``);
  console.log(`Wrote JSON report: ${jsonPath}`);
  console.log(`Wrote text report: ${humanPath}`);
  await prisma.$disconnect();
}

async function evaluateOne(clubId: string, md: ManifestDoc): Promise<EvalRow> {
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: md.documentId, clubId },
    select: { id: true, sha256Hash: true },
  });
  if (!doc) {
    return {
      documentIdTail: md.documentId.slice(-6),
      shaTail: "----",
      expectedClass: md.expectedClass ?? "UNKNOWN",
      observedClass: "UNKNOWN",
      extraction: {
        hasSupplier: false,
        hasPayableReference: false,
        hasTotal: false,
        lineItemCount: 0,
        ocrStrategy: "NONE",
        ocrStatus: "DOCUMENT_MISSING",
      },
      expectations: md.expectations ?? {},
      matches: {
        classMatch: false,
        supplierMatch: null,
        payableRefMatch: null,
        totalMatch: null,
      },
      errorMessage: "Document not found in DB for this club.",
    };
  }

  try {
    const analysis = await analyseIngestedInvoice({
      clubId,
      ingestedDocumentId: doc.id,
    });
    const observedClass = analysis.documentAssessment?.documentClass ?? "UNKNOWN";
    const hasSupplier = !!analysis.extraction.vendor.guessedName;
    const hasPayableRef = !!analysis.extraction.invoiceNumber;
    const hasTotal = !!analysis.extraction.total;
    return {
      documentIdTail: doc.id.slice(-6),
      shaTail: doc.sha256Hash.slice(-8),
      expectedClass: md.expectedClass ?? "UNKNOWN",
      observedClass,
      extraction: {
        hasSupplier,
        hasPayableReference: hasPayableRef,
        hasTotal,
        lineItemCount: analysis.lineItemsExtracted.length,
        ocrStrategy: analysis.documentAssessment?.documentClass ?? "N/A",
        ocrStatus: (analysis.documentAssessment?.exceptions ?? []).join(",") || "OK",
      },
      expectations: md.expectations ?? {},
      matches: {
        classMatch:
          md.expectedClass && observedClass !== "UNKNOWN"
            ? md.expectedClass === observedClass
            : null,
        supplierMatch:
          md.expectations?.hasSupplier != null
            ? md.expectations.hasSupplier === hasSupplier
            : null,
        payableRefMatch:
          md.expectations?.hasPayableReference != null
            ? md.expectations.hasPayableReference === hasPayableRef
            : null,
        totalMatch:
          md.expectations?.hasTotal != null
            ? md.expectations.hasTotal === hasTotal
            : null,
      },
      errorMessage: null,
    };
  } catch (e) {
    return {
      documentIdTail: doc.id.slice(-6),
      shaTail: doc.sha256Hash.slice(-8),
      expectedClass: md.expectedClass ?? "UNKNOWN",
      observedClass: "UNKNOWN",
      extraction: {
        hasSupplier: false,
        hasPayableReference: false,
        hasTotal: false,
        lineItemCount: 0,
        ocrStrategy: "ERROR",
        ocrStatus: "ANALYSER_THREW",
      },
      expectations: md.expectations ?? {},
      matches: {
        classMatch: false,
        supplierMatch: null,
        payableRefMatch: null,
        totalMatch: null,
      },
      errorMessage: (e as Error).message.slice(0, 200),
    };
  }
}

function printRow(row: EvalRow): void {
  const flag = (b: boolean | null) => (b == null ? "  " : b ? "✓ " : "✗ ");
  console.log(
    `  doc=${row.documentIdTail} sha=${row.shaTail}  class=${row.observedClass.padEnd(16)} ` +
      `sup=${flag(row.matches.supplierMatch)} ref=${flag(row.matches.payableRefMatch)} tot=${flag(row.matches.totalMatch)} ` +
      (row.errorMessage ? ` ⚠ ${row.errorMessage}` : ""),
  );
}

function summarize(rows: EvalRow[], approved: number, shortfall: number) {
  const supplierMatches = rows.filter((r) => r.matches.supplierMatch === true).length;
  const supplierExpectations = rows.filter((r) => r.expectations.hasSupplier != null).length;
  const payableMatches = rows.filter((r) => r.matches.payableRefMatch === true).length;
  const payableExpectations = rows.filter((r) => r.expectations.hasPayableReference != null).length;
  const totalMatches = rows.filter((r) => r.matches.totalMatch === true).length;
  const totalExpectations = rows.filter((r) => r.expectations.hasTotal != null).length;
  const classMatches = rows.filter((r) => r.matches.classMatch === true).length;
  const classExpectations = rows.filter((r) => r.expectedClass !== "UNKNOWN").length;
  const analyserErrors = rows.filter((r) => r.errorMessage != null).length;
  return {
    documentsEvaluated: rows.length,
    approvedInManifest: approved,
    corpusTarget: CORPUS_TARGET,
    corpusShortfall: shortfall,
    supplierMatches,
    supplierExpectations,
    payableMatches,
    payableExpectations,
    totalMatches,
    totalExpectations,
    classMatches,
    classExpectations,
    analyserErrors,
  };
}

function humanReport(report: { generatedAt: string; clubIdTail: string; summary: ReturnType<typeof summarize>; rows: EvalRow[] }): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`AP DOCUMENT BENCHMARK — ${report.generatedAt}`);
  lines.push(`club (last-6): ${report.clubIdTail}`);
  lines.push(``);
  lines.push(`Corpus:`);
  lines.push(`  approved in manifest: ${s.approvedInManifest}`);
  lines.push(`  target corpus size:   ${s.corpusTarget}`);
  lines.push(`  shortfall:            ${s.corpusShortfall}`);
  lines.push(``);
  lines.push(`Match rates:`);
  lines.push(`  class:              ${s.classMatches} / ${s.classExpectations}`);
  lines.push(`  supplier presence:  ${s.supplierMatches} / ${s.supplierExpectations}`);
  lines.push(`  payable ref:        ${s.payableMatches} / ${s.payableExpectations}`);
  lines.push(`  total:              ${s.totalMatches} / ${s.totalExpectations}`);
  lines.push(``);
  lines.push(`Analyser errors: ${s.analyserErrors}`);
  lines.push(``);
  lines.push(`Per-doc rows (${report.rows.length}):`);
  for (const r of report.rows) {
    lines.push(
      `  doc=${r.documentIdTail} sha=${r.shaTail} class=${r.observedClass}  ` +
        `sup=${r.extraction.hasSupplier} ref=${r.extraction.hasPayableReference} tot=${r.extraction.hasTotal} li=${r.extraction.lineItemCount}` +
        (r.errorMessage ? `\n     ERROR: ${r.errorMessage}` : ""),
    );
  }
  return lines.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
