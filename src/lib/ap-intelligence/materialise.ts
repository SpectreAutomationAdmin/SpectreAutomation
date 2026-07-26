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
}): Promise<{ intakeId: string; created: boolean; findingsCreated: number; findingsPreserved: number }> {
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
  await prisma.workIntakeItem.update({
    where: { id: canonical.id },
    data: { lastAnalysedAt: now },
  });
  logger.info("ap-intelligence.materialise_single.complete", {
    clubId: args.clubId,
    documentIdTail: doc.id.slice(-6),
    intakeIdTail: canonical.id.slice(-6),
    created: canonical.created,
    findingsCreated: persisted.created,
    findingsPreserved: persisted.preserved,
  });
  return {
    intakeId: canonical.id,
    created: canonical.created,
    findingsCreated: persisted.created,
    findingsPreserved: persisted.preserved,
  };
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
