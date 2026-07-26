// Sprint 3 Checkpoint 15G (2026-07-24) — Statement reconciliation
// materialiser. One canonical WorkIntakeItem per statement document.
//
// Sequence:
//   1. Enumerate IngestedDocuments classified STATEMENT (STORED, PDF).
//   2. Ensure a canonical WorkIntakeItem exists via INGESTED_DOCUMENT
//      PRIMARY origin (reuses the same convention as 15E for AP-review).
//   3. Run the analyser end-to-end.
//   4. Upsert VendorStatementReconciliation + VendorStatementLine +
//      VendorStatementLineMatch rows (idempotent — the reconciliation
//      is unique on ingestedDocumentId, and lines are unique on
//      (reconciliationId, sequence)).
//   5. Attach the doc → reconciliation evidence link.
//   6. Persist findings via C15B persistence (semantic-identity dedup).

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { analyseIngestedStatement, type StatementAnalyseResult } from "./analyse";
import { upsertOrigins } from "@/lib/intelligence/origins";
import { upsertAnalysisFindings } from "@/lib/intelligence/persistence";
import { linkEvidence as linkDocumentEvidence } from "@/lib/documents/ingest";
import type { DocumentStorageAdapter } from "@/lib/documents/types";
import type { FindingInput } from "@/lib/intelligence/types";

const MAX_DOCS_PER_RUN = 200;
const RULE_MODULE = "ap-statement-intelligence";

export interface StatementMaterialiseArgs {
  clubId: string;
  now?: Date;
  maxDocs?: number;
  dryRun?: boolean;
  storageOverride?: DocumentStorageAdapter;
}

export interface StatementMaterialiseResult {
  clubId: string;
  ruleModule: string;
  runAt: string;
  documentsExamined: number;
  reconciliationsCreated: number;
  reconciliationsReused: number;
  linesPersisted: number;
  matchesPersisted: number;
  findingsCreated: number;
  findingsPreserved: number;
  findingsSuperseded: number;
  errorCount: number;
  errors: Array<{ category: string; referenceId: string; message: string }>;
  dryRun: boolean;
}

