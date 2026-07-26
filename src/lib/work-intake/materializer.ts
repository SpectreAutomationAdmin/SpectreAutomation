// Sprint 2 (2026-07-19) — Source materialiser contract for the
// canonical WorkIntakeItem layer.
//
// This is the ONE authoritative writer of every `display_*` and every
// `classification_*` column on WorkIntakeItem. Ad-hoc writes from the
// source ingester are forbidden — the ingester must call the source's
// materialiser and let it own the display projection.
//
// Every materialiser MUST satisfy the invariants below. Each is
// enforced by a test in tests/lib/work-intake/materializer.contract.test.ts:
//
//   I1 — Idempotent upsert. Calling upsertFromEvidence twice with the
//        same evidence produces the same DB state.
//
//   I2 — Orchestration preservation. A resync MUST NOT overwrite:
//          status, ownerUserId, deferredUntil, resolvedAt,
//          resolvedByUserId, judgmentRequired
//        The user owns those fields once they act. Only display and
//        classification can be refreshed.
//
//   I3 — User override respect. When classificationOverriddenByUserId
//        is set, refreshClassification MUST NOT overwrite the
//        classification columns.
//
//   I4 — Evidence retraction. handleEvidenceDeleted MUST NOT delete
//        the WorkIntakeItem; it should mark the item SUPPRESSED or
//        annotate the activity log, preserving orchestration history.
//        Retention policy decisions live at the source; the intake
//        row survives so audit trails remain intact.
//
//   I5 — Tenant isolation. Every write is scoped by clubId. A
//        materialiser NEVER touches an intake belonging to a
//        different club, even by primary key.
//
// The contract is deliberately generic over evidence type. Each
// source ships a concrete implementation:
//   - EmailIntakeMaterializer (Sprint 2, this phase)
//   - APInvoiceIntakeMaterializer (future, replaces the projection)
//   - MemberAROverdueIntakeMaterializer (future)
//   - WeatherAlertIntakeMaterializer, etc.

import type { PrismaClient, WorkIntakeItem } from "@prisma/client";

/**
 * A read-only description of what a source has to say about a piece
 * of evidence. Materialisers translate their own evidence type into
 * this shape via projectDisplay(). The intake row's display columns
 * are refreshed from this projection whenever the underlying
 * evidence changes.
 */
export interface WorkIntakeDisplayProjection {
  /** Human-readable source label — "Outlook" | "AP Invoice" | ... */
  sourceLabel: string;
  sender: string;
  subject: string;
  preview: string;
  receivedAt: Date;
  hasAttachments: boolean;
}

/**
 * The classifier output for a piece of evidence. Nullable when no
 * rule fired and no user has overridden — the intake displays as
 * unclassified.
 *
 * `confidence` describes the STRENGTH of the inference (0..1). It is
 * NOT a "did the rule fire" boolean. A rule that matches on a single
 * ambiguous keyword should return confidence far below 1.0 even
 * though its code branch executed.
 */
export interface WorkIntakeClassification {
  classification: string;
  reason: string;
  method: "RULE" | "AI";
  confidence: number;
  ruleKey?: string;
  ruleVersion?: number;
}

/**
 * The contract every source materialiser implements. `TEvidence` is
 * the source-specific evidence type (e.g. `EmailMessage`).
 */
export interface SourceMaterializer<TEvidence extends { id: string; clubId: string }> {
  /** Which link table this materialiser owns. Used by the base class
   *  to look up the PRIMARY link during idempotent upserts. */
  readonly linkTableModelName: string;
  /** Which column on the link table carries the origin FK. */
  readonly linkOriginColumn: string;
  /** Human-readable source label for the display projection. */
  readonly sourceLabel: string;

  /** Upsert an intake row for this evidence. MUST satisfy I1, I2, I5. */
  upsertFromEvidence(evidence: TEvidence, tx: PrismaClient): Promise<WorkIntakeItem>;

  /** Rebuild the display projection from current evidence.
   *  Called during scheduled refreshes and after evidence updates. */
  refreshDisplayProjection(intakeId: string, evidence: TEvidence, tx: PrismaClient): Promise<void>;

  /** Update classification from source-specific rules. MUST honour
   *  the user-override guard (I3). */
  refreshClassification(intakeId: string, evidence: TEvidence, tx: PrismaClient): Promise<void>;

  /** Called when the source evidence is retracted or deleted. MUST
   *  satisfy I4 — the intake survives; retention lives at the source. */
  handleEvidenceDeleted(evidenceId: string, clubId: string, tx: PrismaClient): Promise<void>;

  /** Extract a display projection from an evidence record.
   *  Pure function; no DB writes. */
  projectDisplay(evidence: TEvidence): WorkIntakeDisplayProjection;
}

/**
 * Fields on WorkIntakeItem that a materialiser MUST NOT overwrite on
 * resync. Exported for the contract test.
 */
export const ORCHESTRATION_FIELDS = [
  "status",
  "ownerUserId",
  "judgmentRequired",
  "deferredUntil",
  "resolvedAt",
  "resolvedByUserId",
] as const;

/**
 * Fields on WorkIntakeItem that carry the display projection. A
 * materialiser owns these — Mission Control MUST NOT reconstruct
 * them from origin data at read time.
 */
export const DISPLAY_FIELDS = [
  "displaySourceLabel",
  "displaySender",
  "displaySubject",
  "displayPreview",
  "displayReceivedAt",
  "displayHasAttachments",
] as const;

/**
 * Fields on WorkIntakeItem that describe the current classification.
 * A materialiser owns these UNLESS classificationOverriddenByUserId
 * is set — a user override freezes the classification.
 */
export const CLASSIFICATION_FIELDS = [
  "classification",
  "classificationReason",
  "classificationMethod",
  "classificationConfidence",
  "classificationRuleKey",
  "classificationRuleVersion",
] as const;

/**
 * Guard used by refreshClassification. When true, the caller MUST
 * skip the update — the user has taken control of the classification
 * and a resync must not stomp their choice.
 */
export function isClassificationLocked(item: {
  classificationOverriddenByUserId: string | null;
}): boolean {
  return item.classificationOverriddenByUserId != null;
}

/**
 * Freeze a WorkIntakeItem's orchestration fields into a plain object
 * so a resync-preservation test can compare "state I care about
 * before" vs "state I care about after" without reflecting on every
 * column.
 */
export function pickOrchestrationState(item: {
  status: string;
  ownerUserId: string | null;
  judgmentRequired: boolean;
  deferredUntil: Date | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
}) {
  return {
    status: item.status,
    ownerUserId: item.ownerUserId,
    judgmentRequired: item.judgmentRequired,
    deferredUntil: item.deferredUntil?.toISOString() ?? null,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: item.resolvedByUserId,
  };
}
