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
// Sprint 3 · Checkpoint 15V — multi-GL allocation engine.
import { computeAllocations, type AllocationResult } from "./gl-allocations";
import { extractConceptsForAccount } from "./gl-account-concepts";
// Sprint 3 · Checkpoint 15V Addendum-2 — coordinate-aware layout
// extraction for supplier-block detection.
import { extractPdfLayout } from "./pdf-layout-extract";
import { detectLayoutRegions, pickSupplierRegion } from "./layout-regions";
// Sprint 3 · Checkpoint 15W — document-class assessment so the
// pipeline distinguishes image-only PDFs from healthy-text PDFs
// before invoking downstream extractors that could otherwise
// invent vendor / GL from empty input.
import { assessPdfExtraction, type PdfExtractionAssessment } from "./document-class";
// Sprint 3 · Checkpoint 15X — extraction strategy router. Routes
// image-only PDFs through AWS Textract AnalyzeExpense and returns
// a provider-neutral CanonicalDocumentExtraction that downstream
// extractors consume as if it were embedded text.
import { runDocumentExtractionStrategy } from "./document-extractors/strategy-router";
import type { CanonicalDocumentExtraction } from "./document-extractors/canonical-model";
// Sprint 3 · Checkpoint 15X Activation (2026-08-03) — canonical
// projection merge. When OCR produces a canonical extraction, its
// STRUCTURED fields (address components, line items, etc.) override
// the analyser's text-parsed values which lose that structure via
// the synthesizer round-trip.
import {
  mergeCanonicalIntoExtraction,
  mergeCanonicalIntoLineItems,
  mergeCanonicalIntoVendorProfile,
  overrideAssessmentFromCanonical,
} from "./ocr/canonical-projection";
// Sprint 3 · Checkpoint 15Y (2026-08-03) — field-quality validation
// and rescue. Runs AFTER text parse and canonical merge; rejects
// header-row supplier candidates, concatenated identifier values,
// and forces GL abstention when foundational extraction is
// structurally unreliable (§9). General logic — no invoice-
// specific rules.
import { applyFieldQualityGate, type QualityGateResult } from "./field-quality";
// Sprint 3 · Checkpoint 16A (2026-08-04) — hierarchical accounting
// intelligence. Accounting-nature classifier + positioned-table
// reconstructor.
import { classifyAccountingNature, type AccountingNatureAssessment } from "./accounting-nature";
import { reconstructLineItemTable, type TableReconstructResult } from "./positioned-table-reconstruct";
// Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — structural-quality
// reclassification + escalation trigger. When embedded text was
// extracted but the RESULT shows structural degradation (rejected
// supplier, contaminated reference, total-without-lines), reclassify
// as COLLAPSED_COLUMNS / UNRECOVERED_TABLE and escalate to the next
// strategy (positioned layout OR persisted Textract).
import { assessStructuralQuality } from "./structural-quality";
import { extractFromPositionedLayout } from "./positioned-extract";
import { requestOcrExtraction } from "./ocr/enqueue";

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
  // Sprint 3 · Checkpoint 15V — canonical multi-GL allocation output.
  // Every AP invoice now produces a list of per-purpose allocations
  // with per-allocation recommended account, alternatives, tax
  // treatment, and confidence. The reconciliation totals prove the
  // debits + recoverable tax balance the AP credit.
  allocations: AllocationResult;
  // Sprint 3 · Checkpoint 15W — document-class assessment. Callers
  // (projection layer, tests, diagnostics) can distinguish an image-
  // only scan (needs OCR) from an unreadable PDF (never parses) from
  // a text-healthy invoice (structured analysis expected to work).
  // When documentClass is IMAGE_ONLY or UNSUPPORTED or ENCRYPTED,
  // no confident supplier or GL recommendation is emitted.
  documentAssessment: PdfExtractionAssessment | null;
  // Sprint 3 · Checkpoint 16A (2026-08-04) — hierarchical
  // accounting intelligence. Consumed by benchmarks + diagnostics;
  // the rendered card contract is unchanged.
  accountingIntelligence: {
    natureLeader: import("./accounting-nature").AccountingNature;
    natureConfidence: number;
    natureIsDefensible: boolean;
    natureRankedTop3: Array<{
      nature: import("./accounting-nature").AccountingNature;
      score: number;
      supportingEvidence: string[];
      contradictingEvidence: string[];
    }>;
    tableReconstruction: null | {
      headerFound: boolean;
      columnCount: number;
      lineItemsRecovered: number;
      columnAlignmentConfidence: number;
    };
  };
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
  // Sprint 3 · Checkpoint 15V Addendum-2 — coordinate-aware layout
  // extraction. Populated from the PDF bytes path (not the text-
  // override path used only by tests). Consumed by the supplier-
  // region selector so vendor-profile extraction runs against the
  // spatially-selected letterhead rather than the flattened stream.
  let supplierRegionText: string | null = null;
  // Sprint 3 · Checkpoint 15W — document-class inputs.
  let positionedItemCount = 0;
  let positionedTextChars = 0;
  let pdfPageCount = 0;
  let parserThrew = false;
  let parserError: string | null = null;
  // Sprint 3 · Checkpoint 15X — canonical extraction from the
  // strategy router. Populated when the router selected OCR
  // (AWS Textract) as the winning strategy.
  let canonicalExtraction: CanonicalDocumentExtraction | null = null;
  // Sprint 3 · Checkpoint 16A — positioned-layout table
  // reconstruction result. When Textract line items are sparse or
  // absent, the reconstructor recovers rows from the pdf.js
  // positioned items.
  let tableReconstruction: TableReconstructResult | null = null;
  let accountingNatureAssessment: AccountingNatureAssessment | null = null;
  // Sprint 3 · Checkpoint 15Y-Rejected — keep the PdfLayout in
  // scope so the positioned-layout rescue path can consume it
  // when the flat-text parser produces structurally-degraded
  // candidates. Set from the router result.
  let pdfLayout: import("./pdf-layout-extract").PdfLayout | null = null;
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
    if (!pdf.ok) {
      parserThrew = true;
      parserError = pdf.reason ?? "parse_failed";
    }
    // Sprint 3 · Checkpoint 15X — run the strategy router. It:
    //   * extracts layout + text (Strategies A + B)
    //   * assesses document class
    //   * invokes AWS Textract AnalyzeExpense for IMAGE_ONLY /
    //     TEXT_FRAGMENTED / MIXED docs (Strategy C)
    //   * abstains truthfully for ENCRYPTED / UNSUPPORTED
    try {
      // Sprint 3 · Checkpoint 15X continuation — the router now
      // NEVER invokes a paid provider synchronously. It reads the
      // persisted DocumentOcrExtraction row (§3-§5) and, if
      // missing, enqueues one worker job (§2, §4). The web tier
      // is never blocked on Textract.
      //
      // Pass clubId + docId + sha so the enqueue path can persist
      // idempotently. Without these fields the router falls back to
      // NOT_ENQUEUED and callers see truthful "pending" state.
      const routed = await runDocumentExtractionStrategy({
        bytes,
        mimeType: doc.mimeType,
        clubId: args.clubId,
        ingestedDocumentId: doc.id,
        documentSha256: doc.sha256Hash,
        correlationHash: doc.sha256Hash?.slice(0, 16),
      });
      pdfPageCount = routed.layout?.pageCount ?? 0;
      positionedItemCount = routed.layout?.items.length ?? 0;
      positionedTextChars = routed.layout?.items.reduce((sum, it) => sum + (it.text?.replace(/\s+/g, "").length ?? 0), 0) ?? 0;
      if (routed.layout) {
        pdfLayout = routed.layout;   // 15Y-Rejected — retained for post-parse rescue
        const regions = detectLayoutRegions(routed.layout.visualLines);
        const supplier = pickSupplierRegion(regions);
        if (supplier) supplierRegionText = supplier.text;
        // Sprint 3 · Checkpoint 16A — positioned-layout table
        // reconstruction. Runs on every doc with a layout; result
        // is used as an ADDITIONAL evidence source when Textract
        // line items are sparse or absent.
        try {
          tableReconstruction = reconstructLineItemTable(routed.layout);
        } catch (e) {
          logger.warn("ap-intelligence.table-reconstruct.error", {
            clubId: args.clubId, docIdTail: doc.id.slice(-6),
            message: (e as Error).message.slice(0, 200),
          });
        }
      }
      // If Textract succeeded, its canonical extraction is the
      // authoritative source of supplier / payable / total / lines
      // for downstream consumers. Feed a synthetic pdfText into the
      // pre-Textract extractors so they can still pull evidence
      // (concepts, purposes) via their existing regexes.
      if (routed.canonicalExtraction) {
        canonicalExtraction = routed.canonicalExtraction;
        pdfText = synthesizePdfTextFromCanonical(canonicalExtraction, pdfText);
        pdfOk = pdfText.trim().length > 0;
        // Supplier region text — assemble from canonical extraction.
        if (canonicalExtraction.fields.supplierName || canonicalExtraction.fields.supplierAddress) {
          supplierRegionText = synthesizeSupplierRegionText(canonicalExtraction);
        }
      }
    } catch (e) {
      // Strategy-router error is non-fatal; existing paths still run
      // against whatever pdfText was extracted.
      logger.warn("ap-intelligence.strategy-router.error", {
        clubId: args.clubId,
        docIdTail: doc.id.slice(-6),
        message: (e as Error).message.slice(0, 200),
      });
    }
  }
  // Sprint 3 · Checkpoint 15W — assess extraction quality up front.
  // An IMAGE_ONLY scan (0 chars + 0 positioned items) triggers early
  // abstention so the downstream ranker never surfaces a
  // fabricated GL. Text-healthy docs proceed unchanged.
  const documentAssessment: PdfExtractionAssessment | null = args.extractedTextOverride != null
    ? null
    : assessPdfExtraction({
        flattenedText: pdfText,
        positionedItemCount,
        positionedTextChars,
        pageCount: pdfPageCount,
        parserThrew,
        parserError,
      });
  const parsed = parseInvoiceText({
    extractedText: pdfOk ? pdfText : "",
    emailSubject: args.emailSubject ?? null,
    emailSenderAddress: args.emailSenderAddress ?? null,
  });
  let extraction: ExtractedInvoice = pdfOk
    ? parsed.invoice
    : { ...parsed.invoice, state: "DOCUMENT_UNREADABLE", extractedTextChars: 0, warnings: [pdfReason ?? "PDF_PARSE_ERROR"] };

  // Sprint 3 · Checkpoint 15Y (2026-08-03) — field-quality gate pass 1
  // (pre-canonical-merge). Rejects supplier candidates dominated by
  // form labels (crammed header-row noise) and payable references
  // composed of concatenated dates + numbers (multiple identifiers
  // glued by a flat-text extractor).
  // Rescue path scans fullText for an organization-suffix line
  // (LP / Inc / Ltd / Corp / LLC / Co. / Corporation) when a
  // structurally sound alternative exists. GENERAL logic — no
  // invoice-specific rules.
  const gateResult1 = applyFieldQualityGate({ extraction, fullText: pdfText });
  extraction = gateResult1.extraction;
  let fieldQualityGate: QualityGateResult = gateResult1.gate;

  // Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — structural
  // reclassification + escalation.
  //
  // Text presence is not sufficient evidence of usable document
  // structure. When the parse RESULT shows degradation (rejected
  // supplier, contaminated reference, total-without-lines), the
  // doc is reclassified as COLLAPSED_COLUMNS or UNRECOVERED_TABLE
  // and the next strategy is invoked:
  //   * POSITIONED_LAYOUT — rescue supplier/identifiers from row/
  //     column-aware analysis of the pdf.js positioned items.
  //   * AWS_TEXTRACT_EXPENSE — enqueue a persisted OCR extraction
  //     (idempotent per §16; at most one paid call per identity).
  //
  // The OCR enqueue is asynchronous; the current analyser call
  // does NOT wait for it. The projection cache invalidates via the
  // ocrRevision axis once the worker persists SUCCEEDED, so the
  // next Mission Control render surfaces the enriched result
  // without a browser refresh triggering another provider call.
  const structural = assessStructuralQuality({
    documentClass: (documentAssessment?.documentClass ?? "TEXT_HEALTHY") as import("./document-class").DocumentClass,
    fieldQualityGate,
    extraction,
    layoutItemCount: positionedItemCount,
    layoutHasVisualLines: !!pdfLayout && (pdfLayout.visualLines?.length ?? 0) > 0,
    supplierWasRejected: fieldQualityGate.supplier.action === "rejected",
    referenceWasRejected: fieldQualityGate.reference.action === "rejected",
    referenceWasContaminated: fieldQualityGate.reference.action === "trimmed",
  });

  // Positioned-layout rescue — free, in-process. Try when the flat-
  // text supplier was rejected AND we have positioned items.
  if (
    (structural.recommendedEscalation === "POSITIONED_LAYOUT" ||
      structural.recommendedEscalation === "AWS_TEXTRACT_EXPENSE") &&
    pdfLayout &&
    fieldQualityGate.supplier.action === "rejected"
  ) {
    const positioned = extractFromPositionedLayout(pdfLayout);
    if (positioned.supplier) {
      // Re-run supplier validation on the rescued candidate.
      const revalidated = applyFieldQualityGate({
        extraction: { ...extraction, vendor: { ...extraction.vendor, guessedName: positioned.supplier.value } },
        fullText: pdfText,
      });
      if (revalidated.gate.supplier.action !== "rejected") {
        extraction = revalidated.extraction;
        fieldQualityGate = revalidated.gate;
      }
    }
    // Identifier rescues from positioned layout — only fill IF flat-
    // text parse rejected the field.
    if (extraction.invoiceNumber == null && positioned.invoiceNumber) {
      extraction = { ...extraction, invoiceNumber: positioned.invoiceNumber.value, payableReferenceType: "INVOICE_NUMBER" };
    }
    if ((extraction.purchaseOrder == null || extraction.purchaseOrder === "") && positioned.purchaseOrderNumber) {
      extraction = { ...extraction, purchaseOrder: positioned.purchaseOrderNumber.value };
    }
  }

  // OCR escalation — enqueue an async Textract job when the structural
  // quality assessment recommends it and the doc has embedded text
  // (image-only docs are already handled by the strategy router).
  if (
    structural.recommendedEscalation === "AWS_TEXTRACT_EXPENSE" &&
    (documentAssessment?.documentClass === "TEXT_HEALTHY" ||
      documentAssessment?.documentClass === "TEXT_FRAGMENTED" ||
      documentAssessment?.documentClass === "MIXED") &&
    args.extractedTextOverride == null &&
    !canonicalExtraction  // only if we don't already have OCR
  ) {
    try {
      await requestOcrExtraction({
        clubId: args.clubId,
        ingestedDocumentId: doc.id,
        documentSha256: doc.sha256Hash,
        // Treat as fragmented so the strategy router's OCR gate
        // opens on subsequent renders as well.
        documentClass: "TEXT_FRAGMENTED",
        strategy: "AWS_TEXTRACT_EXPENSE",
      });
      logger.info("ap-intelligence.analyse.escalated_to_ocr", {
        clubId: args.clubId,
        docIdTail: doc.id.slice(-6),
        structuralQuality: structural.quality,
        reasons: structural.reasons,
      });
    } catch (e) {
      logger.warn("ap-intelligence.analyse.ocr_escalation_failed", {
        clubId: args.clubId,
        docIdTail: doc.id.slice(-6),
        message: (e as Error).message.slice(0, 200),
      });
    }
  }

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
    ? extractVendorProfile(pdfText, {
        vendorLegalName: extraction.vendor.guessedName,
        supplierRegionText,
      })
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

  let gl = await recommendGlAccount({
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

  // Sprint 3 · Checkpoint 15V — multi-GL allocation engine. Runs the
  // 15U ranker per economic-purpose cluster; the result feeds the
  // AP Coding modal directly and drives the "Multiple" Category
  // display on the Work Intake card.
  const accountsForAllocations = await prisma.account.findMany({
    where: { clubId: args.clubId, isActive: true, isHeader: false, type: { in: ["EXPENSE", "ASSET"] } },
    select: {
      id: true, accountNumber: true, name: true, type: true,
      allowManualPosting: true, fundApplicability: true,
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
  });
  const allocationAccounts = accountsForAllocations.map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    name: a.name,
    categoryKey: a.category?.key ?? null,
    categoryName: a.category?.name ?? null,
    fsGroupKey: a.fsGroup?.key ?? null,
    fsGroupName: a.fsGroup?.name ?? null,
  }));
  const allocationPostingBlockers = new Map<string, Array<import("./gl-recommend").PostingBlocker>>();
  for (const a of accountsForAllocations) {
    const blockers: Array<import("./gl-recommend").PostingBlocker> = [];
    if (!a.allowManualPosting) blockers.push("MANUAL_POSTING_DISALLOWED");
    const isPL = a.type === "EXPENSE";
    if (isPL && (!a.fundApplicability || a.fundApplicability.trim() === "")) {
      blockers.push("FUND_APPLICABILITY_UNMAPPED");
    }
    allocationPostingBlockers.set(a.id, blockers);
  }
  const allocations = computeAllocations({
    lineItems: lineItemsExtracted,
    accounts: allocationAccounts,
    postingBlockersByAccount: allocationPostingBlockers,
    economicPurposeCandidates: economicPurpose,
    fullDocumentText: pdfOk ? pdfText : null,
    supplierName: extraction.vendor.guessedName,
    printedSubtotal,
    printedTax,
    printedTotal,
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
  let vendorProfile = vendorProfileExtracted;

  // Sprint 3 · Checkpoint 15X Activation (2026-08-03) — canonical
  // projection merge. When OCR produced a canonical extraction, its
  // structured fields (address components with province + postal +
  // country separated; per-line-item amounts) override the text-
  // parsed derivatives that lost structure via the flat-text
  // synthesizer. Text-parsed values remain as fallback for fields
  // the provider didn't classify. See ocr/canonical-projection.ts.
  let mergedExtraction = extraction;
  let mergedLineItems = lineItemsExtracted;
  let mergedAssessment = documentAssessment;
  if (canonicalExtraction) {
    mergedExtraction = mergeCanonicalIntoExtraction(extraction, canonicalExtraction);
    mergedLineItems = mergeCanonicalIntoLineItems(lineItemsExtracted, canonicalExtraction);
    vendorProfile = mergeCanonicalIntoVendorProfile(vendorProfile, canonicalExtraction);
    mergedAssessment = overrideAssessmentFromCanonical(documentAssessment, canonicalExtraction);
  }

  // Sprint 3 · Checkpoint 15Y (2026-08-03) — field-quality gate pass 2
  // (post-canonical-merge). Canonical (OCR) fields may re-introduce a
  // supplier / reference candidate that ALSO fails validation — for
  // example, a provider that labels a header row as VENDOR_NAME. Run
  // the gate again on the merged output and abstain from GL when
  // structural quality is insufficient (§9). Preserves 15W safe-
  // abstention behaviour under OCR contamination.
  // Sprint 3 · Checkpoint 16A — merge reconstructed table rows into
  // mergedExtraction when Textract/text line items are sparse.
  // "Sparse" = fewer than 2 line items with substantive descriptions
  // (≥12 chars). The reconstructor's output is used ADDITIVELY —
  // never overrides confidently-extracted Textract lines.
  if (tableReconstruction && tableReconstruction.lineItems.length > 0) {
    const currentSubstantive = mergedExtraction.lineItems.filter(
      (li) => (li.description?.length ?? 0) >= 12 && Number(li.amount ?? 0) > 0,
    ).length;
    if (currentSubstantive < 2 && tableReconstruction.lineItems.length >= 2) {
      const reconstructed = tableReconstruction.lineItems
        .filter((li) => (li.description?.length ?? 0) >= 3)
        .map((li) => ({
          description: li.sku ? `${li.sku} | ${li.description}` : li.description,
          quantity: li.quantity != null ? String(li.quantity) : null,
          unitCost: li.unitPrice != null ? li.unitPrice.toFixed(2) : null,
          amount: li.amount != null ? li.amount.toFixed(2) : "0.00",
        }));
      mergedExtraction = { ...mergedExtraction, lineItems: reconstructed };
      mergedLineItems = reconstructed.map((li, i) => ({
        description: li.description,
        quantity: li.quantity != null ? Number(li.quantity) : null,
        unitPrice: li.unitCost != null ? Number(li.unitCost) : null,
        amount: Number(li.amount),
        taxRate: null,
        taxAmount: null,
        taxTreatment: "unknown" as const,
        evidence: [],
        confidence: 60,
        lineNo: i + 1,
      }));
    }
  }

  const gateResult2 = applyFieldQualityGate({ extraction: mergedExtraction, fullText: pdfText });
  mergedExtraction = gateResult2.extraction;
  fieldQualityGate = gateResult2.gate;
  let gatedAllocations = allocations;
  if (!fieldQualityGate.glEligible) {
    // Force GL abstention. Preserves candidate list for diagnostics
    // but nulls the SELECTED account so the projection displays
    // "review required" with a truthful reason.
    gl = {
      ...gl,
      accountNumber: null,
      accountName: null,
      categoryKey: null,
      fsGroupKey: null,
      source: "NONE",
      confidence: 0,
      reason: `abstained_field_quality:${fieldQualityGate.abstentionReasons.join(",")}`,
      candidates: gl.candidates ?? [],
      autoApprovalEligible: false,
    };
    // §9 rule: contaminated extraction must not yield a confident
    // multi-GL allocation either. Preserve the entries for
    // diagnostics (auditors may want to see what the ranker would
    // have produced), but null the SURFACED category and force
    // requiresReview so the projection does not show a plausible
    // GL/category. See gl-allocations.AllocationResult shape.
    gatedAllocations = {
      ...allocations,
      cardCategory: null,
      requiresReview: true,
    };
  }

  return {
    documentId: doc.id,
    ruleVersion: EXTRACTION_RULE_VERSION,
    extraction: mergedExtraction,
    extractionHints: parsed.hints,
    vendor,
    reconcile,
    capital,
    gl,
    findings,
    extractionTextLength: mergedExtraction.extractedTextChars,
    vendorProfile,
    supplier: supplierExtraction,
    lineItemsExtracted: mergedLineItems,
    taxReconciliation,
    identifiers,
    economicPurpose,
    confidenceDimensions,
    amountHierarchy,
    taxGroupsResult,
    splitGlRecommendations: gl.splitRecommendations,
    allocations: gatedAllocations,
    documentAssessment: mergedAssessment,
    accountingIntelligence: (() => {
      // Sprint 3 · Checkpoint 16A — hierarchical accounting
      // intelligence. Consumed additively by the projection layer
      // for diagnostics + future card-lane routing. Does not change
      // the existing gl / allocations top-level fields (rendered
      // card contract is unchanged per §18).
      const lineDescriptions = [
        ...mergedExtraction.lineItems.map((li) => li.description),
        ...mergedLineItems.map((li) => li.description),
        ...(tableReconstruction?.lineItems ?? []).map((li) => li.description),
      ].filter((d): d is string => typeof d === "string" && d.length > 0);
      const uniqDescriptions = Array.from(new Set(lineDescriptions));
      accountingNatureAssessment = classifyAccountingNature({
        extraction: mergedExtraction,
        supplierName: mergedExtraction.vendor.guessedName,
        lineItemDescriptions: uniqDescriptions,
        fullDocumentText: pdfText || null,
        capitalStateFromClassifier: capital.state,
        capitalThresholdCents: capitalMinCents,
        totalCents: mergedExtraction.total ? Math.round(Number(mergedExtraction.total) * 100) : null,
      });
      return {
        natureLeader: accountingNatureAssessment.leader,
        natureConfidence: accountingNatureAssessment.leaderConfidence,
        natureIsDefensible: accountingNatureAssessment.isDefensible,
        natureRankedTop3: accountingNatureAssessment.ranked.slice(0, 3),
        tableReconstruction: tableReconstruction
          ? {
              headerFound: tableReconstruction.headerFound,
              columnCount: tableReconstruction.detectedColumns.length,
              lineItemsRecovered: tableReconstruction.lineItems.length,
              columnAlignmentConfidence: tableReconstruction.columnAlignmentConfidence,
            }
          : null,
      };
    })(),
  };
}

// ---------------------------------------------------------------------------
// Sprint 3 · Checkpoint 15X — canonical extraction → synthetic text
// ---------------------------------------------------------------------------
//
// When AWS Textract wins the strategy race, it returns a structured
// CanonicalDocumentExtraction rather than flat text. Downstream
// extractors (parseInvoiceText, extractLineItems, classifyEconomicPurpose,
// etc.) still expect flat text as their primary input. To avoid
// rewriting every downstream extractor, we synthesize a flat text
// representation of the canonical extraction and feed it as
// pdfText. This preserves the existing text-based extraction paths
// without special-casing OCR upstream of them.
//
// The synthetic text keeps the SAME shape a text-based invoice would
// produce so pre-Textract extractors can pull invoice #, subtotal,
// tax, total, and line items via their existing patterns. Supplier
// section is composed separately and passed through supplierRegionText.

function synthesizePdfTextFromCanonical(canonical: CanonicalDocumentExtraction, existingText: string): string {
  const parts: string[] = [];
  if (existingText.trim()) parts.push(existingText.trim());

  const f = canonical.fields;
  if (f.supplierName) parts.push(f.supplierName.value);
  if (f.supplierAddress) {
    const addr = f.supplierAddress;
    if (addr.addressLine1) parts.push(addr.addressLine1.value);
    if (addr.addressLine2) parts.push(addr.addressLine2.value);
    const cityLine = [addr.city?.value, addr.provinceState?.value, addr.postalCode?.value].filter(Boolean).join(", ");
    if (cityLine) parts.push(cityLine);
    if (addr.country) parts.push(addr.country.value);
  }
  if (f.supplierPhone) parts.push(f.supplierPhone.value);
  if (f.supplierWebsite) parts.push(f.supplierWebsite.value);
  if (f.supplierEmail) parts.push(f.supplierEmail.value);
  if (f.taxRegistrationNumber) parts.push(`GST: ${f.taxRegistrationNumber.value}`);
  if (f.payableReference) {
    const label = canonical.fields.payableReferenceType === "STATEMENT_NUMBER" ? "Statement Number"
      : canonical.fields.payableReferenceType === "BILL_NUMBER" ? "Bill Number"
      : "Invoice Number";
    parts.push(`${label}: ${f.payableReference.value}`);
  }
  if (f.invoiceDate) parts.push(`Invoice Date: ${f.invoiceDate.value}`);
  if (f.dueDate) parts.push(`Due Date: ${f.dueDate.value}`);
  if (f.purchaseOrderNumber) parts.push(`PO Number: ${f.purchaseOrderNumber.value}`);

  for (const line of canonical.lineItems) {
    const desc = line.description.value;
    const amount = line.amount.value;
    parts.push(`${desc}  ${amount.toFixed(2)}`);
  }

  if (f.subtotal) parts.push(`Subtotal: ${f.subtotal.value.toFixed(2)}`);
  if (f.tax) parts.push(`GST/HST: ${f.tax.value.toFixed(2)}`);
  if (f.total) parts.push(`Invoice Total: ${f.total.value.toFixed(2)}`);
  if (f.currency) parts.push(`Currency: ${f.currency.value}`);

  return parts.join("\n");
}

function synthesizeSupplierRegionText(canonical: CanonicalDocumentExtraction): string {
  const parts: string[] = [];
  const f = canonical.fields;
  if (f.supplierName) parts.push(f.supplierName.value);
  if (f.supplierAddress) {
    const addr = f.supplierAddress;
    if (addr.addressLine1) parts.push(addr.addressLine1.value);
    if (addr.addressLine2) parts.push(addr.addressLine2.value);
    const cityLine = [addr.city?.value, addr.provinceState?.value, addr.postalCode?.value].filter(Boolean).join(", ");
    if (cityLine) parts.push(cityLine);
    if (addr.country) parts.push(addr.country.value);
  }
  if (f.supplierPhone) parts.push(f.supplierPhone.value);
  if (f.supplierWebsite) parts.push(f.supplierWebsite.value);
  return parts.join("\n");
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
