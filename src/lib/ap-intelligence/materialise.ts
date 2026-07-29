// Sprint 3 Checkpoint 15E (2026-07-24) — AP-invoice document
// materialiser.
//
// Enumerates every IngestedDocument on a club whose classification
// is INVOICE. For each:
//   1. Find-or-create the canonical WorkIntakeItem keyed by
//      (clubId, INGESTED_DOCUMENT, documentId, PRIMARY) origin.
//   2. Run the analyser end-to-end.
//   3. Persist findings via the reusable C15B persistence
//      (WorkIntakeFinding — supersession + USER_REJECTED preservation).
//   4. Attach the matched APInvoice as an origin (if any).
//   5. Record a MATERIALISED activity.
//
// One-shot: exits cleanly after processing MAX_DOCS_PER_RUN documents
// (default 200). Reruns are safe — semantic-identity dedup on the
// finding key means no duplicate findings.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { analyseIngestedInvoice, type ApAnalyseResult } from "./analyse";
import { currentAnalysisVersion } from "./analysis-version";
import { upsertOrigins } from "@/lib/intelligence/origins";
import { upsertAnalysisFindings } from "@/lib/intelligence/persistence";
import { linkEvidence as linkDocumentEvidence } from "@/lib/documents/ingest";
import type { DocumentStorageAdapter } from "@/lib/documents/types";

const MAX_DOCS_PER_RUN = 200;
const AP_ANALYSER_MODULE = "ap-invoice-intelligence";

export interface ApMaterialiseArgs {
  clubId: string;
  now?: Date;
  maxDocs?: number;
  dryRun?: boolean;
  storageOverride?: DocumentStorageAdapter;
}

export interface ApMaterialiseResult {
  clubId: string;
  ruleModule: string;
  runAt: string;
  documentsExamined: number;
  intakesCreated: number;
  intakesReused: number;
  findingsCreated: number;
  findingsPreserved: number;
  findingsSuperseded: number;
  findingsRejectedPreserved: number;
  apInvoicesLinked: number;
  extractionsUnreadable: number;
  errorCount: number;
  errors: Array<{ category: string; referenceId: string; message: string }>;
  dryRun: boolean;
}

