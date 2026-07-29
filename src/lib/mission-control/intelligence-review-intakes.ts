// Sprint 3 Checkpoint 15H (2026-07-25) — Loaders for the two new
// document-driven review situations that surface in Mission Control:
//   * AP_INVOICE_REVIEW      — created by C15E ap-intelligence
//   * VENDOR_STATEMENT_REVIEW — created by C15G ap-statement-intelligence
//
// READ-ONLY. Zero writes on page load. Reuses the persisted
// WorkIntakeItem + WorkIntakeFinding + WorkIntakeOrigin rows the
// materialisers already wrote — never re-analyses at page load.
//
// Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
// One-card-per-conversation rule: when an AP or Statement intake was
// materialised from an email-attachment doc AND that email has its
// own PRIMARY email intake, the AP/Statement intake is a child of the
// email intake and is suppressed from the feed. The child intake is
// preserved in the DB — the email card renders its analysis in a tab.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import type { WorkItem, WorkItemEvidenceCell } from "./index";
import { analyseIngestedInvoice } from "@/lib/ap-intelligence/analyse";
import type { ApAnalyseResult } from "@/lib/ap-intelligence/analyse";
import type { ExtractedInvoice } from "@/lib/ap-intelligence/types";
import { EXTRACTOR_VERSION as VENDOR_PROFILE_EXTRACTOR_VERSION } from "@/lib/ap-intelligence/vendor-profile-extract";
import { EXTRACTION_RULE_VERSION } from "@/lib/ap-intelligence/types";
import type { ExtractedVendorProfile } from "@/lib/ap-intelligence/vendor-profile-extract";

// Sprint 3 Checkpoint 15I-2 (2026-07-27) — process-local TTL cache
// for the AP-card intelligence projection.
//
// WHY: `summariseApIntake` runs `analyseIngestedInvoice` which
// fetches the invoice PDF from object storage + runs `pdf-parse`
// + queries vendors + reconciles + recommends a GL account. On a
// Mission Control render with N AP cards, that's N × object-store
// round-trip + N × CPU-bound PDF parse. Unbounded, that adds
// multiple seconds per page load and hammers R2 unnecessarily.
//
// This cache is intentionally minimal:
//   • per Fly VM (not shared across replicas) — deploys and machine
//     restarts start with a cold cache, which is acceptable;
//   • fixed 90-second TTL — long enough that page-refresh burst
//     traffic hits the cache, short enough that a re-analysis
//     triggered elsewhere is picked up within a minute;
//   • cache key includes the primary IngestedDocument.id — a new
//     document (re-materialised child intake) invalidates naturally.
//
// Sprint 3 · Checkpoint 15L (2026-07-27) — the cache key ALSO
// includes a COA revision fingerprint per club so a COA commit
// (or any Account row edit / archive / category change) invalidates
// every AP projection that referenced the pre-commit chart. Without
// this, the founder-observed bug was: after committing 237 accounts
// on staging, every AP card still rendered its pre-commit
// "CHART_OF_ACCOUNTS_REQUIRED" projection until the Fly VM restarted.
// The revision is a cheap `(count, max(updatedAt))` fingerprint —
// a 6-hour query cache would still miss real edits.
//
// FOLLOW-UP (out of scope for this deploy): persist the extraction
// on materialisation into a `WorkIntakeItemFactsCache` row (JSON) so
// the summariser is O(1) DB read with no re-parse ever. That is a
// small schema change and belongs to a separate checkpoint.
const AP_SUMMARY_TTL_MS = 90_000;
const apSummaryCache = new Map<
  string,
  { at: number; value: LinkedIntelligenceForEmail["invoiceSummary"] }
>();
// Sprint 3 · Checkpoint 15P-5 — the cache key now fingerprints
// canonical state on THREE axes:
//
//   coa=<coaRevision>       Chart of Accounts (any Account row change)
//   vpx=<extractor version> Vendor-profile extractor code version
//   vend=<vendorRevision>   Vendor + VendorContact table state
//   apinv=<apInvRevision>   APInvoice table state (post/void)
//
// The vendor + AP-invoice fingerprints eliminate the founder-observed
// 15P-4 defects where the projection stayed warm across vendor
// create / delete / post operations. NO writer needs an explicit
// `apSummaryCache.delete(...)` call — bumping the underlying table's
// max(updatedAt) is sufficient. Same self-invalidation shape as the
// existing coaRevision.
function apSummaryCacheKey(
  intakeId: string,
  docId: string | null,
  coaRevision: string,
  vendorRevision: string,
  apInvRevision: string,
): string {
  // Sprint 3 · Checkpoint 15Q (revised, 2026-07-28) — the ap-intelligence
  // rule version is now part of the cache key. Bumping EXTRACTION_RULE_
  // VERSION on any analyser change auto-invalidates every warm entry
  // on the next request — no process-restart or manual cache purge
  // needed. Pre-15Q-revised the key only fingerprinted VENDOR_PROFILE_
  // EXTRACTOR_VERSION, so changes to parse-invoice / supplier-extract /
  // gl-recommend / line-items-extract / tax-reconcile / economic-purpose
  // did NOT invalidate the cache, contributing to founder-observed
  // stale card output within the 90s TTL after a deploy.
  return `${intakeId}::${docId ?? "no-doc"}::coa=${coaRevision}::vpx=${VENDOR_PROFILE_EXTRACTOR_VERSION}::apix=${EXTRACTION_RULE_VERSION}::vend=${vendorRevision}::apinv=${apInvRevision}`;
}

