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
import { recommendGlAccount, type GlRecommendation, type SplitRecommendation } from "./gl-recommend";
import { extractVendorProfile, type ExtractedVendorProfile } from "./vendor-profile-extract";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import { getSetting } from "@/lib/enterprise/settings";
import type { ExtractedInvoice, ParseHint } from "./types";
import { EXTRACTION_RULE_VERSION } from "./types";
import type { FindingInput } from "@/lib/intelligence/types";
import type { DocumentStorageAdapter } from "@/lib/documents/types";
// Sprint 3 · Checkpoint 15Q — orchestrator now consumes the four
// generalized invoice-intelligence modules directly (previously they
// were unit-tested helpers). Their outputs become card provenance.
import type { SupplierExtraction } from "./supplier-extract";
import { extractLineItems, type LineItem } from "./line-items-extract";
import { reconcileTax, type TaxReconciliation } from "./tax-reconcile";
import { extractIdentifiers, type IdentifierCandidate } from "./identifier-taxonomy";
import { classifyEconomicPurpose, type PurposeCandidate } from "./economic-purpose";
// Sprint 3 · Checkpoint 15T — amount hierarchy + tax/credit groups.
import { computeAmountHierarchy, type AmountHierarchyResult } from "./amount-hierarchy";
import { buildTaxGroups, type TaxGroupsResult } from "./tax-groups";

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
  // Sprint 3 · Checkpoint 15P — second-pass vendor-profile extraction.
  // Runs against the same PDF text as the AP pipeline but populates
  // the vendor's permanent profile (address, phone, website, tax
  // registration, terms). Every field carries per-field confidence
  // + provenance so the Create Vendor modal can render trust chips.
  vendorProfile: ExtractedVendorProfile;
  // Sprint 3 · Checkpoint 15Q — the four generalized invoice-
  // intelligence outputs, wired through to the card projection so
  // the review UI can render per-dimension confidence + provenance.
  supplier: SupplierExtraction;
  lineItemsExtracted: LineItem[];
  taxReconciliation: TaxReconciliation;
  identifiers: IdentifierCandidate[];
  economicPurpose: PurposeCandidate[];
  // Decomposed confidence — one integer per dimension. Card renders
  // each as a chip; the founder can see WHY overall confidence is
  // whatever it is instead of a single opaque number.
  confidenceDimensions: ConfidenceDimensions;
  // Sprint 3 · Checkpoint 15T — amount hierarchy + tax/credit groups.
  // In-memory only this checkpoint; not persisted until arithmetic
  // and evidence validation are complete (founder rule §9).
  amountHierarchy: AmountHierarchyResult;
  taxGroupsResult: TaxGroupsResult;
  // Sprint 3 · Checkpoint 15U — canonical-analysis-only. Split
  // recommendations surface possible multi-debit-leg coding for a
  // mixed-purpose invoice. Consumed by future AP Coding modal work;
  // NOT used to automatically post multiple journal lines this
  // checkpoint.
  splitGlRecommendations: SplitRecommendation[];
}

