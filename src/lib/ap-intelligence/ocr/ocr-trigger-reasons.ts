// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — machine-readable
// targeted-OCR trigger reasons.
//
// Founder amendment #2: keep the fused-row trigger as the first
// enabled trigger, but design routing around machine-readable
// trigger reasons rather than hardwiring DMM's failure shape. The
// router must be extensible to other unresolved critical-evidence
// classes without redesign.
//
// This module defines the trigger enum + a per-page evaluator +
// a decision object. Adding a new trigger is a matter of
// implementing one more evaluator function and adding one enum
// variant — nothing in the router needs to change.

import type { PdfLayout, PdfPageDescriptor } from "../pdf-layout-extract";
import type { LineItemRegion } from "../line-item-region-strategies";
import type { CanonicalLineItem } from "../evidence/canonical-line-item";

// -----------------------------------------------------------------------------
// Trigger reasons — every future critical-evidence class extends
// this enum. The router dispatches on the reason, not on any
// document-specific detail.
// -----------------------------------------------------------------------------

export type OcrTriggerReason =
  /** Page has no exploitable positioned structure at all. */
  | "PAGE_IMAGE_ONLY"
  /** Page has some positioned items but not enough distinct y-bands
   *  to reconstruct a table (rare — usually a scanned-fax hybrid). */
  | "PAGE_PARTIAL_STRUCTURE"
  /** Classic-column-table region detected but committed zero
   *  CanonicalLineItems AND ≥1 fused positioned item spans multiple
   *  detected column x-centres inside the region. The DMM
   *  archetype (single positioned run per row that pdf.js
   *  concatenated across columns). */
  | "CLASSIC_TABLE_FUSED_ROW"
  /** [reserved, not yet enabled] Ambiguous supplier — supplier
   *  identity orchestrator abstained AND page 1 has ≥1 candidate
   *  visual-branding region. */
  | "SUPPLIER_AMBIGUOUS_VISUAL_CANDIDATE"
  /** [reserved, not yet enabled] Totals cannot reconcile via native
   *  evidence but positioned line items exist. */
  | "TOTALS_UNRECONCILED_WITH_LINE_ITEMS";

/** Whether a trigger is currently enabled to route to OCR. New
 *  triggers land here first as `false` for shadow-mode observation
 *  before flipping true. */
export const OCR_TRIGGER_ENABLED: Record<OcrTriggerReason, boolean> = {
  PAGE_IMAGE_ONLY: true,
  PAGE_PARTIAL_STRUCTURE: true,
  CLASSIC_TABLE_FUSED_ROW: true,
  SUPPLIER_AMBIGUOUS_VISUAL_CANDIDATE: false, // reserved
  TOTALS_UNRECONCILED_WITH_LINE_ITEMS: false, // reserved
};

export interface OcrTriggerDecision {
  page: number;
  triggered: OcrTriggerReason[];
  shouldOcr: boolean;
  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Per-page evaluation
// -----------------------------------------------------------------------------

export interface EvaluateOcrTriggerArgs {
  layout: PdfLayout;
  pageDescriptor: PdfPageDescriptor;
  /** Regions that were detected on this page during native
   *  reconstruction (may be empty). */
  regionsOnPage: LineItemRegion[];
  /** Line items committed by native reconstruction for this page. */
  nativeItemsOnPage: CanonicalLineItem[];
}

/** Evaluate every trigger against a single page. Returns the
 *  ordered list of triggered reasons + whether ≥1 enabled trigger
 *  fired. Never throws. */
export function evaluateOcrTriggers(args: EvaluateOcrTriggerArgs): OcrTriggerDecision {
  const triggered: OcrTriggerReason[] = [];

  // 1. Image-only page — no positioned structure at all.
  if (args.pageDescriptor.pageClass === "IMAGE_ONLY") {
    triggered.push("PAGE_IMAGE_ONLY");
  }

  // 2. Partial text — some positioned items but not enough y-bands
  // to reconstruct a table.
  if (args.pageDescriptor.pageClass === "PARTIAL_TEXT") {
    triggered.push("PAGE_PARTIAL_STRUCTURE");
  }

  // 3. Classic-table fused-row — the DMM archetype. Detected when
  // a CLASSIC region exists on this page, committed zero native
  // line items, AND ≥1 fused positioned item spans multiple
  // detected column centres inside the region.
  if (isClassicTableFusedRow(args)) {
    triggered.push("CLASSIC_TABLE_FUSED_ROW");
  }

  const enabled = triggered.filter((r) => OCR_TRIGGER_ENABLED[r]);
  const shouldOcr = enabled.length > 0;
  return {
    page: args.pageDescriptor.page,
    triggered,
    shouldOcr,
    diagnostic: `pageClass=${args.pageDescriptor.pageClass} regions=${args.regionsOnPage.length} nativeItems=${args.nativeItemsOnPage.length} triggered=[${triggered.join(",")}] enabled=[${enabled.join(",")}]`,
  };
}

function isClassicTableFusedRow(args: EvaluateOcrTriggerArgs): boolean {
  const classicRegions = args.regionsOnPage.filter((r) => r.kind === "CLASSIC_COLUMN_TABLE");
  if (classicRegions.length === 0) return false;
  // Native committed zero items in these regions?
  const primaryNative = args.nativeItemsOnPage.filter((it) => it.role === "PRIMARY_PURCHASE");
  if (primaryNative.length > 0) return false;
  // Any positioned item on this page span ≥2 column x-centres?
  for (const region of classicRegions) {
    const columns = (region.payload as { columns?: Array<{ role: string; xCenter: number }> }).columns ?? [];
    if (columns.length < 2) continue;
    const inRegion = args.layout.items.filter(
      (it) => it.page === region.page && it.y >= region.yTop && it.y <= region.yBottom,
    );
    for (const it of inRegion) {
      if (it.width <= 0) continue;
      const spansHit = columns.filter((c) => c.xCenter >= it.x && c.xCenter <= it.x + it.width).length;
      if (spansHit >= 2) return true;
    }
  }
  return false;
}
