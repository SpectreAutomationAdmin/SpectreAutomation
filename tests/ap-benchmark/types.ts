// Sprint 3 · Checkpoint 16H rejection #4 → audit approval (2026-08-06)
// AP Intelligence Benchmark — shared types.
//
// A `BenchmarkCase` is a plain JSON manifest (persisted alongside the
// harness). It describes a single document plus the expected AND
// forbidden ground truth per the audit's Part E schema.
//
// The manifest deliberately keeps ground truth OUT of any production
// code path — production must never read from this directory.

export type CorpusSplit = "dev" | "validation" | "holdout";

export interface BenchmarkCase {
  /** Stable identifier — filesystem slug. Used to key results. */
  id: string;
  /** Development / validation / blind holdout. Holdout cases must NOT
   *  be examined while tuning; the runner refuses to print their raw
   *  document text or extraction detail unless explicitly permitted. */
  split: CorpusSplit;
  /** Free-form label the report renders. */
  label: string;
  /** Broad document class the case exercises (fuel / statement /
   *  newsletter / etc.). Drives report grouping. */
  category: string;
  /** Optional descriptive tags — `"french-headers"`, `"mixed-tax"`,
   *  `"text-layer-pdf"`, etc. */
  tags?: string[];
  /** How the harness produces text for the analyser.  In V1 every
   *  case uses `extractedTextOverride` so the runner has no PDF
   *  bytes and no OCR-provider dependency.  Real PDF bytes can be
   *  added later via `source.pdfPath` — the runner will refuse to
   *  read the path when it points outside `tests/ap-benchmark/`. */
  source: {
    kind: "TEXT_OVERRIDE";
    text: string;
    /** Present only for cases where the analyser needs the header
     *  metadata (sender domain, subject) for downstream signals. */
    email?: {
      senderAddress?: string;
      subject?: string;
    };
  };
  /** Truth the runner compares extraction + recommendation against. */
  expected: ExpectedTruth;
}

export interface ExpectedTruth {
  documentClass: "INVOICE" | "STATEMENT" | "CREDIT_NOTE" | "REMITTANCE" | "PURCHASE_ORDER" | "INFORMATIONAL" | "UNKNOWN";
  supplier?: {
    name: string;
    acceptableAliases?: string[];
    unacceptable?: string[];
  };
  invoiceNumber?: {
    value: string;
    unacceptable?: string[];
  };
  invoiceDate?: string;         // YYYY-MM-DD
  dueDate?: string;             // YYYY-MM-DD
  currency?: string;            // "CAD" | "USD" | …
  subtotal?: number;
  taxTotal?: number;
  taxRate?: number;
  total?: number;
  lineItems?: Array<{
    descriptionContains?: string;
    amountApprox?: number;
    quantityApprox?: number;
  }>;
  economicPurpose?: string;
  departmentHints?: string[];
  vendorMatchExpectation?: "MATCHED" | "NOT_FOUND" | "AMBIGUOUS" | "INSUFFICIENT_SIGNAL";
  /** GL accounts (by number) any of which would be acceptable Top-1.
   *  Numbers reference the synthetic COA seeded by seed.ts. */
  acceptableGlAccounts?: string[];
  /** Concepts (free-form tags) any of which the recommendation's
   *  evidence must reference for a "useful" Top-1. */
  acceptableGlConcepts?: string[];
  /** GL accounts that MUST NOT appear as Top-1.  A Top-1 hit here is
   *  an "unsafe recommendation" — the blocking metric. */
  forbiddenGlAccounts?: string[];
  forbiddenGlConcepts?: string[];
  /** Expected workflow projection state.  Compared against the
   *  card-projection layer's derivation. */
  expectedWorkflowType?: "AP_READY" | "AP_REVIEW" | "VENDOR_MATCH_REQUIRED" | "MISSING_INFORMATION" | "INFORMATIONAL" | "REVIEW_REQUIRED";
  expectedAllocationCount?: number;
  /** When true, the correct behaviour is to ABSTAIN — no supplier,
   *  no invoice number, no GL recommendation.  Used for unreadable /
   *  irrelevant documents. */
  expectedAbstention?: boolean;
  /** Free-form notes for the report — not compared. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Runtime shapes (harness → comparators → report)
// ---------------------------------------------------------------------------

export type ComparatorVerdict = "PASS" | "FAIL" | "PARTIAL" | "NOT_APPLICABLE";

export interface ComparatorResult {
  dimension: string;                    // supplier / invoiceNumber / gl-top1 / …
  verdict: ComparatorVerdict;
  score: number;                        // 0..1
  /** Machine-readable actual value (what the pipeline produced). */
  actual: unknown;
  /** Machine-readable expected value (what the case declared). */
  expected: unknown;
  /** Single-sentence reason for the verdict.  Never includes founder-
   *  specific literals in production code — the reason is composed
   *  from case data at runtime. */
  reason: string;
  /** True when this comparator's failure counts as an UNSAFE
   *  recommendation (blocking metric).  Only the forbidden-account
   *  and forbidden-concept comparators set this. */
  unsafe?: boolean;
}

export interface CaseRunResult {
  caseId: string;
  split: CorpusSplit;
  category: string;
  label: string;
  /** ms elapsed inside `analyseIngestedInvoice` for this case. */
  latencyMs: number;
  /** Full ranked comparator output. */
  results: ComparatorResult[];
  /** Verdict for the whole case: PASS iff no FAIL and no unsafe hits. */
  overall: ComparatorVerdict;
  /** Selected summary values for the report (kept small — the full
   *  analysis is not persisted in the harness). */
  extract: {
    supplier?: string | null;
    invoiceNumber?: string | null;
    total?: string | null;
    currency?: string | null;
    glLeaderAccountNumber?: string | null;
    glLeaderName?: string | null;
    glConfidence?: number | null;
    workflowState?: string | null;
    /** Number of candidates suppressed by the Phase 0 containment
     *  gate on this run (0 when containment is disabled). */
    phase0Suppressions?: number;
  };
}

export interface BenchmarkRunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  phase0Enabled: boolean;
  corpusVersion: string;
  totals: {
    cases: number;
    pass: number;
    fail: number;
    partial: number;
    notApplicable: number;
    unsafeRecommendations: number;
    abstentionOnUnreadable: number;
    falseAbstention: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  };
  perDimension: Record<string, {
    pass: number;
    fail: number;
    partial: number;
    notApplicable: number;
    averageScore: number;
  }>;
  cases: CaseRunResult[];
}