// Sprint 3 · Checkpoint 15Q — decomposed confidence, one dimension
// per operational judgement the reviewer needs to trust. Each is a
// 0-100 integer; the card renders per-dimension chips.
export interface ConfidenceDimensions {
  supplier: DimensionResult;
  invoiceNumber: DimensionResult;
  dates: DimensionResult;
  lineItemCompleteness: DimensionResult;
  taxReconciliation: DimensionResult;
  totalReconciliation: DimensionResult;
  vendorMatch: DimensionResult;
  glClassification: DimensionResult;
}
export interface DimensionResult {
  confidence: number;              // 0..100
  source: DimensionSource;
  reason: string;
}
export type DimensionSource =
  | "invoice_document"
  | "email_sender"
  | "vendor_history"
  | "vendor_profile"
  | "computed"
  | "system_default";

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

  // Sprint 3 · Checkpoint 15P-6 — compute the vendor-profile
  // extraction FIRST so the resolver can consume its richer field
  // set (address, phone, website, tax id from the 15P-1 extractor).
  // Pre-15P-6 order was: resolve vendor (with only parse-invoice
  // guesses) THEN extract profile. That produced founder-observed
  // drift for the Microsoft record — projection said NOT_FOUND
  // while the modal's own POST endpoint (which uses the richer
  // profile) saw an EXACT match.
  const vendorProfileExtracted: ExtractedVendorProfile = pdfOk
    ? extractVendorProfile(pdfText, { vendorLegalName: extraction.vendor.guessedName })
    : {
        address: { line1: { value: null, confidence: 0, source: null }, line2: { value: null, confidence: 0, source: null },
                   city: { value: null, confidence: 0, source: null }, provinceState: { value: null, confidence: 0, source: null },
                   postalCode: { value: null, confidence: 0, source: null }, country: { value: null, confidence: 0, source: null },
                   blockConfidence: 0 },
        phone:                 { value: null, confidence: 0, source: null },
        fax:                   { value: null, confidence: 0, source: null },
        website:               { value: null, confidence: 0, source: null },
        customerSupportEmail:  { value: null, confidence: 0, source: null },
        arEmail:               { value: null, confidence: 0, source: null },
        remittanceEmail:       { value: null, confidence: 0, source: null },
        taxRegistrationNumber: { value: null, confidence: 0, source: null },
        vatNumber:             { value: null, confidence: 0, source: null },
        paymentTerms:          { value: null, confidence: 0, source: null },
      };

  const vendor = await resolveVendorForExtraction({
    clubId: args.clubId,
    extraction,
    extractedProfile: vendorProfileExtracted,
  });
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
  // Sprint 3 · Checkpoint 15Q — run the four generalized modules on
  // the same source text so the card projection can render per-
  // dimension confidence + provenance. Each of these is deterministic
  // and side-effect-free; safe to run inside the analyser.
  const supplierExtraction = parsed.supplier;
  const lineItemsExtracted: LineItem[] = pdfOk ? extractLineItems(pdfText) : [];
  const identifiers: IdentifierCandidate[] = pdfOk ? extractIdentifiers(pdfText) : [];
  const printedSubtotal = extraction.subtotal ? Number(extraction.subtotal) : null;
  const printedTax = extraction.taxTotal ? Number(extraction.taxTotal) : null;
  const printedTotal = extraction.total ? Number(extraction.total) : null;
  const taxReconciliation = reconcileTax({
    lines: lineItemsExtracted,
    printedSubtotal,
    printedTax,
    printedTotal,
  });
  // Sprint 3 · Checkpoint 15T — economic-purpose classifier now
  // consumes STRUCTURED evidence + full-document phrases in addition
  // to line-item descriptions. Founder rule (§4): evidence
  // strength is differentiated inside the classifier — this analyser
  // just makes sure ALL the signals are present.
  const membershipLineRe = /\b(?:membership|annual\s+dues|professional\s+dues|member(?:ship)?\s+fee|member\s+dues)\b/i;
  const professionalBodyRe =
    /\b(?:association|society|college|institute|order\s+of|academy|federation|chartered\s+(?:professional|accountants?|engineers?|surveyors?))\b/i;
  // ACRONYM + Region shape — e.g. "CPA ALBERTA", "LSBC BC", "ICABC BC".
  // Two to six ALL-CAPS letters followed by a Canadian / US region name.
  // Catches regulatory-body naming conventions without a vendor allowlist.
  const professionalBodyAcronymRe =
    /^[A-Z]{2,6}\s+(?:Alberta|Ontario|Manitoba|Saskatchewan|British\s+Columbia|BC|Quebec|Nova\s+Scotia|New\s+Brunswick|Newfoundland|Prince\s+Edward\s+Island|PEI|Yukon|Northwest\s+Territories|NWT|Nunavut|Canada|USA|America)$/i;
  const supplierName = extraction.vendor.guessedName;
  const hasMembershipLine =
    lineItemsExtracted.some((l) => membershipLineRe.test(l.description))
    || (pdfOk && membershipLineRe.test(pdfText));
  const hasProfessionalCredentialContext =
    (supplierName != null && (professionalBodyRe.test(supplierName) || professionalBodyAcronymRe.test(supplierName)))
    || (pdfOk && professionalBodyRe.test(pdfText));
  const economicPurpose = classifyEconomicPurpose({
    supplierName,
    lineDescriptions: lineItemsExtracted.map((l) => l.description),
    fullDocumentText: pdfOk ? pdfText : null,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: lineItemsExtracted.some(
      (l) => l.taxTreatment === "exempt" && l.evidence.includes("penalty_or_finance_charge"),
    ),
    hasMembershipLine,
    hasProfessionalCredentialContext,
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
    // Sprint 3 · Checkpoint 15T — hand the recommender the classifier
    // output produced HERE. This is the only path that carries the
    // full-document-phrase evidence into the GL boost logic; the
    // recommender's own classifier call cannot see the raw text.
    economicPurposeCandidates: economicPurpose,
    // Sprint 3 · Checkpoint 15U — pass the full extracted document
    // text + the richer line items with tax classification. Both
    // feed the query-concept extractor's document-phrase and line-
    // item channels respectively.
    fullDocumentText: pdfOk ? pdfText : null,
    extractedLineItems: lineItemsExtracted,
  });
  const confidenceDimensions = computeConfidenceDimensions({
    supplierExtraction,
    extraction,
    lineItemsExtracted,
    taxReconciliation,
    printedSubtotal,
    printedTax,
    printedTotal,
    vendorResolve: vendor,
    gl,
  });

  // Sprint 3 · Checkpoint 15T — compute amount hierarchy and tax /
  // credit groups. Printed total is preserved verbatim regardless
  // of whether the tax allocation reconciles (founder rule §6).
  const amountHierarchy = computeAmountHierarchy({
    printedTotal,
    printedSubtotal,
    printedTax,
    lineItems: lineItemsExtracted,
  });
  const taxGroupsResult = buildTaxGroups({
    lines: lineItemsExtracted,
    printedSubtotal,
    printedTax,
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

  // 15P-6: vendorProfile is already computed at the top of the
  // function (moved up so the resolver can consume it). Alias so the
  // return object keeps the pre-15P-6 field name that downstream
  // consumers depend on.
  const vendorProfile = vendorProfileExtracted;

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
    vendorProfile,
    supplier: supplierExtraction,
    lineItemsExtracted,
    taxReconciliation,
    identifiers,
    economicPurpose,
    confidenceDimensions,
    amountHierarchy,
    taxGroupsResult,
    splitGlRecommendations: gl.splitRecommendations,
  };
}

