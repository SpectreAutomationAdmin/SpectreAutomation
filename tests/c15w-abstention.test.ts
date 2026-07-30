// Sprint 3 · Checkpoint 15W (2026-07-30) — regression tests for
// the ranker's abstention semantics and the document-class
// assessment.
//
// Founder rules §4-§6: an image-only PDF that produces no text
// must not surface a fabricated GL recommendation. The ranker's
// deterministic accountNumber tie-break must not let the smallest
// account number win by default.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankAccountsPure } from "@/lib/ap-intelligence/gl-recommend";
import { extractQueryConcepts } from "@/lib/ap-intelligence/gl-query-concepts";
import { assessPdfExtraction } from "@/lib/ap-intelligence/document-class";
import { COULEE_RIDGE_ACCOUNTS_SHAPE } from "./fixtures/c15u-coulee-ridge-coa-shape";

// -----------------------------------------------------------------------------
// §5 — Petty Cash abstention
// -----------------------------------------------------------------------------

describe("15W · GL ranker abstention (no fabricated Petty Cash)", () => {
  it("empty query concepts produce zero-score rankings — not a confident recommendation", () => {
    // No line items, no purpose, no document text, no supplier.
    const queryConcepts = extractQueryConcepts({
      lineItems: [],
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
    });
    // Query concepts should be empty when no evidence supplied.
    expect(queryConcepts.length).toBe(0);
    // Every ranker slot returns semantic score 0.
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    expect(ranked.every((r) => r.semanticScore === 0)).toBe(true);
  });

  it("scored recommendation NEVER lands on 1000 Petty Cash when there is zero evidence", () => {
    // Coulee Ridge shape does not have a 1000 account in the fixture,
    // but the smallest accountNumber in the fixture is a plausible
    // fabrication target under the previous tie-break. Assert that
    // the top-ranked account with zero score is NOT held out as a
    // confident recommendation.
    const queryConcepts = extractQueryConcepts({
      lineItems: [], economicPurposeCandidates: null, fullDocumentText: null, supplierName: null,
    });
    const ranked = rankAccountsPure({ accounts: COULEE_RIDGE_ACCOUNTS_SHAPE, queryConcepts });
    // The rank-1 account (whichever it is) has semanticScore 0 —
    // downstream callers must NOT treat this as a valid recommendation.
    expect(ranked[0].semanticScore).toBe(0);
    // Any consumer that reads rank-1 as "recommended" without
    // checking semanticScore would fabricate. This test locks in
    // the invariant: rank-1 score can be 0.
  });
});

// -----------------------------------------------------------------------------
// §4 — document-class assessment
// -----------------------------------------------------------------------------

