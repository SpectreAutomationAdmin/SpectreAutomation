// Sprint 3 · Post-16H Phase 4 Slice 3-hotfix (2026-08-06) —
// diagnostic endpoint for a specific staging Work Intake item.
// Purpose: read the CURRENT analyseIngestedInvoice output for a
// WI without going through the mission-control projection layer,
// so we can observe divergence between (a) the analyser's output
// and (b) the card's rendered values.
//
// Security: identical posture to /api/ap-intelligence/replay-analyse
//   * staging-only (404 in production)
//   * SUPER_ADMIN or system:audit:read only
//   * tenant scoped (WI must belong to the caller's active club)
//   * read-only (no DB writes, no queue enqueue)
//   * bounded payload / execution time
//   * no raw document text logged
//
// Body:
//   { wiId?: string; wiIdSuffix4?: string; }
//
// Response:
//   { workIntakeItem, ingestedDocument, analyseResult, extractedTextSample }
//
// extractedTextSample is a HEAD sample of the pdf-parse output so
// we can eyeball what the analyser is actually parsing. Capped at
// 2KB and returned only to authorised callers.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { analyseIngestedInvoice } from "@/lib/ap-intelligence/analyse";

function isStagingEnv(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase();
  return env !== "production" && env !== "prod";
}

const bodySchema = z.object({
  wiId: z.string().min(1).optional(),
  wiIdSuffix4: z.string().length(4).optional(),
}).refine((v) => v.wiId || v.wiIdSuffix4, { message: "wiId or wiIdSuffix4 required" });

export async function POST(req: Request) {
  if (!isStagingEnv()) return new NextResponse("Not Found", { status: 404 });
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ ok: false, error: "NO_CLUB" }, { status: 400 });
  if (!isSuperAdmin(principal) && !hasPermission(principal, clubId, "system:audit:read")) {
    return NextResponse.json({ ok: false, error: "PERMISSION" }, { status: 403 });
  }
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "VALIDATION" }, { status: 400 });

  // Resolve WI. Tenant-scoped.
  const wi = parsed.data.wiId
    ? await prisma.workIntakeItem.findFirst({
        where: { id: parsed.data.wiId, clubId },
        select: { id: true, status: true, displaySender: true, createdAt: true },
      })
    : await prisma.workIntakeItem.findFirst({
        where: { clubId, id: { endsWith: parsed.data.wiIdSuffix4!.toLowerCase() } },
        select: { id: true, status: true, displaySender: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
  if (!wi) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  // Locate the underlying IngestedDocument via ApIntakeSource (the
  // canonical mapping introduced in Sprint 3 Checkpoint 15-P-ish).
  const source = await prisma.apIntakeSource.findFirst({
    where: { clubId, canonicalApIntakeId: wi.id },
    select: { ingestedDocumentId: true, emailAttachmentId: true, emailMessageId: true },
    orderBy: { createdAt: "desc" },
  });
  if (!source?.ingestedDocumentId) {
    return NextResponse.json({ ok: true, workIntakeItem: wi, ingestedDocument: null, analyseResult: null, note: "no ApIntakeSource → no ingested document to analyse" });
  }
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: source.ingestedDocumentId, clubId },
    select: { id: true, filename: true, mimeType: true, sourceKind: true, sha256Hash: true, byteLength: true },
  });
  let analyseResult: unknown = null;
  let extractedTextSample: string | null = null;
  try {
    const result = await analyseIngestedInvoice({ clubId, ingestedDocumentId: source.ingestedDocumentId });
    analyseResult = {
      state: result.extraction.state,
      extractedTextChars: result.extraction.extractedTextChars,
      supplierGuessedName: result.extraction.vendor.guessedName,
      invoiceNumber: result.extraction.invoiceNumber,
      subtotal: result.extraction.subtotal,
      taxTotal: result.extraction.taxTotal,
      total: result.extraction.total,
      currency: result.extraction.currency,
      warnings: result.extraction.warnings,
    };
    // Additional canonical-evidence view: re-fetch the ingested
    // document bytes through the standard retrieval path + re-run
    // parseInvoiceText so we can surface the ranked supplier
    // candidates + winner. Skipped silently if any step fails.
    try {
      const { getDocumentBytes } = await import("@/lib/documents/retrieve");
      const { parseInvoiceText } = await import("@/lib/ap-intelligence/parse-invoice");
      const pdfParse = (await import("pdf-parse")).default;
      const bytes = await getDocumentBytes(
        { clubId, documentId: source.ingestedDocumentId, actorUserId: principal.id },
        "PREVIEW",
      );
      const parsed = await pdfParse(bytes.bytes);
      const text = (parsed.text ?? "").trim();
      extractedTextSample = text.slice(0, 2000);
      const p = parseInvoiceText({ extractedText: text });
      (analyseResult as { canonicalSupplierCandidates?: unknown }).canonicalSupplierCandidates =
        p.canonicalEvidence?.fields.supplierCandidates.slice(0, 8) ?? null;
      (analyseResult as { canonicalSupplierWinner?: unknown }).canonicalSupplierWinner =
        p.selection?.supplier ?? null;
    } catch (pErr) {
      (analyseResult as { canonicalProbeError?: string }).canonicalProbeError =
        pErr instanceof Error ? pErr.message : String(pErr);
    }
  } catch (err) {
    analyseResult = { error: err instanceof Error ? err.message : "unknown" };
  }
  return NextResponse.json({
    ok: true,
    workIntakeItem: wi,
    ingestedDocument: doc,
    apIntakeSource: source,
    analyseResult,
    extractedTextSample,
  });
}