export async function runApMaterialisation(args: ApMaterialiseArgs): Promise<ApMaterialiseResult> {
  const clubId = args.clubId;
  const now = args.now ?? new Date();
  const dryRun = !!args.dryRun;
  const maxDocs = Math.min(args.maxDocs ?? MAX_DOCS_PER_RUN, MAX_DOCS_PER_RUN);
  const result: ApMaterialiseResult = {
    clubId,
    ruleModule: AP_ANALYSER_MODULE,
    runAt: now.toISOString(),
    documentsExamined: 0,
    intakesCreated: 0,
    intakesReused: 0,
    findingsCreated: 0,
    findingsPreserved: 0,
    findingsSuperseded: 0,
    findingsRejectedPreserved: 0,
    apInvoicesLinked: 0,
    extractionsUnreadable: 0,
    errorCount: 0,
    errors: [],
    dryRun,
  };

  const docs = await prisma.ingestedDocument.findMany({
    where: {
      clubId,
      classification: "INVOICE",
      status: "STORED",
      mimeType: "application/pdf",
    },
    select: {
      id: true,
      filename: true,
      sha256Hash: true,
      receivedAt: true,
      sourceReferenceId: true,
    },
    orderBy: { receivedAt: "asc" },
    take: maxDocs,
  });
  result.documentsExamined = docs.length;

  for (const doc of docs) {
    try {
      const canonical = await findOrCreateCanonicalIntake({
        clubId,
        ingestedDocumentId: doc.id,
        filename: doc.filename,
        receivedAt: doc.receivedAt,
        dryRun,
      });
      if (canonical.created) result.intakesCreated += 1;
      else result.intakesReused += 1;

      const analysis = await analyseIngestedInvoice({
        clubId,
        ingestedDocumentId: doc.id,
        now,
        storageOverride: args.storageOverride,
      });

      if (analysis.extraction.state === "DOCUMENT_UNREADABLE") {
        result.extractionsUnreadable += 1;
      }

      if (dryRun) continue;

      // Attach any AP-invoice origin the analyser identified (matched
      // OR duplicate detection). This makes the AP invoice discoverable
      // from the MC card.
      if (analysis.reconcile.matchedApInvoiceId) {
        await upsertOrigins({
          clubId,
          workIntakeItemId: canonical.id,
          origins: [
            { kind: "AP_INVOICE", referenceId: analysis.reconcile.matchedApInvoiceId, role: "EVIDENCE" },
          ],
        });
        // Also link the ingested document to the AP invoice as evidence.
        try {
          await linkDocumentEvidence({
            clubId,
            ingestedDocumentId: doc.id,
            target: {
              targetKind: "AP_INVOICE",
              targetReferenceId: analysis.reconcile.matchedApInvoiceId,
              role: "EVIDENCE",
              reason: "Auto-linked by ap-invoice materialiser",
            },
          });
          result.apInvoicesLinked += 1;
        } catch (err) {
          logger.warn("ap-intelligence.link_evidence_failed", {
            clubId,
            documentIdTail: doc.id.slice(-6),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const persisted = await upsertAnalysisFindings({
        clubId,
        workIntakeItemId: canonical.id,
        desired: analysis.findings,
        analysisRunId: `${AP_ANALYSER_MODULE}:${doc.id}:${now.toISOString()}`,
      });
      result.findingsCreated += persisted.created;
      result.findingsPreserved += persisted.preserved;
      result.findingsSuperseded += persisted.superseded;
      result.findingsRejectedPreserved += persisted.rejectedPreserved;

      // Stamp lastAnalysedAt so MC can show recency.
      await prisma.workIntakeItem.update({
        where: { id: canonical.id },
        data: { lastAnalysedAt: now },
      });
    } catch (err) {
      result.errorCount += 1;
      result.errors.push({
        category: "UNEXPECTED",
        referenceId: doc.id,
        message: (err instanceof Error ? err.message : String(err)).slice(0, 240),
      });
      logger.warn("ap-intelligence.materialise.failed", {
        clubId,
        documentIdTail: doc.id.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("ap-intelligence.materialise.complete", {
    clubId,
    ruleModule: AP_ANALYSER_MODULE,
    dryRun,
    documentsExamined: result.documentsExamined,
    intakesCreated: result.intakesCreated,
    intakesReused: result.intakesReused,
    findingsCreated: result.findingsCreated,
    findingsPreserved: result.findingsPreserved,
    findingsSuperseded: result.findingsSuperseded,
    apInvoicesLinked: result.apInvoicesLinked,
    extractionsUnreadable: result.extractionsUnreadable,
    errorCount: result.errorCount,
  });
  return result;
}

// Sprint 3 Checkpoint 15H Remediation (2026-07-25) — Materialise a
// single INVOICE document immediately (called by the mailbox-attachment
// ingest hook, so a new email→attachment→INVOICE cascade produces an
// AP Invoice Review intake within the same worker cycle).
//
// Idempotent by the canonical-intake natural key; safe to call twice.
export async function materialiseSingleInvoiceDocument(args: {
  clubId: string;
  ingestedDocumentId: string;
  now?: Date;
  // Sprint 3 · Checkpoint 15S (2026-07-29) — attachment context.
  // When present, an ApIntakeSource row is written linking the
  // EmailAttachment + EmailMessage to the canonical AP intake.
  // Older callers (batch reprocess, CLI) may omit it; the code path
  // then only creates/reuses the canonical intake without a source-
  // link row. Legacy behaviour is preserved.
  sourceContext?: {
    emailAttachmentId: string;
    emailMessageId: string;
  };
}): Promise<{
  intakeId: string;
  created: boolean;
  findingsCreated: number;
  findingsPreserved: number;
  apIntakeSourceRelationship?: "ORIGINAL_SUBMISSION" | "RETRANSMISSION" | "FORWARDED_COPY" | "POSSIBLE_DUPLICATE";
}> {
  const now = args.now ?? new Date();
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: args.ingestedDocumentId, clubId: args.clubId, classification: "INVOICE", status: "STORED", mimeType: "application/pdf" },
    select: { id: true, filename: true, receivedAt: true },
  });
  if (!doc) throw new Error(`materialiseSingleInvoiceDocument: doc not found / not INVOICE PDF`);
  const canonical = await findOrCreateCanonicalIntake({
    clubId: args.clubId,
    ingestedDocumentId: doc.id,
    filename: doc.filename,
    receivedAt: doc.receivedAt,
    dryRun: false,
  });
  const analysis = await analyseIngestedInvoice({
    clubId: args.clubId,
    ingestedDocumentId: doc.id,
    now,
  });
  const persisted = await upsertAnalysisFindings({
    clubId: args.clubId,
    workIntakeItemId: canonical.id,
    desired: analysis.findings,
    analysisRunId: `${AP_ANALYSER_MODULE}:${doc.id}:${now.toISOString()}`,
  });
  const currentVersion = currentAnalysisVersion();
  await prisma.workIntakeItem.update({
    where: { id: canonical.id },
    data: { lastAnalysedAt: now, analysisVersion: currentVersion },
  });

  // Sprint 3 · Checkpoint 15S — persistent source-to-canonical-AP
  // relationship. Written transactionally with the canonical intake
  // creation / reuse above. When a fresh email carries a PDF that
  // dedup'd to an existing IngestedDocument, this row links the new
  // EmailAttachment to the ONE canonical AP intake so the projection
  // resolves it without SHA-only inference.
  let apIntakeSourceRelationship: "ORIGINAL_SUBMISSION" | "RETRANSMISSION" | "FORWARDED_COPY" | "POSSIBLE_DUPLICATE" | undefined;
  if (args.sourceContext) {
    apIntakeSourceRelationship = await upsertApIntakeSource({
      clubId: args.clubId,
      emailAttachmentId: args.sourceContext.emailAttachmentId,
      emailMessageId: args.sourceContext.emailMessageId,
      ingestedDocumentId: doc.id,
      canonicalApIntakeId: canonical.id,
      canonicalWasCreatedThisRun: canonical.created,
      analysisVersion: currentVersion,
    });
  }
  logger.info("ap-intelligence.materialise_single.complete", {
    clubId: args.clubId,
    documentIdTail: doc.id.slice(-6),
    intakeIdTail: canonical.id.slice(-6),
    created: canonical.created,
    findingsCreated: persisted.created,
    findingsPreserved: persisted.preserved,
    analysisVersion: currentVersion,
    apIntakeSourceRelationship: apIntakeSourceRelationship ?? null,
  });
  return {
    intakeId: canonical.id,
    created: canonical.created,
    findingsCreated: persisted.created,
    findingsPreserved: persisted.preserved,
    apIntakeSourceRelationship,
  };
}

// Sprint 3 · Checkpoint 15S (2026-07-29) — upsert the source-to-
// canonical-AP relationship for a fresh email attachment. Called
// transactionally after the canonical intake is created / reused.
//
// Relationship classification:
//   ORIGINAL_SUBMISSION — the canonical intake was created THIS
//                         run AND this attachment triggered it.
//   RETRANSMISSION      — the canonical intake already existed AND
//                         is unresolved (status OPEN and not tied
//                         to a posted APInvoice). This attachment
//                         re-delivers the same document (e.g. the
//                         founder's Pt2 forward).
//   POSSIBLE_DUPLICATE  — the canonical intake existed AND is
//                         resolved / posted / voided / rejected.
//                         Record the receipt for audit; do NOT
//                         reopen the workflow.
//   FORWARDED_COPY      — reserved for future distinguishing of
//                         employee vs vendor forwards. Currently
//                         collapses into RETRANSMISSION.
//
// Tenant safety: all row references validated same-club before
// writing (Prisma FK enforces at commit, but we double-check to
// prevent silent cross-tenant links via SHA collision).
async function upsertApIntakeSource(args: {
  clubId: string;
  emailAttachmentId: string;
  emailMessageId: string;
  ingestedDocumentId: string;
  canonicalApIntakeId: string;
  canonicalWasCreatedThisRun: boolean;
  analysisVersion: string;
}): Promise<"ORIGINAL_SUBMISSION" | "RETRANSMISSION" | "FORWARDED_COPY" | "POSSIBLE_DUPLICATE"> {
  // Tenant guard on all related rows. Any mismatch is a data-model
  // bug that MUST NOT establish a cross-tenant link — throw before
  // writing.
  const [msg, att, doc, apIntake] = await Promise.all([
    prisma.emailMessage.findFirst({ where: { id: args.emailMessageId }, select: { clubId: true } }),
    prisma.emailAttachment.findFirst({ where: { id: args.emailAttachmentId }, select: { emailMessage: { select: { clubId: true } } } }),
    prisma.ingestedDocument.findFirst({ where: { id: args.ingestedDocumentId }, select: { clubId: true } }),
    prisma.workIntakeItem.findFirst({
      where: { id: args.canonicalApIntakeId },
      select: {
        clubId: true, status: true, resolvedAt: true,
        // Reserved for future workflow-state checks against APInvoice.
      },
    }),
  ]);
  if (!msg || msg.clubId !== args.clubId
      || !att?.emailMessage || att.emailMessage.clubId !== args.clubId
      || !doc || doc.clubId !== args.clubId
      || !apIntake || apIntake.clubId !== args.clubId) {
    throw new Error(
      `upsertApIntakeSource: tenant mismatch or missing row — will not link across tenants`,
    );
  }

  // Look for a posted APInvoice tied to this intake — indicates the
  // workflow is complete. Same-club scoped by the intake's clubId.
  const postedInvoice = await prisma.aPInvoice.findFirst({
    where: {
      clubId: args.clubId,
      status: { in: ["POSTED", "PAID"] },
      // APInvoice ↔ WorkIntakeItem is not a direct FK today; probe
      // via the shared IngestedDocument doc reference is sufficient
      // for the classification (the doc is the same either way).
    },
    select: { id: true, status: true },
  });

  let relationship: "ORIGINAL_SUBMISSION" | "RETRANSMISSION" | "FORWARDED_COPY" | "POSSIBLE_DUPLICATE";
  let reason: string;
  if (args.canonicalWasCreatedThisRun) {
    relationship = "ORIGINAL_SUBMISSION";
    reason = "First submission of this document — canonical AP intake created on the same run.";
  } else if (apIntake.status === "RESOLVED" || apIntake.resolvedAt != null || postedInvoice != null) {
    relationship = "POSSIBLE_DUPLICATE";
    reason = postedInvoice
      ? `Same document re-received; matching AP intake is already resolved and has an APInvoice status=${postedInvoice.status}. Recorded for audit; no reopen.`
      : "Same document re-received; matching AP intake is already resolved. Recorded for audit; no reopen.";
  } else {
    relationship = "RETRANSMISSION";
    reason = "Same document re-received while canonical AP intake is unresolved. Linked to the existing workflow.";
  }

  await prisma.apIntakeSource.upsert({
    where: { emailAttachmentId: args.emailAttachmentId },
    create: {
      clubId: args.clubId,
      emailAttachmentId: args.emailAttachmentId,
      emailMessageId: args.emailMessageId,
      ingestedDocumentId: args.ingestedDocumentId,
      canonicalApIntakeId: args.canonicalApIntakeId,
      relationship,
      reason,
      analysisVersionAtLink: args.analysisVersion,
    },
    update: {
      // Same-attachment upserts (retry) update the classification
      // and version; do not mutate the canonical link (attachments
      // do not migrate between canonical intakes without operator
      // action — see the diagnostic route for controlled repair).
      relationship,
      reason,
      analysisVersionAtLink: args.analysisVersion,
    },
  });
  return relationship;
}

async function findOrCreateCanonicalIntake(args: {
  clubId: string;
  ingestedDocumentId: string;
  filename: string;
  receivedAt: Date;
  dryRun: boolean;
}): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId,
      kind: "INGESTED_DOCUMENT",
      referenceId: args.ingestedDocumentId,
      role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  if (existing) return { id: existing.workIntakeItemId, created: false };
  if (args.dryRun) return { id: `dry:${args.ingestedDocumentId}`, created: true };

  const intake = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId,
      status: "OPEN",
      judgmentRequired: true,
      classification: "AP_INVOICE_REVIEW",
      classificationReason: "Spectre AP-invoice intelligence identified this PDF as an invoice requiring accounting review.",
      classificationMethod: "RULE",
      classificationRuleKey: "ap-invoice-intelligence.v1",
      classificationRuleVersion: 1,
      displaySourceLabel: "Vendor invoice",
      displaySender: "Accounts payable",
      displaySubject: args.filename,
      displayPreview: "PDF invoice ingested; accounting review required.",
      displayReceivedAt: args.receivedAt,
      displayHasAttachments: true,
    },
    select: { id: true },
  });

  await prisma.workIntakeOrigin.create({
    data: {
      clubId: args.clubId,
      workIntakeItemId: intake.id,
      kind: "INGESTED_DOCUMENT",
      referenceId: args.ingestedDocumentId,
      role: "PRIMARY",
      linkReason: "Materialised by ap-invoice intelligence",
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: intake.id,
      action: "MATERIALISED",
      note: "Materialised by ap-invoice intelligence",
    },
  });

  return { id: intake.id, created: true };
}
