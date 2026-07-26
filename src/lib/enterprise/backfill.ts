// Phase 7D — Document backfill.
//
// Scans the scattered attachment tables (MemberDocument, JournalAttachment,
// APInvoiceAttachment, ApplicationDocument, FinancingDocument, VendorDocument,
// ReceiptCapture) and creates unified Document rows linked back to the same
// source entities.
//
// The original tables stay intact — backfill is additive, never destructive.
// Idempotency: a `documentBackfillSource` field on the new Document records
// the original `{table, id}` so reruns can detect existing records.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError } from "../errors";

type SourceTable =
  | "MemberDocument"
  | "JournalAttachment"
  | "APInvoiceAttachment"
  | "ApplicationDocument"
  | "FinancingDocument"
  | "VendorDocument"
  | "ReceiptCapture";

const SOURCES: SourceTable[] = [
  "MemberDocument", "JournalAttachment", "APInvoiceAttachment",
  "ApplicationDocument", "FinancingDocument", "VendorDocument", "ReceiptCapture",
];

export async function runBackfill(principal: Principal, clubId: string, opts: { dryRun: boolean; sources?: SourceTable[] }) {
  requirePermission(principal, clubId, "documents:write");
  const sources = opts.sources ?? SOURCES;

  const batches = [];
  for (const source of sources) {
    const batch = await runSingleBackfill(principal, clubId, source, opts.dryRun);
    batches.push(batch);
  }

  const totals = batches.reduce(
    (acc, b) => ({
      candidates: acc.candidates + b.totalCandidates,
      created: acc.created + b.totalCreated,
      skipped: acc.skipped + b.totalSkipped,
      failed: acc.failed + b.totalFailed,
    }),
    { candidates: 0, created: 0, skipped: 0, failed: 0 }
  );

  await audit(principal, {
    action: opts.dryRun ? "document.backfill.dryrun" : "document.backfill",
    entityType: "Club", entityId: clubId, clubId,
    after: { sources, totals },
  });
  return { totals, batches };
}

async function runSingleBackfill(principal: Principal, clubId: string, source: SourceTable, dryRun: boolean) {
  const batch = await prisma.documentBackfillBatch.create({
    data: {
      clubId, sourceTable: source, dryRun,
      status: dryRun ? "DRY_RUN" : "RUNNING", startedByUserId: principal.id,
    },
  });

  try {
    const candidates = await loadCandidates(clubId, source);
    let created = 0, skipped = 0, failed = 0;
    const reportEntries: Array<{ id: string; result: "created" | "skipped" | "failed"; reason?: string }> = [];

    for (const c of candidates) {
      try {
        // Dedupe key: a Document record carrying searchText="backfill:<table>:<id>".
        const probe = await prisma.document.findFirst({
          where: { clubId, searchText: `backfill:${source}:${c.sourceId}` },
        });
        if (probe) { skipped++; reportEntries.push({ id: c.sourceId, result: "skipped", reason: "already migrated" }); continue; }
        if (dryRun) {
          created++; reportEntries.push({ id: c.sourceId, result: "created", reason: "would create" });
          continue;
        }
        const doc = await prisma.document.create({
          data: {
            clubId,
            name: c.name,
            description: c.description ?? null,
            mimeType: c.mimeType ?? null,
            sizeBytes: c.sizeBytes ?? 0,
            storageKey: c.storageKey ?? null,
            status: "ACTIVE",
            searchText: `backfill:${source}:${c.sourceId}`,
            uploadedByUserId: c.uploadedByUserId ?? null,
            memberId: c.memberId ?? null,
            vendorId: c.vendorId ?? null,
            apInvoiceId: c.apInvoiceId ?? null,
            journalEntryId: c.journalEntryId ?? null,
            financingAgreementId: c.financingAgreementId ?? null,
            createdAt: c.createdAt ?? new Date(),
          },
        });
        await prisma.documentVersion.create({
          data: { clubId, documentId: doc.id, versionNumber: 1, storageKey: c.storageKey ?? null, sizeBytes: c.sizeBytes ?? 0 },
        });
        created++;
        reportEntries.push({ id: c.sourceId, result: "created" });
      } catch (err) {
        failed++;
        reportEntries.push({ id: c.sourceId, result: "failed", reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return await prisma.documentBackfillBatch.update({
      where: { id: batch.id },
      data: {
        totalCandidates: candidates.length, totalCreated: created, totalSkipped: skipped, totalFailed: failed,
        status: dryRun ? "DRY_RUN" : "COMPLETED",
        finishedAt: new Date(),
        reportJson: JSON.stringify(reportEntries).slice(0, 200_000),
      },
    });
  } catch (err) {
    return prisma.documentBackfillBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err), finishedAt: new Date() },
    });
  }
}

// Candidate shape (uniform across source tables).
type Candidate = {
  sourceId: string;
  name: string;
  description?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  storageKey?: string | null;
  uploadedByUserId?: string | null;
  createdAt?: Date | null;
  memberId?: string | null;
  vendorId?: string | null;
  apInvoiceId?: string | null;
  journalEntryId?: string | null;
  financingAgreementId?: string | null;
};

async function loadCandidates(clubId: string, source: SourceTable): Promise<Candidate[]> {
  switch (source) {
    case "MemberDocument": {
      const rows = await prisma.memberDocument.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes ?? 0,
        storageKey: r.storageKey, createdAt: r.createdAt,
        memberId: r.memberId,
      }));
    }
    case "JournalAttachment": {
      const rows = await prisma.journalAttachment.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes ?? 0,
        storageKey: r.storageKey, uploadedByUserId: r.uploadedByUserId, createdAt: r.uploadedAt,
        journalEntryId: r.journalEntryId,
      }));
    }
    case "APInvoiceAttachment": {
      const rows = await prisma.aPInvoiceAttachment.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes ?? 0,
        storageKey: r.storageKey, uploadedByUserId: r.uploadedByUserId, createdAt: r.uploadedAt,
        apInvoiceId: r.invoiceId,
      }));
    }
    case "ApplicationDocument": {
      const rows = await prisma.applicationDocument.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes,
        storageKey: r.storageKey, uploadedByUserId: r.uploadedByUserId, createdAt: r.uploadedAt,
      }));
    }
    case "FinancingDocument": {
      const rows = await prisma.financingDocument.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: `Financing agreement v${r.version}`, mimeType: "application/pdf",
        storageKey: r.storageKey, createdAt: r.createdAt,
        financingAgreementId: r.agreementId,
      }));
    }
    case "VendorDocument": {
      const rows = await prisma.vendorDocument.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes ?? 0,
        storageKey: r.storageKey, uploadedByUserId: r.uploadedByUserId, createdAt: r.uploadedAt,
        vendorId: r.vendorId,
      }));
    }
    case "ReceiptCapture": {
      const rows = await prisma.receiptCapture.findMany({ where: { clubId } });
      return rows.map((r) => ({
        sourceId: r.id, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes ?? 0,
        storageKey: r.storageKey, uploadedByUserId: r.uploadedByUserId, createdAt: r.uploadedAt,
      }));
    }
    default:
      throw new ConflictError(`Unknown source table: ${source}`);
  }
}

export async function listBackfillBatches(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "documents:read");
  return prisma.documentBackfillBatch.findMany({
    where: { clubId }, orderBy: { startedAt: "desc" }, take: 50,
  });
}