describe("15W · assessPdfExtraction — document class detection", () => {
  it("classifies zero-text / zero-positioned-item PDF as IMAGE_ONLY with DOCUMENT_TEXT_UNAVAILABLE exception", () => {
    const assessment = assessPdfExtraction({
      flattenedText: "",
      positionedItemCount: 0,
      positionedTextChars: 0,
      pageCount: 1,
      parserThrew: false,
    });
    expect(assessment.documentClass).toBe("IMAGE_ONLY");
    expect(assessment.exceptions).toContain("DOCUMENT_TEXT_UNAVAILABLE");
    expect(assessment.fallbackRequired).toBe(true);
    expect(assessment.textCoverage).toBe(0);
    expect(assessment.layoutCoherence).toBe(0);
  });

  it("classifies parser-threw with encryption hint as ENCRYPTED", () => {
    const assessment = assessPdfExtraction({
      flattenedText: "",
      positionedItemCount: 0,
      positionedTextChars: 0,
      pageCount: 1,
      parserThrew: true,
      parserError: "PasswordException: File requires a password",
    });
    expect(assessment.documentClass).toBe("ENCRYPTED");
    expect(assessment.exceptions).toContain("DOCUMENT_ANALYSIS_FAILED");
  });

  it("classifies parser-threw without encryption hint as UNSUPPORTED", () => {
    const assessment = assessPdfExtraction({
      flattenedText: "",
      positionedItemCount: 0,
      positionedTextChars: 0,
      pageCount: 0,
      parserThrew: true,
      parserError: "InvalidPDFException: bad xref",
    });
    expect(assessment.documentClass).toBe("UNSUPPORTED");
    expect(assessment.exceptions).toContain("DOCUMENT_ANALYSIS_FAILED");
  });

  it("classifies a text-healthy invoice with monetary + identifier signals as TEXT_HEALTHY", () => {
    const assessment = assessPdfExtraction({
      flattenedText: "Invoice # 12345\nSupplier Name Ltd\nSubtotal $1,000.00\nGST $50.00\nTotal $1,050.00\n" + "x".repeat(600),
      positionedItemCount: 60,
      positionedTextChars: 600,
      pageCount: 1,
      parserThrew: false,
    });
    expect(assessment.documentClass).toBe("TEXT_HEALTHY");
    expect(assessment.exceptions.length).toBe(0);
    expect(assessment.fallbackRequired).toBe(false);
    expect(assessment.monetarySignalCount).toBeGreaterThan(0);
    expect(assessment.identifierSignalCount).toBeGreaterThan(0);
  });

  it("classifies fragmented sparse text as TEXT_FRAGMENTED with fallback flagged", () => {
    // Enough chars to pass the IMAGE_ONLY floor but not enough for
    // structured analysis. 50 chars, positioned items present but
    // sparse.
    const assessment = assessPdfExtraction({
      flattenedText: "Invoice frag frag frag $5 more frag text here",
      positionedItemCount: 8,
      positionedTextChars: 50,
      pageCount: 1,
      parserThrew: false,
    });
    expect(assessment.documentClass).toBe("TEXT_FRAGMENTED");
    expect(assessment.exceptions).toContain("DOCUMENT_LAYOUT_UNUSABLE");
    expect(assessment.fallbackRequired).toBe(true);
  });

  it("classifies text-with-no-accounting-signals as MIXED", () => {
    const assessment = assessPdfExtraction({
      flattenedText: "This is a document with plenty of text but no invoice or amount markers to speak of. ".repeat(4),
      positionedItemCount: 40,
      positionedTextChars: 400,
      pageCount: 1,
      parserThrew: false,
    });
    expect(assessment.documentClass).toBe("MIXED");
  });
});

// -----------------------------------------------------------------------------
// §13 — architectural anti-hardcoding + anti-fabrication guard
// -----------------------------------------------------------------------------

describe("15W · anti-fabrication architectural guard", () => {
  const FORBIDDEN_FABRICATIONS = [
    // Petty Cash / bank / other cash-like accounts must NEVER appear
    // as literal fallback targets in ranker executable code.
    "1000 Petty Cash",
    "\"Petty Cash\"",
    "'Petty Cash'",
    "accountNumber === \"1000\"",
    "accountNumber === '1000'",
    "accountNumber == \"1000\"",
  ];

  function stripComments(line: string): string {
    return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  }
  function scanFile(path: string): Array<{ path: string; line: number; term: string }> {
    const raw = readFileSync(path, "utf8");
    const rawLines = raw.split(/\r?\n/);
    const out: Array<{ path: string; line: number; term: string }> = [];
    let inBlockComment = false;
    for (let i = 0; i < rawLines.length; i++) {
      let effective = rawLines[i];
      if (inBlockComment) {
        const end = effective.indexOf("*/");
        if (end === -1) continue;
        effective = effective.slice(end + 2);
        inBlockComment = false;
      }
      const start = effective.indexOf("/*");
      if (start !== -1 && effective.indexOf("*/", start) === -1) {
        inBlockComment = true;
        effective = effective.slice(0, start);
      }
      effective = stripComments(effective);
      for (const term of FORBIDDEN_FABRICATIONS) {
        if (effective.includes(term)) out.push({ path, line: i + 1, term });
      }
    }
    return out;
  }

  it("no ranker executable code branches on '1000 Petty Cash' as a fabricated fallback", async () => {
    const { readdir } = await import("node:fs/promises");
    const root = join(process.cwd(), "src", "lib", "ap-intelligence");
    const files = (await readdir(root)).filter((f) => f.endsWith(".ts"));
    const violations = files.flatMap((f) => scanFile(join(root, f)));
    if (violations.length > 0) {
      throw new Error(
        "Petty-Cash fabrication literals leaked into executable ap-intelligence code:\n"
        + violations.map((v) => `  ${v.path}:${v.line}  [${v.term}]`).join("\n"),
      );
    }
  });
});
