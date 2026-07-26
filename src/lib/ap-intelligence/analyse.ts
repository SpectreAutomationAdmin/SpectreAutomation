// Sprint 3 Checkpoint 15E (2026-07-24) — AP-invoice analyser
// orchestrator.
//
// Sequence:
//   1. Load IngestedDocument (must exist, must be PDF).
//   2. Fetch bytes from storage.
//   3. pdf-parse → text.
//   4. parseInvoiceText → structured extraction.
//   5. Arithmetic validation → findings.
//   6. Vendor resolution → candidates.
//   7. AP reconciliation → findings.
//   8. Capital-vs-operating → recommendation.
//   9. GL recommendation → account.
//   10. Emit findings via persistence.ts (reusing the C15B WorkIntakeFinding table).

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { extractPdfText } from "./pdf-extract";
import { parseInvoiceText } from "./parse-invoice";
import { validateExtractedArithmetic } from "./validate";
import { resolveVendorForExtraction, type VendorResolveResult } from "./vendor-resolve";
import { reconcileAgainstAp, type ReconcileResult } from "./reconcile";
import { classifyCapitalVsOperating, type CapitalVsOperatingRecommendation } from "./capital-vs-operating";
import { recommendGlAccount, type GlRecommendation } from "./gl-recommend";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import { getSetting } from "@/lib/enterprise/settings";
import type { ExtractedInvoice, ParseHint } from "./types";
import { EXTRACTION_RULE_VERSION } from "./types";
import type { FindingInput } from "@/lib/intelligence/types";
import type { DocumentStorageAdapter } from "@/lib/documents/types";

export interface ApAnalyseArgs {
  clubId: string;
  ingestedDocumentId: string;
  now?: Date;
  emailSubject?: string | null;
  emailSenderAddress?: string | null;
  storageOverride?: DocumentStorageAdapter;
  bytesOverride?: Buffer | null;
  // Test-only escape hatch — skips PDF parsing and feeds the parser
  // the supplied string directly. Production must never pass this.
  extractedTextOverride?: string | null;
}

export interface ApAnalyseResult {
  documentId: string;
  ruleVersion: number;
  extraction: ExtractedInvoice;
  extractionHints: ParseHint[];
  vendor: VendorResolveResult;
  reconcile: ReconcileResult;
  capital: CapitalVsOperatingRecommendation;
  gl: GlRecommendation;
  findings: FindingInput[];
  extractionTextLength: number;
}