export async function runStatementMaterialisation(
  args: StatementMaterialiseArgs,
): Promise<StatementMaterialiseResult> {
  const now = args.now ?? new Date();
  const clubId = args.clubId;
  const dryRun = !!args.dryRun;
  const maxDocs = Math.min(args.maxDocs ?? MAX_DOCS_PER_RUN, MAX_DOCS_PER_RUN);
  const result: StatementMaterialiseResult = {
    clubId, ruleModule: RULE_MODULE, runAt: now.toISOString(),
    documentsExamined: 0, reconciliationsCreated: 0, reconciliationsReused: 0,
    linesPersisted: 0, matchesPersisted: 0,
    findingsCreated: 0, findingsPreserved: 0, findingsSuperseded: 0,
    errorCount: 0, errors: [], dryRun,
  };

  const docs = await prisma.ingestedDocument.findMany({
    where: { clubId, classification: "STATEMENT", status: "STORED", mimeType: "application/pdf" },
    select: { id: true, filename: true, receivedAt: true },
    orderBy: { receivedAt: "asc" },
    take: maxDocs,
  });
  result.documentsExamined = docs.length;

  for (const doc of docs) {
    try {
      const intake = await findOrCreateCanonicalIntake({
        clubId, ingestedDocumentId: doc.id, filename: doc.filename, receivedAt: doc.receivedAt, dryRun,
      });
      const analysis = await analyseIngestedStatement({
        clubId, ingestedDocumentId: doc.id, now, storageOverride: args.storageOverride,
      });

      if (!dryRun) {
        const reconciliation = await persistReconciliation({ clubId, doc, analysis, existingIntakeId: intake.id });
        result.reconciliationsCreated += reconciliation.created ? 1 : 0;
        result.reconciliationsReused += reconciliation.created ? 0 : 1;
        const persistedLines = await persistLines({ clubId, reconciliationId: reconciliation.id, analysis });
        result.linesPersisted += persistedLines.linesWritten;
        result.matchesPersisted += persistedLines.matchesWritten;
        try {
          await linkDocumentEvidence({
            clubId,
            ingestedDocumentId: doc.id,
            target: { targetKind: "VENDOR_STATEMENT_RECONCILIATION", targetReferenceId: reconciliation.id, role: "PRIMARY", reason: "Statement PDF is the source of this reconciliation" },
          });
        } catch (err) {
          logger.warn("ap-statement.materialise.link_evidence_failed", {
            clubId, documentIdTail: doc.id.slice(-6),
            message: err instanceof Error ? err.message : String(err),
          });
        }

        // Findings persistence
        const findings: FindingInput[] = analysis.findings.map((f) => ({
          key: f.key,
          statement: f.statement,
          state: (f.key === "ap.statement.reconciled" ? "OBSERVED" : "CONFIRMED"),
          severity: f.severity,
          materialityCents: f.amountDifferenceCents ? BigInt(f.amountDifferenceCents) : null,
          ruleKey: f.ruleKey,
          ruleVersion: f.ruleVersion,
          evidenceRefs: [
            { kind: "INGESTED_DOCUMENT", referenceId: doc.id },
            ...(f.targetKind === "AP_INVOICE" && f.targetReferenceId ? [{ kind: "AP_INVOICE" as const, referenceId: f.targetReferenceId }] : []),
          ],
        }));
        const persisted = await upsertAnalysisFindings({
          clubId, workIntakeItemId: intake.id, desired: findings,
          analysisRunId: `${RULE_MODULE}:${doc.id}:${now.toISOString()}`,
        });
        result.findingsCreated += persisted.created;
        result.findingsPreserved += persisted.preserved;
        result.findingsSuperseded += persisted.superseded;

        await prisma.workIntakeItem.update({ where: { id: intake.id }, data: { lastAnalysedAt: now } });
      } else {
        if (intake.created) result.reconciliationsCreated += 1;
        else result.reconciliationsReused += 1;
      }
    } catch (err) {
      result.errorCount += 1;
      result.errors.push({ category: "UNEXPECTED", referenceId: doc.id, message: (err instanceof Error ? err.message : String(err)).slice(0, 240) });
      logger.warn("ap-statement.materialise.failed", {
        clubId, documentIdTail: doc.id.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info("ap-statement.materialise.complete", {
    clubId, ruleModule: RULE_MODULE, dryRun,
    documentsExamined: result.documentsExamined,
    reconciliationsCreated: result.reconciliationsCreated,
    reconciliationsReused: result.reconciliationsReused,
    findingsCreated: result.findingsCreated,
    findingsPreserved: result.findingsPreserved,
    errorCount: result.errorCount,
  });
  return result;
}

// Sprint 3 Checkpoint 15H Remediation (2026-07-25) — Materialise a
// single STATEMENT document immediately from the mailbox-attachment
// ingest hook. Idempotent by canonical-intake natural key.
export async function materialiseSingleStatementDocument(args: {
  clubId: string;
  ingestedDocumentId: string;
  now?: Date;
}): Promise<{ intakeId: string; reconciliationId: string; created: boolean }> {
  const now = args.now ?? new Date();
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: args.ingestedDocumentId, clubId: args.clubId, classification: "STATEMENT", status: "STORED", mimeType: "application/pdf" },
    select: { id: true, filename: true, receivedAt: true },
  });
  if (!doc) throw new Error(`materialiseSingleStatementDocument: doc not found / not STATEMENT PDF`);
  const intake = await findOrCreateCanonicalIntake({
    clubId: args.clubId,
    ingestedDocumentId: doc.id,
    filename: doc.filename,
    receivedAt: doc.receivedAt,
    dryRun: false,
  });
  const analysis = await analyseIngestedStatement({
    clubId: args.clubId,
    ingestedDocumentId: doc.id,
    now,
  });
  const reconciliation = await persistReconciliation({ clubId: args.clubId, doc, analysis, existingIntakeId: intake.id });
  await persistLines({ clubId: args.clubId, reconciliationId: reconciliation.id, analysis });
  try {
    await linkDocumentEvidence({
      clubId: args.clubId,
      ingestedDocumentId: doc.id,
      target: { targetKind: "VENDOR_STATEMENT_RECONCILIATION", targetReferenceId: reconciliation.id, role: "PRIMARY", reason: "Statement PDF is the source of this reconciliation" },
    });
  } catch (err) {
    logger.warn("ap-statement.materialise_single.link_failed", {
      clubId: args.clubId, documentIdTail: doc.id.slice(-6),
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const findings: FindingInput[] = analysis.findings.map((f) => ({
    key: f.key, statement: f.statement,
    state: (f.key === "ap.statement.reconciled" ? "OBSERVED" : "CONFIRMED"),
    severity: f.severity, materialityCents: f.amountDifferenceCents ? BigInt(f.amountDifferenceCents) : null,
    ruleKey: f.ruleKey, ruleVersion: f.ruleVersion,
    evidenceRefs: [{ kind: "INGESTED_DOCUMENT", referenceId: doc.id }],
  }));
  await upsertAnalysisFindings({
    clubId: args.clubId, workIntakeItemId: intake.id, desired: findings,
    analysisRunId: `${RULE_MODULE}:${doc.id}:${now.toISOString()}`,
  });
  await prisma.workIntakeItem.update({ where: { id: intake.id }, data: { lastAnalysedAt: now } });
  logger.info("ap-statement.materialise_single.complete", {
    clubId: args.clubId,
    documentIdTail: doc.id.slice(-6),
    intakeIdTail: intake.id.slice(-6),
    created: intake.created,
    reconciliationState: analysis.reconciliationState,
  });
  return { intakeId: intake.id, reconciliationId: reconciliation.id, created: intake.created };
}

async function findOrCreateCanonicalIntake(args: {
  clubId: string;
  ingestedDocumentId: string;
  filename: string;
  receivedAt: Date;
  dryRun: boolean;
}): Promise<{ id: string; created: boolean }> {
  const classificationRuleKey = `ap-statement:${args.clubId}:${args.ingestedDocumentId}`;
  const existing = await prisma.workIntakeItem.findFirst({
    where: { clubId: args.clubId, classificationRuleKey },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  if (args.dryRun) return { id: `dry:${args.ingestedDocumentId}`, created: true };

  const intake = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId, status: "OPEN", judgmentRequired: true,
      classification: "VENDOR_STATEMENT_REVIEW",
      classificationReason: "Spectre statement intelligence identified this PDF as a vendor statement of account.",
      classificationMethod: "RULE",
      classificationRuleKey, classificationRuleVersion: 1,
      displaySourceLabel: "Vendor statement",
      displaySender: "AP intelligence",
      displaySubject: args.filename,
      displayPreview: "Statement reconciliation required.",
      displayReceivedAt: args.receivedAt,
      displayHasAttachments: true,
    },
    select: { id: true },
  });
  await prisma.workIntakeOrigin.create({
    data: {
      clubId: args.clubId, workIntakeItemId: intake.id,
      kind: "INGESTED_DOCUMENT", referenceId: args.ingestedDocumentId, role: "PRIMARY",
      linkReason: "Materialised by ap-statement intelligence",
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: intake.id, action: "MATERIALISED",
      note: `Materialised by ap-statement intelligence`,
    },
  });
  return { id: intake.id, created: true };
}

async function persistReconciliation(args: {
  clubId: string;
  doc: { id: string; filename: string; receivedAt: Date };
  analysis: StatementAnalyseResult;
  existingIntakeId: string;
}): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.vendorStatementReconciliation.findFirst({
    where: { clubId: args.clubId, ingestedDocumentId: args.doc.id },
    select: { id: true },
  });
  const data = {
    clubId: args.clubId,
    ingestedDocumentId: args.doc.id,
    canonicalVendorId: args.analysis.vendor.canonicalVendorId,
    statementDate: args.analysis.extraction.header.statementDate ? new Date(args.analysis.extraction.header.statementDate) : null,
    periodStart: args.analysis.extraction.header.periodStart ? new Date(args.analysis.extraction.header.periodStart) : null,
    periodEnd: args.analysis.extraction.header.periodEnd ? new Date(args.analysis.extraction.header.periodEnd) : null,
    openingBalance: args.analysis.extraction.header.openingBalance ?? "0",
    closingBalance: args.analysis.extraction.header.closingBalance ?? "0",
    amountDue: args.analysis.extraction.header.amountDue ?? args.analysis.extraction.header.closingBalance ?? "0",
    currency: args.analysis.extraction.header.currency ?? "CAD",
    extractionState: args.analysis.extraction.state,
    reconciliationState: args.analysis.reconciliationState,
    extractionRuleVersion: args.analysis.ruleVersion,
    reconciliationRuleVersion: args.analysis.ruleVersion,
    lastAnalysedAt: new Date(),
  };
  if (existing) {
    await prisma.vendorStatementReconciliation.update({ where: { id: existing.id }, data });
    return { id: existing.id, created: false };
  }
  const created = await prisma.vendorStatementReconciliation.create({ data, select: { id: true } });
  return { id: created.id, created: true };
}

async function persistLines(args: {
  clubId: string;
  reconciliationId: string;
  analysis: StatementAnalyseResult;
}): Promise<{ linesWritten: number; matchesWritten: number }> {
  // Delete any previous lines to keep a clean rerun (they are all
  // deterministically re-derivable from the PDF).
  await prisma.vendorStatementLineMatch.deleteMany({
    where: { statementLine: { reconciliationId: args.reconciliationId } },
  });
  await prisma.vendorStatementLine.deleteMany({
    where: { reconciliationId: args.reconciliationId },
  });
  let linesWritten = 0;
  let matchesWritten = 0;
  for (const line of args.analysis.extraction.lines) {
    const outcome = args.analysis.lineOutcomes.find((o) => o.sequence === line.sequence);
    const persistedLine = await prisma.vendorStatementLine.create({
      data: {
        clubId: args.clubId,
        reconciliationId: args.reconciliationId,
        sequence: line.sequence,
        transactionDate: line.transactionDate ? new Date(line.transactionDate) : null,
        referenceNumber: line.referenceNumber,
        description: line.description,
        transactionKind: line.transactionKind,
        debitAmount: line.debitAmount ?? "0",
        creditAmount: line.creditAmount ?? "0",
        runningBalance: line.runningBalance,
        extractionEvidence: JSON.stringify(line.evidence),
      },
      select: { id: true },
    });
    linesWritten += 1;
    if (outcome) {
      await prisma.vendorStatementLineMatch.create({
        data: {
          clubId: args.clubId,
          statementLineId: persistedLine.id,
          targetKind: outcome.matchTargetKind,
          targetReferenceId: outcome.matchTargetReferenceId,
          matchState: outcome.matchState,
          matchBasis: JSON.stringify(outcome.matchBasis),
          amountDifference: outcome.amountDifferenceCents !== null ? String(outcome.amountDifferenceCents / 100) : null,
          dateDifferenceDays: outcome.dateDifferenceDays,
        },
      });
      matchesWritten += 1;
    }
  }
  return { linesWritten, matchesWritten };
}
