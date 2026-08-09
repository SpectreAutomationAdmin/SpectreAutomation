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
    }>;
    contradictedPoolCount: number;
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
        .filter((li) => li.role !== "TAX")
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
  const expectedDebitRole: import("@/lib/accounting/eligibility").ExpectedDebitRole =
    capital.state === "CAPITAL" ? "CAPITAL_ASSET"
    : capital.state === "OPERATING" ? "OPERATING_EXPENSE"
    : "UNKNOWN";

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
    //
    // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #4+#6) —
    // when a defensible transactional-text view exists, pass THAT
    // to the ranker's document-phrase channel instead of the raw
    // pdfText. Supplier / recipient / footer / policy regions are
    // excluded so document-phrase evidence cannot fire on
    // "Telephone" / "Internet" appearing in a supplier address
    // block or "finance charge" appearing in a terms paragraph.
    // Falls back to raw pdfText when transactional text is empty
    // (image-only PDF, OCR pending) to preserve legacy behaviour.
    fullDocumentText:
      transactionalTextValue != null && transactionalTextValue.trim().length > 0
        ? transactionalTextValue
        : (pdfOk ? pdfText : null),
    extractedLineItems: lineItemsExtracted,
    // Post-16H Phase 2 — eligibility context.
    eligibilityContext: {
      expectedDebitRole,
      capitalizationEvidence: {
        supported: capital.state === "CAPITAL",
        confidence: capital.state === "CAPITAL" ? 80 : 0,
      },
    },
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
    purposeDecision = resolveEconomicPurpose({
      canonicalLineItems: canonicalLineItemsFromLayout,
      supplierName: extraction.vendor.guessedName,
      transactionalText: transactionalTextValue,
      hasPenaltyLine: canonicalLineItemsFromLayout.some((li) => li.role === "PENALTY"),
      hasMembershipLine: canonicalLineItemsFromLayout.some((li) =>
        /\b(member(?:ship)?\s*(?:dues|fee))\b/i.test(li.description)),
      hasProfessionalCredentialContext: (extraction.vendor.guessedName ?? "").match(
        /\b(?:association|society|college|institute|CPA|Chartered|Order\s+of)\b/i) != null,
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
    getProductReferenceProvider,
    activeProviderKind,
  } = await import("./external-product-reference/factory");
  const {
    tryConsumeDailyQuota,
    currentClubDailyCount,
    DEFAULT_RATE_LIMIT,
  } = await import("./external-product-reference/rate-limiter");
  const { fingerprintProductRequest } = await import("./product-reference-provider");
  const { InMemoryProductReferenceCache } = await import("./product-reference-provider");
  // Process-lifetime cache singleton (in-memory per §17 — a Redis /
  // DB-backed cache is a Slice 5.7 hardening item).
  const cache = ((globalThis as unknown as { __spectreProductRefCache?: InstanceType<typeof InMemoryProductReferenceCache> }).__spectreProductRefCache ??=
    new InMemoryProductReferenceCache());

  const rawProvider = getProductReferenceProvider();
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

  if (internalOnlyIdentity.externalCorroborationRequired
      && refRequest != null
      && refRequestFingerprint != null
      && configuredProviderKind !== "null"
      && configuredProviderKind !== "null-fallback") {
    externalTrigger.considered = true;
    // Cache lookup first (§17). Cache key is manufacturer|model|part
    // — invoice-independent per §17.
    const cachedRef = primaryObjectForRefRequest && primaryObjectForRefRequest.modelCandidates[0]
      ? cache.get(
          primaryObjectForRefRequest.brandCandidates[0]?.value ?? "",
          primaryObjectForRefRequest.modelCandidates[0].value,
          primaryObjectForRefRequest.skuCandidates[0]?.value ?? null,
        )
      : null;

    if (cachedRef) {
      externalTrigger.cacheHit = true;
      externalTrigger.triggered = false;
      externalTrigger.reason = `cache hit — re-using ${cachedRef.sourceEvidence.length} previously-fetched evidence records; product cache entry firstSeen=${cachedRef.firstSeenAt}`;
      // Build a MockProvider-shape that just replays cached evidence.
      const { FixtureProductReferenceProvider } = await import("./external-product-reference/fixture-provider");
      const cachedProvider = new FixtureProductReferenceProvider();
      cachedProvider.seedByFingerprint(refRequestFingerprint, {
        state: cachedRef.sourceEvidence.length > 0 ? "RESOLVED" : "NO_RESULTS",
        products: cachedRef.sourceEvidence,
      });
      sharedProductIdentity = await resolveProductIdentityShared({
        objects: sharedPurchasedObjects,
        pricePlausibilityProvider: new NullPricePlausibilityProvider(),
        productReferenceProvider: cachedProvider,
      });
    } else {
      // Quota check (§18)
      const quota = tryConsumeDailyQuota(args.clubId);
      externalTrigger.quotaAllowed = quota.allowed;
      externalTrigger.quotaRemaining = quota.remaining;
      if (!quota.allowed) {
        externalTrigger.reason = quota.reason ?? "daily quota exceeded";
      } else {
        externalTrigger.triggered = true;
        externalTrigger.reason = `external research triggered — provider=${configuredProviderKind} fingerprint=${refRequestFingerprint}`;
        logger.info("ap-intelligence.slice5-6.external-research.triggered", {
          clubId: args.clubId,
          docIdTail: doc.id.slice(-6),
          provider: configuredProviderKind,
          fingerprint: refRequestFingerprint,
          quotaRemaining: quota.remaining,
        });
        const beforeExternalStatus = internalOnlyIdentity.status;
        const beforeExternalTop = internalOnlyIdentity.candidates[0]?.objectType;
        const beforeExternalScore = internalOnlyIdentity.candidates[0]?.internalEvidenceScore;
        sharedProductIdentity = await resolveProductIdentityShared({
          objects: sharedPurchasedObjects,
          pricePlausibilityProvider: new NullPricePlausibilityProvider(),
          productReferenceProvider: rawProvider,
          externalTimeoutMs: DEFAULT_RATE_LIMIT.wholeJobTimeoutMs,
          externalCallCap: DEFAULT_RATE_LIMIT.perRequestMaxQueries,
        });
        logger.info("ap-intelligence.slice5-6.external-research.completed", {
          clubId: args.clubId,
          docIdTail: doc.id.slice(-6),
          externalLookupCount: sharedProductIdentity.externalLookupCount,
          externalLatencyMs: sharedProductIdentity.externalLatencyMs,
          statusBefore: beforeExternalStatus,
          statusAfter: sharedProductIdentity.status,
          topBefore: beforeExternalTop,
          topAfter: sharedProductIdentity.candidates[0]?.objectType,
          topScoreBefore: beforeExternalScore,
          topScoreAfter: sharedProductIdentity.candidates[0]?.internalEvidenceScore,
          selectedObjectType: sharedProductIdentity.selected?.objectType ?? null,
          diagnostic: sharedProductIdentity.diagnostic,
          reason: sharedProductIdentity.reason,
        });
        // Slice 5.6 live-acceptance §17: cache ANY successful external
        // call under the manufacturer|model|partNumber key so a repeat
        // analysis of the SAME product-identity doesn't fire another
        // 24-second web_search. Cache stores the parsed evidence
        // records the provider returned; when resolution status is
        // AMBIGUOUS (evidence returned but not enough to commit), we
        // still cache so the next call sees the same input state and
        // can decide identically without another provider hit.
        if (primaryObjectForRefRequest?.modelCandidates[0]
            && sharedProductIdentity.externalLookupCount > 0
            && (sharedProductIdentity.externalEvidence?.length ?? 0) > 0) {
          cache.put({
            manufacturer: primaryObjectForRefRequest.brandCandidates[0]?.value ?? "",
            model: primaryObjectForRefRequest.modelCandidates[0].value,
            partNumber: primaryObjectForRefRequest.skuCandidates[0]?.value ?? null,
            productFamily: sharedProductIdentity.selected?.objectType ?? "UNKNOWN",
            objectType: sharedProductIdentity.selected?.objectType ?? "UNKNOWN",
            sourceEvidence: (sharedProductIdentity.externalEvidence ?? []).map((e) => ({
              evidenceType: e.evidenceType as "OEM_PRODUCT_MATCH" | "OEM_PART_MATCH" | "OEM_SPECIFICATION" | "AUTHORIZED_DEALER_MATCH" | "MARKET_COMPARABLE" | "PRICE_PLAUSIBILITY",
              sourceDomain: e.sourceDomain,
              sourceTitle: e.sourceTitle,
              retrievedAt: new Date().toISOString(),
              queryFingerprint: refRequestFingerprint ?? "",
              matchedManufacturer: e.matchedManufacturer,
              matchedModel: e.matchedModel,
              matchedPartNumber: null,
              matchedProductFamily: e.matchedProductFamily,
              observedPrice: null,
              currency: null,
              confidence: e.confidence,
              evidenceSnippet: e.evidenceSnippet,
            })),
            confidence: sharedProductIdentity.confidence,
            firstSeenAt: new Date().toISOString(),
            lastVerifiedAt: new Date().toISOString(),
            expiresAt: null,
          });
        }
      }
    }
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
  if (purposeDecision.source === "CANONICAL_COMMITTED" && purposeDecision.concept != null && gl.accountName) {
    const winnerAffinity = evaluatePurposeAccountAffinity(purposeDecision.concept, gl.accountName);
    if (winnerAffinity == null) {
      // Winner has no ontology tie to the committed purpose. Look
      // for the highest-scoring alternative that does.
      const alternatives = gl.candidates ?? [];
      let promoted: typeof alternatives[number] | null = null;
      for (const alt of alternatives) {
        if (alt.accountId === gl.candidates[0]?.accountId) continue;
        const affinity = evaluatePurposeAccountAffinity(purposeDecision.concept, alt.accountName);
        if (affinity && alt.postable) {
          promoted = alt;
          break;
        }
      }
      if (promoted) {
        logger.info("ap-intelligence.purpose-ontology.override", {
          clubId: args.clubId, docIdTail: doc.id.slice(-6),
          concept: purposeDecision.concept,
          from: gl.accountNumber, to: promoted.accountNumber,
        });
        gl = {
          ...gl,
          accountNumber: promoted.accountNumber,
          accountName: promoted.accountName,
          categoryKey: promoted.categoryKey,
          fsGroupKey: promoted.fsGroupKey,
          source: "ECONOMIC_PURPOSE",
          confidence: Math.min(promoted.confidence + 8, 90),
          reason: `purpose_ontology_promotion:${purposeDecision.concept}(${purposeDecision.confidence})->${promoted.accountNumber}(base_conf=${promoted.confidence},from=${gl.accountNumber})`,
          leaderIsPostable: promoted.postable,
          leaderPostingBlockers: promoted.postingBlockers,
          autoApprovalEligible: false,
        };
      } else {
        // Amendment #11: "A recommendation that is merely less
        // wrong does not pass." When the winner is INCOMPATIBLE
        // with a committed canonical purpose AND no compatible
        // alternative exists in the base ranker's candidates, we
        // ABSTAIN — clearing the winner is more honest than letting
        // a wrong high-confidence answer stand. Nature-scoped
        // Stage B may still widen the search.
        logger.info("ap-intelligence.purpose-ontology.abstain", {
          clubId: args.clubId, docIdTail: doc.id.slice(-6),
          concept: purposeDecision.concept,
          clearedWinner: gl.accountNumber,
        });
        gl = {
          ...gl,
          accountNumber: null,
          accountName: null,
          categoryKey: null,
          fsGroupKey: null,
          source: "NONE",
          confidence: null,
          reason: `purpose_ontology_abstain:${purposeDecision.concept}(${purposeDecision.confidence}) — no purpose-compatible candidate in ranker top-N; base winner ${gl.accountNumber} ${JSON.stringify(gl.accountName)} was incompatible`,
          leaderIsPostable: false,
          leaderPostingBlockers: [],
          autoApprovalEligible: false,
          requiresReview: true,
        };
      }
    }
  }

  // Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08) — full-
  // eligible-COA purpose-driven ranker (§1 + §2). Runs when the base
  // ranker + ontology guard have not produced a defensible winner
  // AND the canonical purpose is COMMIT-ELIGIBLE (purpose decision
  // clears the evidence-quality gate). Scores EVERY Phase-2-eligible
  // account — never depends on the base ranker's top-N.
  //
  // Ontology name-substring matches are a strong BOOST, not a
  // pre-filter. An account with no ontology match but strong nature
  // + department + line-item Jaccard can still win.
  //
  // The evidence-quality gate protects against high-confidence
  // taxonomy scores over weak primary-item descriptions (e.g. a
  // "2 Lines Total" summary row winning the taxonomy but not
  // constituting real primary-item evidence): commitEligible is
  // false when
  // the primary-purchase description is short OR summary-shape OR
  // lacks a discriminative substring for the concept — in which case
  // this ranker skips and the analyser truthfully abstains.
  let purposeDrivenDiagnostic: string | null = null;
  let purposeEvidenceQualityDiag: string | null = null;
  const winnerIsNull = gl.accountNumber == null;
  const winnerNonPostable = gl.accountName == null || !gl.leaderIsPostable;
  if (purposeDecision != null && (winnerIsNull || winnerNonPostable)) {
    const { assessPurposeEvidenceQuality } = await import("./purpose-evidence-quality");
    const evidenceQuality = assessPurposeEvidenceQuality(purposeDecision, canonicalLineItemsFromLayout);
    purposeEvidenceQualityDiag = evidenceQuality.diagnostic;
    if (evidenceQuality.commitEligible) {
      const { rankPurposeDrivenAccounts } = await import("./purpose-driven-ranker");
      const { filterEligibleAccounts } = await import("@/lib/accounting/eligibility");
      const eligibleAccountsForPurpose = await prisma.account.findMany({
        where: { clubId: args.clubId, isActive: true, isHeader: false },
        select: {
          id: true, accountNumber: true, name: true, type: true,
          normalBalance: true, isActive: true, isHeader: true,
          allowManualPosting: true, isControlAccount: true,
          isBankAccount: true, isCashAccount: true, archivedAt: true,
          fundApplicability: true,
          accountRole: true,
          category: { select: { key: true, name: true } },
          fsGroup: { select: { key: true, name: true } },
        },
      });
      const asEligibilityView = eligibleAccountsForPurpose.map((a) => ({
        id: a.id, accountNumber: a.accountNumber, name: a.name, type: a.type,
        normalBalance: a.normalBalance, isActive: a.isActive, isHeader: a.isHeader,
        allowManualPosting: a.allowManualPosting, isControlAccount: a.isControlAccount,
        isBankAccount: a.isBankAccount, isCashAccount: a.isCashAccount,
        archivedAt: a.archivedAt, fundApplicability: a.fundApplicability,
        categoryKey: a.category?.key ?? null,
        fsGroupKey: a.fsGroup?.key ?? null,
        accountRole: a.accountRole ?? "STANDARD",
      }));
      const filtered = filterEligibleAccounts(asEligibilityView, {
        transactionKind: "AP_INVOICE",
        expectedDebitRole,
        departmentHint: null,
        capitalizationEvidence: {
          supported: capital.state === "CAPITAL",
          confidence: capital.state === "CAPITAL" ? 80 : 0,
        },
      });
      // Department hint via existing 16D inference — pattern list boosts
      // department-qualifying accounts.
      const {
        inferDepartment: inferDeptPD, DEFAULT_CLUB_DEPARTMENTS: DEFAULT_DEPTS_PD,
        departmentAccountNamePatterns: deptPatternsPD,
      } = await import("./department-inference");
      const uniqDescsPD = Array.from(new Set(
        canonicalLineItemsFromLayout.map((li) => li.description).filter(Boolean),
      ));
      const deptPD = inferDeptPD({
        supplierName: extraction.vendor.guessedName,
        lineItemDescriptions: uniqDescsPD,
        fullDocumentText: transactionalTextValue,
        clubDepartments: DEFAULT_DEPTS_PD,
      });
      const deptKeyPD = deptPD.leader?.key ?? deptPD.ranked.find((d) => d.score > 0)?.key ?? null;
      const deptPatsPD = deptKeyPD ? deptPatternsPD(deptKeyPD) : [];

      const pdResult = rankPurposeDrivenAccounts({
        purposeDecision,
        natureLeader: "UNKNOWN", // recomputed below if analyse.ts already produced natureForRanker
        natureConfidence: 0,
        natureIsDefensible: false,
        canonicalLineItems: canonicalLineItemsFromLayout,
        eligibleAccounts: filtered.eligible,
        departmentKey: deptKeyPD,
        departmentAccountNamePatterns: deptPatsPD,
        capitalDecision: sharedCapitalDecision.decision,
        capitalDecisionConfidence: sharedCapitalDecision.confidence,
      });
      purposeDrivenDiagnostic = pdResult.diagnostic;
      if (pdResult.winner) {
        logger.info("ap-intelligence.purpose-driven-ranker.promotion", {
          clubId: args.clubId, docIdTail: doc.id.slice(-6),
          concept: purposeDecision.concept,
          winner: pdResult.winner.accountNumber,
          score: pdResult.winner.total,
        });
        gl = {
          ...gl,
          accountNumber: pdResult.winner.accountNumber,
          accountName: pdResult.winner.accountName,
          categoryKey: filtered.eligible.find((a) => a.accountNumber === pdResult.winner!.accountNumber)?.categoryKey ?? null,
          fsGroupKey: filtered.eligible.find((a) => a.accountNumber === pdResult.winner!.accountNumber)?.fsGroupKey ?? null,
          source: "ECONOMIC_PURPOSE",
          confidence: Math.min(90, pdResult.winner.total),
          reason: `purpose_driven_full_coa_search:${purposeDecision.concept}(${purposeDecision.confidence},quality=${evidenceQuality.quality})->${pdResult.winner.accountNumber}(score=${pdResult.winner.total},considered=${pdResult.totalConsidered})`,
          leaderIsPostable: pdResult.winner.postable,
          leaderPostingBlockers: [],
          autoApprovalEligible: false,
          requiresReview: pdResult.winner.total < 60,
        };
      }
    }
  }
  // Persist diagnostics for downstream inspection.
  void purposeDrivenDiagnostic;
  void purposeEvidenceQualityDiag;

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

  // Sprint 3 · Checkpoint 16B (2026-08-04) — nature-driven GL
  // promotion. When the ranker abstained (gl.accountNumber === null)
  // but the accounting-nature classifier produced a defensible
  // classification, promote the highest-scored candidate that
  // matches BOTH the nature's expected account-type AND (loosely)
  // one of the nature's category hints. This is §6's hierarchical
  // model: nature defines the semantic search space; the promoted
  // candidate is the leader within that space.
  //
  // Confidence-driven per §8:
  //   * nature.confidence ≥ 60 → strong constraint: promote nature-
  //     matching candidate even if a higher-raw-score non-matching
  //     candidate exists
  //   * 30 ≤ confidence < 60 → moderate: promote only when the
  //     ranker abstained OR the top candidate lost to the anti-
  //     contamination gate
  //   * confidence < 30 → do NOT promote; use base ranker outcome
  //
  // Uses the reconstructed line-items list + full text via the
  // classifier so promotion honours EVERY page's evidence (§2).
  {
    // Compute nature here (before the accountingIntelligence IIFE
    // in the return) so we can consult it for promotion.
    const uniqDescs = Array.from(new Set([
      ...mergedExtraction.lineItems.map((li) => li.description),
      ...mergedLineItems.map((li) => li.description),
      ...(tableReconstruction?.lineItems ?? []).map((li) => li.description),
    ].filter((d): d is string => typeof d === "string" && d.length > 0)));
    const natureForRanker = classifyAccountingNature({
      extraction: mergedExtraction,
      supplierName: mergedExtraction.vendor.guessedName,
      lineItemDescriptions: uniqDescs,
      fullDocumentText: pdfText || null,
      transactionalText: transactionalTextValue,
      capitalStateFromClassifier: capital.state,
      capitalThresholdCents: capitalMinCents,
      totalCents: mergedExtraction.total ? Math.round(Number(mergedExtraction.total) * 100) : null,
    });

    // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #1) —
    // resolve the canonical economic-purpose decision once, HERE,
    // so it can gate the nature-scoped SEMANTIC_MATCH override
    // below and be published on the diagnostic.
    if (purposeDecision == null) {
      purposeDecision = resolveEconomicPurpose({
        canonicalLineItems: canonicalLineItemsFromLayout,
        supplierName: mergedExtraction.vendor.guessedName,
        transactionalText: transactionalTextValue,
        hasPenaltyLine: canonicalLineItemsFromLayout.some((li) => li.role === "PENALTY"),
        hasMembershipLine: canonicalLineItemsFromLayout.some((li) =>
          /\b(member(?:ship)?\s*(?:dues|fee))\b/i.test(li.description)),
        hasProfessionalCredentialContext: (mergedExtraction.vendor.guessedName ?? "").match(
          /\b(?:association|society|college|institute|CPA|Chartered|Order\s+of)\b/i) != null,
      });
    }

    const shouldPromote =
      natureForRanker.isDefensible &&
      (gl.accountNumber == null || natureForRanker.leaderConfidence >= 60);
    if (shouldPromote) {
      const { accountTypesForNature } = await import("./accounting-nature");
      const { rankNatureScopedAccounts } = await import("./nature-scoped-ranker");
      const wantTypes = new Set(accountTypesForNature(natureForRanker.leader));
      const accountLookup = new Map(
        accountsForAllocations.map((a) => [a.id, a]),
      );
      const candidates = (gl.candidates ?? []).map((c) => {
        const full = accountLookup.get(c.accountId);
        return { c, full };
      });
      // Stage A — try to promote from the raw ranker's top-N. Cheap.
      const matches = candidates.filter(({ c, full }) => {
        if (!full) return false;
        return wantTypes.has(full.type);
      });
      // 16D §12 — department tie-break: if we have a defensible
      // department leader, prefer top-N candidates whose account
      // name contains a department-qualifying token.
      const {
        inferDepartment: inferDeptStageA,
        DEFAULT_CLUB_DEPARTMENTS: DEFAULT_DEPTS_STAGE_A,
        departmentAccountNamePatterns: deptPatternsStageA,
      } = await import("./department-inference");
      const uniqDescsStageA = Array.from(new Set([
        ...mergedExtraction.lineItems.map((li) => li.description),
        ...mergedLineItems.map((li) => li.description),
        ...(tableReconstruction?.lineItems ?? []).map((li) => li.description),
      ].filter((d): d is string => typeof d === "string" && d.length > 0)));
      const deptStageA = inferDeptStageA({
        supplierName: mergedExtraction.vendor.guessedName,
        lineItemDescriptions: uniqDescsStageA,
        fullDocumentText: pdfText || null,
        clubDepartments: DEFAULT_DEPTS_STAGE_A,
      });
      // 16D — for ranker tie-break we use the highest-scoring
      // department candidate even when below the defensibility
      // threshold. Supplier-only signals cannot cross defensibility
      // (§6: vendor name alone = weak evidence) but they CAN break
      // a ranker tie between two otherwise-equal accounts.
      const deptStageAHint = deptStageA.leader?.key
        ?? deptStageA.ranked.find((d) => d.score > 0)?.key
        ?? null;
      const deptPatsStageA = deptStageAHint ? deptPatternsStageA(deptStageAHint) : [];
      let promoted = false;
      let stageAPickedDeptMatch = false;
      if (matches.length > 0) {
        matches.sort((a, b) => {
          // Department preference first: an account matching the
          // department leader beats one that doesn't (when both
          // have comparable raw confidence).
          const aDept = deptPatsStageA.some((p) => p.test(a.full?.name ?? "")) ? 1 : 0;
          const bDept = deptPatsStageA.some((p) => p.test(b.full?.name ?? "")) ? 1 : 0;
          if (aDept !== bDept) return bDept - aDept;
          const cd = (b.c.confidence ?? 0) - (a.c.confidence ?? 0);
          if (cd !== 0) return cd;
          return a.c.accountNumber.localeCompare(b.c.accountNumber);
        });
        stageAPickedDeptMatch = deptPatsStageA.length > 0 &&
          deptPatsStageA.some((p) => p.test(matches[0].full?.name ?? ""));
        const picked = matches[0];
        const picked_c = picked.c;
        // Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08,
        // amendment #5) — Stage A nature-promotion must also go
        // through the SEMANTIC_MATCH override gate. Stage A promotes
        // an account from the raw ranker's top-N when its type
        // matches the classified nature — but without the gate, a
        // low-confidence nature (e.g. INTEREST_OR_PENALTY(20)
        // matched on a policy-footer "finance charge" phrase) can
        // stomp a canonical FUEL / EQUIPMENT_PARTS purpose. The
        // gate blocks that path.
        const stageAGate = evaluateSemanticMatchGate({
          natureLeader: natureForRanker.leader,
          natureConfidence: natureForRanker.leaderConfidence,
          natureIsDefensible: natureForRanker.isDefensible,
          candidateAccountType: picked.full?.type ?? null,
          purposeDecision: purposeDecision ?? {
            source: "ABSTAIN" as const, concept: null, confidence: 0, label: "unresolved",
            canonicalTop3: [], legacyCandidates: [],
            diagnostic: "no purpose decision available at Stage A",
          },
          // Stage A always operates AFTER the base ranker. This is
          // not a "base abstained" call site — we're OVERRIDING a
          // base pick. Use the strict threshold.
          baseRankerAbstained: false,
        });
        if ((picked_c.confidence ?? 0) >= 20 && stageAGate.allow) {
          const blended = Math.min(picked_c.confidence ?? 0, natureForRanker.leaderConfidence);
          gl = {
            ...gl,
            accountNumber: picked_c.accountNumber,
            accountName: picked_c.accountName,
            categoryKey: picked_c.categoryKey,
            fsGroupKey: picked_c.fsGroupKey,
            source: "SEMANTIC_MATCH",
            confidence: blended,
            reason: `nature_promoted:${natureForRanker.leader}(${natureForRanker.leaderConfidence})->${picked_c.accountNumber}(raw_${picked_c.confidence},gate=allow)`,
            leaderIsPostable: picked_c.postable,
            leaderPostingBlockers: picked_c.postingBlockers,
            autoApprovalEligible: false,
          };
          promoted = true;
        } else if ((picked_c.confidence ?? 0) >= 20 && !stageAGate.allow) {
          logger.info("ap-intelligence.stage-a-promotion.gate-denied", {
            clubId: args.clubId, docIdTail: doc.id.slice(-6),
            candidate: picked_c.accountNumber,
            denials: stageAGate.denials.join("|"),
          });
        }
      }
      // Stage B (16C §5 + 16D §3+§12) — full nature-scoped COA
      // branch search WITH department inference. Ranks every
      // nature-compatible account in the tenant COA, excludes
      // contra / depreciation / header / inactive / control
      // accounts, boosts accounts whose name contains department-
      // qualifying tokens when invoice evidence supports a
      // department.
      //
      // 16D — Stage B ALSO runs when Stage A promoted an account
      // that does NOT match the hint-department. This ensures a
      // department-specific account (e.g. R & M - Ground Equip)
      // beats a generic account (e.g. Supplies - Backshop) that
      // happened to appear higher in the raw ranker's top-5.
      const stageBShouldRun = !promoted || (deptPatsStageA.length > 0 && !stageAPickedDeptMatch);
      if (stageBShouldRun) {
        const allCoa = await prisma.account.findMany({
          where: { clubId: args.clubId, isActive: true },
          select: {
            id: true, accountNumber: true, name: true, type: true,
            isHeader: true, isControlAccount: true,
            allowManualPosting: true, fundApplicability: true,
            category: { select: { key: true, name: true } },
            fsGroup: { select: { key: true, name: true } },
          },
        });
        const uniqDescsNS = Array.from(new Set([
          ...mergedExtraction.lineItems.map((li) => li.description),
          ...mergedLineItems.map((li) => li.description),
          ...(tableReconstruction?.lineItems ?? []).map((li) => li.description),
        ].filter((d): d is string => typeof d === "string" && d.length > 0)));

        // 16D §3+§4+§12 — compute department candidates + pass to
        // the ranker. Uses the tenant's department taxonomy
        // (defaults when tenant hasn't configured one).
        const {
          inferDepartment,
          DEFAULT_CLUB_DEPARTMENTS,
          departmentAccountNamePatterns,
        } = await import("./department-inference");
        const departmentResult = inferDepartment({
          supplierName: mergedExtraction.vendor.guessedName,
          lineItemDescriptions: uniqDescsNS,
          fullDocumentText: pdfText || null,
          clubDepartments: DEFAULT_CLUB_DEPARTMENTS,
        });
        // 16D — hint department: highest-scoring candidate even
        // when below defensibility threshold. Used ONLY as a
        // ranker tie-break (not primary signal).
        const deptKey = departmentResult.leader?.key
          ?? departmentResult.ranked.find((d) => d.score > 0)?.key
          ?? null;
        const deptPatterns = deptKey ? departmentAccountNamePatterns(deptKey) : [];

        const scoped = rankNatureScopedAccounts({
          nature: natureForRanker.leader,
          natureConfidence: natureForRanker.leaderConfidence,
          allAccounts: allCoa.map((a) => ({
            id: a.id,
            accountNumber: a.accountNumber,
            name: a.name,
            type: a.type,
            isActive: true,
            isHeader: a.isHeader ?? false,
            isControlAccount: a.isControlAccount ?? false,
            allowManualPosting: a.allowManualPosting ?? true,
            categoryKey: a.category?.key ?? null,
            categoryName: a.category?.name ?? null,
            fsGroupKey: a.fsGroup?.key ?? null,
            fsGroupName: a.fsGroup?.name ?? null,
            fundApplicability: a.fundApplicability,
          })),
          lineItemDescriptions: uniqDescsNS,
          fullDocumentText: pdfText || null,
          supplierName: mergedExtraction.vendor.guessedName,
          departmentKey: deptKey,
          departmentAccountNamePatterns: deptPatterns,
        });
        if (scoped.leader) {
          const ldr = scoped.leader;
          // 16D — override rule when Stage A already promoted:
          // only take Stage B's leader if it matches the hint-
          // department AND Stage A didn't. This prevents Stage B
          // from stomping a fine Stage A choice with a lower-
          // scoring account.
          const ldrDeptMatches = deptPatterns.length > 0 &&
            deptPatterns.some((p) => p.test(ldr.account.name));
          const shouldOverride = !promoted || (ldrDeptMatches && !stageAPickedDeptMatch);
          // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #5) —
          // strengthened SEMANTIC_MATCH override gate. The override
          // may only proceed when ALL of: nature confidence clears
          // threshold; nature is defensible; nature is compatible
          // with the committed canonical purpose; the candidate
          // account type is compatible with the nature; no stronger
          // canonical evidence contradicts. Confidence alone is not
          // enough. This closes the class of defect where a low-
          // confidence nature (e.g. 20-33) elected a full-COA
          // account whose type was incompatible with the canonical
          // purchase — a "confidence-laundering" path §25 warns
          // against.
          const gateInput = {
            natureLeader: natureForRanker.leader,
            natureConfidence: natureForRanker.leaderConfidence,
            natureIsDefensible: natureForRanker.isDefensible,
            candidateAccountType: ldr.account.type ?? null,
            purposeDecision: purposeDecision ?? {
              source: "ABSTAIN" as const, concept: null, confidence: 0, label: "unresolved",
              canonicalTop3: [], legacyCandidates: [],
              diagnostic: "no purpose decision available",
            },
            // When the base ranker abstained (no winner), the gate
            // relaxes its confidence threshold — a defensible-but-
            // moderate nature is preferable to a null answer.
            baseRankerAbstained: gl.accountNumber == null,
          };
          const gateOutcome = evaluateSemanticMatchGate(gateInput);
          semanticMatchGateEvaluations.push({
            candidateAccountNumber: ldr.account.accountNumber,
            allow: gateOutcome.allow,
            denials: gateOutcome.denials,
          });
          if (shouldOverride && gateOutcome.allow) {
            gl = {
              ...gl,
              accountNumber: ldr.account.accountNumber,
              accountName: ldr.account.name,
              categoryKey: ldr.account.categoryKey ?? null,
              fsGroupKey: ldr.account.fsGroupKey ?? null,
              source: "SEMANTIC_MATCH",
              confidence: Math.min(natureForRanker.leaderConfidence, Math.min(95, ldr.score)),
              reason: `nature_scoped_full_coa_search:${natureForRanker.leader}(${natureForRanker.leaderConfidence})->${ldr.account.accountNumber}(compat=${scoped.compatibleAccountCount},excluded=${scoped.excludedAccountCount},dept=${deptKey ?? "none"},dept_match=${ldrDeptMatches},gate=allow)`,
              leaderIsPostable: ldr.isPostable,
              leaderPostingBlockers: ldr.postingBlockers as any,
              autoApprovalEligible: false,
            };
          } else if (shouldOverride && !gateOutcome.allow) {
            logger.info("ap-intelligence.semantic-match.override-denied", {
              clubId: args.clubId, docIdTail: doc.id.slice(-6),
              candidate: ldr.account.accountNumber,
              denials: gateOutcome.denials.join("|"),
            });
          }
        }
      }
    }
  }

  // Post-16H Phase 2 (2026-08-06) — post-promotion eligibility
  // check. Nature-scoped promotion above ranks the full COA
  // independently of the base ranker's eligibility filter, so it
  // can re-introduce an ineligible account. Re-evaluate the
  // promoted leader against the same eligibility service; if
  // ineligible, abstain. This is the SECOND enforcement site for
  // Phase 2 — the pre-ranker filter is the first.
  {
    const {
      evaluateEligibility,
      isPhase2EligibilityEnabled,
    } = await import("@/lib/accounting/eligibility");
    if (isPhase2EligibilityEnabled() && gl.accountNumber != null) {
      const { prisma: prismaClient } = await import("@/lib/prisma");
      const acct = await prismaClient.account.findFirst({
        where: { clubId: args.clubId, accountNumber: gl.accountNumber },
        select: {
          id: true, accountNumber: true, name: true, type: true, normalBalance: true,
          isActive: true, isHeader: true, allowManualPosting: true,
          isControlAccount: true, isBankAccount: true, isCashAccount: true,
          archivedAt: true, fundApplicability: true,
          accountRole: true,
          category: { select: { key: true } }, fsGroup: { select: { key: true } },
        },
      });
      if (acct) {
        const verdict = evaluateEligibility({
          id: acct.id, accountNumber: acct.accountNumber, name: acct.name,
          type: acct.type, normalBalance: acct.normalBalance,
          isActive: acct.isActive, isHeader: acct.isHeader,
          allowManualPosting: acct.allowManualPosting,
          isControlAccount: acct.isControlAccount,
          isBankAccount: acct.isBankAccount, isCashAccount: acct.isCashAccount,
          archivedAt: acct.archivedAt,
          fundApplicability: acct.fundApplicability,
          categoryKey: acct.category?.key ?? null,
          fsGroupKey: acct.fsGroup?.key ?? null,
          accountRole: acct.accountRole ?? "STANDARD",
        }, {
          transactionKind: "AP_INVOICE",
          expectedDebitRole,
          capitalizationEvidence: {
            supported: capital.state === "CAPITAL",
            confidence: capital.state === "CAPITAL" ? 80 : 0,
          },
        });
        if (!verdict.eligible) {
          gl = {
            ...gl,
            accountNumber: null, accountName: null,
            categoryKey: null, fsGroupKey: null,
            source: "NONE",
            confidence: null,
            reason: `Phase 2 accounting eligibility rejected the promoted leader ${verdict.accountNumber}: ${verdict.exclusionReasons.join(", ")}. No supported recommendation — review required.`,
            candidates: [],
            leaderIsPostable: false,
            leaderPostingBlockers: [],
            autoApprovalEligible: false,
            requiresReview: true,
          };
        }
      }
    }
  }

  // Sprint 3 · Phase 4 Slice 5.5 (2026-08-08, §3-§7) —
  // capital-aware full-COA ranker. When CapitalEvidenceDecision
  // commits to a defensible non-UNRESOLVED nature, this authority
  // narrows the eligible tenant COA to accounting-nature-COMPATIBLE
  // accounts BEFORE ranking. Purpose/keyword scoring alone no longer
  // outranks committed capital nature. Per-dimension scoring is
  // exposed on the diagnostic for founder review.
  //
  // Truthful abstention preserved: when multiple compatible
  // candidates exist without a defensible discriminator, gl is
  // cleared to null with a specific abstention reason rather than
  // choosing arbitrarily.
  let capitalAwareRankingResult: import("./accounting-nature-compatibility").CapitalAwareRankingResult | null = null;
  if (sharedCapitalDecision.decision !== "UNRESOLVED"
      && sharedCapitalDecision.confidence >= 40) {
    const { rankCapitalAwareAccounts } = await import("./accounting-nature-compatibility");
    const capEligibleAccounts = await prisma.account.findMany({
      where: { clubId: args.clubId, isActive: true, isHeader: false },
      select: {
        accountNumber: true, name: true, type: true,
        normalBalance: true, isActive: true, isHeader: true,
        allowManualPosting: true, isControlAccount: true,
        isBankAccount: true, isCashAccount: true,
        accountRole: true,
        category: { select: { key: true } },
        fsGroup: { select: { key: true } },
      },
    });
    const capEligibleView = capEligibleAccounts.map((a) => ({
      accountNumber: a.accountNumber, name: a.name, type: a.type,
      normalBalance: a.normalBalance, isActive: a.isActive, isHeader: a.isHeader,
      allowManualPosting: a.allowManualPosting, isControlAccount: a.isControlAccount,
      isBankAccount: a.isBankAccount, isCashAccount: a.isCashAccount,
      categoryKey: a.category?.key ?? null,
      fsGroupKey: a.fsGroup?.key ?? null,
      accountRole: a.accountRole ?? "STANDARD",
    }));
    // Slice 5.6 live-acceptance §14: when external evidence
    // produced a functional product family (e.g. "Groundsmaster 3500
    // Series", "fairway mower"), fold that text into the department
    // inference input so the department can be derived from PRODUCT
    // FUNCTION rather than only from purchased-object description
    // vocabulary. The purchased-object description alone may not
    // contain the functional noun ("mower") even when the product
    // family clearly does.
    const externalProductFamilyText = (sharedProductIdentity.externalEvidence ?? [])
      .map((e) => e.matchedProductFamily)
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" ");
    const augmentedDeptDescs = externalProductFamilyText
      ? [...sharedUniqDescs, externalProductFamilyText]
      : sharedUniqDescs;
    const augmentedDept = externalProductFamilyText
      ? inferDeptShared({
          supplierName: extraction.vendor.guessedName,
          lineItemDescriptions: augmentedDeptDescs,
          fullDocumentText: transactionalTextValue,
          clubDepartments: DEFAULT_DEPTS_SHARED,
        })
      : sharedDept;

    capitalAwareRankingResult = rankCapitalAwareAccounts({
      capitalDecision: sharedCapitalDecision,
      productIdentity: sharedProductIdentity,
      purchasedObjects: sharedPurchasedObjects,
      departmentResult: augmentedDept,
      eligibleAccounts: capEligibleView,
      vendorHistoryPreferredAccountNumbers: [],
    });
    if (capitalAwareRankingResult.active) {
      logger.info("ap-intelligence.slice5-5.capital-aware-ranker.result", {
        clubId: args.clubId,
        docIdTail: doc.id.slice(-6),
        decision: sharedCapitalDecision.decision,
        confidence: sharedCapitalDecision.confidence,
        winner: capitalAwareRankingResult.winner?.accountNumber ?? "abstain",
        winnerScore: capitalAwareRankingResult.winner?.totalScore ?? 0,
        compatiblePoolCount: capitalAwareRankingResult.compatiblePool.length,
        abstained: capitalAwareRankingResult.abstained,
        abstentionReason: capitalAwareRankingResult.abstentionReason,
      });
      if (capitalAwareRankingResult.winner != null) {
        // The capital-aware winner OVERRIDES any prior purpose-driven
        // or Stage A/B leader when the committed accounting nature
        // makes the prior leader incompatible.
        const w = capitalAwareRankingResult.winner;
        gl = {
          ...gl,
          accountNumber: w.accountNumber,
          accountName: w.accountName,
          categoryKey: capEligibleView.find((a) => a.accountNumber === w.accountNumber)?.categoryKey ?? null,
          fsGroupKey: capEligibleView.find((a) => a.accountNumber === w.accountNumber)?.fsGroupKey ?? null,
          source: "SEMANTIC_MATCH",
          confidence: Math.min(90, w.totalScore),
          reason: `capital-aware nature-compatible search: decision=${sharedCapitalDecision.decision}(${sharedCapitalDecision.confidence}) → ${w.accountNumber} (${w.accountName}) totalScore=${w.totalScore} natureCompat=${w.natureCompat} dims=${JSON.stringify(w.dimensions)}`,
          leaderIsPostable: w.postable,
          leaderPostingBlockers: [],
          autoApprovalEligible: false,
          requiresReview: false,
        };
      } else if (capitalAwareRankingResult.abstained) {
        // Nature-compatible pool exists but no defensible winner —
        // clear any prior gl and surface a truthful abstention reason
        // per §7.
        gl = {
          ...gl,
          accountNumber: null,
          accountName: null,
          categoryKey: null,
          fsGroupKey: null,
          source: "NONE",
          confidence: 0,
          reason: `capital-aware ranker abstained: ${capitalAwareRankingResult.abstentionReason}. Decision=${sharedCapitalDecision.decision}(${sharedCapitalDecision.confidence}). Compatible pool size=${capitalAwareRankingResult.compatiblePool.length}.`,
          leaderIsPostable: false,
          leaderPostingBlockers: [],
          autoApprovalEligible: false,
          requiresReview: true,
        };
      }
    }
  }

  // Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08, §31
  // Outcome B) — object-authority contradiction guard. Applied AFTER
  // Stage A/B nature-scoped promotion. When purchased-object evidence
  // is HIGH-quality AND identifies a durable-asset context
  // (COMPLETE_MACHINE / SERIALIZED_COMPONENT / bundled ACCESSORY /
  // ambiguous UNKNOWN with model+brand present) AND the current GL
  // leader's account name matches interest / penalty / bank-charge /
  // finance-fee patterns, the leader is CONTRADICTED — those account
  // types are incompatible with a durable-asset transaction regardless
  // of what a footer phrase's raw ranker score suggested. Guard clears
  // the GL to null so the founder-facing card falls through to the
  // object-oriented category chip. No fabricated GL (§20 + §31).
  if (gl.accountNumber != null && sharedPurchasedObjects.length > 0) {
    const primary = [...sharedPurchasedObjects]
      .sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0];
    const durableAssetContext = primary
      && primary.evidenceQuality === "HIGH"
      && (
        primary.objectRole === "COMPLETE_MACHINE"
        || primary.objectRole === "SERIALIZED_COMPONENT"
        || (primary.objectRole === "UNKNOWN"
            && primary.brandCandidates.length > 0
            && primary.modelCandidates.length > 0)
      );
    const leaderName = (gl.accountName ?? "").toLowerCase();
    const isInterestOrFeeAccount =
      /\binterest\b/.test(leaderName)
      || /\bfinance\s*charge\b/.test(leaderName)
      || /\bpenalty\b/.test(leaderName)
      || /\blate\s*fee\b/.test(leaderName)
      || /\bbank\s*charges?\b/.test(leaderName)
      || /\bcredit\s*card\s*fees?\b/.test(leaderName);
    if (durableAssetContext && isInterestOrFeeAccount) {
      logger.info("ap-intelligence.slice5-3.object-contradiction-guard.cleared-gl", {
        clubId: args.clubId,
        docIdTail: doc.id.slice(-6),
        clearedAccount: gl.accountNumber,
        clearedName: gl.accountName,
        primaryObjectRole: primary.objectRole,
        primaryModel: primary.modelCandidates[0]?.value,
      });
      gl = {
        ...gl,
        accountNumber: null,
        accountName: null,
        categoryKey: null,
        fsGroupKey: null,
        source: "NONE",
        confidence: 0,
        reason: `Slice 5.3 object-authority guard: cleared draft ${gl.accountNumber} (${gl.accountName}) — purchased-object evidence identifies a durable-asset context that is incompatible with interest / fee accounts. Object role=${primary.objectRole}, model candidates=${primary.modelCandidates.map((m) => m.value).join("|")}. Capital vs operating treatment remains UNRESOLVED — review required.`,
        leaderIsPostable: false,
        leaderPostingBlockers: [],
        autoApprovalEligible: false,
        requiresReview: true,
      };
      // Also clear the multi-GL allocation cardCategory so the
      // founder-facing projection falls through to the object-
      // oriented label rather than surfacing a stale draft
      // allocation (which shares the same underlying evidence
      // that just contradicted the primary GL).
      gatedAllocations = {
        ...gatedAllocations,
        cardCategory: null,
        requiresReview: true,
      };
    }
  }

  // Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08, §31
  // Outcome B) — parallel guard for the allocation engine even when
  // gl remained postable. When the primary purchased object has HIGH
  // evidence of a durable-asset context AND the allocation
  // cardCategory names an interest / penalty / bank-charge / fee /
  // inventory account (all of which contradict durable-asset
  // treatment), clear the allocation cardCategory so the projection
  // does not surface a plausible-but-wrong category chip.
  if (gatedAllocations?.cardCategory && sharedPurchasedObjects.length > 0) {
    const primary2 = [...sharedPurchasedObjects]
      .sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0];
    const durableAssetContext2 = primary2
      && primary2.evidenceQuality === "HIGH"
      && (
        primary2.objectRole === "COMPLETE_MACHINE"
        || primary2.objectRole === "SERIALIZED_COMPONENT"
        || (primary2.objectRole === "UNKNOWN"
            && primary2.brandCandidates.length > 0
            && primary2.modelCandidates.length > 0)
      );
    const catLower = gatedAllocations.cardCategory.toLowerCase();
    const catContradicts =
      /\binterest\b/.test(catLower)
      || /\bfinance\s*charge\b/.test(catLower)
      || /\bpenalty\b/.test(catLower)
      || /\blate\s*fee\b/.test(catLower)
      || /\bbank\s*charges?\b/.test(catLower)
      || /\bcredit\s*card\s*fees?\b/.test(catLower)
      || /\binventory\s*-\s*(?:liquor|beer|wine|food|beverage)\b/.test(catLower);
    if (durableAssetContext2 && catContradicts) {
      logger.info("ap-intelligence.slice5-3.object-contradiction-guard.cleared-allocation", {
        clubId: args.clubId,
        docIdTail: doc.id.slice(-6),
        clearedCardCategory: gatedAllocations.cardCategory,
        primaryObjectRole: primary2.objectRole,
      });
      gatedAllocations = {
        ...gatedAllocations,
        cardCategory: null,
        requiresReview: true,
      };
    }
  }

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
    capitalAwareRanking: capitalAwareRankingResult ? {
      active: capitalAwareRankingResult.active,
      winnerAccountNumber: capitalAwareRankingResult.winner?.accountNumber ?? null,
      abstained: capitalAwareRankingResult.abstained,
      abstentionReason: capitalAwareRankingResult.abstentionReason,
      compatiblePool: capitalAwareRankingResult.compatiblePool.slice(0, 20).map((c) => ({
        accountNumber: c.accountNumber,
        accountName: c.accountName,
        totalScore: c.totalScore,
        natureCompat: c.natureCompat,
        dimensions: c.dimensions,
        supportingEvidence: c.supportingEvidence,
        contradictions: c.contradictions,
        postable: c.postable,
      })),
      contradictedPoolCount: capitalAwareRankingResult.contradictedPool.length,
      diagnostic: capitalAwareRankingResult.diagnostic,
    } : undefined,
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
