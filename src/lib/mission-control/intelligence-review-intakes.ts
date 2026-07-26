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
  // An AP or Statement intake is a "child of an email intake" IFF:
  //   1. It has an INGESTED_DOCUMENT PRIMARY origin.
  //   2. That IngestedDocument was ingested from EMAIL_ATTACHMENT.
  //   3. The parent EmailMessage has a PRIMARY EmailWorkIntakeOrigin
  //      (i.e. there's a canonical email intake owning that email).
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
  const docIds = reviews.flatMap((r) => r.origins.map((o) => o.referenceId));
  if (docIds.length === 0) {
    return { suppressedApIntakeIds: new Set(), suppressedStatementIntakeIds: new Set() };
  }
  const docs = await prisma.ingestedDocument.findMany({
    where: { clubId, id: { in: docIds }, sourceKind: "EMAIL_ATTACHMENT" },
    select: { id: true, sourceReferenceId: true },
  });
  const attachmentIds = docs.map((d) => d.sourceReferenceId).filter(Boolean);
  if (attachmentIds.length === 0) {
    return { suppressedApIntakeIds: new Set(), suppressedStatementIntakeIds: new Set() };
  }
  const attachments = await prisma.emailAttachment.findMany({
    // clubId scope enforced via the parent emailMessage — attachments
    // do not carry clubId directly, so we route the tenant guard
    // through the message relation.
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
  // Build attachmentId → parent email intake id map.
  const attToParent = new Map<string, string>();
  for (const a of attachments) {
    if (!a.emailMessage || a.emailMessage.clubId !== clubId) continue;
    const parent = a.emailMessage.workIntakeOrigins[0]?.workIntakeItemId;
    if (parent) attToParent.set(a.id, parent);
  }
  const docToParent = new Map<string, string>();
  for (const d of docs) {
    const parent = attToParent.get(d.sourceReferenceId);
    if (parent) docToParent.set(d.id, parent);
  }
  const suppressedApIntakeIds = new Set<string>();
  const suppressedStatementIntakeIds = new Set<string>();
  for (const r of reviews) {
    const primaryDocId = r.origins[0]?.referenceId;
    if (!primaryDocId) continue;
    if (!docToParent.has(primaryDocId)) continue;
    if (r.classification === "AP_INVOICE_REVIEW") suppressedApIntakeIds.add(r.id);
    else suppressedStatementIntakeIds.add(r.id);
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
  invoiceSummary?: {
    vendorGuess: string | null;
    invoiceNumber: string | null;
    total: string | null;
    currency: string | null;
    capitalState: string | null;
    unresolvedFindingCount: number;
  };
  statementSummary?: {
    vendorGuess: string | null;
    closingBalance: string | null;
    currency: string | null;
    reconciliationState: string | null;
    unresolvedFindingCount: number;
  };
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
  const docs = await prisma.ingestedDocument.findMany({
    where: { clubId: args.clubId, sourceKind: "EMAIL_ATTACHMENT", sourceReferenceId: { in: attachmentIds } },
    select: { id: true, sourceReferenceId: true, classification: true },
  });
  const docsByAttachment = new Map<string, { id: string; classification: string }>();
  for (const d of docs) docsByAttachment.set(d.sourceReferenceId, d);

  const reviewIntakes = docs.length > 0
    ? await prisma.workIntakeItem.findMany({
        where: {
          clubId: args.clubId,
          classification: { in: ["AP_INVOICE_REVIEW", "VENDOR_STATEMENT_REVIEW"] },
          origins: { some: { kind: "INGESTED_DOCUMENT", role: "PRIMARY", referenceId: { in: docs.map((d) => d.id) } } },
        },
        select: {
          id: true, classification: true,
          origins: { where: { kind: "INGESTED_DOCUMENT", role: "PRIMARY" }, select: { referenceId: true } },
          findings: { where: { state: { in: ["CONFIRMED", "OBSERVED"] } }, select: { key: true, severity: true } },
        },
      })
    : [];

  for (const emailIntakeId of args.emailIntakeIds) {
    const atts = emailIntakeToAttachments.get(emailIntakeId) ?? [];
    // Skip inline images (isInline=true is a signature/logo attachment).
    const realAtts = atts.filter((a) => !a.isInline);
    const attDocs = realAtts.map((a) => docsByAttachment.get(a.id)).filter(Boolean) as Array<{ id: string; classification: string }>;
    const invoiceAttCount = attDocs.filter((d) => d.classification === "INVOICE").length;
    const statementAttCount = attDocs.filter((d) => d.classification === "STATEMENT").length;
    const attDocIds = new Set(attDocs.map((d) => d.id));
    const ownedReviews = reviewIntakes.filter((r) => r.origins.some((o) => attDocIds.has(o.referenceId)));
    const apIds = ownedReviews.filter((r) => r.classification === "AP_INVOICE_REVIEW").map((r) => r.id);
    const stIds = ownedReviews.filter((r) => r.classification === "VENDOR_STATEMENT_REVIEW").map((r) => r.id);

    const invoiceSummary = apIds.length > 0
      ? await summariseApIntake(args.clubId, apIds[0])
      : undefined;
    const statementSummary = stIds.length > 0
      ? await summariseStatementIntake(args.clubId, stIds[0])
      : undefined;

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
  }
  return map;
}

async function summariseApIntake(clubId: string, intakeId: string): Promise<LinkedIntelligenceForEmail["invoiceSummary"]> {
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: intakeId, clubId },
    select: {
      findings: { where: { state: { in: ["CONFIRMED", "OBSERVED"] } }, select: { key: true, severity: true, statement: true } },
    },
  });
  if (!intake) return undefined;
  // Statement text on ap.invoice.capital_candidate / operating_candidate carries reasoning; extract fields from persisted findings if present.
  const capitalFinding = intake.findings.find((f) => f.key === "ap.invoice.capital_candidate")
    ?? intake.findings.find((f) => f.key === "ap.invoice.operating_candidate")
    ?? intake.findings.find((f) => f.key === "ap.invoice.requires_review");
  const capitalState = capitalFinding?.key === "ap.invoice.capital_candidate" ? "CAPITAL"
    : capitalFinding?.key === "ap.invoice.operating_candidate" ? "OPERATING"
    : capitalFinding?.key === "ap.invoice.requires_review" ? "AMBIGUOUS"
    : null;
  const unresolvedFindingCount = intake.findings.filter((f) =>
    f.severity === "HIGH" || f.severity === "CRITICAL" || f.severity === "MEDIUM",
  ).length;
  return {
    vendorGuess: null, invoiceNumber: null, total: null, currency: null,
    capitalState, unresolvedFindingCount,
  };
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
      actions: [
        { key: "review", label: "Review invoice", kind: "primary" },
        { key: "defer", label: "Defer", kind: "tertiary" },
      ],
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
      actions: [
        { key: "review", label: "Reconcile statement", kind: "primary" },
        { key: "defer", label: "Defer", kind: "tertiary" },
      ],
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
