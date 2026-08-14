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
import { type GlRecommendation, type SplitRecommendation } from "./gl-recommend";
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
import { detectLayoutRegions, pickSupplierRegion, type LayoutRegion } from "./layout-regions";
// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — document-role-aware
// transactional text + canonical purpose authority + SEMANTIC_MATCH
// gate + weak concept→GL ontology.
import { buildTransactionalText, transactionalTextDiagnostic } from "./transactional-text";
import { resolveEconomicPurpose, type EconomicPurposeDecision } from "./economic-purpose-authority";
import { evaluateSemanticMatchGate } from "./semantic-match-gate";
import { evaluatePurposeAccountAffinity } from "./purpose-to-gl-ontology";
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
// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — the ONE line-item authority.
import { extractCanonicalLineItems } from "./canonical-line-item-extractor";
import type { CanonicalLineItem } from "./evidence/canonical-line-item";
// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level trigger
// evaluation, targeted OCR dispatch, and visual-branding evidence.
import { evaluateOcrTriggers, OCR_TRIGGER_ENABLED, type OcrTriggerDecision } from "./ocr/ocr-trigger-reasons";
import { requestOcrExtraction } from "./ocr/enqueue";
import { findOcrExtraction } from "./ocr/persistence";
import { OCR_EXTRACTION_VERSION, OCR_PROVIDER_ID_AWS_TEXTRACT, resolveDailyTargetedOcrCap, TARGETED_OCR_TRIGGERS } from "./ocr/config";
import { extractVisualBrandingEvidence } from "./ocr/visual-branding-extractor";
import type { SupplierIdentityEvidence } from "./evidence/supplier-identity";
// Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — structural-quality
// reclassification + escalation trigger. When embedded text was
// extracted but the RESULT shows structural degradation (rejected
// supplier, contaminated reference, total-without-lines), reclassify
// as COLLAPSED_COLUMNS / UNRECOVERED_TABLE and escalate to the next
// strategy (positioned layout OR persisted Textract).
import { assessStructuralQuality } from "./structural-quality";
import { extractFromPositionedLayout } from "./positioned-extract";

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
  // Sprint 3 · Phase 4R final freeze-blocker (2026-08-11) — canonical
  // SupplierIdentity authority projection. Threaded from
  // parsed.canonicalEvidence.supplierIdentity so downstream confidence
  // consumers read the AUTHORITATIVE evidence-family count + selection
  // confidence + supporting evidence types + abstention state, rather
  // than approximating supplier evidence from ExtractedVendorProfile
  // field counts + SupplierExtraction positive-kind counts. Founder
  // rule §1: every founder confidence dimension should consume the
  // SAME canonical authority that produced the underlying decision.
  //
  // null when the pipeline path did not produce a canonical
  // supplierIdentity selection (e.g. empty/unreadable document).
  canonicalSupplierIdentity: {
    /** Selection confidence 0-100 from `SupplierSelection.diagnostic.confidence`. */
    confidence: number;
    /** Count of INDEPENDENT evidence families supporting the winner
     *  from `SupplierSelection.diagnostic.independentEvidenceGroups`. */
    independentEvidenceGroups: number;
    /** Distinct evidence types present (HEADER_ORG_TEXT / VISUAL_LOGO /
     *  WEBSITE_DOMAIN / TAX_REGISTRATION / etc.). */
    supportingEvidence: string[];
    /** True when SupplierSelection abstained (no winner). */
    abstained: boolean;
    /** Count of contradiction evidence items — non-zero implies a
     *  materially conflicting identity signal survived clustering. */
    contradictionCount: number;
    /** Winner display name for diagnostic surfaces. */
    displayName: string | null;
  } | null;
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
  // Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08) — canonical
  // economic-purpose decision. Projection layer uses this to
  // populate `category.purposeLabel` when GL commits to null but
  // purpose is defensibly understood.
  purposeDecision: EconomicPurposeDecision | null;
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
  // Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08) —
  // purchased-OBJECT authority (§6–§14). objects[] carries per-object
  // brand/model/sku/serial candidates + objectRole + relationships
  // + the object-aware capital decision. Downstream projection uses
  // it for the founder-facing category chip when GL cannot commit
  // and to surface diagnostic detail in inspect-wi.
  // Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — external product
  // research trigger + provider outcome exposed for inspect-wi
  // auditability (§25).
  externalResearchTrace?: {
    considered: boolean;
    triggered: boolean;
    providerKind: string;
    cacheHit: boolean;
    quotaAllowed: boolean;
    quotaRemaining: number;
    fingerprint: string | null;
    reason: string;
    externalLookupCount: number;
    externalLatencyMs: number;
  };
  // Sprint 3 · Phase 4 Slice 5.5 (2026-08-08) — Capital-aware
  // ranking result. Emitted whenever the ranker was active
  // (CapitalEvidenceDecision committed at defensible confidence).
  // The per-account dimension diagnostics let the founder inspect
  // WHY each candidate won or lost.
  capitalAwareRanking?: {
    active: boolean;
    winnerAccountNumber: string | null;
    abstained: boolean;
    abstentionReason: string | null;
    compatiblePool: Array<{
      accountNumber: string;
      accountName: string;
      totalScore: number;
      natureCompat: string;
      dimensions: {
        accountingNature: number;
        department: number;
        purpose: number;
        objectIdentity: number;
        accountNameSimilarity: number;
        category: number;
        fsGroup: number;
        history: number;
        postingEligibility: number;
      };
      supportingEvidence: string[];
      contradictions: string[];
      postable: boolean;
      // Slice 5.7A §16 rich diagnostics
      capitalAccountRole?: string;
      capitalRoleSource?: string;
      accountFunctionalRole?: string;
      functionalRoleSource?: string;
      organizationalDepartment?: string | null;
      finalVerdict?: string;
      rejectionReasons?: string[];
      dimensionVerdicts?: {
        nature?: { verdict: string; reason: string };
        capitalRole?: { verdict: string; reason: string };
        functionalRole?: { verdict: string; reason: string };
        department?: { verdict: string; reason: string };
        specialCondition?: { verdict: string; reason: string };
      };
    }>;
    contradictedPoolCount: number;
    // Slice 5.7A §16: surface contradicted candidates + rejection
    // reasons so the founder can see WHY each was excluded.
    contradictedPool?: Array<{
      accountNumber: string;
      accountName: string;
      totalScore: number;
      finalVerdict?: string;
      rejectionReasons?: string[];
      capitalAccountRole?: string;
      accountFunctionalRole?: string;
    }>;
    diagnostic: string;
  };
  // Sprint 3 · Phase 4 Slice 5.4 (2026-08-08) — Product Identity
  // Resolution result. Slice 5.4 scaffolding ships with Null
  // providers active (no external calls) so status will typically
  // be RESOLVED_INTERNAL, AMBIGUOUS, or UNRESOLVED. When a real
  // external provider is authorised, RESOLVED_WITH_EXTERNAL_
  // CORROBORATION becomes achievable.
  productIdentityResolution?: {
    status: string;
    confidence: number;
    evidenceQuality: string;
    reason: string;
    externalCorroborationRequired: boolean;
    externalLookupCount: number;
    externalLatencyMs: number;
    externalProviderDiagnostic?: string;
    externalEvidence?: Array<{
      sourceDomain: string | null;
      sourceTitle: string | null;
      evidenceType: string;
      matchedManufacturer: string | null;
      matchedModel: string | null;
      matchedProductFamily: string | null;
      confidence: number;
      evidenceSnippet: string;
    }>;
    diagnostic: string;
    selectedObjectType: string | null;
    candidates: Array<{
      objectType: string;
      internalEvidenceScore: number;
      pricePlausibilityBand?: string;
      pricePlausibilityScore?: number;
      externalEvidenceScore?: number;
      supportingCount: number;
      contradictionsCount: number;
      reason: string;
    }>;
  };
  purchasedObjectIntelligence?: {
    objects: Array<{
      description: string;
      brandCandidates: Array<{ value: string; strength: string; provenance: string }>;
      modelCandidates: Array<{ value: string; strength: string; provenance: string }>;
      skuCandidates: Array<{ value: string; strength: string; provenance: string }>;
      serialCandidates: Array<{ value: string; strength: string; provenance: string }>;
      quantity: number | null;
      unit: string | null;
      unitPrice: number | null;
      extension: number | null;
      objectRole: string;
      objectRoleConfidence: number;
      objectRoleDiagnostic: string;
      relatedObjects: Array<{ targetIndex: number; kind: string; strength: string; detail: string }>;
      evidenceQuality: string;
    }>;
  };
  purchasedItemIntelligence: {
    items: Array<{
      description: string;
      manufacturer: string | null;
      model: string | null;
      sku: string | null;
      serialNumber: string | null;
      quantity: number | null;
      unitPrice: number | null;
      extension: number | null;
      evidenceQuality: "HIGH" | "MEDIUM" | "LOW";
      completeness: "COMPLETE_ASSET" | "COMPONENT" | "CONSUMABLE" | "SERVICE" | "UNKNOWN";
      completenessConfidence: number;
    }>;
    capitalDecision: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED";
    capitalConfidence: number;
    capitalDiagnostic: string;
    departmentLeaderKey: string | null;
    departmentLeaderName: string | null;
    departmentIsDefensible: boolean;
    /** Founder-facing category chip when GL cannot commit and the
     *  purpose label is too generic. Formed by combining capital
     *  decision + department. Null when insufficient signal. */
    founderFacingCategory: string | null;
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
  // Sprint 3 · Phase 4 Slice 5 — canonical line-item authority state.
  let canonicalLineItemsFromLayout: CanonicalLineItem[] = [];
  let canonicalLineItemExtractionDiagnostic: string | null = null;
  let canonicalLineItemPages: Array<{ page: number; pageClass: string; itemsProduced: number; routedTo: string }> = [];
  let canonicalOcrPending = false;
  // Sprint 3 · Phase 4 Slice 5.1 — page-level trigger + OCR fusion + visual branding.
  let ocrTriggerDecisions: OcrTriggerDecision[] = [];
  let targetedOcrDispatchLog: Array<{ page: number; reasons: string[]; outcome: string; rowIdTail: string }> = [];
  let visualBrandingEvidence: SupplierIdentityEvidence[] = [];
  let fusedOcrExtractionRowIds: string[] = [];
  // Sprint 3 · Phase 4 Slice 5.2 — layout regions + transactional text
  // + resolved economic-purpose decision. Computed once per document
  // and threaded into every accounting-reasoning consumer so the
  // classifier surface is consistent (supplier/policy/footer never
  // leak into accounting nature or purpose evidence).
  let allLayoutRegions: LayoutRegion[] = [];
  let transactionalTextValue: string | null = null;
  let transactionalTextDiag: string | null = null;
  let purposeDecision: EconomicPurposeDecision | null = null;
  let semanticMatchGateEvaluations: Array<{ candidateAccountNumber: string; allow: boolean; denials: string[] }> = [];
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
        allLayoutRegions = regions;
        const supplier = pickSupplierRegion(regions);
        if (supplier) supplierRegionText = supplier.text;
        // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #4) —
        // build DOCUMENT-ROLE-AWARE transactional text. Supplier /
        // recipient / policy / footer regions are excluded so that
        // downstream accounting-nature + purpose classifiers cannot
        // pick up street-name matches ("Capital Circle") or policy-
        // paragraph regex matches ("finance charge of X% per month").
        try {
          const tx = buildTransactionalText(regions);
          transactionalTextValue = tx.text;
          transactionalTextDiag = transactionalTextDiagnostic(tx);
        } catch (txe) {
          logger.warn("ap-intelligence.transactional-text.error", {
            clubId: args.clubId, docIdTail: doc.id.slice(-6),
            message: (txe as Error).message.slice(0, 200),
          });
        }
        // Sprint 3 · Phase 4 Slice 5 (2026-08-07) — replaced the
        // old positioned-table-reconstruct call with the ONE canonical
        // line-item authority. The authority runs region detection +
        // reconstruction (classic-column + category-block strategies)
        // + arithmetic validation + role classification. The old
        // TableReconstructResult shape is populated as a
        // backward-compatibility shim so downstream analyse.ts
        // consumers see the same rows through their existing
        // interface — but the rows come from ONE source.
        try {
          const canonicalOut = await extractCanonicalLineItems({
            layout: routed.layout,
            flattenedText: pdfText,
            pageCount: routed.layout.pageCount,
          });
          canonicalLineItemsFromLayout = canonicalOut.lineItems;
          canonicalLineItemExtractionDiagnostic = canonicalOut.diagnostic;
          canonicalLineItemPages = canonicalOut.pages;
          canonicalOcrPending = canonicalOut.ocrPending;
          // Compat shim — map canonical items to TableReconstructResult
          // so the many downstream call sites keep working without a
          // parallel refactor. `headerFound` is true whenever any
          // CLASSIC_COLUMN_TABLE region committed a row; column list
          // is derived from those regions' payload.
          const classicRegions = canonicalOut.regions.filter((r) => r.kind === "CLASSIC_COLUMN_TABLE");
          const detectedColumns: Array<{ role: string; xCenter: number }> = [];
          for (const r of classicRegions) {
            const cols = (r.payload as { columns?: Array<{ role: string; xCenter: number }> }).columns ?? [];
            for (const c of cols) {
              if (!detectedColumns.some((d) => d.role === c.role)) detectedColumns.push(c);
            }
          }
          tableReconstruction = {
            headerFound: classicRegions.length > 0,
            headerRowY: classicRegions[0]?.yTop ?? null,
            detectedColumns,
            columnAlignmentConfidence: 0,
            lineItems: canonicalOut.lineItems
              .filter((li) => li.role === "PRIMARY_PURCHASE"
                || li.role === "SURCHARGE" || li.role === "FREIGHT")
              .map((li) => ({
                page: li.page,
                rowY: li.region?.y ?? 0,
                sku: li.sku ?? null,
                description: li.description,
                quantity: li.quantity ?? null,
                unitPrice: li.unitPrice ?? null,
                amount: li.extension,
                supportingCellCount: li.quantity != null && li.unitPrice != null ? 4 : 2,
                confidence: li.validationConfidence,
              })),
            rejectedRows: [],
          };
        } catch (e) {
          logger.warn("ap-intelligence.canonical-line-items.error", {
            clubId: args.clubId, docIdTail: doc.id.slice(-6),
            message: (e as Error).message.slice(0, 200),
          });
        }

        // Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — per-page
        // trigger evaluation + targeted-OCR dispatch. Runs AFTER
        // native extraction so triggers see the actual native
        // outcome (item counts, region detection). For each page
        // whose trigger fires: check persistence first (idempotent),
        // enqueue if missing, fuse if present.
        try {
          const pagesToEvaluate = routed.layout.pages ?? [];
          const dailyCap = resolveDailyTargetedOcrCap();
          let targetedThisTurn = 0;
          for (const pd of pagesToEvaluate) {
            const regionsOnPage: import("./line-item-region-strategies").LineItemRegion[] = [];
            const nativeItemsOnPage = canonicalLineItemsFromLayout.filter((li) => li.page === pd.page);
            const decision = evaluateOcrTriggers({
              layout: routed.layout,
              pageDescriptor: pd,
              regionsOnPage,
              nativeItemsOnPage,
            });
            ocrTriggerDecisions.push(decision);
            if (!decision.shouldOcr) continue;

            // Look for a persisted OCR row for this page (idempotent).
            const persisted = await findOcrExtraction({
              clubId: args.clubId,
              documentSha256: doc.sha256Hash,
              provider: OCR_PROVIDER_ID_AWS_TEXTRACT,
              extractionVersion: OCR_EXTRACTION_VERSION,
              pageNumber: pd.page,
            });
            if (persisted) {
              if (persisted.status === "SUCCEEDED" && persisted.normalizedExtractionJson) {
                try {
                  const ocrCanonical = JSON.parse(persisted.normalizedExtractionJson) as import("./document-extractors/canonical-model").CanonicalDocumentExtraction;
                  // Re-run canonical extraction with fusion.
                  const fused = await extractCanonicalLineItems({
                    layout: routed.layout,
                    flattenedText: pdfText,
                    pageCount: routed.layout.pageCount,
                    ocrExtraction: ocrCanonical,
                    ocrSourcePageNumber: pd.page,
                  });
                  canonicalLineItemsFromLayout = fused.lineItems;
                  canonicalLineItemExtractionDiagnostic = fused.diagnostic;
                  fusedOcrExtractionRowIds.push(persisted.id);
                  // Also produce visual-branding evidence from this
                  // OCR result. Corroborative only; the frozen
                  // supplier-identity orchestrator picks it up via
                  // canonicalEvidence.visualBrandingEvidence.
                  const branding = extractVisualBrandingEvidence(ocrCanonical, { sourcePageNumber: pd.page });
                  for (const b of branding) visualBrandingEvidence.push(b);
                  targetedOcrDispatchLog.push({
                    page: pd.page,
                    reasons: decision.triggered,
                    outcome: "FUSED_PERSISTED",
                    rowIdTail: persisted.id.slice(-8),
                  });
                } catch (fusionErr) {
                  logger.warn("ap-intelligence.ocr.fusion.error", {
                    clubId: args.clubId, docIdTail: doc.id.slice(-6),
                    pageNumber: pd.page,
                    message: (fusionErr as Error).message.slice(0, 200),
                  });
                }
                continue;
              }
              // Row exists but is PENDING / PROCESSING / FAILED_*.
              targetedOcrDispatchLog.push({
                page: pd.page,
                reasons: decision.triggered,
                outcome: `PERSISTED_${persisted.status}`,
                rowIdTail: persisted.id.slice(-8),
              });
              continue;
            }

            // Cost ceiling gate — only count targeted (non-IMAGE_ONLY) triggers.
            const isTargeted = decision.triggered.some((r) => TARGETED_OCR_TRIGGERS.has(r));
            if (isTargeted && dailyCap != null && targetedThisTurn >= dailyCap) {
              targetedOcrDispatchLog.push({
                page: pd.page,
                reasons: decision.triggered,
                outcome: "CAP_REACHED_TRUTHFUL_ABSTAIN",
                rowIdTail: "-",
              });
              continue;
            }

            // Enqueue targeted OCR (or IMAGE_ONLY OCR) for this page.
            // Router's canonicalExtraction, when present, already
            // carries a documentClass classification; otherwise
            // default to the neutral "INVOICE" class (the router's
            // own default).
            const documentClass: import("./document-class").DocumentClass =
              routed.canonicalExtraction?.documentClass ?? "TEXT_HEALTHY";
            const requested = await requestOcrExtraction({
              clubId: args.clubId,
              ingestedDocumentId: doc.id,
              documentSha256: doc.sha256Hash,
              documentClass,
              strategy: "PAGE_TARGETED_OCR",
              pageNumber: pd.page,
              triggerReason: decision.triggered[0],
            });
            if (isTargeted) targetedThisTurn++;
            targetedOcrDispatchLog.push({
              page: pd.page,
              reasons: decision.triggered,
              outcome: `ENQUEUE_${requested.reason.toUpperCase()}`,
              rowIdTail: requested.row.id.slice(-8),
            });
          }
        } catch (te) {
          logger.warn("ap-intelligence.ocr.trigger.error", {
            clubId: args.clubId, docIdTail: doc.id.slice(-6),
            message: (te as Error).message.slice(0, 200),
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
        // Slice 5.1 amendment #4 — extract visual-branding evidence
        // from the router's own OCR result too (image-only path).
        try {
          const branding = extractVisualBrandingEvidence(routed.canonicalExtraction);
          for (const b of branding) visualBrandingEvidence.push(b);
        } catch { /* diagnostic-only; never fatal */ }
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
  // Sprint 3 · Phase 4 Slice 5 — flattened fallback for docs where
  // the positional path produced zero items but useful flat text
  // exists. Runs BEFORE parseInvoiceText so canonicalLineItems can
  // thread through as the ONE source of truth for evidence.lineItems.
  if (canonicalLineItemsFromLayout.length === 0 && pdfOk && pdfText.trim().length > 0) {
    try {
      const fallbackOut = await extractCanonicalLineItems({
        flattenedText: pdfText,
        pageCount: pdfPageCount || 1,
      });
      canonicalLineItemsFromLayout = fallbackOut.lineItems;
      if (fallbackOut.lineItems.length > 0) {
        canonicalLineItemExtractionDiagnostic =
          (canonicalLineItemExtractionDiagnostic ?? "") + " | fallback:" + fallbackOut.diagnostic;
      }
    } catch { /* keep empty */ }
  }
  const parsed = parseInvoiceText({
    extractedText: pdfOk ? pdfText : "",
    emailSubject: args.emailSubject ?? null,
    emailSenderAddress: args.emailSenderAddress ?? null,
    canonicalLineItems: canonicalLineItemsFromLayout,
    // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #8) —
    // additive visual-branding evidence for the frozen supplier
    // orchestrator. Supplier scoring rules unchanged; branding
    // participates as one more evidence source alongside text /
    // domain / contact-block.
    supplierAdditionalEvidence: visualBrandingEvidence,
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
  // Sprint 3 · Phase 4 Slice 5 (2026-08-07) — ONE authority. Derive
  // the legacy LineItem[] shape from CanonicalLineItem[] so
  // tax-reconciliation + economic-purpose + GL recommender see the
  // same rows the canonical evidence layer + AP Coding modal see.
  // Fall back to the flat-text extractor ONLY when canonical produced
  // nothing (image-only docs where OCR is pending).
  const lineItemsExtracted: LineItem[] = canonicalLineItemsFromLayout.length > 0
    ? canonicalLineItemsFromLayout
        // Sprint 3 · 221178 follow-on (Correction A completion) — also
        // exclude SUMMARY_ROW_REJECTED so the phantom SUBTOTAL row
        // (marked by the generalized totals-block classifier upstream
        // in line-item-region-strategies.ts / textract-to-slice5-line-
        // items.ts) does NOT feed the allocation composer. Without
        // this filter the extractor rejects the row from the founder-
        // facing lineItems list but the allocation composer still
        // sees it, producing the impossible 4,752 unresolved bucket
        // the audit found on 221178.
        .filter((li) => li.role !== "TAX" && li.role !== "SUMMARY_ROW_REJECTED")
        .map((li) => ({
          description: li.description,
          quantity: li.quantity ?? null,
          unitPrice: li.unitPrice ?? null,
          amount: li.extension,
          taxRate: li.taxTreatment?.rate ?? null,
          taxAmount: null,
          taxTreatment: li.role === "PENALTY" || li.role === "INTEREST"
            ? "exempt"
            : (li.taxTreatment?.taxable ? "taxable" : "unknown"),
          evidence: li.role === "PENALTY" || li.role === "INTEREST"
            ? ["penalty_or_finance_charge"]
            : (li.taxTreatment?.taxable ? ["member_dues_language"] : ["amount_only"]),
          confidence: li.validationConfidence,
          lineNo: li.region?.lineIndex ?? 0,
        }))
    : (pdfOk ? extractLineItems(pdfText) : []);
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
  // Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — §10 primary
  // signal is CANONICAL line-item descriptions when the evidence
  // layer surfaced them, else fall back to the legacy line list.
  // Canonical line items are the founder-mandated authority when
  // present: filename / sender / supplier name are supplementary.
  const canonicalLineDescriptions =
    parsed.canonicalEvidence?.lineItems?.map((l) => l.description.value) ?? [];
  const legacyLineDescriptions = lineItemsExtracted.map((l) => l.description);
  const lineDescriptions =
    canonicalLineDescriptions.length > 0 ? canonicalLineDescriptions : legacyLineDescriptions;
  const economicPurpose = classifyEconomicPurpose({
    supplierName,
    lineDescriptions,
    fullDocumentText: pdfOk ? pdfText : null,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: lineItemsExtracted.some(
      (l) => l.taxTreatment === "exempt" && l.evidence.includes("penalty_or_finance_charge"),
    ),
    hasMembershipLine,
    hasProfessionalCredentialContext,
  });

  // Post-16H Phase 2 (2026-08-06) — derive `expectedDebitRole` for
  // the accounting eligibility service from the capital classifier
  // we already ran. The eligibility layer uses this to admit ASSET
  // accounts only when a capital / inventory / prepaid nature is
  // defensible. Precise nature-mapping (COST_OF_SALES / R&M / …)
  // is computed AFTER the ranker (see `classifyAccountingNature`
  // call further down) — that finer resolution feeds nature-scoped
  // promotion, not the pre-ranking eligibility gate.
  // Phase 4R · Phase 7.2I-b (2026-08-13) — compositional capital
  // admission. A defensible structured accounting conclusion from ONE
  // treatment classifier (accounting-nature) may widen the eligible
  // candidate universe even when ANOTHER classifier (capital-vs-operating)
  // is unresolved. Composition rule per founder §7.2I-b:
  //
  //   IF `accountingNature.leader === "CAPITAL_ASSET"` AND
  //      `accountingNature.isDefensible === true`
  //   THEN ASSET accounts are admissible at Phase-2 eligibility,
  //        EVEN WHEN `capital-vs-operating.state !== "CAPITAL"`.
  //
  //   Does NOT force an asset winner.
  //   Does NOT exclude expense candidates.
  //   Does NOT mark the invoice RECOMMEND automatically.
  //   Does NOT bypass canonical ranking.
  //   Canonical ranker still decides after seeing all candidates.
  //
  // Pre-nature check uses line-item evidence available at this point
  // in the pipeline (before the facade's fuller `natureForCanonical`
  // computation). Same classifier, same defensibility threshold —
  // just an earlier read for the eligibility gate.
  //
  // §isDefensible semantics: leader score >= 20 (raw >= 3, i.e. at
  // least one STRONG_WEIGHT match) AND leader has ≥1 supporting
  // evidence entry. Score 20 corresponds to a single strongTerm
  // match on the line-item description — a modest bar but not
  // trivial, and it explicitly requires supporting evidence
  // (not amount alone).
  const preNatureForEligibility = classifyAccountingNature({
    extraction,
    supplierName: extraction.vendor.guessedName,
    lineItemDescriptions: lineItemsExtracted
      .map((li) => li.description)
      .filter((d): d is string => typeof d === "string" && d.length > 0),
    fullDocumentText: pdfOk ? pdfText : null,
    capitalStateFromClassifier: capital.state,
    capitalThresholdCents: null,
    totalCents: null,
    transactionalText: null,
  });
  const natureAdmitsCapitalAsset =
    preNatureForEligibility.leader === "CAPITAL_ASSET"
    && preNatureForEligibility.isDefensible;

  const expectedDebitRole: import("@/lib/accounting/eligibility").ExpectedDebitRole =
    capital.state === "CAPITAL" ? "CAPITAL_ASSET"
    : capital.state === "OPERATING" ? "OPERATING_EXPENSE"
    : natureAdmitsCapitalAsset ? "CAPITAL_ASSET"
    : "UNKNOWN";

  // Phase 4R · Phase 4 (2026-08-11) — legacy Pipeline A ranker
  // (`recommendGlAccount`) removed. Confidence dimensions are now
  // computed AFTER the canonical facade runs, using the canonical
  // winner as the `glClassification` dimension input. This eliminates
  // the last runtime path where a document-level GL competition
  // executed in parallel to the canonical ranker.
  let gl: GlRecommendation;

  // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #2+#6) —
  // post-base-ranker purpose-compatibility guard. When the canonical
  // purpose is COMMITTED (Slice-5 taxonomy ≥60) AND the base
  // ranker's winner does NOT match any discriminative ontology
  // substring for that concept, walk the top-K candidates for a
  // purpose-compatible alternative and promote it. If none exists,
  // KEEP the winner but flag it requiresReview — never fabricate.
  //
  // This closes the last-mile defect where DMM (canonical
  // FUEL(96)) was still winning "Telephone & Internet" because
  // the base ranker's document-phrase channel matched telecom
  // vocabulary in the supplier's raw phone/website footer text.
  // Weak-ontology boost is intentionally modest (§2) — used only
  // when the winner IS INCOMPATIBLE with the committed purpose.
  if (purposeDecision == null) {
    // Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — §6 authority
    // consumption. Compute PurchasedObjectIdentity roles ONCE here so
    // the taxonomy classifier can consume them (this is a cheap
    // deterministic transform of canonicalLineItems). The value is
    // reused a few lines below as `sharedPurchasedObjects` — same
    // provider instance, same input, so the reordering is neutral.
    const { DeterministicPurchasedObjectProvider: PurchasedObjectProviderEarly } =
      await import("./purchased-object-identity");
    const purposeRoleObjects = new PurchasedObjectProviderEarly().interpret(canonicalLineItemsFromLayout);
    const rolesByLineIndex: Array<
      "COMPLETE_MACHINE" | "SERIALIZED_COMPONENT" | "COMPONENT"
      | "ACCESSORY" | "CONSUMABLE" | "SERVICE" | "UNKNOWN" | null
    > = canonicalLineItemsFromLayout.map((_li, idx) => {
      const obj = purposeRoleObjects.find((o) => o.sourceLineItemIndex === idx);
      return obj?.objectRole ?? null;
    });
    purposeDecision = resolveEconomicPurpose({
      canonicalLineItems: canonicalLineItemsFromLayout,
      supplierName: extraction.vendor.guessedName,
      transactionalText: (transactionalTextValue != null && transactionalTextValue.trim().length > 0)
        ? transactionalTextValue
        : (pdfText || null),
      hasPenaltyLine: canonicalLineItemsFromLayout.some((li) => li.role === "PENALTY"),
      hasMembershipLine: canonicalLineItemsFromLayout.some((li) =>
        /\b(member(?:ship)?\s*(?:dues|fee))\b/i.test(li.description)),
      hasProfessionalCredentialContext: (extraction.vendor.guessedName ?? "").match(
        /\b(?:association|society|college|institute|CPA|Chartered|Order\s+of)\b/i) != null,
      purchasedObjectRolesByLineIndex: rolesByLineIndex,
    });
  }

  // Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — purchased-item
  // substance authority. Computed ONCE from the canonical line items
  // and reused by (a) the purpose-driven ranker as a capital signal,
  // (b) the ApAnalyseResult return payload for the projection layer
  // and inspect-wi diagnostic. Amendment #6 separates identity from
  // capital nature; amendment #7 keeps capital probabilistic;
  // amendment #8 bans amount as capital evidence.
  const { extractPurchasedItems: extractPurchasedItemsShared } = await import("./purchased-item-identity");
  const { classifyItemCompleteness: classifyItemCompletenessShared } = await import("./item-completeness");
  const { evaluateCapitalObjectEvidence: evaluateCapitalObjectShared } = await import("./capital-evidence");
  const { DeterministicPurchasedObjectProvider: PurchasedObjectProvider } = await import("./purchased-object-identity");
  const sharedPurchasedItems = extractPurchasedItemsShared(canonicalLineItemsFromLayout);
  const sharedItemCompleteness = new Map<number, ReturnType<typeof classifyItemCompletenessShared>>();
  for (const item of sharedPurchasedItems) {
    sharedItemCompleteness.set(item.sourceLineItemIndex, classifyItemCompletenessShared(item));
  }
  // Completion pass (§6–§14): PurchasedObject identity + object-role
  // + relationships + refined capital reasoning. The object-aware
  // capital branch consumes PurchasedObjectIdentity[] and treats
  // "engine"/"seat"/etc. as evidence, not verdict.
  const sharedPurchasedObjects = new PurchasedObjectProvider().interpret(canonicalLineItemsFromLayout);

  // Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — Product Identity
  // Resolution with controlled external product research authorised.
  //
  // Provider selection is env-driven via getProductReferenceProvider()
  // (§3). Default remains NullProductReferenceProvider — activation
  // on staging requires PRODUCT_REFERENCE_PROVIDER=claude-web-search
  // + PRODUCT_REFERENCE_API_KEY set. External calls are gated by:
  //   1. externalCorroborationRequired flag from the amended §10
  //      Slice-5.5 trigger (material accounting ambiguity)
  //   2. per-club daily quota (§18)
  //   3. cache hit on manufacturer+model+partNumber fingerprint (§17)
  //   4. circuit-breaker on repeated provider failure (§19)
  //
  // Founder §20: external evidence never writes a GL. It flows back
  // through ProductIdentityResolution → CapitalEvidenceDecision →
  // capital-aware ranker. Accounting authorities remain internal.
  const { resolveProductIdentity: resolveProductIdentityShared } = await import("./product-identity-resolution");
  const { NullPricePlausibilityProvider } = await import("./price-plausibility");
  const {
    activeProviderKind,
  } = await import("./external-product-reference/factory");
  const {
    tryConsumeDailyQuota,
    currentClubDailyCount,
    DEFAULT_RATE_LIMIT,
  } = await import("./external-product-reference/rate-limiter");
  const { fingerprintProductRequest } = await import("./product-reference-provider");
  // Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — external research is
  // now asynchronous. The web tier NEVER invokes the paid provider
  // directly (§B founder gate). Flow:
  //   1. compute internal identity
  //   2. if externalCorroborationRequired → look up durable
  //      ProductReference (DB-backed, global, tenant-independent)
  //   3. if COMPLETED → replay cached evidence, re-resolve, done
  //   4. else → enqueue PRODUCT_REFERENCE_RESEARCH, return truthful
  //      current internal-only state with `researchStatus` populated
  //   5. worker completes research + enqueues AP_INVOICE_REANALYSE;
  //      next analyse() call hits step 3
  const { ensureProductResearchEnqueued, evidenceToReplayResult } =
    await import("./external-product-reference/enqueue");

  const configuredProviderKind = activeProviderKind();

  // Two-pass strategy: (a) run internal-only resolution first with a
  // Null external provider so we always compute internal candidates
  // and know whether externalCorroborationRequired fires; (b) if
  // required AND provider is configured AND quota available AND no
  // cache hit, THEN invoke the real provider and re-resolve with the
  // fetched evidence.
  const internalOnlyIdentity = await resolveProductIdentityShared({
    objects: sharedPurchasedObjects,
    pricePlausibilityProvider: new NullPricePlausibilityProvider(),
    productReferenceProvider: null,
  });

  // Build the fingerprintable request from the current primary
  // purchased object (§4/§17 — no invoice-scoped identity).
  const primaryObjectForRefRequest = sharedPurchasedObjects.length > 0
    ? [...sharedPurchasedObjects].sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0]
    : null;
  const refRequest = primaryObjectForRefRequest ? {
    brandCandidates: primaryObjectForRefRequest.brandCandidates.map((b) => b.value),
    modelCandidates: primaryObjectForRefRequest.modelCandidates.map((m) => m.value),
    skuCandidates: primaryObjectForRefRequest.skuCandidates.map((s) => s.value),
    serialCandidates: primaryObjectForRefRequest.serialCandidates.map((s) => s.value),
    descriptionExcerpt: primaryObjectForRefRequest.description.slice(0, 200),
    observedUnitPrice: primaryObjectForRefRequest.unitPrice ?? null,
    currency: null,
    maxCalls: DEFAULT_RATE_LIMIT.perRequestMaxQueries,
  } : null;
  const refRequestFingerprint = refRequest ? fingerprintProductRequest(refRequest) : null;

  let externalTrigger: {
    considered: boolean;
    triggered: boolean;
    providerKind: string;
    cacheHit: boolean;
    quotaAllowed: boolean;
    quotaRemaining: number;
    fingerprint: string | null;
    reason: string;
  } = {
    considered: false,
    triggered: false,
    providerKind: configuredProviderKind,
    cacheHit: false,
    quotaAllowed: true,
    quotaRemaining: DEFAULT_RATE_LIMIT.perClubPerDay - currentClubDailyCount(args.clubId),
    fingerprint: refRequestFingerprint,
    reason: "",
  };

  let sharedProductIdentity = internalOnlyIdentity;

  // Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — always consult the
  // durable ProductReference store when external corroboration is
  // required. The web tier no longer instantiates the paid provider
  // (activeProviderKind() is "null" here), so a check on that would
  // never fire. The durable path either replays cached evidence, or
  // enqueues research for the worker (which is where the provider
  // singleton lives after §15 secret-move).
  if (internalOnlyIdentity.externalCorroborationRequired
      && refRequest != null
      && refRequestFingerprint != null) {
    externalTrigger.considered = true;

    // §J dedupe-BEFORE-quota: consult the durable global cache
    // first. Refreshing Mission Control 20 times must not consume
    // 20 paid invocations. Quota is only relevant when we are
    // actually about to enqueue new research.
    const decision = await ensureProductResearchEnqueued({
      refRequest,
      clubId: args.clubId,
      ingestedDocumentId: doc.id,
    });

    if (decision.kind === "REUSED_COMPLETED") {
      externalTrigger.cacheHit = true;
      externalTrigger.triggered = false;
      externalTrigger.reason = `durable cache hit — reusing ${decision.reference.identityEvidenceJson.length} evidence records; identityVerifiedAt=${decision.reference.identityVerifiedAt?.toISOString() ?? "n/a"}`;
      // Replay the persisted evidence through the existing resolver so
      // downstream capital/department/GL logic sees identical shape.
      const { FixtureProductReferenceProvider } = await import("./external-product-reference/fixture-provider");
      const cachedProvider = new FixtureProductReferenceProvider();
      const replay = evidenceToReplayResult(decision.reference);
      cachedProvider.seedByFingerprint(refRequestFingerprint, {
        state: replay.state,
        products: replay.products,
      });
      sharedProductIdentity = await resolveProductIdentityShared({
        objects: sharedPurchasedObjects,
        pricePlausibilityProvider: new NullPricePlausibilityProvider(),
        productReferenceProvider: cachedProvider,
      });
    } else if (decision.kind === "REUSED_TERMINAL") {
      // §H — do NOT re-enqueue for NO_RESULT / CONFLICTING / terminal.
      externalTrigger.cacheHit = true;
      externalTrigger.triggered = false;
      externalTrigger.reason = `durable terminal cache — state=${decision.reference.researchState}, not retrying`;
    } else if (decision.kind === "AWAITING_PENDING"
      || decision.kind === "AWAITING_RUNNING"
      || decision.kind === "AWAITING_COOLDOWN"
      || decision.kind === "RESEARCH_JUST_ENQUEUED") {
      // §20 truthful "research pending" — analyser returns internal-
      // only result; worker will complete + enqueue AP_INVOICE_REANALYSE
      // which re-invokes this exact code path (which will hit
      // REUSED_COMPLETED on the second run).
      externalTrigger.cacheHit = false;
      externalTrigger.triggered = decision.kind === "RESEARCH_JUST_ENQUEUED";
      externalTrigger.reason = decision.kind === "RESEARCH_JUST_ENQUEUED"
        ? `research enqueued (jobId=${decision.jobId ?? "n/a"}); refresh once complete`
        : `research pending in durable store (state=${decision.reference.researchState})`;
    } else if (decision.kind === "UNRESOLVABLE_KEY") {
      externalTrigger.triggered = false;
      externalTrigger.reason = `unresolvable product key: ${decision.reason}`;
    } else if (decision.kind === "RESEARCH_ENQUEUE_FAILED") {
      externalTrigger.triggered = false;
      externalTrigger.reason = `research enqueue failed: ${decision.error}`;
    }

    // §18 daily quota is now consulted ONLY when the worker actually
    // runs the paid provider. Web-side never consumes quota; the
    // in-memory quota counter still exists as a diagnostic surface
    // and defensive floor for legacy call-sites.
    void tryConsumeDailyQuota; void currentClubDailyCount; void DEFAULT_RATE_LIMIT;
  } else if (internalOnlyIdentity.externalCorroborationRequired) {
    externalTrigger.considered = true;
    externalTrigger.triggered = false;
    externalTrigger.reason = `external corroboration required BUT provider=${configuredProviderKind} — falling back to internal-only resolution`;
  }

  const sharedCapitalDecision = evaluateCapitalObjectShared({
    objects: sharedPurchasedObjects,
    poRequestorText: null,
    supplierName: extraction.vendor.guessedName,
    resolvedProductIdentity: sharedProductIdentity,
    // Sprint 3 · Phase 4 Slice 5.9 (2026-08-09) — pass the
    // transactional text so CapitalEvidenceDecision can detect
    // structural CAPITAL signals (placed-in-service, structure/
    // building, land, complete-unit-delivered, asset-enhancement,
    // CIP-explicit) that don't live at the object-role level.
    // Prefers transactionalTextValue (Slice 5.2 amendment #4 —
    // supplier/recipient/policy/footer regions already excluded) so
    // street names and policy paragraphs cannot false-positive.
    // Falls back to raw pdfText when the layout-based route wasn't
    // exercised (extractedTextOverride path — synthetic benchmark).
    documentBodyText: (transactionalTextValue != null && transactionalTextValue.trim().length > 0)
      ? transactionalTextValue
      : pdfText,
  });
  // Department leader from object-identity-primary inference
  // (completion pass §18: object application beats vendor).
  const {
    inferDepartment: inferDeptShared,
    DEFAULT_CLUB_DEPARTMENTS: DEFAULT_DEPTS_SHARED,
  } = await import("./department-inference");
  // Compose lineItemDescriptions from PurchasedObject descriptions so
  // department inference scores against the SUBSTANTIVE purchased-
  // object surface (which excludes summary rows and includes attached
  // continuations like Serial# lines and description-wrap words).
  const sharedUniqDescs = Array.from(new Set(
    sharedPurchasedObjects.length > 0
      ? sharedPurchasedObjects.map((o) => o.description)
      : canonicalLineItemsFromLayout.map((li) => li.description).filter(Boolean),
  ));
  const sharedDept = inferDeptShared({
    supplierName: extraction.vendor.guessedName,
    lineItemDescriptions: sharedUniqDescs,
    fullDocumentText: transactionalTextValue,
    clubDepartments: DEFAULT_DEPTS_SHARED,
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
      id: true, accountNumber: true, name: true, type: true, accountRole: true,
      normalBalance: true, isActive: true, isHeader: true, archivedAt: true,
      allowManualPosting: true, fundApplicability: true,
      isBankAccount: true, isCashAccount: true, isControlAccount: true,
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
    // Phase 4R · Phase 7.2 (2026-08-13) — hard-eligibility flags so
    // the discovery union cannot surface bank/cash/control accounts
    // as AP debits. Consumed by
    // src/lib/ap-intelligence/candidate-discovery/.
    //
    // NOTE: `type` and `accountRole` are DELIBERATELY not propagated
    // into AccountView until candidate-recall is proven adequate —
    // canonical-ranker.ts reads `account.type` and activates
    // CAPITAL_ASSET_MATCH +20 when it sees ASSET, which is a
    // SCORING change (forbidden by Phase 7.2 directive §12 "Do not
    // change canonical weights yet"). Discovery providers that need
    // type-awareness must consult account-side heuristics (name /
    // fsGroup / categoryKey) instead of `acct.type`.
    isBankAccount: (a as { isBankAccount?: boolean }).isBankAccount ?? false,
    isCashAccount: (a as { isCashAccount?: boolean }).isCashAccount ?? false,
    isControlAccount: (a as { isControlAccount?: boolean }).isControlAccount ?? false,
    allowManualPosting: a.allowManualPosting,
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
  // Phase 4R · Phase 5 (2026-08-11) — allocations run AFTER the
  // canonical facade so per-cluster ranking receives the same
  // globalSignals (nature, capital, purchased-object) as
  // document-level classification. See computeAllocations call
  // below, immediately after the canonical facade block.

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

  // ==========================================================================
  // Phase 4R · single-GL-authority refactor · Phase 3.2 (2026-08-11).
  //
  // Canonical runtime authority — replaces the Group A post-ranking
  // override chain (purpose_ontology_promotion + purpose_ontology_abstain
  // + purpose_driven_full_coa_search) with ONE ranked competition.
  //
  // Before this migration, the initial `recommendGlAccount` result
  // above could be OVERWRITTEN by up to three subsequent override
  // sites that ran their own selection logic without rebuilding
  // `gl.candidates`. That violated the founder §1 invariant
  //   analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber
  //
  // Now: `runCanonicalGlRanking` runs the canonical family-based
  // ranker once. Its result is a pure projection of the canonical
  // ranker output (§11 no business logic in the facade). Winner is
  // candidates[0] by structural type contract. Purpose ontology
  // becomes evidence inside the competition (TRANSACTION_TEXT
  // family) — not a post-ranking authority.
  //
  // Purpose/ontology intelligence preserved:
  //   Site A1 (purpose_ontology_promotion) → PURPOSE_TYPE_COMPAT +
  //     PURPOSE_CATEGORY_HINT + ONTOLOGY_NAME_MATCH observations
  //     inside TRANSACTION_TEXT family (rankCanonical scoring).
  //   Site A2 (purpose_ontology_abstain) → structural: when no
  //     candidate scores above COMMIT_MIN_SCORE, the canonical
  //     result is ABSTAIN with candidates[0] preserved (§8 —
  //     abstention does not destroy ranking provenance).
  //   Site A3 (purpose_driven_full_coa_search / Pipeline B) →
  //     rankCanonical ALREADY iterates the ENTIRE eligible COA.
  //     No separate "if empty then run full-COA" fallback — one
  //     competition, always.
  // ==========================================================================
  // Phase 4R · Phase 3.3 (2026-08-11) — nature signals folded into
  // canonical input BEFORE ranking (§13 ordering rule). This replaces
  // Group B's post-ranking authorities (nature_promoted +
  // nature_scoped_full_coa_search + Phase 2 eligibility recheck).
  //
  // Nature is now a PRE-RANKING input to the single canonical
  // competition. `rankCanonical` already emits NATURE_COMPAT /
  // NATURE_INCOMPATIBLE / ACCOUNT_ROLE_MATCH observations in the
  // CAPITAL_NATURE family, plus explicit contradictions for
  // materially incompatible types. No post-ranking selector is
  // reintroduced.
  //
  // Classification per §2:
  //   - Nature type compat/mismatch → SOFT CONTRADICTION (scoring
  //     evidence in CAPITAL_NATURE family)
  //   - Nature-scoped full-COA search → REDUNDANT: rankCanonical
  //     already iterates the ENTIRE eligibleAccounts by construction.
  //   - Phase 2 eligibility recheck → REDUNDANT: eligibility is
  //     enforced BEFORE canonical ranking via filterEligibleAccounts
  //     inside runCanonicalGlRanking (§6 hard eligibility upstream).
  // ==========================================================================
  const natureForCanonical = classifyAccountingNature({
    extraction: mergedExtraction,
    supplierName: mergedExtraction.vendor.guessedName,
    lineItemDescriptions: Array.from(new Set([
      ...mergedExtraction.lineItems.map((li) => li.description),
      ...mergedLineItems.map((li) => li.description),
      ...(tableReconstruction?.lineItems ?? []).map((li) => li.description),
    ].filter((d): d is string => typeof d === "string" && d.length > 0))),
    fullDocumentText: pdfText || null,
    transactionalText: transactionalTextValue,
    capitalStateFromClassifier: capital.state,
    capitalThresholdCents: capitalMinCents,
    totalCents: mergedExtraction.total ? Math.round(Number(mergedExtraction.total) * 100) : null,
  });
  // ==========================================================================
  // Phase 4R · Phase 7 (2026-08-12) · CLUSTER-OWNED CLASSIFICATION.
  //
  // The founder-approved architecture: THE ECONOMIC TRANSACTION CLUSTER
  // IS THE UNIT OF GL CLASSIFICATION. `analyseIngestedInvoice` no
  // longer runs a second document-level canonical competition here.
  // Compute WHOLE-DOCUMENT context ONCE (compat-gate verdict lists,
  // financing-evidence flag, eligible-account pool) then let
  // `computeAllocations` run per-cluster canonical ranking. After
  // clustering, project the cluster results into `gl` via
  // `projectClustersToGlRecommendation` (see gl-allocations.ts).
  //
  // For single-cluster invoices: `gl` mirrors the single cluster's
  // canonical result (winner, candidates, confidence, recommendation
  // status). For multi-cluster invoices: `gl.accountNumber = null`
  // with aggregated confidence / recommendation status.
  //
  // Founder §9: "Do not implement this merely as show allocation
  // winner instead of document winner. Remove the duplicate document
  // classification call for single-cluster invoices." — this is that
  // removal. `runCanonicalGlRanking` is no longer called from this
  // pipeline.
  // ==========================================================================
  const { computeGlobalContextForClusters } = await import("./canonical-runtime-facade");
  const { departmentAccountNamePatterns: deptPatternsForCanonical } =
    await import("./department-inference");
  const deptKeyForCanonical = sharedDept.leader?.key ?? sharedDept.ranked.find((d) => d.score > 0)?.key ?? null;
  const deptPatsForCanonical = deptKeyForCanonical ? deptPatternsForCanonical(deptKeyForCanonical) : [];
  const hasPayrollEvidenceForClusters = (await import("./account-semantics/payroll-evidence"))
    .detectPayrollEvidence({
      vendorNames: [
        extraction.vendor.guessedName,
        vendor.state === "MATCHED" ? vendor.candidates[0]?.legalName : null,
        vendor.state === "MATCHED" ? vendor.candidates[0]?.operatingName : null,
      ],
      lineItemDescriptions: lineItemsExtracted.map((li) => li.description ?? ""),
      documentText: pdfOk ? pdfText : null,
    }).hasPayrollEvidence;
  const globalContext = await computeGlobalContextForClusters({
    clubId: args.clubId,
    expectedDebitRole,
    hasPayrollEvidence: hasPayrollEvidenceForClusters,
    departmentKey: deptKeyForCanonical,
    capital,
    capitalDecisionFull: sharedCapitalDecision,
    productIdentity: sharedProductIdentity,
    purchasedObjects: sharedPurchasedObjects,
    transactionFunctionalSignals: [
      ...sharedPurchasedObjects.map((o) => o.description),
      (sharedProductIdentity.externalEvidence ?? [])
        .map((e) => e.matchedProductFamily)
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join(" "),
      transactionalTextValue ?? "",
    ].filter((s) => typeof s === "string" && s.length > 0),
    additionalEvidenceTexts: [transactionalTextValue ?? ""].filter(Boolean),
  });
  // Phase 4R · Phase 3.6 (Group E, 2026-08-11) — the post-canonical
  // gl.accountNumber = null override for field-quality abstention has
  // been deleted. The facade now applies the recommendation policy
  // during projection: gl.recommendationStatus === "ABSTAIN_QUALITY"
  // when field-quality is insufficient (winner provenance preserved
  // via gl.canonicalWinnerAccountNumber). We continue to clear the
  // allocation cardCategory under the same condition here.
  //
  // Phase 4R · Phase 5 (2026-08-11) — allocations run canonically
  // AFTER the canonical facade completes so per-cluster ranking
  // consumes the same globalSignals as document-level classification
  // (nature classifier output, capital decision, purchased-object
  // durable-asset context, financing evidence, department signals,
  // vendor identity/history). Each allocation cluster then runs
  // through the SAME canonical ranker + recommendation policy +
  // confidence assessment as document-level GL — one authority for
  // both single- and multi-account invoices.
  const {
    departmentAccountNamePatterns: deptPatternsForAlloc,
  } = await import("./department-inference");
  const deptKeyForAlloc = sharedDept.leader?.key ?? sharedDept.ranked.find((d) => d.score > 0)?.key ?? null;
  const deptPatsForAlloc = deptKeyForAlloc ? deptPatternsForAlloc(deptKeyForAlloc) : [];
  const allocations = computeAllocations({
    lineItems: lineItemsExtracted,
    accounts: allocationAccounts,
    postingBlockersByAccount: allocationPostingBlockers,
    economicPurposeCandidates: economicPurpose,
    fullDocumentText: pdfOk ? pdfText : null,
    supplierName: extraction.vendor.guessedName,
    // Phase 4R · Phase 7.1 (2026-08-13) — pass canonical purpose
    // decision so clustering uses it as authoritative concept when
    // CANONICAL_COMMITTED. Fixes 221178 fragmentation: 5 IT-service
    // lines split into 3 clusters because clustering ignored the
    // canonical SOFTWARE_SUBSCRIPTION decision (conf 96) and the
    // legacy purpose vote failed the >=40 threshold.
    purposeDecision: purposeDecision ?? null,
    // Phase 4R · Phase 7.2B (2026-08-13) — discovery context for
    // legacy-direct discovery providers (candidate-discovery/). Never
    // read by canonical ranking. Founder Option B authorisation.
    discoveryContext: {
      richAccounts: accountsForAllocations.map((a) => ({
        id: a.id,
        accountNumber: a.accountNumber,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isActive: a.isActive,
        isHeader: a.isHeader,
        allowManualPosting: a.allowManualPosting,
        isControlAccount: (a as { isControlAccount?: boolean }).isControlAccount ?? false,
        isBankAccount: (a as { isBankAccount?: boolean }).isBankAccount ?? false,
        isCashAccount: (a as { isCashAccount?: boolean }).isCashAccount ?? false,
        archivedAt: (a as { archivedAt?: Date | null }).archivedAt ?? null,
        fundApplicability: a.fundApplicability,
        categoryKey: a.category?.key ?? null,
        categoryName: a.category?.name ?? null,
        fsGroupKey: a.fsGroup?.key ?? null,
        fsGroupName: a.fsGroup?.name ?? null,
        accountRole: (a as { accountRole?: string | null }).accountRole ?? null,
      })),
      purposeDecision: purposeDecision ?? null,
      capitalDecision: sharedCapitalDecision,
      productIdentity: sharedProductIdentity,
      purchasedObjects: sharedPurchasedObjects,
      departmentInference: sharedDept,
      vendorHistoryPreferredAccountNumbers: [],
      natureClassification: natureForCanonical,
      supplierName: extraction.vendor.guessedName,
    },
    printedSubtotal,
    printedTax,
    printedTotal,
    globalSignals: {
      departmentKey: deptKeyForAlloc,
      departmentAccountNamePatterns: deptPatsForAlloc,
      natureLeader: natureForCanonical.leader,
      natureConfidence: natureForCanonical.leaderConfidence,
      natureIsDefensible: natureForCanonical.isDefensible,
      capitalDecision: (natureForCanonical.isDefensible && natureForCanonical.leader === "REPAIR_AND_MAINTENANCE")
        ? "REPAIR_MAINTENANCE"
        : (capital.state === "CAPITAL" ? "CAPITAL_CANDIDATE" : capital.state === "OPERATING" ? "OPERATING" : "UNRESOLVED"),
      capitalConfidence: capital.state === "CAPITAL" ? 80 : capital.state === "OPERATING" ? 80 : 0,
      hasHighQualityDurableAssetContext: (() => {
        if (sharedPurchasedObjects.length === 0) return false;
        const primary = [...sharedPurchasedObjects].sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0];
        return !!primary && primary.evidenceQuality === "HIGH" && (
          primary.objectRole === "COMPLETE_MACHINE"
          || primary.objectRole === "SERIALIZED_COMPONENT"
          || (primary.objectRole === "UNKNOWN" && primary.brandCandidates.length > 0 && primary.modelCandidates.length > 0)
        );
      })(),
      hasFinancingEvidence: globalContext.hasFinancingEvidence,
      matchedVendorId: vendor.state === "MATCHED" ? vendor.candidates[0]?.id ?? null : null,
      // Phase 4R · Phase 7 (2026-08-12) — pre-baked compatibility-gate
      // verdict lists computed ONCE per invoice (whole-document context)
      // and fed to every cluster as globalSignals per founder §4.
      preferredAccountNumbers: globalContext.preferredAccountNumbers,
      contradictedAccountNumbers: globalContext.contradictedAccountNumbers,
    },
  });

  // Phase 4R · Phase 7 (2026-08-12) — cluster-owned projection.
  // The document GL result is derived from the cluster canonical
  // results, not from a second document-level canonical competition.
  // Single-cluster invoice → gl mirrors cluster[0]. Multi-cluster →
  // gl.accountNumber = null + aggregated recommendationStatus +
  // aggregated canonicalConfidence per founder §7 Option A + §8.
  const { projectClustersToGlRecommendation } = await import("./gl-allocations");
  gl = projectClustersToGlRecommendation(allocations.allocations, {
    fieldQualityEligible: fieldQualityGate.glEligible,
    fieldQualityAbstentionReasons: fieldQualityGate.abstentionReasons,
    totalAccountsEvaluated: globalContext.totalAccountsEvaluated,
  });

  // Phase 4R · Phase 5 (§9) — overall multi-allocation review policy
  // (unchanged from Phase 5). Any non-RECOMMEND cluster flips the
  // allocation surface to requiresReview. Field-quality ABSTAIN
  // additionally nulls cardCategory.
  const anyAllocationNeedsReview = allocations.allocations.some(
    (a) => a.recommendationStatus != null && a.recommendationStatus !== "RECOMMEND",
  );
  let gatedAllocations = anyAllocationNeedsReview
    ? { ...allocations, requiresReview: true }
    : allocations;
  if (gl.recommendationStatus === "ABSTAIN_QUALITY") {
    gatedAllocations = {
      ...gatedAllocations,
      cardCategory: null,
      requiresReview: true,
    };
  }

  // Phase 4R · Phase 4 (2026-08-11) — confidenceDimensions runs
  // AFTER canonical so the glClassification dimension is fed by the
  // canonical winner (or ABSTAIN reason), not by a legacy Pipeline A
  // guess. Eliminates the last "canonical chooses winner while legacy
  // ranker explains confidence" architectural split.
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


  // Phase 4R · Phase 5 (2026-08-11, §11) — the parallel Slice 5.3
  // cardCategory guard is REMOVED. It used account-NAME regex on the
  // derived cardCategory to clear it when a durable-asset context
  // was present. That intelligence is now handled correctly upstream:
  // per-cluster canonical ranking emits OBJECT_ROLE_CONTRADICTION
  // (-22) on fee-family fsGroupKey accounts when
  // hasHighQualityDurableAssetContext is true and hasFinancingEvidence
  // is false (see canonical-ranker.ts). Fee-family accounts therefore
  // lose the per-cluster canonical competition rather than being
  // suppressed by a post-projection category-name regex. Founder §11:
  // "make it consume canonical evidence rather than constructing a
  // separate competitor universe."

  // Phase 2.1 (2026-08-06) §A6 — Phase 0 vs Phase 2 disagreement
  // logging. Both containment layers run below; here we snapshot
  // what Phase 2 concluded so the Phase 0 wire (next block) can
  // compare its own verdict. Founder §A6: never silently choose
  // the more permissive outcome — most restrictive wins.
  const phase2ConcludedLeader = gl.accountNumber;
  const phase2ConcludedAbstained = phase2ConcludedLeader == null;

  // Sprint 3 · Checkpoint 16H rejection #4 → audit approval
  // (2026-08-06) — Phase 0 safety containment. Runs AFTER the
  // nature-scoped promotion has (potentially) overridden the base
  // ranker's leader. Refuses to surface an accounting-invalid
  // leader — structural schema-field checks only, no name-pattern
  // gating. When suppressed, `gl` is replaced by an abstained
  // recommendation and the raw ranker output is retained in
  // diagnostics for review. Guarded by AP_INTELLIGENCE_PHASE0_SAFETY.
  {
    const {
      applyPhase0SafetyContainment,
      isPhase0SafetyEnabled,
    } = await import("./eligibility/phase0-safety");
    if (isPhase0SafetyEnabled() && gl.accountNumber != null) {
      const { prisma: prismaClient } = await import("@/lib/prisma");
      const accts = await prismaClient.account.findMany({
        where: { clubId: args.clubId, accountNumber: gl.accountNumber },
        select: {
          accountNumber: true, name: true, type: true, normalBalance: true,
          isActive: true, isHeader: true, allowManualPosting: true,
          isControlAccount: true, isBankAccount: true, isCashAccount: true,
        },
      });
      const acctMap = new Map(accts.map((a) => [a.accountNumber, a]));
      const guarded = applyPhase0SafetyContainment(gl, acctMap);
      if (guarded.suppressed) {
        // Phase 2.1 §A6 disagreement warning: Phase 2 admitted a
        // leader that Phase 0 then suppressed. Both concluding to
        // abstain is fine (agreement on the safe outcome); a P0
        // suppression AFTER a non-abstained P2 verdict means Phase 2
        // missed something Phase 0 caught — a diagnostic worth
        // logging. Sanitized: account number + reasons only, no
        // account name.
        if (!phase2ConcludedAbstained) {
          logger.warn("ap-intelligence.eligibility.p0_p2_disagreement", {
            clubIdTail: args.clubId.slice(-6),
            documentIdTail: doc.id.slice(-6),
            phase0SuppressedAccountNumber: guarded.diagnostic?.suppressedLeaderAccountNumber ?? null,
            phase0Reasons: guarded.diagnostic?.suppressedLeaderReasons ?? [],
            phase2ConcludedLeaderAccountNumber: phase2ConcludedLeader,
            outcome: "PHASE0_MORE_RESTRICTIVE_WINS",
          });
        }
        gl = guarded.recommendation;
      } else if (phase2ConcludedAbstained && gl.accountNumber != null) {
        // Would only happen if Phase 0 somehow re-populated gl,
        // which it doesn't — kept as a defensive branch that will
        // surface via telemetry if the invariant is ever violated.
        logger.warn("ap-intelligence.eligibility.p0_p2_disagreement", {
          clubIdTail: args.clubId.slice(-6),
          documentIdTail: doc.id.slice(-6),
          phase2ConcludedAbstained: true,
          outcome: "UNEXPECTED_P0_REPOPULATION",
        });
      }
    }
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
    canonicalSupplierIdentity: (() => {
      const si = (parsed.canonicalEvidence as unknown as { supplierIdentity?: { winner: unknown; abstained: boolean; diagnostic: { selectedSupplier: string | null; confidence: number; independentEvidenceGroups: number; supportingEvidence: string[]; contradictions: string[] } } })?.supplierIdentity;
      if (!si) return null;
      return {
        confidence: si.diagnostic.confidence,
        independentEvidenceGroups: si.diagnostic.independentEvidenceGroups,
        supportingEvidence: si.diagnostic.supportingEvidence,
        abstained: si.abstained,
        contradictionCount: si.diagnostic.contradictions?.length ?? 0,
        displayName: si.diagnostic.selectedSupplier,
      };
    })(),
    lineItemsExtracted: mergedLineItems,
    taxReconciliation,
    identifiers,
    economicPurpose,
    confidenceDimensions,
    amountHierarchy,
    taxGroupsResult,
    splitGlRecommendations: gl.splitRecommendations,
    // Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08, amendment
    // #8) — expose the canonical purpose decision so the projection
    // layer can render the purpose label in the founder-facing
    // Category cell when GL commits to null but purpose is
    // defensibly understood.
    purposeDecision: purposeDecision ?? null,
    allocations: gatedAllocations,
    documentAssessment: mergedAssessment,
    externalResearchTrace: {
      considered: externalTrigger.considered,
      triggered: externalTrigger.triggered,
      providerKind: externalTrigger.providerKind,
      cacheHit: externalTrigger.cacheHit,
      quotaAllowed: externalTrigger.quotaAllowed,
      quotaRemaining: externalTrigger.quotaRemaining,
      fingerprint: externalTrigger.fingerprint,
      reason: externalTrigger.reason,
      externalLookupCount: sharedProductIdentity.externalLookupCount,
      externalLatencyMs: sharedProductIdentity.externalLatencyMs,
    },
    // Phase 4R · Phase 3.4 (Group C, 2026-08-11) — the capital-aware
    // full-COA ranker was deleted. Its intelligence (compatibility gate
    // verdicts) is now consumed by canonical scoring as CAPITAL_NATURE
    // observations via the facade's per-account gate evaluation. This
    // diagnostic field is retained for API-schema compatibility but no
    // longer carries a parallel ranking result.
    capitalAwareRanking: undefined,
    productIdentityResolution: {
      status: sharedProductIdentity.status,
      confidence: sharedProductIdentity.confidence,
      evidenceQuality: sharedProductIdentity.evidenceQuality,
      reason: sharedProductIdentity.reason,
      externalCorroborationRequired: sharedProductIdentity.externalCorroborationRequired,
      externalLookupCount: sharedProductIdentity.externalLookupCount,
      externalLatencyMs: sharedProductIdentity.externalLatencyMs,
      externalProviderDiagnostic: sharedProductIdentity.externalProviderDiagnostic,
      externalEvidence: sharedProductIdentity.externalEvidence,
      diagnostic: sharedProductIdentity.diagnostic,
      selectedObjectType: sharedProductIdentity.selected?.objectType ?? null,
      candidates: sharedProductIdentity.candidates.map((c) => ({
        objectType: c.objectType,
        internalEvidenceScore: c.internalEvidenceScore,
        pricePlausibilityBand: c.pricePlausibilityBand,
        pricePlausibilityScore: c.pricePlausibilityScore,
        externalEvidenceScore: c.externalEvidenceScore,
        supportingCount: c.supportingEvidence.length,
        contradictionsCount: c.contradictions.length,
        reason: c.reason,
      })),
    },
    purchasedObjectIntelligence: {
      objects: sharedPurchasedObjects.map((o) => ({
        description: o.description,
        brandCandidates: o.brandCandidates,
        modelCandidates: o.modelCandidates,
        skuCandidates: o.skuCandidates,
        serialCandidates: o.serialCandidates,
        quantity: o.quantity,
        unit: o.unit,
        unitPrice: o.unitPrice,
        extension: o.extension,
        objectRole: o.objectRole,
        objectRoleConfidence: o.objectRoleConfidence,
        objectRoleDiagnostic: o.objectRoleDiagnostic,
        relatedObjects: o.relatedObjects,
        evidenceQuality: o.evidenceQuality,
      })),
    },
    purchasedItemIntelligence: (() => {
      // Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — pack the shared
      // purchased-item authorities for the projection layer + inspect-
      // wi diagnostic. Amendment #16/§27: founder-facing category is
      // derived from capital-decision + department only when both are
      // sufficiently supported; otherwise it stays null and the
      // projection falls through to the purpose label.
      const items = sharedPurchasedItems.map((it) => {
        const c = sharedItemCompleteness.get(it.sourceLineItemIndex);
        return {
          description: it.description,
          manufacturer: it.manufacturer,
          model: it.model,
          sku: it.sku,
          serialNumber: it.serialNumber,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          extension: it.extension,
          evidenceQuality: it.evidenceQuality,
          completeness: (c?.completeness ?? "UNKNOWN") as
            "COMPLETE_ASSET" | "COMPONENT" | "CONSUMABLE" | "SERVICE" | "UNKNOWN",
          completenessConfidence: c?.confidence ?? 0,
        };
      });
      const capital = sharedCapitalDecision;
      const dept = sharedDept.leader;
      const deptDefensible = sharedDept.isDefensible;
      // Founder-facing category hierarchy (§19 completion pass):
      //   1. If GL committed → projection uses account name (upstream).
      //   2. If capital+nature understood → composed label
      //      ("Equipment Purchase" / "Repairs & Maintenance") with
      //      optional department prefix.
      //   3. If capital unresolved but PurchasedObject understood →
      //      object-oriented label (e.g. "<brand> <model> equipment").
      //   4. Otherwise null → projection falls to taxonomy purpose.
      let founderFacingCategory: string | null = null;
      if (capital.confidence >= 40 && capital.decision !== "UNRESOLVED") {
        const deptPrefix = deptDefensible && dept ? dept.displayName + " " : "";
        if (capital.decision === "CAPITAL_CANDIDATE") {
          founderFacingCategory = (deptPrefix + "Equipment Purchase").trim();
        } else if (capital.decision === "REPAIR_MAINTENANCE") {
          founderFacingCategory = (deptPrefix + "Repairs & Maintenance").trim();
        }
        // OPERATING: fall through to purpose label; the concept
        // (Fuel, Telecom, …) is more informative than a generic
        // "Operating Purchase" chip.
      }
      if (founderFacingCategory == null && sharedPurchasedObjects.length > 0) {
        // Object-oriented fallback (§19 layer 3). Compose from the
        // strongest brand + model of the highest-extension object.
        const primary = [...sharedPurchasedObjects]
          .sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0];
        if (primary && primary.evidenceQuality !== "LOW") {
          const brand = primary.brandCandidates[0]?.value ?? "";
          const model = primary.modelCandidates[0]?.value ?? "";
          const bits = [brand, model].filter(Boolean).join(" ");
          if (bits.length > 0) {
            founderFacingCategory = `${bits} equipment`.trim();
          }
        }
      }
      return {
        items,
        capitalDecision: capital.decision,
        capitalConfidence: capital.confidence,
        capitalDiagnostic: capital.diagnostic,
        departmentLeaderKey: dept?.key ?? null,
        departmentLeaderName: dept?.displayName ?? null,
        departmentIsDefensible: deptDefensible,
        founderFacingCategory,
      };
    })(),
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

  // Phase 4R · Phase 5 (§12) — glClassification is a compat projection
  // of the AUTHORITATIVE canonical confidence assessment. Consumers
  // that need the full canonical assessment read gl.canonicalConfidence
  // directly; this legacy dimension is a numeric compat surface for
  // the confidence-dimensions payload used by Mission Control.
  //
  // Numeric mapping (documented so downstream code doesn't reconstruct):
  //   HIGH             → 90
  //   MODERATE         → 60
  //   LOW              → 25
  //   REVIEW_REQUIRED  →  0
  //   (canonicalConfidence absent — legacy or pre-canonical path)
  //                    → derived from gl.confidence with source mapping
  const glClassification: DimensionResult = (() => {
    const canonical = gl.canonicalConfidence;
    if (canonical) {
      const confMap: Record<string, number> = {
        HIGH: 90, MODERATE: 60, LOW: 25, REVIEW_REQUIRED: 0,
      };
      const src: DimensionSource = canonical.level === "REVIEW_REQUIRED" ? "system_default" : "computed";
      return {
        confidence: confMap[canonical.level] ?? 0,
        source: src,
        reason: canonical.humanReadableReason,
      };
    }
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