// Sprint 3 · Checkpoint 15L — cheap per-club COA revision fingerprint.
// Cached process-locally at a short (30s) TTL so a burst of AP-card
// projections during one Mission Control render shares one DB probe
// but never staler than 30s. Any Account row change — commit, edit,
// archive, category swap, FS-group swap — bumps `max(updatedAt)` and
// invalidates every downstream `apSummaryCache` entry that referenced
// the old fingerprint.
const COA_REVISION_TTL_MS = 30_000;
const coaRevisionCache = new Map<string, { at: number; fingerprint: string }>();
async function loadCoaRevision(clubId: string): Promise<string> {
  const now = Date.now();
  const cached = coaRevisionCache.get(clubId);
  if (cached && now - cached.at < COA_REVISION_TTL_MS) return cached.fingerprint;
  const [count, latest] = await Promise.all([
    prisma.account.count({ where: { clubId } }),
    prisma.account.findFirst({
      where: { clubId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  const fingerprint = `${count}@${latest?.updatedAt.getTime() ?? 0}`;
  coaRevisionCache.set(clubId, { at: now, fingerprint });
  return fingerprint;
}

// Sprint 3 · Checkpoint 15P-5 — vendor-table revision fingerprint.
// Same shape as loadCoaRevision. Any vendor create / update /
// delete for the club bumps `max(updatedAt)`. Same 30-second TTL —
// worst-case a Mission Control render made within 30s of a vendor
// mutation sees the pre-mutation projection; every render after
// that reflects the change. In practice `router.refresh()` from
// the modal fires after createVendor / deleteVendor / postApInvoice,
// but the modal fires those AFTER the vendor row updatedAt bumps —
// so even the immediate refresh gets a fresh fingerprint.
//
// Includes VendorContact because that's how AR / remittance emails
// get bound and the AP card projection reads them via VendorContact
// rows.
const VENDOR_REVISION_TTL_MS = 30_000;
const vendorRevisionCache = new Map<string, { at: number; fingerprint: string }>();
async function loadVendorRevision(clubId: string): Promise<string> {
  const now = Date.now();
  const cached = vendorRevisionCache.get(clubId);
  if (cached && now - cached.at < VENDOR_REVISION_TTL_MS) return cached.fingerprint;
  const [vCount, vLatest, cCount, cLatest] = await Promise.all([
    prisma.vendor.count({ where: { clubId } }),
    prisma.vendor.findFirst({ where: { clubId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.vendorContact.count({ where: { clubId } }),
    prisma.vendorContact.findFirst({ where: { clubId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const fingerprint = `v${vCount}@${vLatest?.updatedAt.getTime() ?? 0};c${cCount}@${cLatest?.createdAt.getTime() ?? 0}`;
  vendorRevisionCache.set(clubId, { at: now, fingerprint });
  return fingerprint;
}

// Sprint 3 · Checkpoint 15P-5 — AP-invoice revision fingerprint.
// A post OR void OR reversal bumps `max(updatedAt)` on the table.
// The projection includes reconcile state which reads APInvoice rows,
// so a fresh invoice for the same vendor / hash SHOULD invalidate
// any dependent cached card.
const AP_INV_REVISION_TTL_MS = 30_000;
const apInvRevisionCache = new Map<string, { at: number; fingerprint: string }>();
async function loadApInvRevision(clubId: string): Promise<string> {
  const now = Date.now();
  const cached = apInvRevisionCache.get(clubId);
  if (cached && now - cached.at < AP_INV_REVISION_TTL_MS) return cached.fingerprint;
  const [count, latest] = await Promise.all([
    prisma.aPInvoice.count({ where: { clubId } }),
    prisma.aPInvoice.findFirst({ where: { clubId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
  ]);
  const fingerprint = `${count}@${latest?.updatedAt.getTime() ?? 0}`;
  apInvRevisionCache.set(clubId, { at: now, fingerprint });
  return fingerprint;
}

interface LoaderArgs {
  clubId: string;
  now: Date;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Suppression helper — returns the set of (AP + Statement) intake IDs that
// are children of an email intake and therefore should NOT appear as their
// own feed cards. Callers use this to filter their result sets.
// ---------------------------------------------------------------------------
export async function loadChildReviewIntakesToSuppress(clubId: string): Promise<{
  suppressedApIntakeIds: Set<string>;
  suppressedStatementIntakeIds: Set<string>;
}> {
  // Sprint 3 · Checkpoint 15S (2026-07-29) — the primary source is
  // now the ApIntakeSource table. An AP intake is suppressed IFF
  // any ApIntakeSource row references it — that row's EmailMessage
  // deterministically resolves to the founder-visible email intake.
  //
  // Bounded legacy fallback: for AP intakes with NO ApIntakeSource
  // rows (pre-15S materialisations), fall back to the original walk
  // (AP → INGESTED_DOCUMENT → EmailAttachment → EmailMessage →
  // EmailWorkIntakeOrigin). Legacy is retained so historic intakes
  // continue to project correctly; new materialisations always take
  // the explicit path.

  const reviews = await prisma.workIntakeItem.findMany({
    where: {
      clubId,
      classification: { in: ["AP_INVOICE_REVIEW", "VENDOR_STATEMENT_REVIEW"] },
    },
    select: {
      id: true,
      classification: true,
      origins: {
        where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" },
        select: { referenceId: true },
      },
    },
  });
  if (reviews.length === 0) {
    return { suppressedApIntakeIds: new Set(), suppressedStatementIntakeIds: new Set() };
  }

  // Explicit path — ApIntakeSource rows. One query per club.
  const apIntakeIds = reviews
    .filter((r) => r.classification === "AP_INVOICE_REVIEW")
    .map((r) => r.id);
  const explicitLinks = apIntakeIds.length > 0
    ? await prisma.apIntakeSource.findMany({
        where: { clubId, canonicalApIntakeId: { in: apIntakeIds } },
        select: { canonicalApIntakeId: true },
      })
    : [];
  const explicitlyLinkedApIntakes = new Set(explicitLinks.map((l) => l.canonicalApIntakeId));

  // Legacy fallback — AP intakes that have no ApIntakeSource but
  // whose old walk resolves to an email intake. Bounded to the
  // reviews with no explicit link.
  const legacyReviews = reviews.filter((r) =>
    r.classification !== "AP_INVOICE_REVIEW" || !explicitlyLinkedApIntakes.has(r.id),
  );
  const legacyDocIds = legacyReviews.flatMap((r) => r.origins.map((o) => o.referenceId));
  const legacyDocToParent = new Map<string, string>();
  if (legacyDocIds.length > 0) {
    const docs = await prisma.ingestedDocument.findMany({
      where: { clubId, id: { in: legacyDocIds }, sourceKind: "EMAIL_ATTACHMENT" },
      select: { id: true, sourceReferenceId: true },
    });
    const attachmentIds = docs.map((d) => d.sourceReferenceId).filter(Boolean);
    if (attachmentIds.length > 0) {
      const attachments = await prisma.emailAttachment.findMany({
        where: { id: { in: attachmentIds }, emailMessage: { clubId } },
        select: {
          id: true,
          emailMessage: {
            select: {
              id: true, clubId: true,
              workIntakeOrigins: {
                where: { role: "PRIMARY" },
                select: { workIntakeItemId: true },
                take: 1,
              },
            },
          },
        },
      });
      const attToParent = new Map<string, string>();
      for (const a of attachments) {
        if (!a.emailMessage || a.emailMessage.clubId !== clubId) continue;
        const parent = a.emailMessage.workIntakeOrigins[0]?.workIntakeItemId;
        if (parent) attToParent.set(a.id, parent);
      }
      for (const d of docs) {
        const parent = attToParent.get(d.sourceReferenceId);
        if (parent) legacyDocToParent.set(d.id, parent);
      }
    }
  }

  const suppressedApIntakeIds = new Set<string>();
  const suppressedStatementIntakeIds = new Set<string>();
  for (const r of reviews) {
    if (r.classification === "AP_INVOICE_REVIEW") {
      // Prefer explicit link. Fall back to legacy walk.
      if (explicitlyLinkedApIntakes.has(r.id)) {
        suppressedApIntakeIds.add(r.id);
        continue;
      }
      const primaryDocId = r.origins[0]?.referenceId;
      if (primaryDocId && legacyDocToParent.has(primaryDocId)) {
        suppressedApIntakeIds.add(r.id);
      }
    } else {
      const primaryDocId = r.origins[0]?.referenceId;
      if (primaryDocId && legacyDocToParent.has(primaryDocId)) {
        suppressedStatementIntakeIds.add(r.id);
      }
    }
  }
  return { suppressedApIntakeIds, suppressedStatementIntakeIds };
}

// ---------------------------------------------------------------------------
// Linked-intelligence resolver — returns the AP/Statement child intakes
// for a specific email intake, so the email card can render their
// analysis as tab facets. Called by the email loader on card render.
// ---------------------------------------------------------------------------
export interface LinkedIntelligenceForEmail {
  apReviewIntakeIds: string[];
  statementReviewIntakeIds: string[];
  attachmentCount: number;
  invoiceAttachmentCount: number;
  statementAttachmentCount: number;
  dominantFacet: "email" | "invoice" | "statement" | "invoice+statement";
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — typed AP-card
  // intelligence projection. The Variant D AP invoice card
  // renders EVERY collapsed field from this shape; the card
  // does not re-parse the PDF or re-query the extraction on
  // its own. Absence of `invoiceSummary` → card falls back to
  // the email-only projection.
  invoiceSummary?: ApInvoiceCardIntelligence;
  statementSummary?: {
    vendorGuess: string | null;
    closingBalance: string | null;
    currency: string | null;
    reconciliationState: string | null;
    unresolvedFindingCount: number;
  };
}

// Sprint 3 Checkpoint 15I-2 — the operational-intelligence
// projection the Variant D AP invoice card consumes. Every field
// is nullable — a missing field means "not confidently derived",
// NEVER "guessed". Card renders each region conditionally.
export interface ApInvoiceCardIntelligence {
  // Sender identity is provenance-only. It NEVER labels the vendor.
  sender: {
    name: string | null;
    email: string | null;
    // VENDOR: the message came from the vendor's own domain.
    // EMPLOYEE_FORWARD: the sender is a club user forwarding a
    //   vendor invoice (e.g. a staff member forwarding a bill).
    // OTHER: unclassifiable — treat as provenance only.
    relationship: "VENDOR" | "EMPLOYEE_FORWARD" | "OTHER";
  };
  // PDF-extracted vendor identity. Distinct from the Spectre
  // vendor-record match state.
  extractedVendor: {
    name: string | null;
  };
  // Whether the extracted vendor was resolved to a Spectre vendor
  // record. If MATCHED, `matchedName` carries the record's
  // operating/legal name.
  vendorMatch: {
    state: "MATCHED" | "AMBIGUOUS" | "NOT_FOUND" | "INSUFFICIENT_SIGNAL";
    matchedName: string | null;
    // Sprint 3 · Checkpoint 15M — the underlying vendor row id when
    // state === "MATCHED", so the AP card's vendor-name link can
    // route straight to that vendor's permanent timeline. null in
    // every other state (the card falls back to a provisional
    // timeline keyed to the extracted name + work-intake id).
    matchedVendorId: string | null;
  };
  invoiceNumber: string | null;
  gross: {
    amount: string | null;    // Decimal-safe string
    currency: string | null;  // ISO code
  };
  paymentTerms: string | null;
  // Sprint 3 · Checkpoint 15L — payment-terms provenance. Distinguishes
  // terms EXTRACTED from the invoice PDF from terms INHERITED from a
  // matched vendor profile (or a prior invoice on the same vendor).
  // Null when both are absent — the card omits the segment rather than
  // asserting "net-30" as a default. Values kept small so the payload
  // stays JSON-friendly.
  paymentTermsSource: "EXTRACTED" | "VENDOR_PROFILE" | "PRIOR_INVOICE" | null;
  purchaseOrder: {
    poNumber: string | null;
    matchedPoDocumentId: string | null;
    // Sprint 3 · Checkpoint 15L — signed decimal-string variance
    // (invoice.total − po.total). Null when no PO matched. Rendered
    // via `+/- CAD X.XX` in the summary.
    variance: string | null;
  };
  category: {
    label: string | null;                     // Human-facing e.g. "Kitchen supplies"
    glAccountNumber: string | null;
    glAccountName: string | null;
    capitalState: "OPERATING" | "CAPITAL" | "AMBIGUOUS" | "INSUFFICIENT_EVIDENCE" | null;
    // Sprint 3 · Checkpoint 15L — the source of the top recommendation.
    // Used by the UI to render the rationale strip (e.g. "matched via
    // vendor default", "matched by keyword"). Null when no
    // recommendation exists (empty COA or no supported match found).
    source: "VENDOR_DEFAULT" | "PRIOR_CODING" | "NAME_KEYWORD" | "CAPITAL_CLASS_MAP" | "NONE" | null;
    // Sprint 3 · Checkpoint 15L — alternate candidates for the modal /
    // rationale panel. Ranked, best-first. Capped at 5 to keep the
    // JSON payload small; the full list can be re-queried via the
    // rationale endpoint if the founder ever needs a deeper picker.
    alternates: Array<{
      accountNumber: string;
      accountName: string;
      confidence: number;
    }>;
  };
  // Sprint 3 · Checkpoint 15L — GST verification result. Distinguishes:
  //   VERIFIED             — the arithmetic (subtotal × rate ≈ tax) matches;
  //                          the rate can be stated confidently on the card
  //                          (via `gstRatePercent`).
  //   EXTRACTED_UNVERIFIED — tax figure was extracted but the rate could
  //                          not be reconciled (missing subtotal, currency
  //                          jurisdiction mismatch, rounding beyond tolerance).
  //   NOT_PRESENT          — no tax line found on the PDF.
  //   INSUFFICIENT_DATA    — we can't judge either way — extraction was
  //                          incomplete; card omits the GST segment.
  gstVerification: "VERIFIED" | "EXTRACTED_UNVERIFIED" | "NOT_PRESENT" | "INSUFFICIENT_DATA" | null;
  // Percentage rate as a plain number (e.g. 5 for 5%). Only set when
  // gstVerification === "VERIFIED".
  gstRatePercent: number | null;
  // Sprint 3 · Checkpoint 15M — per-club "show currency code beside
  // monetary amounts" preference. When true → `$31.29 CAD`; when
  // false → `$31.29`. Applies to operational surfaces only; the
  // monthly reporting package has its own money helpers. Default
  // true for Coulee Ridge; the club can flip it via Settings.
  currencyShowCode?: boolean;
  // Sprint 3 · Checkpoint 15P — second-pass vendor-profile extraction.
  // Populated per-field with (value, confidence, source) so the
  // Create Vendor modal Step 1 can pre-fill every field the invoice
  // supports AND render provenance chips beside each populated field.
  // Absent (null) only when the analyser could not read the PDF at
  // all; individual fields inside are null when below the extraction
  // confidence threshold.
  extractedVendorProfile: ExtractedVendorProfile | null;
  // Rolling count of accepted invoices from the matched vendor
  // in the current calendar quarter (inclusive of this one).
  // Null when no vendor match exists — cannot count without a
  // vendor id.
  invoiceCadenceThisQuarter: number | null;
  // Confidence blended from extraction state + vendor match
  // certainty + reconcile state, expressed as a 0-100 integer.
  confidence: number | null;
  // Precomputed workflow state — drives the pill, primary action,
  // and recommendation branch on the card. See deriveWorkflowState.
  //
  // Sprint 3 Checkpoint 15I-3 (2026-07-27) — CHART_OF_ACCOUNTS_REQUIRED
  // is a runtime-only override applied when the tenant has zero
  // Account rows. The AP card must NOT invent a GL account when the
  // chart is empty. Truthful language: "GL coding unavailable — no
  // chart of accounts is loaded". No persisted enum change; this is
  // a rendering blocker computed per snapshot.
  workflowState:
    | "READY_FOR_APPROVAL"
    | "VENDOR_MATCH_REQUIRED"
    | "MISSING_INFORMATION"
    | "NEEDS_JUDGMENT"
    | "POSSIBLE_DUPLICATE"
    | "CHART_OF_ACCOUNTS_REQUIRED";
  // Compact human-facing reason for the current workflowState —
  // used verbatim in the recommendation strip.
  workflowReason: string;
  // Count of unresolved MEDIUM+ analyser findings.
  unresolvedFindingCount: number;
  // The primary invoice attachment — used by the collapsed card's
  // "Invoice · PDF" footer aux link. Null when the child intake
  // has no ingested PDF (shouldn't happen in practice).
  primaryAttachment: {
    documentId: string;
    filename: string;
  } | null;
}
export async function loadLinkedIntelligenceForEmailIntakes(args: {
  clubId: string;
  emailIntakeIds: string[];
}): Promise<Map<string, LinkedIntelligenceForEmail>> {
  const map = new Map<string, LinkedIntelligenceForEmail>();
  if (args.emailIntakeIds.length === 0) return map;
  // Load the emails owned by these intakes + their attachments + the
  // AP / Statement intakes materialised from those attachments' docs.
  const origins = await prisma.emailWorkIntakeOrigin.findMany({
    where: { role: "PRIMARY", clubId: args.clubId, workIntakeItemId: { in: args.emailIntakeIds } },
    select: {
      workIntakeItemId: true,
      emailMessage: {
        select: {
          id: true,
          attachments: {
            select: {
              id: true, filename: true, contentType: true, storageState: true,
              isInline: true,
            },
          },
        },
      },
    },
  });
  const attachmentIdsToEmailIntake = new Map<string, string>();
  const emailIntakeToAttachments = new Map<string, Array<{ id: string; filename: string; contentType: string; storageState: string; isInline: boolean }>>();
  for (const o of origins) {
    if (!o.emailMessage) continue;
    for (const a of o.emailMessage.attachments) {
      attachmentIdsToEmailIntake.set(a.id, o.workIntakeItemId);
      const arr = emailIntakeToAttachments.get(o.workIntakeItemId) ?? [];
      arr.push(a);
      emailIntakeToAttachments.set(o.workIntakeItemId, arr);
    }
  }
  const attachmentIds = [...attachmentIdsToEmailIntake.keys()];
  if (attachmentIds.length === 0) {
    for (const id of args.emailIntakeIds) {
      map.set(id, { apReviewIntakeIds: [], statementReviewIntakeIds: [], attachmentCount: 0, invoiceAttachmentCount: 0, statementAttachmentCount: 0, dominantFacet: "email" });
    }
    return map;
  }
  // Sprint 3 · Checkpoint 15S (2026-07-29) — attachment → doc
  // resolution. The legacy walk used
  // IngestedDocument.sourceReferenceId, which is set ONCE at
  // initial ingestion (SHA dedup). When a fresh email attachment
  // shares a SHA with an existing document, the reused doc's
  // sourceReferenceId still names the ORIGINAL attachment — the
  // legacy walk from the NEW attachment to the reused doc thus
  // returned empty, which is exactly why Pt2 email intake fell
  // back to the sender-name label.
  //
  // The explicit path uses the new ApIntakeSource table: per-
  // attachment, always current, deterministic.
  const explicitSources = await prisma.apIntakeSource.findMany({
    where: { clubId: args.clubId, emailAttachmentId: { in: attachmentIds } },
    select: {
      emailAttachmentId: true, ingestedDocumentId: true, canonicalApIntakeId: true,
      canonicalApIntake: { select: { classification: true } },
    },
  });
  const docsByAttachment = new Map<string, { id: string; classification: string }>();
  const canonicalApByAttachment = new Map<string, string>();
  for (const s of explicitSources) {
    docsByAttachment.set(s.emailAttachmentId, {
      id: s.ingestedDocumentId,
      classification: s.canonicalApIntake.classification === "AP_INVOICE_REVIEW" ? "INVOICE" : "UNKNOWN",
    });
    canonicalApByAttachment.set(s.emailAttachmentId, s.canonicalApIntakeId);
  }

  // Legacy fallback — pre-15S rows without ApIntakeSource. Bounded
  // to attachments the explicit path didn't cover.
  const legacyAttachmentIds = attachmentIds.filter((id) => !docsByAttachment.has(id));
  if (legacyAttachmentIds.length > 0) {
    const legacyDocs = await prisma.ingestedDocument.findMany({
      where: { clubId: args.clubId, sourceKind: "EMAIL_ATTACHMENT", sourceReferenceId: { in: legacyAttachmentIds } },
      select: { id: true, sourceReferenceId: true, classification: true },
    });
    for (const d of legacyDocs) {
      docsByAttachment.set(d.sourceReferenceId, { id: d.id, classification: d.classification });
    }
  }

  const allDocIds = Array.from(new Set(Array.from(docsByAttachment.values()).map((d) => d.id)));
  const allExplicitApIntakeIds = Array.from(new Set(Array.from(canonicalApByAttachment.values())));
  const reviewIntakes = allDocIds.length > 0 || allExplicitApIntakeIds.length > 0
    ? await prisma.workIntakeItem.findMany({
        where: {
          clubId: args.clubId,
          classification: { in: ["AP_INVOICE_REVIEW", "VENDOR_STATEMENT_REVIEW"] },
          OR: [
            { id: { in: allExplicitApIntakeIds } },
            { origins: { some: { kind: "INGESTED_DOCUMENT", role: "PRIMARY", referenceId: { in: allDocIds } } } },
          ],
        },
        select: {
          id: true, classification: true,
          origins: { where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" }, select: { referenceId: true } },
          findings: { where: { state: { in: ["CONFIRMED", "OBSERVED"] } }, select: { key: true, severity: true } },
        },
      })
    : [];

  // Sprint 3 Checkpoint 15I-2 — parallelise the per-email projection
  // fan-out. Each iteration runs the AP + Statement summarisers, each
  // of which is itself cached process-locally to bound the PDF
  // re-parse cost on repeat loads.
  const projectionStart = Date.now();
  await Promise.all(args.emailIntakeIds.map(async (emailIntakeId) => {
    const atts = emailIntakeToAttachments.get(emailIntakeId) ?? [];
    // Skip inline images (isInline=true is a signature/logo attachment).
    const realAtts = atts.filter((a) => !a.isInline);
    const attDocs = realAtts.map((a) => docsByAttachment.get(a.id)).filter(Boolean) as Array<{ id: string; classification: string }>;
    const invoiceAttCount = attDocs.filter((d) => d.classification === "INVOICE").length;
    const statementAttCount = attDocs.filter((d) => d.classification === "STATEMENT").length;
    const attDocIds = new Set(attDocs.map((d) => d.id));
    // Sprint 3 · Checkpoint 15S (2026-07-29) — collect canonical AP
    // intake ids from BOTH the explicit ApIntakeSource path AND the
    // legacy INGESTED_DOCUMENT origin walk. The explicit path is
    // authoritative for post-15S materialisations; the legacy path
    // covers older records.
    const explicitApIds = realAtts
      .map((a) => canonicalApByAttachment.get(a.id))
      .filter((v): v is string => v != null);
    const legacyApIds = reviewIntakes
      .filter((r) => r.classification === "AP_INVOICE_REVIEW"
        && r.origins.some((o) => attDocIds.has(o.referenceId)))
      .map((r) => r.id);
    const apIds = Array.from(new Set([...explicitApIds, ...legacyApIds]));
    const ownedReviews = reviewIntakes.filter((r) => r.origins.some((o) => attDocIds.has(o.referenceId)));
    const stIds = ownedReviews.filter((r) => r.classification === "VENDOR_STATEMENT_REVIEW").map((r) => r.id);

    // Sprint 3 Checkpoint 15I-2 — projections run in parallel per
    // email intake. Each `summariseApIntake` is cached process-locally
    // to bound the PDF re-parse cost on repeat loads.
    const [invoiceSummary, statementSummary] = await Promise.all([
      apIds.length > 0 ? summariseApIntake(args.clubId, apIds[0]) : Promise.resolve(undefined),
      stIds.length > 0 ? summariseStatementIntake(args.clubId, stIds[0]) : Promise.resolve(undefined),
    ]);

    const dominantFacet: LinkedIntelligenceForEmail["dominantFacet"] =
      invoiceAttCount > 0 && statementAttCount > 0 ? "invoice+statement"
      : invoiceAttCount > 0 ? "invoice"
      : statementAttCount > 0 ? "statement"
      : "email";

    map.set(emailIntakeId, {
      apReviewIntakeIds: apIds,
      statementReviewIntakeIds: stIds,
      attachmentCount: realAtts.length,
      invoiceAttachmentCount: invoiceAttCount,
      statementAttachmentCount: statementAttCount,
      dominantFacet,
      invoiceSummary,
      statementSummary,
    });
  }));
  logger.info("mission-control.linked-intelligence.projected", {
    clubId: args.clubId,
    emailIntakeCount: args.emailIntakeIds.length,
    apSummaryCacheSize: apSummaryCache.size,
    elapsedMs: Date.now() - projectionStart,
  });
  return map;
}

async function summariseApIntake(clubId: string, intakeId: string): Promise<LinkedIntelligenceForEmail["invoiceSummary"]> {
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — real AP-card
  // intelligence projection with a process-local TTL cache.
  //
  // The previous implementation returned null for every extracted
  // field, so the Variant D card had nothing PDF-derived to render.
  // This projection now:
  //   1. Loads the child intake's primary IngestedDocument.
  //   2. Runs analyseIngestedInvoice() — deterministic, no LLM/OCR.
  //   3. Loads the source EmailMessage (via the parent's
  //      EmailWorkIntakeOrigin) so the sender line can distinguish
  //      forwarding employees from the vendor itself.
  //   4. Counts prior invoices from the matched vendor this quarter
  //      to derive the cadence line ("3rd invoice this quarter").
  //   5. Derives the AP workflow state (READY_FOR_APPROVAL,
  //      VENDOR_MATCH_REQUIRED, MISSING_INFORMATION, NEEDS_JUDGMENT,
  //      POSSIBLE_DUPLICATE) from vendor + reconcile + extraction
  //      states — this drives the card's status pill + primary
  //      action + recommendation wording.
  //
  // Cost + bound: one PDF re-parse per (intakeId, docId) per 90s
  // per Fly VM. Repeated Mission Control page loads within that
  // window hit the cache. Cold on deploy and every 90s thereafter.
  // Steady-state: 0 re-parses. See apSummaryCache above.

  // Fast path — return the cached projection if still fresh.
  // Key includes the doc id below; we defer key resolution until after
  // we have the intake's origin.
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: intakeId, clubId },
    select: {
      findings: { where: { state: { in: ["CONFIRMED", "OBSERVED"] } }, select: { key: true, severity: true, statement: true } },
      origins: {
        where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" },
        select: { referenceId: true },
        take: 1,
      },
    },
  });
  if (!intake) return undefined;

  const docRef = intake.origins[0]?.referenceId ?? null;

  // Sprint 3 · Checkpoint 15P-5 — pull ALL revision fingerprints
  // BEFORE hitting the projection cache so any canonical change
  // since the last projection naturally invalidates the cached
  // entry. In particular vendor create / delete / update / post
  // MUST invalidate the AP card (founder-observed 15P-4 defects).
  const [coaRevision, vendorRevision, apInvRevision] = await Promise.all([
    loadCoaRevision(clubId),
    loadVendorRevision(clubId),
    loadApInvRevision(clubId),
  ]);

  const cacheKey = apSummaryCacheKey(intakeId, docRef, coaRevision, vendorRevision, apInvRevision);
  const cached = apSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AP_SUMMARY_TTL_MS) {
    return cached.value;
  }

  // Analyser — deterministic PDF parse. Wrapped in try/catch so a
  // parse failure never breaks the whole feed load.
  let analysis: ApAnalyseResult | null = null;
  if (docRef) {
    try {
      analysis = await analyseIngestedInvoice({ clubId, ingestedDocumentId: docRef });
    } catch (e) {
      logger.warn("mission-control.ap-card-summary.analyse_failed", {
        clubId, intakeId, docRef, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const extraction: ExtractedInvoice | null = analysis?.extraction ?? null;

  // Document metadata (filename for the aux link) + sourceReferenceId
  // (the EmailAttachment.id — IngestedDocument.sourceReferenceId is a
  // plain string, not a Prisma relation, so we walk it manually).
  const doc = docRef
    ? await prisma.ingestedDocument.findFirst({
        where: { id: docRef, clubId },
        select: { id: true, filename: true, sourceKind: true, sourceReferenceId: true },
      })
    : null;

  // Source email — for sender name + email + forwarding-employee
  // detection. Walk: WorkIntakeItem → IngestedDocument →
  // EmailAttachment (via sourceReferenceId) → EmailMessage.
  let sourceEmail: { senderName: string; senderAddress: string; internetMessageId: string | null } | null = null;
  if (doc?.sourceKind === "EMAIL_ATTACHMENT" && doc.sourceReferenceId) {
    const attachment = await prisma.emailAttachment.findFirst({
      where: { id: doc.sourceReferenceId, emailMessage: { clubId } },
      select: {
        emailMessage: {
          select: { senderName: true, senderAddress: true, internetMessageId: true, clubId: true },
        },
      },
    });
    if (attachment?.emailMessage && attachment.emailMessage.clubId === clubId) {
      sourceEmail = {
        senderName: attachment.emailMessage.senderName,
        senderAddress: attachment.emailMessage.senderAddress,
        internetMessageId: attachment.emailMessage.internetMessageId,
      };
    }
  }

  // Sender relationship — is the email from the vendor's own domain,
  // or from a Spectre club user (employee forward), or unknown?
  const senderRelationship = await classifySenderRelationship({
    clubId,
    senderAddress: sourceEmail?.senderAddress ?? null,
    extractedVendorDomain: extraction?.vendor.guessedDomain ?? null,
    matchedVendorId: analysis?.vendor.state === "MATCHED" ? (analysis.vendor.candidates[0]?.id ?? null) : null,
  });

  // Invoice cadence — prior invoices for THIS vendor this quarter.
  // 15L: also counts prior APInvoice rows for the same normalised
  // vendor NAME even when no vendor record exists yet, so a founder
  // uploading a fresh Microsoft invoice sees cadence even before
  // Microsoft is a vendor.
  const matchedVendorId = analysis?.vendor.state === "MATCHED" ? (analysis.vendor.candidates[0]?.id ?? null) : null;
  const invoiceCadenceThisQuarter = matchedVendorId
    ? await countInvoicesThisQuarter(clubId, matchedVendorId)
    : await countInvoicesThisQuarterByName(clubId, extraction?.vendor.guessedName ?? null);

  const capitalState = analysis?.capital.state ?? null;
  const gl = analysis?.gl ?? null;
  const categoryLabel = gl?.accountName
    ?? (analysis?.capital.capitalClass ? humanCapitalClass(analysis.capital.capitalClass) : null);

  // Sprint 3 Checkpoint 15I-3 (2026-07-27) — no-COA truthful state.
  // If the tenant has zero Account rows, the GL recommender cannot
  // produce a coding recommendation. The AP card must NOT invent a
  // GL category. Override the workflow state to a runtime
  // CHART_OF_ACCOUNTS_REQUIRED signal and clear the category label.
  const accountCount = await prisma.account.count({ where: { clubId } });
  const noCoa = accountCount === 0;

  const confidence = deriveApCardConfidence(analysis);
  const workflowState = noCoa
    ? "CHART_OF_ACCOUNTS_REQUIRED" as const
    : deriveApWorkflowState(analysis);
  const workflowReason = noCoa
    ? "GL coding unavailable — no chart of accounts is loaded for this club. Import the club's chart of accounts before approving any AP posting."
    : deriveApWorkflowReason(workflowState, analysis);

  const unresolvedFindingCount = intake.findings.filter((f) =>
    f.severity === "HIGH" || f.severity === "CRITICAL" || f.severity === "MEDIUM",
  ).length;

  // Sprint 3 · Checkpoint 15L — GST verification. The analyser's
  // extraction has `subtotal` + `taxTotal` — reconcile the arithmetic
  // to decide whether the card can honestly state a verified rate.
  const gstResult = classifyGstVerification(extraction);

  // Sprint 3 · Checkpoint 15L — payment-terms provenance. Extracted
  // wins; matched-vendor profile falls back if we have one; otherwise
  // null.
  const paymentTermsResult = await resolvePaymentTerms({
    clubId,
    extractedTerms: extraction?.paymentTerms ?? null,
    matchedVendorId,
  });

  const value: LinkedIntelligenceForEmail["invoiceSummary"] = {
    sender: {
      name: sourceEmail?.senderName ?? null,
      email: sourceEmail?.senderAddress ?? null,
      relationship: senderRelationship,
    },
    extractedVendor: {
      name: extraction?.vendor.guessedName ?? null,
    },
    vendorMatch: {
      state: analysis?.vendor.state ?? "INSUFFICIENT_SIGNAL",
      matchedName: matchedVendorId
        ? (analysis?.vendor.candidates[0]?.operatingName
          ?? analysis?.vendor.candidates[0]?.legalName
          ?? null)
        : null,
      matchedVendorId,
    },
    invoiceNumber: extraction?.invoiceNumber ?? null,
    // Sprint 3 · Checkpoint 15T — gross amount follows the amount
    // hierarchy: printed total > reconciled > subtotal+tax-credits >
    // line-item sum > null. The printed total is preserved verbatim
    // even when tax allocation is unresolved (founder rule §6).
    gross: {
      amount:
        extraction?.total
        ?? (analysis?.amountHierarchy?.value != null
          ? analysis.amountHierarchy.value.toFixed(2)
          : null),
      currency: extraction?.currency ?? null,
    },
    paymentTerms: paymentTermsResult.terms,
    paymentTermsSource: paymentTermsResult.source,
    purchaseOrder: {
      poNumber: extraction?.purchaseOrder ?? null,
      matchedPoDocumentId: null,   // Future: reconcile.matchedPoId
      variance: null,              // Future: computed once PO reconciliation lands.
    },
    category: {
      // Blank the category label when the tenant has no chart of
      // accounts — we cannot honestly recommend a category. The
      // recommendation strip carries the truthful no-COA message.
      label: noCoa ? null : categoryLabel,
      glAccountNumber: noCoa ? null : (gl?.accountNumber ?? null),
      glAccountName: noCoa ? null : (gl?.accountName ?? null),
      capitalState,
      source: noCoa ? null : ((gl?.source ?? "NONE") as ApInvoiceCardIntelligence["category"]["source"]),
      alternates: noCoa || !gl?.candidates ? [] : gl.candidates.slice(1, 5).map((c) => ({
        accountNumber: c.accountNumber,
        accountName: c.accountName,
        confidence: c.confidence,
      })),
    },
    gstVerification: gstResult.state,
    gstRatePercent: gstResult.ratePercent,
    // Sprint 3 · Checkpoint 15M — Club currency-suffix preference.
    // Read once per projection from the tenant's ClubSetting record.
    currencyShowCode: await loadCurrencyShowCode(clubId),
    // Sprint 3 · Checkpoint 15P — vendor-profile extraction result.
    extractedVendorProfile: analysis?.vendorProfile ?? null,
    invoiceCadenceThisQuarter,
    confidence,
    workflowState,
    workflowReason,
    unresolvedFindingCount,
    primaryAttachment: doc ? { documentId: doc.id, filename: doc.filename } : null,
  };

  // Cache the projection for AP_SUMMARY_TTL_MS. Repeated Mission
  // Control renders within this window skip the re-parse entirely.
  apSummaryCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/**
 * Classify how the sender relates to the invoice.
 *   VENDOR — sender's email domain matches the extracted vendor's domain
 *     OR the matched Spectre vendor's contact email domain.
 *   EMPLOYEE_FORWARD — sender is a User of this club.
 *   OTHER — anything else. Card treats this as provenance only.
 * Never confuses a forwarding staff member with the vendor.
 */
async function classifySenderRelationship(args: {
  clubId: string;
  senderAddress: string | null;
  extractedVendorDomain: string | null;
  matchedVendorId: string | null;
}): Promise<"VENDOR" | "EMPLOYEE_FORWARD" | "OTHER"> {
  const addr = args.senderAddress?.toLowerCase().trim() ?? "";
  if (!addr) return "OTHER";
  const senderDomain = addr.split("@")[1] ?? "";

  // 1. Extracted-vendor domain match.
  if (args.extractedVendorDomain && senderDomain === args.extractedVendorDomain.toLowerCase()) {
    return "VENDOR";
  }
  // 2. Matched-Spectre-vendor contact email domain match.
  if (args.matchedVendorId) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: args.matchedVendorId, clubId: args.clubId },
      select: { email: true },
    });
    const vDomain = vendor?.email?.toLowerCase().split("@")[1] ?? "";
    if (vDomain && senderDomain === vDomain) return "VENDOR";
  }
  // 3. Sender is a club User (employee forward).
  //    Uses the canonical UserClubRole junction (User.clubRoles).
  const user = await prisma.user.findFirst({
    where: { email: addr, clubRoles: { some: { clubId: args.clubId } } },
    select: { id: true },
  });
  if (user) return "EMPLOYEE_FORWARD";
  return "OTHER";
}

/**
 * Count APInvoice rows for a vendor this calendar quarter (matched
 * vendor's own invoices only). Feeds the "3rd invoice this quarter"
 * sender-line cadence copy.
 */
async function countInvoicesThisQuarter(clubId: string, vendorId: string): Promise<number> {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  const start = new Date(now.getFullYear(), quarter * 3, 1);
  return prisma.aPInvoice.count({
    where: { clubId, vendorId, invoiceDate: { gte: start } },
  });
}

/**
 * Sprint 3 · Checkpoint 15L — cadence fallback for the "no vendor
 * record yet" case (Microsoft on Coulee Ridge). Counts APInvoice
 * rows whose Vendor.legalName / operatingName normalises to the same
 * canonical string as the extracted vendor name. Returns null when
 * we have insufficient signal.
 */
async function countInvoicesThisQuarterByName(clubId: string, extractedName: string | null): Promise<number | null> {
  if (!extractedName || extractedName.trim().length < 3) return null;
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  const start = new Date(now.getFullYear(), quarter * 3, 1);
  // Sprint 3 · Checkpoint 15L — SQLite (local dev) doesn't support
  // `mode: "insensitive"`, but Postgres (staging/prod) does. We use
  // the default case-sensitive `contains` here; the extracted name
  // as it appears on invoices from the same vendor is stable enough
  // that a case-sensitive substring match works for the cadence
  // heuristic. Missed matches downgrade cadence to "First invoice
  // received" rather than emitting a wrong count.
  return prisma.aPInvoice.count({
    where: {
      clubId,
      invoiceDate: { gte: start },
      vendor: {
        OR: [
          { legalName: { contains: extractedName } },
          { operatingName: { contains: extractedName } },
        ],
      },
    },
  });
}

/**
 * Sprint 3 · Checkpoint 15L — GST verification.
 *
 * The card can honestly say "verified GST at X%" ONLY when:
 *   1. subtotal + taxTotal + total are all extracted;
 *   2. total = subtotal + taxTotal (within a $0.02 rounding tolerance);
 *   3. the rate (taxTotal / subtotal) matches a supported rate to
 *      within 0.10 percentage points.
 *
 * If the tax figure was extracted but the rate can't be reconciled,
 * returns EXTRACTED_UNVERIFIED — the card shows a truthful "tax
 * extracted; rate requires review" line.
 *
 * If no tax was extracted, returns NOT_PRESENT.
 *
 * Otherwise INSUFFICIENT_DATA and the card omits the segment.
 */
function classifyGstVerification(extraction: ExtractedInvoice | null): {
  state: "VERIFIED" | "EXTRACTED_UNVERIFIED" | "NOT_PRESENT" | "INSUFFICIENT_DATA";
  ratePercent: number | null;
} {
  if (!extraction) return { state: "INSUFFICIENT_DATA", ratePercent: null };
  // No tax section on the PDF.
  if (extraction.taxTotal == null && extraction.subtotal != null && extraction.total != null) {
    const subN = Number(extraction.subtotal);
    const totN = Number(extraction.total);
    if (Number.isFinite(subN) && Number.isFinite(totN) && Math.abs(totN - subN) < 0.02) {
      return { state: "NOT_PRESENT", ratePercent: null };
    }
  }
  // Full arithmetic reconcile.
  const sub = Number(extraction.subtotal);
  const tax = Number(extraction.taxTotal);
  const tot = Number(extraction.total);
  if (![sub, tax, tot].every(Number.isFinite)) {
    // We may still have tax alone (Microsoft-style: shows tax, no
    // separate subtotal) — mark as extracted-but-unverified so the
    // card doesn't invent a rate.
    if (Number.isFinite(tax) && tax > 0) return { state: "EXTRACTED_UNVERIFIED", ratePercent: null };
    return { state: "INSUFFICIENT_DATA", ratePercent: null };
  }
  if (Math.abs(sub + tax - tot) > 0.02) return { state: "EXTRACTED_UNVERIFIED", ratePercent: null };
  if (sub <= 0) return { state: "EXTRACTED_UNVERIFIED", ratePercent: null };
  const rate = (tax / sub) * 100;
  const supportedRates = [5, 7, 8, 12, 13, 14.975, 15]; // GST + provincial HST rates
  const match = supportedRates.find((r) => Math.abs(rate - r) < 0.15);
  if (match != null) return { state: "VERIFIED", ratePercent: match };
  return { state: "EXTRACTED_UNVERIFIED", ratePercent: null };
}

/**
 * Sprint 3 · Checkpoint 15M — read the per-club "show currency
 * code beside monetary amounts" preference. Default TRUE so the
 * pre-preference behaviour ($31.29 CAD) is preserved for every
 * club that hasn't opted out. Read via the existing club-settings
 * layer; failures degrade to the default rather than crashing the
 * projection.
 */
async function loadCurrencyShowCode(clubId: string): Promise<boolean> {
  try {
    const { getSetting } = await import("@/lib/enterprise/settings");
    const v = await getSetting<boolean>(clubId, "OPERATIONAL_UI", "currency_show_code");
    return v == null ? true : v;
  } catch {
    return true;
  }
}

/**
 * Sprint 3 · Checkpoint 15L — resolve payment terms with provenance.
 * Prefers extracted terms; falls back to matched-vendor profile.
 */
async function resolvePaymentTerms(args: {
  clubId: string;
  extractedTerms: string | null;
  matchedVendorId: string | null;
}): Promise<{ terms: string | null; source: ApInvoiceCardIntelligence["paymentTermsSource"] }> {
  if (args.extractedTerms) return { terms: args.extractedTerms, source: "EXTRACTED" };
  if (args.matchedVendorId) {
    const v = await prisma.vendor.findFirst({
      where: { id: args.matchedVendorId, clubId: args.clubId },
      select: { paymentTermsDays: true },
    });
    if (v?.paymentTermsDays != null) {
      return { terms: `Net ${v.paymentTermsDays}`, source: "VENDOR_PROFILE" };
    }
  }
  return { terms: null, source: null };
}

/** Blend extraction quality, vendor certainty, and reconcile state into a 0-100. */
function deriveApCardConfidence(a: ApAnalyseResult | null): number | null {
  if (!a) return null;
  let score = 0;
  if (a.extraction.state === "STRUCTURED") score += 40;
  else if (a.extraction.state === "PARTIAL") score += 20;
  if (a.vendor.state === "MATCHED") score += 30;
  else if (a.vendor.state === "AMBIGUOUS") score += 15;
  if (a.reconcile.state === "MATCH") score += 20;
  else if (a.reconcile.state === "AMOUNT_MISMATCH" || a.reconcile.state === "DATE_MISMATCH") score += 10;
  if (a.gl.accountNumber) score += 10;
  return Math.max(0, Math.min(100, score));
}

/**
 * The workflow-state decision tree. Drives the pill, primary action,
 * and recommendation branch. Order matters — first matching rule wins.
 */
function deriveApWorkflowState(a: ApAnalyseResult | null):
  ApInvoiceCardIntelligence["workflowState"] {
  if (!a) return "NEEDS_JUDGMENT";
  if (a.reconcile.state === "DUPLICATE" || a.reconcile.state === "HASH_DUPLICATE") return "POSSIBLE_DUPLICATE";
  if (a.extraction.state === "DOCUMENT_UNREADABLE") return "MISSING_INFORMATION";
  // Sprint 3 · Checkpoint 15T — MISSING_INFORMATION is reserved for
  // cases where the sender must be contacted (founder rule §8):
  //   * source document unreadable
  //   * supplier cannot be determined
  //   * no usable payable reference
  // Missing total, mixed tax, uncertain GL, or unmapped account
  // configuration are validation requirements inside the workflow —
  // they DO NOT change the action to Request information.
  const supplierUnknown = !a.extraction.vendor?.guessedName;
  const noPayableReference = !a.extraction.invoiceNumber;
  if (supplierUnknown || noPayableReference) return "MISSING_INFORMATION";
  if (a.vendor.state === "NOT_FOUND" || a.vendor.state === "AMBIGUOUS") return "VENDOR_MATCH_REQUIRED";
  if (a.vendor.state === "INSUFFICIENT_SIGNAL") return "VENDOR_MATCH_REQUIRED";
  // Everything the analyser needs to code the invoice was found.
  // If reconcile confirmed a match to an existing APInvoice, we
  // already have a coding path — ready for approval.
  if (a.reconcile.state === "MATCH") return "READY_FOR_APPROVAL";
  // Extraction + vendor are OK but reconcile has a variance the
  // reviewer must judge (amount/date mismatch or PO variance).
  if (a.reconcile.state === "AMOUNT_MISMATCH" || a.reconcile.state === "DATE_MISMATCH"
      || a.reconcile.state === "VENDOR_MISMATCH") {
    return "NEEDS_JUDGMENT";
  }
  // No AP row exists yet but coding is clean → ready to draft + post.
  return "READY_FOR_APPROVAL";
}

function deriveApWorkflowReason(
  state: ApInvoiceCardIntelligence["workflowState"],
  a: ApAnalyseResult | null,
): string {
  if (!a) return "Analysis unavailable — open review to inspect.";
  const vendor = a.extraction.vendor.guessedName ?? "the vendor";
  const gl = a.gl.accountName ? `GL ${a.gl.accountNumber} ${a.gl.accountName}` : "the recommended GL account";
  switch (state) {
    case "READY_FOR_APPROVAL":
      return `Approve and post to ${gl}. No exceptions detected.`;
    case "VENDOR_MATCH_REQUIRED":
      return a.vendor.state === "AMBIGUOUS"
        ? `Select the correct vendor from the extracted candidates, then confirm the proposed coding.`
        : `Match ${vendor} to an existing vendor or onboard it, then confirm the proposed coding.`;
    case "MISSING_INFORMATION":
      return a.extraction.state === "DOCUMENT_UNREADABLE"
        ? `The attached PDF could not be parsed. Request a legible copy from the sender.`
        : `The extractor could not confidently read every required field. Open review to fill in the missing values.`;
    case "POSSIBLE_DUPLICATE":
      return `Spectre already has this invoice on the AP subledger. Confirm this is a duplicate before dismissing.`;
    case "NEEDS_JUDGMENT":
    default:
      if (a.reconcile.state === "AMOUNT_MISMATCH") return `Total on the PDF does not match the existing AP row. Reconcile the variance.`;
      if (a.reconcile.state === "DATE_MISMATCH") return `Invoice date on the PDF does not match the existing AP row. Reconcile the variance.`;
      if (a.reconcile.state === "VENDOR_MISMATCH") return `Invoice reference already exists on a different vendor. Investigate before approving.`;
      return `Review the extracted invoice facts before advancing.`;
  }
}

function humanCapitalClass(cls: string): string {
  return cls.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

async function summariseStatementIntake(clubId: string, intakeId: string): Promise<LinkedIntelligenceForEmail["statementSummary"]> {
  const origin = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, workIntakeItemId: intakeId, kind: "INGESTED_DOCUMENT", role: "PRIMARY" },
    select: { referenceId: true },
  });
  if (!origin) return undefined;
  const recon = await prisma.vendorStatementReconciliation.findFirst({
    where: { clubId, ingestedDocumentId: origin.referenceId },
    select: {
      closingBalance: true, currency: true, reconciliationState: true,
      canonicalVendor: { select: { legalName: true, operatingName: true } },
    },
  });
  const findings = await prisma.workIntakeFinding.findMany({
    where: { clubId, workIntakeItemId: intakeId, state: { in: ["CONFIRMED", "OBSERVED"] } },
    select: { severity: true },
  });
  const unresolvedFindingCount = findings.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL" || f.severity === "MEDIUM").length;
  return {
    vendorGuess: recon?.canonicalVendor?.operatingName ?? recon?.canonicalVendor?.legalName ?? null,
    closingBalance: recon?.closingBalance?.toString() ?? null,
    currency: recon?.currency ?? "CAD",
    reconciliationState: recon?.reconciliationState ?? null,
    unresolvedFindingCount,
  };
}

// ---------------------------------------------------------------------------
// AP Invoice Review
// ---------------------------------------------------------------------------
export async function loadApReviewIntakeItems(args: LoaderArgs & { suppressedIds?: Set<string> }): Promise<WorkItem[]> {
  const items = await prisma.workIntakeItem.findMany({
    where: {
      clubId: args.clubId,
      classification: "AP_INVOICE_REVIEW",
      status: { notIn: ["RESOLVED", "SUPPRESSED"] },
      // Sprint 3 Checkpoint 15H Unified Remediation — suppress children.
      id: args.suppressedIds && args.suppressedIds.size > 0
        ? { notIn: [...args.suppressedIds] }
        : undefined,
    },
    include: {
      origins: {
        where: { OR: [{ kind: "INGESTED_DOCUMENT", role: "PRIMARY" }, { kind: "AP_INVOICE" }] },
        select: { kind: true, referenceId: true, role: true },
      },
      findings: {
        where: { state: { in: ["CONFIRMED", "OBSERVED"] } },
        select: { key: true, severity: true, statement: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: args.limit ?? 24,
  });
  const cards: WorkItem[] = [];
  for (const i of items) {
    const docOrigin = i.origins.find((o) => o.kind === "INGESTED_DOCUMENT" && o.role === "PRIMARY");
    if (!docOrigin) continue;
    const doc = await prisma.ingestedDocument.findFirst({
      where: { id: docOrigin.referenceId, clubId: args.clubId },
      select: { filename: true, byteLength: true, receivedAt: true },
    });
    if (!doc) continue;
    const dominant = pickDominantFinding(i.findings);
    const capitalFinding = i.findings.find((f) => f.key === "ap.invoice.capital_candidate")
      ?? i.findings.find((f) => f.key === "ap.invoice.operating_candidate")
      ?? i.findings.find((f) => f.key === "ap.invoice.requires_review");
    const capitalLabel = capitalFinding?.key === "ap.invoice.capital_candidate" ? "Capital"
      : capitalFinding?.key === "ap.invoice.operating_candidate" ? "Operating"
      : capitalFinding?.key === "ap.invoice.requires_review" ? "Review required"
      : "Insufficient evidence";
    // Sprint 3 Checkpoint 15H Remediation — count ALL material
    // findings as issues, not just HIGH/CRITICAL. Missing extracted
    // fields (invoice number, total, vendor identity) count too.
    const materialFindings = i.findings.filter((f) =>
      f.severity === "HIGH" || f.severity === "CRITICAL" || f.severity === "MEDIUM",
    );
    const exceptionCount = materialFindings.length;
    const evidence: WorkItemEvidenceCell[] = [
      { label: "INVOICE", value: doc.filename, state: "extracted" },
      { label: "AP STATUS", value: capitalLabel, state: capitalLabel === "Capital" ? "ambiguous" : "extracted" },
      { label: "AMOUNT", value: exceptionCount === 0 ? "no exceptions" : `${exceptionCount} exception${exceptionCount === 1 ? "" : "s"}`, state: exceptionCount > 0 ? "ambiguous" : "extracted" },
      { label: "VENDOR", value: statusLabel(i.status), state: "extracted" },
    ];
    cards.push({
      id: i.id,
      workIntakeItemId: i.id,
      workIntakeStatus: i.status,   // Sprint 3 Checkpoint 15I
      state: dominant?.severity === "HIGH" || dominant?.severity === "CRITICAL" ? "approval" : "info",
      idTag: `AP-${i.id.slice(-6).toUpperCase()}`,
      title: `AP Invoice Review — ${i.displaySubject ?? doc.filename}`,
      sender: { from: i.displaySender ?? "Accounts payable", ctx: `Received ${relDay(doc.receivedAt, args.now)}` },
      timestamp: doc.receivedAt.toISOString(),
      // Sprint 3 Checkpoint 15H Remediation — canonical sort key:
      //   sourceReceivedAt (email) → ingestedDocument.receivedAt.
      sortTimestamp: doc.receivedAt.toISOString(),
      timestampLabel: relDay(doc.receivedAt, args.now),
      synopsisText: dominant?.statement ?? "Invoice document requires accounting review.",
      evidence,
      recommendation: dominant ? shorten(dominant.statement, 140) : "Open the review pane to see extracted invoice facts.",
      classification: "AP_INVOICE_REVIEW",
      actions: [],
    });
  }
  logger.info("mission-control.ap-review.loaded", { clubId: args.clubId, count: cards.length });
  return cards;
}

// ---------------------------------------------------------------------------
// Vendor Statement Review
// ---------------------------------------------------------------------------
export async function loadStatementReviewIntakeItems(args: LoaderArgs & { suppressedIds?: Set<string> }): Promise<WorkItem[]> {
  const items = await prisma.workIntakeItem.findMany({
    where: {
      clubId: args.clubId,
      classification: "VENDOR_STATEMENT_REVIEW",
      status: { notIn: ["RESOLVED", "SUPPRESSED"] },
      id: args.suppressedIds && args.suppressedIds.size > 0
        ? { notIn: [...args.suppressedIds] }
        : undefined,
    },
    include: {
      origins: {
        where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" },
        select: { referenceId: true },
      },
      findings: {
        where: { state: { in: ["CONFIRMED", "OBSERVED"] } },
        select: { key: true, severity: true, statement: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: args.limit ?? 24,
  });
  const cards: WorkItem[] = [];
  for (const i of items) {
    const docOrigin = i.origins[0];
    if (!docOrigin) continue;
    const [doc, recon] = await Promise.all([
      prisma.ingestedDocument.findFirst({
        where: { id: docOrigin.referenceId, clubId: args.clubId },
        select: { filename: true, receivedAt: true },
      }),
      prisma.vendorStatementReconciliation.findFirst({
        where: { clubId: args.clubId, ingestedDocumentId: docOrigin.referenceId },
        select: {
          canonicalVendor: { select: { legalName: true, operatingName: true } },
          statementDate: true, closingBalance: true, reconciliationState: true, currency: true,
        },
      }),
    ]);
    if (!doc) continue;
    const dominant = pickDominantFinding(i.findings);
    const vendorName = recon?.canonicalVendor?.operatingName ?? recon?.canonicalVendor?.legalName ?? "Unresolved vendor";
    const exceptionCount = i.findings.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL").length;
    const evidence: WorkItemEvidenceCell[] = [
      { label: "VENDOR", value: vendorName, state: recon?.canonicalVendor ? "found" : "not_found" },
      { label: "AMOUNT", value: recon?.closingBalance ? `${(recon.currency ?? "CAD")} ${Number(recon.closingBalance).toFixed(2)}` : "n/a", state: "extracted" },
      { label: "AP STATUS", value: recon?.reconciliationState ?? "PENDING", state: recon?.reconciliationState === "RECONCILED" ? "found" : "ambiguous" },
      { label: "INVOICE", value: `${exceptionCount} exceptions`, state: exceptionCount > 0 ? "ambiguous" : "extracted" },
    ];
    cards.push({
      id: i.id,
      workIntakeItemId: i.id,
      workIntakeStatus: i.status,   // Sprint 3 Checkpoint 15I
      state: exceptionCount > 0 ? "approval" : "info",
      idTag: `STMT-${i.id.slice(-6).toUpperCase()}`,
      title: `Vendor Statement Review — ${vendorName}`,
      sender: { from: "AP intelligence", ctx: `Received ${relDay(doc.receivedAt, args.now)}` },
      timestamp: doc.receivedAt.toISOString(),
      sortTimestamp: doc.receivedAt.toISOString(),
      timestampLabel: relDay(doc.receivedAt, args.now),
      synopsisText: dominant?.statement ?? "Statement reconciliation ready for review.",
      evidence,
      recommendation: dominant ? shorten(dominant.statement, 140) : "Open the pane to review line-by-line reconciliation.",
      classification: "VENDOR_STATEMENT_REVIEW",
      actions: [],
    });
  }
  logger.info("mission-control.statement-review.loaded", { clubId: args.clubId, count: cards.length });
  return cards;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function pickDominantFinding(findings: Array<{ key: string; severity: string; statement: string }>) {
  const rank: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  return findings
    .filter((f) => f.key !== "ap.invoice.match" && f.key !== "ap.statement.reconciled")
    .sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0))[0];
}
function shorten(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function statusLabel(s: string): string {
  return s === "OPEN" ? "Awaiting review" : s === "IN_PROGRESS" ? "In progress" : s === "DEFERRED" ? "Deferred" : s;
}
function relDay(when: Date, now: Date): string {
  const days = Math.floor((now.getTime() - when.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return when.toISOString().slice(0, 10);
}
