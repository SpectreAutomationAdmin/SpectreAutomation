// Capture inbox service.
//
// Upload flow:
//   1. The client uploads to the storage adapter (Phase 7) and receives an
//      opaque storageKey.
//   2. `uploadCapture()` records metadata + runs the OCR/AI mock to populate
//      `extractedJson` / `suggestionJson` / `confidence`.
//   3. Optionally: `convertToInvoice()` materializes the capture as an AP
//      invoice DRAFT.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { mockOcrExtract, type OcrExtraction, type CodingSuggestion } from "./ocr";

export const captureUploadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  storageKey: z.string().trim().max(500).optional().nullable(),
  mimeType: z.string().trim().max(100).default("application/pdf"),
  sizeBytes: z.number().int().min(0).max(50_000_000).default(0),
});

// Upload metadata + run OCR. The adapter is pluggable — see src/lib/ap/ocr.ts.
export async function uploadCapture(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "ap:capture:upload");
  const parsed = captureUploadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const { extraction, suggestion } = await mockOcrExtract(parsed.data.name, parsed.data.sizeBytes);

  // Duplicate hint: same vendor invoiceNumber already on file?
  let duplicateOfInvoiceId: string | null = null;
  if (extraction.vendorName && extraction.invoiceNumber) {
    const vendor = await prisma.vendor.findFirst({ where: { clubId, legalName: extraction.vendorName } });
    if (vendor) {
      const dup = await prisma.aPInvoice.findFirst({
        where: { clubId, vendorId: vendor.id, vendorReference: extraction.invoiceNumber },
      });
      if (dup) duplicateOfInvoiceId = dup.id;
    }
  }

  const created = await prisma.receiptCapture.create({
    data: {
      clubId,
      name: parsed.data.name,
      storageKey: parsed.data.storageKey ?? null,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      status: duplicateOfInvoiceId ? "DUPLICATE" : "NEEDS_REVIEW",
      extractedJson: JSON.stringify(extraction),
      suggestionJson: JSON.stringify(suggestion),
      confidence: extraction.confidence,
      duplicateOfInvoiceId,
      uploadedByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "capture.upload",
    entityType: "ReceiptCapture", entityId: created.id, clubId,
    after: { name: created.name, status: created.status, confidence: created.confidence.toString() },
    meta: { duplicateOfInvoiceId },
  });
  return created;
}

export async function listInbox(principal: Principal, clubId: string, opts?: { status?: string }) {
  if (!hasPermission(principal, clubId, "ap:capture:view")) return [];
  return prisma.receiptCapture.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: { uploadedAt: "desc" },
    take: 100,
  });
}

export async function getCapture(principal: Principal, captureId: string) {
  const cap = await prisma.receiptCapture.findUnique({ where: { id: captureId } });
  if (!cap) throw new NotFoundError("ReceiptCapture", captureId);
  assertTenantOwned(cap, principal);
  if (!hasPermission(principal, cap.clubId, "ap:capture:view")) throw new NotFoundError("ReceiptCapture", captureId);
  return cap;
}

export function parseExtraction(cap: { extractedJson: string | null }): OcrExtraction | null {
  if (!cap.extractedJson) return null;
  try { return JSON.parse(cap.extractedJson); } catch { return null; }
}

export function parseSuggestion(cap: { suggestionJson: string | null }): CodingSuggestion | null {
  if (!cap.suggestionJson) return null;
  try { return JSON.parse(cap.suggestionJson); } catch { return null; }
}

export async function rejectCapture(principal: Principal, captureId: string, reason: string) {
  const cap = await prisma.receiptCapture.findUnique({ where: { id: captureId } });
  assertTenantOwned(cap, principal);
  requirePermission(principal, cap.clubId, "ap:capture:upload");
  if (cap.status === "CONVERTED") throw new ConflictError("Already converted");
  const updated = await prisma.receiptCapture.update({
    where: { id: captureId },
    data: { status: "REJECTED" },
  });
  await audit(principal, {
    action: "capture.reject",
    entityType: "ReceiptCapture", entityId: captureId, clubId: cap.clubId,
    before: { status: cap.status }, after: { status: "REJECTED" },
    meta: { reason },
  });
  return updated;
}

export async function markConverted(captureId: string, invoiceId: string) {
  await prisma.receiptCapture.update({
    where: { id: captureId },
    data: { status: "CONVERTED", convertedAt: new Date() },
  });
}