export async function analyseIngestedInvoice(args: ApAnalyseArgs): Promise<ApAnalyseResult> {
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: args.ingestedDocumentId, clubId: args.clubId },
    select: {
      id: true,
      mimeType: true,
      sha256Hash: true,
      storageBucket: true,
      storageKey: true,
      filename: true,
    },
  });
  if (!doc) {
    throw new Error(`AP analyser: IngestedDocument ${args.ingestedDocumentId} not found for club ${args.clubId}`);
  }
  if (doc.mimeType !== "application/pdf") {
    throw new Error(`AP analyser: document ${doc.id} is ${doc.mimeType}, not PDF`);
  }

  let pdfOk = true;
  let pdfText = "";
  let pdfReason: string | null = null;
  if (args.extractedTextOverride != null) {
    pdfText = args.extractedTextOverride;
    pdfOk = pdfText.trim().length > 0;
    if (!pdfOk) pdfReason = "EMPTY_TEXT";
  } else {
    const bytes = args.bytesOverride ?? await loadBytes(args.clubId, doc.storageKey, args.storageOverride);
    if (!bytes) {
      throw new Error(`AP analyser: storage adapter returned no bytes for ${doc.id}`);
    }
    const pdf = await extractPdfText(bytes);
    pdfOk = pdf.ok;
    pdfText = pdf.ok ? pdf.text : "";
    pdfReason = pdf.reason ?? null;
  }
  const parsed = parseInvoiceText({
    extractedText: pdfOk ? pdfText : "",
    emailSubject: args.emailSubject ?? null,
    emailSenderAddress: args.emailSenderAddress ?? null,
  });
  const extraction: ExtractedInvoice = pdfOk
    ? parsed.invoice
    : { ...parsed.invoice, state: "DOCUMENT_UNREADABLE", extractedTextChars: 0, warnings: [pdfReason ?? "PDF_PARSE_ERROR"] };

  // Read the capital threshold from club settings.
  const capitalMinSetting = await getSetting<number>(args.clubId, "APPROVAL_THRESHOLDS", "capital_expense_min");
  const capitalMin = typeof capitalMinSetting === "number" ? capitalMinSetting : 5000;
  const capitalMinCents = Math.round(capitalMin * 100);

  const arithmetic = validateExtractedArithmetic(extraction);
  const vendor = await resolveVendorForExtraction({ clubId: args.clubId, extraction });
  const reconcile = await reconcileAgainstAp({
    clubId: args.clubId,
    extraction,
    vendor,
    ingestedDocumentId: doc.id,
    ingestedDocumentSha256: doc.sha256Hash,
  });
  const capital = classifyCapitalVsOperating({
    extraction,
    clubCapitalMinCents: capitalMinCents,
  });
  const gl = await recommendGlAccount({
    clubId: args.clubId,
    vendorId: vendor.state === "MATCHED" ? vendor.candidates[0].id : null,
    capitalState: capital.state,
    capitalClass: capital.capitalClass,
    // Sprint 3 · Checkpoint 15L — pass the extraction so the recommender
    // can do a name-keyword search against the tenant's COA even when
    // no vendor record exists yet (the founder-observed Microsoft case).
    extraction,
  });

  // ---- Assemble findings for WorkIntakeFinding persistence ---------------
  const findings: FindingInput[] = [];
  const evidenceRefs = [
    { kind: "INGESTED_DOCUMENT" as const, referenceId: doc.id },
  ];

  for (const a of arithmetic) {
    findings.push({
      key: a.key,
      statement: a.statement,
      state: "CONFIRMED",
      severity: a.severity,
      materialityCents: null,
      ruleKey: a.ruleKey,
      ruleVersion: a.ruleVersion,
      evidenceRefs,
    });
  }
  for (const f of reconcile.findings) {
    findings.push({
      key: f.key,
      statement: f.statement,
      state: "CONFIRMED",
      severity: f.severity,
      materialityCents: null,
      ruleKey: f.ruleKey,
      ruleVersion: f.ruleVersion,
      evidenceRefs: f.apInvoiceId
        ? [...evidenceRefs, { kind: "AP_INVOICE" as const, referenceId: f.apInvoiceId }]
        : evidenceRefs,
    });
  }

  // Capital / operating candidate is always emitted so downstream review
  // sees the analyser's judgement even when arithmetic + reconcile were clean.
  const capitalFindingKey =
    capital.state === "CAPITAL" ? "ap.invoice.capital_candidate"
    : capital.state === "OPERATING" ? "ap.invoice.operating_candidate"
    : capital.state === "AMBIGUOUS" ? "ap.invoice.requires_review"
    : "ap.invoice.insufficient_evidence";
  findings.push({
    key: capitalFindingKey,
    statement: capital.reasoning,
    state: "OBSERVED",
    severity: capital.state === "AMBIGUOUS" ? "MEDIUM" : "INFO",
    materialityCents: null,
    ruleKey: capitalFindingKey.replace(/^ap\.invoice\./, "capital_vs_operating."),
    ruleVersion: capital.ruleVersion,
    evidenceRefs,
  });

  // Match-state finding — cheap signal for the MC card.
  const matchKey =
    reconcile.state === "MATCH" || reconcile.state === "DUPLICATE" ? "ap.invoice.match"
    : reconcile.state === "HASH_DUPLICATE" ? "ap.invoice.hash_duplicate"
    : reconcile.state === "AMOUNT_MISMATCH" ? "ap.invoice.total_mismatch"
    : reconcile.state === "VENDOR_MISMATCH" ? "ap.invoice.vendor_ambiguous"
    : "ap.invoice.not_found";
  if (!findings.some((f) => f.key === matchKey)) {
    findings.push({
      key: matchKey,
      statement: `Reconciliation state: ${reconcile.state}. See other findings for detail.`,
      state: "OBSERVED",
      severity: "INFO",
      materialityCents: null,
      ruleKey: "reconcile.summary",
      ruleVersion: reconcile.ruleVersion,
      evidenceRefs,
    });
  }

  logger.info("ap-intelligence.analyse.complete", {
    clubId: args.clubId,
    documentIdTail: doc.id.slice(-6),
    extractionState: extraction.state,
    extractionTextChars: extraction.extractedTextChars,
    vendorState: vendor.state,
    reconcileState: reconcile.state,
    capitalState: capital.state,
    findingsCount: findings.length,
  });

  return {
    documentId: doc.id,
    ruleVersion: EXTRACTION_RULE_VERSION,
    extraction,
    extractionHints: parsed.hints,
    vendor,
    reconcile,
    capital,
    gl,
    findings,
    extractionTextLength: extraction.extractedTextChars,
  };
}

async function loadBytes(clubId: string, storageKey: string, override: DocumentStorageAdapter | undefined): Promise<Buffer | null> {
  if (override) return override.get({ storageKey });
  const adapter = await resolveDocumentStorage({ clubId });
  return adapter.get({ storageKey });
}
