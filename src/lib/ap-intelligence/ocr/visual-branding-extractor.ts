// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — visual-branding
// evidence extractor.
//
// Founder amendment #4:
//   - Do not equate uppercase top-quartile text with VISUAL_LOGO.
//   - Generate visual-branding candidates from top-page Textract
//     word blocks.
//   - Cluster adjacent blocks geometrically.
//   - REJECT document/form labels through the frozen supplier-
//     candidate veto logic (`isGenericLabelCandidate`).
//   - Provide the resulting evidence to the existing supplier
//     identity system.
//   - Preserve page/region/provider confidence.
//   - Logo/branding remains CORROBORATIVE rather than sole authority
//     by default.
//
// Input is the provider-neutral CanonicalDocumentExtraction produced
// by Textract normalization. Output is SupplierIdentityEvidence
// items of type VISUAL_LOGO that plug into the frozen supplier
// identity orchestrator without any changes to that orchestrator.

import type { CanonicalDocumentExtraction } from "../document-extractors/canonical-model";
import type { SupplierIdentityEvidence } from "../evidence/supplier-identity";
import { isGenericLabelCandidate } from "../evidence/supplier-identity";

// -----------------------------------------------------------------------------
// Parameters
// -----------------------------------------------------------------------------

/** Only consider blocks whose vertical position is in the top
 *  fraction of the page (top-left convention: 0.0 = top). */
const TOP_FRACTION = 0.25;
/** Merge horizontally adjacent blocks whose x-gap is less than this
 *  fraction of page width. */
const CLUSTER_X_GAP_FRAC = 0.02;
/** Merge vertically adjacent blocks whose y-gap is less than this
 *  fraction of page height (accommodates two-line logo lockups). */
const CLUSTER_Y_GAP_FRAC = 0.02;
/** Reject clusters shorter than this many characters. */
const MIN_CLUSTER_LEN = 3;
/** Cap the number of branding candidates surfaced. */
const MAX_CANDIDATES = 4;

// -----------------------------------------------------------------------------
// Extraction
// -----------------------------------------------------------------------------

interface ExtractedBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
  providerConfidence: number;
}

/** Extract visual-branding SupplierIdentityEvidence[] from a
 *  Textract-normalized extraction. Returns an empty array when no
 *  usable branding blocks survive the frozen veto.
 *
 *  This function does NOT modify the supplier-identity orchestrator.
 *  It PRODUCES evidence that the orchestrator (already scaffolded
 *  for VISUAL_LOGO) consumes downstream. */
export function extractVisualBrandingEvidence(
  extraction: CanonicalDocumentExtraction,
  opts: { sourcePageNumber?: number } = {},
): SupplierIdentityEvidence[] {
  const page = opts.sourcePageNumber ?? extraction.pages[0]?.pageNumber ?? 1;
  const pageMeta = extraction.pages.find((p) => p.pageNumber === page) ?? extraction.pages[0];
  const pageHeight = pageMeta?.height ?? 792;
  const pageWidth = pageMeta?.width ?? 612;

  // Textract-normalized extraction doesn't currently ship raw word
  // blocks. What it does ship is the supplierName field with a
  // region + provider confidence. We treat that as the primary
  // visual-branding candidate. Additional candidates come from the
  // supplierAddress line1 when its region is in the top fraction.
  const rawCandidates: ExtractedBlock[] = [];
  if (extraction.fields.supplierName?.region) {
    rawCandidates.push({
      text: extraction.fields.supplierName.value,
      x: extraction.fields.supplierName.region.x,
      y: extraction.fields.supplierName.region.y,
      width: extraction.fields.supplierName.region.width,
      height: extraction.fields.supplierName.region.height,
      page: extraction.fields.supplierName.region.page,
      providerConfidence: extraction.fields.supplierName.providerConfidence ?? 0,
    });
  }
  if (extraction.fields.supplierAddress?.addressLine1?.region) {
    const r = extraction.fields.supplierAddress.addressLine1.region;
    rawCandidates.push({
      text: extraction.fields.supplierAddress.addressLine1.value,
      x: r.x, y: r.y, width: r.width, height: r.height, page: r.page,
      providerConfidence: extraction.fields.supplierAddress.addressLine1.providerConfidence ?? 0,
    });
  }

  // Filter to top-of-page blocks only.
  const topBlocks = rawCandidates.filter((b) => (b.y / pageHeight) <= TOP_FRACTION);

  // Cluster adjacent blocks geometrically. Sort by page then y then x.
  topBlocks.sort((a, b) => (a.page - b.page) || (a.y - b.y) || (a.x - b.x));
  const clusters: ExtractedBlock[][] = [];
  for (const b of topBlocks) {
    const last = clusters[clusters.length - 1];
    if (!last) { clusters.push([b]); continue; }
    const tail = last[last.length - 1];
    const sameLine = Math.abs(tail.y - b.y) <= (CLUSTER_Y_GAP_FRAC * pageHeight);
    const closeX = b.x - (tail.x + tail.width) <= (CLUSTER_X_GAP_FRAC * pageWidth);
    const nextLine = (b.y - tail.y) <= (CLUSTER_Y_GAP_FRAC * pageHeight * 3) && Math.abs(b.x - tail.x) <= (pageWidth * 0.1);
    if ((sameLine && closeX) || (nextLine && b.page === tail.page)) {
      last.push(b);
    } else {
      clusters.push([b]);
    }
  }

  const evidence: SupplierIdentityEvidence[] = [];
  for (const cluster of clusters) {
    if (evidence.length >= MAX_CANDIDATES) break;
    const text = cluster.map((c) => c.text.trim()).filter(Boolean).join(" ").trim();
    if (text.length < MIN_CLUSTER_LEN) continue;
    // Amendment #4: reject document/form labels via frozen veto.
    if (isGenericLabelCandidate(text)) continue;
    // Bounding region = union of cluster blocks.
    const x = Math.min(...cluster.map((c) => c.x));
    const y = Math.min(...cluster.map((c) => c.y));
    const right = Math.max(...cluster.map((c) => c.x + c.width));
    const bottom = Math.max(...cluster.map((c) => c.y + c.height));
    const providerConf = Math.max(...cluster.map((c) => c.providerConfidence));
    evidence.push({
      type: "VISUAL_LOGO",
      value: text.slice(0, 120),
      page: cluster[0].page,
      region: { x, y, width: right - x, height: bottom - y, page: cluster[0].page },
      // Amendment #4: corroborative by default — cap contribution at
      // 75 so a spurious visual read cannot single-handedly commit a
      // supplier identity. The orchestrator's family logic + text
      // corroboration decide the final confidence.
      confidence: Math.min(75, Math.round(providerConf)),
      sourceStrategy: "AWS_TEXTRACT_EXPENSE",
      evidenceSnippet: `top-page cluster · providerConf=${Math.round(providerConf)}`,
      independenceGroup: `VISUAL_LOGO:${normalizeForCluster(text)}`,
    });
  }
  return evidence;
}

function normalizeForCluster(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}