// ---------------------------------------------------------------------------
// Sprint 3 · Checkpoint 15Q — per-dimension confidence
// ---------------------------------------------------------------------------
//
// Each dimension is a 0-100 integer with a named source. Two design
// rules:
//   1. Never invent a confidence — return 0/system_default when the
//      underlying signal is missing.
//   2. The source category is the AUTHORITATIVE origin of the value
//      (invoice_document, email_sender, vendor_history, vendor_profile,
//      computed, system_default). The card renders this alongside
//      the score so the reviewer sees WHERE the extraction came from.

function computeConfidenceDimensions(args: {
  supplierExtraction: SupplierExtraction;
  extraction: ExtractedInvoice;
  lineItemsExtracted: LineItem[];
  taxReconciliation: TaxReconciliation;
  printedSubtotal: number | null;
  printedTax: number | null;
  printedTotal: number | null;
  vendorResolve: VendorResolveResult;
  gl: GlRecommendation;
}): ConfidenceDimensions {
  const {
    supplierExtraction, extraction, lineItemsExtracted, taxReconciliation,
    printedSubtotal, printedTax, printedTotal, vendorResolve, gl,
  } = args;

  const supplier: DimensionResult = {
    confidence: supplierExtraction.confidence,
    source: supplierExtraction.source === "invoice_document" ? "invoice_document"
      : supplierExtraction.source === "email_sender" ? "email_sender"
      : "system_default",
    reason: `Supplier reasoning: ${supplierExtraction.reasoningCode}.`,
  };

  const invoiceNumberHint = extraction.invoiceNumber ? 85 : 0;
  const invoiceNumber: DimensionResult = {
    confidence: invoiceNumberHint,
    source: extraction.invoiceNumber ? "invoice_document" : "system_default",
    reason: extraction.invoiceNumber
      ? "Invoice number matched a labelled 'Invoice Number' / 'INV-…' pattern."
      : "No invoice number extracted from the document.",
  };

  const hasBothDates = extraction.invoiceDate && extraction.dueDate;
  const dates: DimensionResult = {
    confidence: hasBothDates ? 90 : extraction.invoiceDate || extraction.dueDate ? 65 : 0,
    source: extraction.invoiceDate || extraction.dueDate ? "invoice_document" : "system_default",
    reason: hasBothDates
      ? "Invoice date and due date extracted."
      : extraction.invoiceDate
        ? "Invoice date extracted; due date not found."
        : extraction.dueDate
          ? "Due date extracted; invoice date not found."
          : "Neither invoice nor due date extracted.",
  };

  const linesCount = lineItemsExtracted.length;
  const hasSubtotal = printedSubtotal != null;
  const lineItemCompleteness: DimensionResult = {
    confidence: linesCount === 0 ? 0
      : hasSubtotal && Math.abs(sum(lineItemsExtracted.map((l) => l.amount)) - printedSubtotal) < 0.02 ? 92
      : linesCount >= 1 ? 55
      : 0,
    source: linesCount > 0 ? "invoice_document" : "system_default",
    reason: linesCount === 0
      ? "No line items extracted from the invoice body."
      : hasSubtotal
        ? `${linesCount} line item(s) extracted; sum reconciles to printed subtotal within tolerance.`
        : `${linesCount} line item(s) extracted; no printed subtotal to reconcile against.`,
  };

  const taxRec: DimensionResult = {
    confidence: taxReconciliation.outcome === "reconciled_single_rate" ? 90
      : taxReconciliation.outcome === "reconciled_no_tax" ? 85
      : taxReconciliation.outcome === "unresolved_ambiguous" ? 45
      : 30,
    source: taxReconciliation.outcome.startsWith("reconciled") ? "computed" : "system_default",
    reason: taxReconciliation.message,
  };

  const totalReconcile: DimensionResult = (() => {
    if (printedSubtotal == null || printedTax == null || printedTotal == null) {
      return {
        confidence: 0,
        source: "system_default",
        reason: "Insufficient printed totals to reconcile.",
      };
    }
    const derived = round2(printedSubtotal + printedTax);
    const diff = Math.abs(derived - printedTotal);
    if (diff <= 0.02) {
      return {
        confidence: 95,
        source: "computed",
        reason: `Subtotal + tax = ${derived.toFixed(2)} reconciles to printed total ${printedTotal.toFixed(2)}.`,
      };
    }
    return {
      confidence: 35,
      source: "computed",
      reason: `Printed total ${printedTotal.toFixed(2)} does not match subtotal + tax = ${derived.toFixed(2)} (diff ${diff.toFixed(2)}).`,
    };
  })();

  const vendorMatch: DimensionResult = (() => {
    switch (vendorResolve.state) {
      case "MATCHED":
        return { confidence: 90, source: "vendor_history", reason: `Matched to Spectre vendor ${vendorResolve.candidates[0]?.legalName ?? "record"}.` };
      case "AMBIGUOUS":
        return { confidence: 45, source: "computed", reason: `${vendorResolve.candidates.length} vendor candidates — reviewer must disambiguate.` };
      case "NOT_FOUND":
        return { confidence: 20, source: "computed", reason: "No matching Spectre vendor record — will create one." };
      case "INSUFFICIENT_SIGNAL":
      default:
        return { confidence: 0, source: "system_default", reason: "Insufficient extraction signal to attempt vendor match." };
    }
  })();

  const glClassification: DimensionResult = (() => {
    if (gl.source === "NONE" || gl.confidence == null) {
      return { confidence: 0, source: "system_default", reason: gl.reason };
    }
    const src: DimensionSource =
      gl.source === "VENDOR_DEFAULT" ? "vendor_profile"
      : gl.source === "PRIOR_CODING" ? "vendor_history"
      : "computed";
    return { confidence: gl.confidence, source: src, reason: gl.reason };
  })();

  return { supplier, invoiceNumber, dates, lineItemCompleteness, taxReconciliation: taxRec, totalReconciliation: totalReconcile, vendorMatch, glClassification };
}

function sum(nums: number[]): number { return nums.reduce((a, n) => a + n, 0); }
function round2(n: number): number { return Math.round(n * 100) / 100; }

async function loadBytes(clubId: string, storageKey: string, override: DocumentStorageAdapter | undefined): Promise<Buffer | null> {
  if (override) return override.get({ storageKey });
  const adapter = await resolveDocumentStorage({ clubId });
  return adapter.get({ storageKey });
}
