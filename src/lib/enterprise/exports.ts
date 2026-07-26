// Phase 6H + 7A — Export pipeline.
//
// Renders a frozen ReportRun into CSV / XLSX / PDF / PPTX, persists the bytes
// through the StorageAdapter, links the result as a Document, and writes a
// ReportExport audit row. Status transitions: QUEUED → PROCESSING → COMPLETED
// (or FAILED with errorMessage).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError } from "../errors";
import { renderPDF, renderXLSX, renderPPTX, type ExportBundle } from "../integrations/exports";
import { activeStorage } from "./documents";

export type ExportFormat = "CSV" | "XLSX" | "PDF" | "PPTX";

export interface ExportAdapter {
  format: ExportFormat;
  render(rows: unknown[], meta: Record<string, unknown> | undefined): Promise<{ body: string; mimeType: string }>;
}

// CSV adapter (Phase 6 — pure-JS, no deps).
export const csvAdapter: ExportAdapter = {
  format: "CSV",
  async render(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { body: "", mimeType: "text/csv" };
    }
    const flatRows = rows.map((r) => flatten(r as Record<string, unknown>));
    const headers = Array.from(new Set(flatRows.flatMap((r) => Object.keys(r))));
    const lines = [headers.map(csvEscape).join(",")];
    for (const r of flatRows) {
      lines.push(headers.map((h) => csvEscape(r[h])).join(","));
    }
    return { body: lines.join("\n"), mimeType: "text/csv" };
  },
};

// Legacy placeholder adapters kept for tests / fallback when the production
// renderer libs are unavailable. The Phase 7 path goes through exportReportRun
// directly and skips these.
export const pdfAdapter: ExportAdapter = {
  format: "PDF",
  async render(rows, meta) {
    const summary = { rowCount: Array.isArray(rows) ? rows.length : 0, meta };
    return { body: `%PDF-1.4\n%Spectre Export Placeholder\n${JSON.stringify(summary)}\n%%EOF`, mimeType: "application/pdf" };
  },
};
export const xlsxAdapter: ExportAdapter = {
  format: "XLSX",
  async render(rows) {
    return { body: JSON.stringify({ note: "xlsx placeholder", rows: Array.isArray(rows) ? rows.length : 0 }), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  },
};
export const pptxAdapter: ExportAdapter = {
  format: "PPTX",
  async render(rows, meta) {
    return { body: JSON.stringify({ note: "pptx placeholder", meta, rows: Array.isArray(rows) ? rows.length : 0 }), mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  },
};

export async function exportReportRun(
  principal: Principal,
  reportRunId: string,
  format: ExportFormat,
  opts?: { packageId?: string }
) {
  const run = await prisma.reportRun.findUnique({ where: { id: reportRunId }, include: { definition: true } });
  assertTenantOwned(run, principal);
  requirePermission(principal, run.clubId, "reports:export");
  if (run.status !== "SUCCEEDED") throw new ConflictError("Report run did not succeed; nothing to export");
  if (!run.resultJson) throw new ConflictError("Report run has no result body");

  const club = await prisma.club.findUnique({ where: { id: run.clubId } });
  if (!club) throw new ConflictError("Club not found");

  // Optional package context (used by PDF/PPTX cover slides).
  let packageContext: ExportBundle["packageContext"] = null;
  if (opts?.packageId) {
    const pkg = await prisma.reportingPackage.findUnique({
      where: { id: opts.packageId },
      include: { commentaries: true },
    });
    if (pkg && pkg.clubId === run.clubId) {
      packageContext = {
        packageName: pkg.name, periodLabel: pkg.periodLabel, version: pkg.version,
        audience: pkg.audience, executiveSummary: pkg.executiveSummary,
        commentaries: pkg.commentaries.map((c) => ({ subject: c.subject, scope: c.scope, body: c.body })),
      };
    }
  }

  // Create the export row in PROCESSING state so failure cases retain a trail.
  const exp = await prisma.reportExport.create({
    data: {
      clubId: run.clubId, reportRunId: run.id, format,
      status: "PROCESSING", startedAt: new Date(),
      exportedByUserId: principal.id,
    },
  });
  try {
    // Parse the result body here so JSON failures are recorded on the export row.
    const parsed = JSON.parse(run.resultJson!) as { rows: unknown[]; meta?: Record<string, unknown> };
    let body: Buffer | string;
    let mimeType: string;
    if (format === "CSV") {
      const csv = await csvAdapter.render(parsed.rows ?? [], parsed.meta);
      body = csv.body;
      mimeType = csv.mimeType;
    } else {
      const bundle: ExportBundle = {
        reportKey: run.definition.key,
        reportName: run.definition.name,
        parameters: JSON.parse(run.parametersJson) as Record<string, unknown>,
        rows: parsed.rows ?? [],
        meta: parsed.meta,
        club: { name: club.name, primaryColor: club.primaryColor, logoUrl: club.logoUrl },
        generatedAt: new Date(),
        generatedBy: principal.name,
        packageContext,
      };
      const rendered = format === "PDF" ? await renderPDF(bundle)
                     : format === "XLSX" ? await renderXLSX(bundle)
                     : await renderPPTX(bundle);
      body = rendered.body;
      mimeType = rendered.mimeType;
    }
    const sizeBytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length;
    // Persist to storage.
    const storageKey = `reports/${run.id}/${exp.id}.${format.toLowerCase()}`;
    await activeStorage.put({ clubId: run.clubId, storageKey, body, mimeType });
    // Link to a Document so retention + audit log apply.
    const doc = await prisma.document.create({
      data: {
        clubId: run.clubId,
        name: `${run.definition.name} — ${run.startedAt.toISOString().slice(0, 10)}.${format.toLowerCase()}`,
        mimeType, sizeBytes, storageKey, status: "ACTIVE",
        searchText: run.definition.name,
        uploadedByUserId: principal.id,
        reportingPackageId: opts?.packageId ?? null,
      },
    });
    await prisma.documentVersion.create({
      data: { clubId: run.clubId, documentId: doc.id, versionNumber: 1, storageKey, sizeBytes, uploadedByUserId: principal.id },
    });
    const updated = await prisma.reportExport.update({
      where: { id: exp.id },
      data: {
        status: "COMPLETED", finishedAt: new Date(),
        sizeBytes, storageKey, documentId: doc.id,
      },
    });
    await audit(principal, {
      action: "report.export",
      entityType: "ReportExport", entityId: updated.id, clubId: run.clubId,
      after: { reportRunId: run.id, format, sizeBytes, documentId: doc.id },
    });
    return { export: updated, body, documentId: doc.id };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await prisma.reportExport.update({
      where: { id: exp.id },
      data: { status: "FAILED", finishedAt: new Date(), errorMessage },
    });
    await audit(principal, { action: "report.export.failed", entityType: "ReportExport", entityId: exp.id, clubId: run.clubId, after: { format, errorMessage } });
    throw err;
  }
}

export async function listExports(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "reports:export");
  return prisma.reportExport.findMany({
    where: { clubId }, orderBy: { exportedAt: "desc" }, take: 50,
    include: { reportRun: { include: { definition: true } } },
  });
}

// ---------------------------------------------------------------------------
function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
