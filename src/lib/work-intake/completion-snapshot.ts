// Sprint 3 · Phase 4R Work Intake Completed-State Immutability
// (2026-08-15) — canonical typed shape for the founder-facing card
// facts captured at completion time.
//
// Founder direction §A2: extend WorkCompletionEvent.metadataJson with a
// typed `cardSnapshot` so historical Completed History cards render
// the facts as they were at approval, not whatever the current
// analyser reports today.
//
// This module is import-safe from both server and client (no Prisma,
// no analyser). The snapshot value MUST originate from the projection
// the founder was looking at when they clicked the terminal-transition
// button — the API route computes it from the rendered
// ApInvoiceCardIntelligence and threads it through
// resolveIntake / postAndClear into emitWorkCompletionEvent.metadata.
//
// The schema-of-record continues to be WorkCompletionEvent.metadataJson
// (TEXT). This file defines what shape the JSON MUST take so both
// writers (resolveIntake, postAndClear) and the reader
// (readCompletedCardFacts) share one source of truth.

// -----------------------------------------------------------------------------
// Version tag
// -----------------------------------------------------------------------------
// Bumped only when the shape below adds required fields or changes
// semantics. Additive-optional fields do NOT require a bump.

export const COMPLETION_CARD_SNAPSHOT_VERSION = "1" as const;

// -----------------------------------------------------------------------------
// Snapshot shape
// -----------------------------------------------------------------------------

export interface CompletionCardSnapshotAllocation {
  accountNumber: string | null;
  accountName: string | null;
  amount: number | null;
  taxTreatment?: string | null;
  taxRate?: number | null;
  taxAmount?: number | null;
  confidence?: number | null;
  requiresReview?: boolean | null;
}

/** Founder-facing card facts frozen at the moment of completion.
 *  Every field is optional so both POSTED and RESOLVED-without-post
 *  completions can populate what they have. The reader MUST tolerate
 *  missing fields (legacy fallback path). */
export interface CompletionCardSnapshot {
  /** Version of this shape. Reader may branch on this if the schema
   *  ever changes in a non-additive way. */
  snapshotVersion: typeof COMPLETION_CARD_SNAPSHOT_VERSION;
  /** Which analyser version produced the facts. Diagnostic — never
   *  used to influence rendering. */
  analysisVersion?: string | null;

  // Supplier / vendor identity as rendered at completion.
  supplierDisplayName?: string | null;
  vendorId?: string | null;
  vendorDisplayName?: string | null;
  vendorMatchState?: string | null;

  // Invoice identity + monetary facts.
  invoiceNumber?: string | null;
  invoiceDate?: string | null;   // ISO date string
  dueDate?: string | null;       // ISO date string
  subtotal?: number | null;
  taxTotal?: number | null;
  total?: number | null;
  currency?: string | null;
  purchaseOrder?: string | null;

  // Category / GL / allocation.
  categoryLabel?: string | null;
  glAccountNumber?: string | null;
  glAccountName?: string | null;
  allocations?: CompletionCardSnapshotAllocation[] | null;

  // Presentation state at approval.
  confidenceLabel?: string | null;   // e.g. "High", "Moderate · GL"
  workflowState?: string | null;     // legacy pill enum value at approval
  recommendationSummary?: string | null;

  // Provenance — helpful for audit trail; can also be read directly
  // from WorkCompletionEvent columns but denormalising here keeps
  // Completed History self-sufficient.
  completionType?: string | null;
  completedByUserId?: string | null;
  completedAt?: string | null;       // ISO timestamp
}

// -----------------------------------------------------------------------------
// Payload envelope for WorkCompletionEvent.metadataJson
// -----------------------------------------------------------------------------
//
// Existing writers (POST_AND_CLEARED) already pass IDs
// (apInvoiceId / apInvoiceNumber / journalEntryId / journalEntryNumber).
// We keep those alongside the new cardSnapshot in a top-level envelope
// so the two axes evolve independently.

export interface CompletionEventMetadataEnvelope {
  cardSnapshot?: CompletionCardSnapshot;
  // Existing POSTED metadata (kept as-is).
  apInvoiceId?: string;
  apInvoiceNumber?: string;
  journalEntryId?: string;
  journalEntryNumber?: string;
  // Any other legacy fields callers pass through survive round-trip.
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Read helper — safely parse WorkCompletionEvent.metadataJson
// -----------------------------------------------------------------------------

export function parseCompletionMetadata(
  raw: string | null | undefined,
): CompletionEventMetadataEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CompletionEventMetadataEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract a validated cardSnapshot from parsed metadata. Returns null
 *  when the snapshot is absent OR structurally invalid. Never throws. */
export function readCardSnapshotFromMetadata(
  meta: CompletionEventMetadataEnvelope | null | undefined,
): CompletionCardSnapshot | null {
  if (!meta) return null;
  const snap = meta.cardSnapshot;
  if (!snap || typeof snap !== "object") return null;
  if (snap.snapshotVersion !== COMPLETION_CARD_SNAPSHOT_VERSION) return null;
  return snap;
}
