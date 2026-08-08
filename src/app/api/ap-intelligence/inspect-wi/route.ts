// Sprint 3 · Post-16H Phase 4 Slice 3-forensic (2026-08-06) —
// full attachment-chain forensic diagnostic for the DMM incident.
// Founder §1-§4 audit path:
//
//   Graph (live) → EmailMessage → EmailAttachment →
//   IngestedDocument → WorkIntakeOrigin → ApIntakeSource →
//   canonical AP intake → mailbox-sync BackgroundJob history
//
// Every stage is reported with sanitised IDs (hashes / suffixes)
// and error classes only. No email body, no subject, no filenames
// beyond suffix. No secrets.
//
// Security posture:
//   * staging-only (SPECTRE_ENV != production → 404)
//   * SUPER_ADMIN or system:audit:read only
//   * tenant scoped
//   * read-only — no writes, no queue enqueue, no OCR provider
//   * bounded execution time
//
// Body:
//   { wiId?: string; wiIdSuffix4?: string; probeGraph?: boolean; }
//
// When probeGraph is true AND the underlying EmailMessage is
// reachable, we live-fetch the attachment list from Microsoft
// Graph via getFreshDelegatedAccessToken + listAttachmentMetadata
// so we can compare Spectre's persisted state against Graph's
// authoritative truth.

import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

function isStagingEnv(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase();
  return env !== "production" && env !== "prod";
}
function hashTail(v: string | null | undefined): string {
  if (!v) return "(null)";
  return "h_" + crypto.createHash("sha1").update(v).digest("hex").slice(-10);
}
function idTail(v: string | null | undefined, n: number = 8): string {
  if (!v) return "(null)";
  return v.slice(-n);
}

const bodySchema = z.object({
  wiId: z.string().min(1).optional(),
  wiIdSuffix4: z.string().length(4).optional(),
  probeGraph: z.boolean().optional().default(false),
  // Phase 4 · Slice 5 (2026-08-07) — diagnostic-only positional trace
  // + two-extractor side-by-side. Staging-only, SUPER_ADMIN-gated,
  // additive to the existing analyseResult block. Does not alter any
  // production analyser code path.
  positionalTrace: z.boolean().optional().default(false),
  extractorDiff: z.boolean().optional().default(false),
  // Discovery mode — resolve a suffix from a filename / sender /
  // invoice-number hint. Used to find the second Oakcreek WI when
  // only the invoice number is known.
  discover: z.object({
    filenameContains: z.string().min(1).max(80).optional(),
    senderContains: z.string().min(1).max(80).optional(),
    invoiceNumberContains: z.string().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(50).optional().default(20),
  }).optional(),
}).refine((v) => v.wiId || v.wiIdSuffix4 || v.discover, {
  message: "wiId, wiIdSuffix4, or discover required",
});

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

  // ---- Discovery mode (early return) ------------------------------
  // When called with { discover: {...} } we return a list of matching
  // Work Intake IDs (as 4-char suffixes for downstream trace calls).
  // Sanitised: only surface displaySender + filename suffix + createdAt.
  if (parsed.data.discover) {
    const disc = parsed.data.discover;
    const limit = disc.limit ?? 20;

    // Step 1: find IngestedDocuments matching filename / invoice-number
    // hints. These give us canonicalApIntakeId via ApIntakeSource.
    let matchingDocIds: string[] = [];
    if (disc.filenameContains || disc.invoiceNumberContains) {
      const docs = await prisma.ingestedDocument.findMany({
        where: {
          clubId,
          OR: [
            ...(disc.filenameContains ? [{ filename: { contains: disc.filenameContains } as const }] : []),
            ...(disc.invoiceNumberContains ? [{ filename: { contains: disc.invoiceNumberContains } as const }] : []),
          ],
        },
        select: { id: true, filename: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      matchingDocIds = docs.map((d) => d.id);
    }
    const apSources = matchingDocIds.length > 0
      ? await prisma.apIntakeSource.findMany({
          where: { clubId, ingestedDocumentId: { in: matchingDocIds } },
          select: { canonicalApIntakeId: true, ingestedDocumentId: true },
        })
      : [];
    const wiIdsFromDocs = Array.from(new Set(apSources.map((s) => s.canonicalApIntakeId).filter(Boolean)));

    // Step 2: also filter by displaySender if provided.
    const wisBySender = disc.senderContains
      ? await prisma.workIntakeItem.findMany({
          where: {
            clubId,
            displaySender: { contains: disc.senderContains },
          },
          select: {
            id: true, displaySender: true, createdAt: true, status: true,
            classification: true,
          },
          orderBy: { createdAt: "desc" },
          take: limit * 2,
        })
      : [];

    const wisById = wiIdsFromDocs.length > 0
      ? await prisma.workIntakeItem.findMany({
          where: { clubId, id: { in: wiIdsFromDocs as string[] } },
          select: {
            id: true, displaySender: true, createdAt: true, status: true,
            classification: true,
          },
          orderBy: { createdAt: "desc" },
          take: limit * 2,
        })
      : [];

    const combined = new Map<string, typeof wisBySender[number]>();
    for (const w of wisBySender) combined.set(w.id, w);
    for (const w of wisById) combined.set(w.id, w);
    const matches = Array.from(combined.values()).slice(0, limit);

    // Resolve one filename per WI for context (best-effort).
    const filenameByWiId = new Map<string, string>();
    if (matches.length > 0) {
      const wiIds = matches.map((m) => m.id);
      const sources = await prisma.apIntakeSource.findMany({
        where: { clubId, canonicalApIntakeId: { in: wiIds } },
        select: { canonicalApIntakeId: true, ingestedDocumentId: true },
      });
      const docIds = Array.from(new Set(sources.map((s) => s.ingestedDocumentId).filter(Boolean))) as string[];
      const docs = docIds.length > 0
        ? await prisma.ingestedDocument.findMany({
            where: { clubId, id: { in: docIds } },
            select: { id: true, filename: true },
          })
        : [];
      const docFilenameById = new Map(docs.map((d) => [d.id, d.filename]));
      for (const s of sources) {
        const fn = docFilenameById.get(s.ingestedDocumentId!);
        if (fn && !filenameByWiId.has(s.canonicalApIntakeId!)) {
          filenameByWiId.set(s.canonicalApIntakeId!, fn);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      discover: {
        query: {
          filenameContains: disc.filenameContains ?? null,
          senderContains: disc.senderContains ?? null,
          invoiceNumberContains: disc.invoiceNumberContains ?? null,
          limit,
        },
        matchCount: matches.length,
        matches: matches.map((m) => ({
          wiIdSuffix4: m.id.slice(-4),
          wiIdSuffix8: m.id.slice(-8),
          displaySender: m.displaySender,
          status: m.status,
          classification: m.classification,
          createdAt: m.createdAt,
          filenameSuffix: (filenameByWiId.get(m.id) ?? "").slice(-32) || null,
        })),
      },
    });
  }

  // ---- (1) Work Intake Item ----------------------------------------
  const wi = parsed.data.wiId
    ? await prisma.workIntakeItem.findFirst({
        where: { id: parsed.data.wiId, clubId },
        select: {
          id: true, status: true, displaySender: true, createdAt: true,
          classification: true, classificationMethod: true, classificationConfidence: true,
          classificationRuleKey: true, judgmentRequired: true,
        },
      })
    : await prisma.workIntakeItem.findFirst({
        where: { clubId, id: { endsWith: parsed.data.wiIdSuffix4!.toLowerCase() } },
        select: {
          id: true, status: true, displaySender: true, createdAt: true,
          classification: true, classificationMethod: true, classificationConfidence: true,
          classificationRuleKey: true, judgmentRequired: true,
        },
        orderBy: { createdAt: "desc" },
      });
  if (!wi) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  // ---- (2) Email origin (WorkIntakeOrigin / EmailWorkIntakeOrigin) --
  const emailOrigins = await prisma.emailWorkIntakeOrigin.findMany({
    where: { clubId, workIntakeItemId: wi.id },
    select: {
      id: true, emailMessageId: true, role: true, linkReason: true, createdAt: true,
    },
  });

  // ---- (3) EmailMessage(s) ----------------------------------------
  const emailMsgs = emailOrigins.length > 0
    ? await prisma.emailMessage.findMany({
        where: { id: { in: emailOrigins.map((o) => o.emailMessageId) } },
        select: {
          id: true, mailboxConnectionId: true, graphMessageId: true,
          internetMessageId: true, conversationId: true, senderAddress: true,
          receivedAt: true, hasAttachments: true, isRead: true,
          lastSyncedAt: true, retryAttempts: true, ingestFailedAt: true, ingestFailReason: true,
        },
      })
    : [];

  // ---- (4) EmailAttachments -----------------------------------------
  const attachments = emailMsgs.length > 0
    ? await prisma.emailAttachment.findMany({
        where: { emailMessageId: { in: emailMsgs.map((m) => m.id) } },
        select: {
          id: true, emailMessageId: true, graphAttachmentId: true, filename: true,
          contentType: true, sizeBytes: true, isInline: true, storageState: true,
          storageKey: true, scanState: true, createdAt: true, updatedAt: true,
        },
      })
    : [];

  // ---- (5) ApIntakeSource(s) ---------------------------------------
  const apSources = await prisma.apIntakeSource.findMany({
    where: { clubId, canonicalApIntakeId: wi.id },
    select: {
      id: true, emailAttachmentId: true, emailMessageId: true,
      ingestedDocumentId: true, relationship: true, reason: true,
      analysisVersionAtLink: true, createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  // Also look up any ApIntakeSource keyed on the attachment IDs we
  // found — catches the case where the source exists but points at
  // a DIFFERENT canonical intake.
  const attachmentIds = attachments.map((a) => a.id);
  const apSourcesByAttachment = attachmentIds.length > 0
    ? await prisma.apIntakeSource.findMany({
        where: { clubId, emailAttachmentId: { in: attachmentIds } },
        select: {
          id: true, emailAttachmentId: true, canonicalApIntakeId: true,
          ingestedDocumentId: true, relationship: true, createdAt: true,
        },
      })
    : [];

  // ---- (6) IngestedDocument(s) -------------------------------------
  const docIds = Array.from(new Set([
    ...apSources.map((s) => s.ingestedDocumentId).filter(Boolean),
    ...apSourcesByAttachment.map((s) => s.ingestedDocumentId).filter(Boolean),
  ]));
  const docs = docIds.length > 0
    ? await prisma.ingestedDocument.findMany({
        where: { id: { in: docIds as string[] }, clubId },
        select: {
          id: true, filename: true, mimeType: true, sha256Hash: true,
          byteLength: true, storageKey: true, storageBucket: true,
          sourceKind: true, sourceReferenceId: true, receivedAt: true, createdAt: true,
        },
      })
    : [];

  // Phase 4 · Slice 4 (2026-08-07) — real-bytes canonical trace.
  // Runs the deployed production analyser against the actual PDF
  // bytes of the FIRST linked IngestedDocument (whether accessed as
  // apIntakeSources or apIntakeSourcesByAttachment). Returns a 2KB
  // sample of the pdf-parse text + ranked supplier candidates +
  // selection winner so the caller can see EXACTLY what the
  // analyser produces from real bytes.
  let analyseResult: unknown = null;
  let extractedTextSample: string | null = null;
  const primaryDocId = docs[0]?.id ?? null;
  if (primaryDocId) {
    try {
      const { analyseIngestedInvoice } = await import("@/lib/ap-intelligence/analyse");
      const result = await analyseIngestedInvoice({ clubId, ingestedDocumentId: primaryDocId });
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
        // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — accounting-
        // reasoning trace. Diagnostic-only exposure of the outputs
        // that today drive the founder-facing category.
        legacyEconomicPurposeTop3: (result.economicPurpose ?? []).slice(0, 3).map((p) => ({
          purpose: p.purpose,
          score: p.score,
          classificationConcept: p.classificationConcept,
          supporting: (p.supporting ?? []).slice(0, 6).map((s) => ({
            kind: s.kind,
            detail: (s.detail ?? "").slice(0, 120),
            strength: s.strength,
          })),
          contradicting: (p.contradicting ?? []).slice(0, 4).map((c) => ({
            kind: c.kind,
            detail: (c.detail ?? "").slice(0, 120),
          })),
        })),
        capitalState: (result as { capital?: { state?: string; capitalClass?: string } }).capital?.state
          ?? (result as { capitalState?: string }).capitalState
          ?? null,
        accountingIntelligence: {
          natureLeader: result.accountingIntelligence?.natureLeader,
          natureConfidence: result.accountingIntelligence?.natureConfidence,
          natureIsDefensible: result.accountingIntelligence?.natureIsDefensible,
          natureRankedTop3: (result.accountingIntelligence?.natureRankedTop3 ?? []).slice(0, 3).map((r) => ({
            nature: r.nature,
            score: r.score,
            supporting: (r.supportingEvidence ?? []).slice(0, 5),
            contradicting: (r.contradictingEvidence ?? []).slice(0, 3),
          })),
        },
        allocations: {
          cardCategory: result.allocations?.cardCategory ?? null,
          requiresReview: result.allocations?.requiresReview ?? null,
          allocationEligibilityMode: result.allocations?.allocationEligibilityMode ?? null,
          entryCount: result.allocations?.allocations?.length ?? 0,
          entries: (result.allocations?.allocations ?? []).slice(0, 6).map((a) => ({
            purpose: (a as { purpose?: string }).purpose ?? null,
            recommendedAccountNumber: (a as { recommendedAccount?: { accountNumber?: string } }).recommendedAccount?.accountNumber ?? null,
            recommendedAccountName: (a as { recommendedAccount?: { accountName?: string } }).recommendedAccount?.accountName ?? null,
            amountCents: (a as { amountCents?: number }).amountCents ?? null,
            requiresReview: (a as { requiresReview?: boolean }).requiresReview ?? null,
          })),
        },
        glRecommendationWinner: {
          accountNumber: (result as { gl?: { accountNumber?: string } }).gl?.accountNumber ?? null,
          accountName: (result as { gl?: { accountName?: string } }).gl?.accountName ?? null,
          confidence: (result as { gl?: { confidence?: number } }).gl?.confidence ?? null,
          source: (result as { gl?: { source?: string } }).gl?.source ?? null,
        },
        glAlternativesTop3: ((result as { gl?: { alternatives?: Array<{ accountNumber?: string; accountName?: string; score?: number }> } }).gl?.alternatives ?? []).slice(0, 3).map((a) => ({
          accountNumber: a.accountNumber ?? null,
          accountName: a.accountName ?? null,
          score: a.score ?? null,
        })),
        // Sprint 3 · Phase 4 Slice 5.2 completion audit (2026-08-08) —
        // full base-ranker candidate list so we can see if
        // purpose-compatible accounts (e.g. 6025 Fuel, 6031 R & M -
        // Ground Equip, 1506 Equipment & Fixtures - Grounds) were
        // ranked below the top-5 cutoff.
        glCandidatesFull: ((result as { gl?: { candidates?: Array<{ accountNumber?: string; accountName?: string; confidence?: number; postable?: boolean }> } }).gl?.candidates ?? []).map((c) => ({
          accountNumber: c.accountNumber ?? null,
          accountName: c.accountName ?? null,
          confidence: c.confidence ?? null,
          postable: c.postable ?? null,
        })),
      };
    } catch (err) {
      analyseResult = { error: err instanceof Error ? err.message : "unknown" };
    }
    try {
      const { getDocumentBytes } = await import("@/lib/documents/retrieve");
      const { parseInvoiceText } = await import("@/lib/ap-intelligence/parse-invoice");
      const pdfParse = (await import("pdf-parse")).default;
      const bytes = await getDocumentBytes(
        { clubId, documentId: primaryDocId, actorUserId: principal.id },
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
      (analyseResult as { canonicalPayableRef?: unknown }).canonicalPayableRef =
        p.selection?.payableReference ?? null;
      (analyseResult as { canonicalSubtotal?: unknown }).canonicalSubtotal =
        p.selection?.subtotal ?? null;
      (analyseResult as { canonicalTax?: unknown }).canonicalTax =
        p.selection?.tax ?? null;
      (analyseResult as { canonicalTotal?: unknown }).canonicalTotal =
        p.selection?.total ?? null;
      (analyseResult as { canonicalCurrency?: unknown }).canonicalCurrency =
        p.selection?.currency ?? null;
      (analyseResult as { canonicalLineItems?: unknown }).canonicalLineItems =
        p.canonicalEvidence?.lineItems.slice(0, 12) ?? null;
      (analyseResult as { canonicalConflicts?: unknown }).canonicalConflicts =
        p.canonicalEvidence?.evidenceConflicts ?? null;
      (analyseResult as { amountReconciliation?: unknown }).amountReconciliation =
        p.selection?.amountReconciliation ?? null;
    } catch (pErr) {
      (analyseResult as { canonicalProbeError?: string }).canonicalProbeError =
        pErr instanceof Error ? pErr.message : String(pErr);
    }
  }

  // Phase 4 · Slice 5 (2026-08-07) — additive positional-layout trace
  // + two-extractor side-by-side. Enabled by { positionalTrace: true }
  // / { extractorDiff: true }. Does not alter any production analyser
  // path — pure diagnostic. Sanitised: text samples truncated, no raw
  // bytes exposed, item counts bounded.
  let positionalTrace: unknown = null;
  let lineItemPaths: unknown = null;
  if (primaryDocId && (parsed.data.positionalTrace || parsed.data.extractorDiff)) {
    try {
      const { getDocumentBytes } = await import("@/lib/documents/retrieve");
      const bytes = await getDocumentBytes(
        { clubId, documentId: primaryDocId, actorUserId: principal.id },
        "PREVIEW",
      );

      if (parsed.data.positionalTrace) {
        try {
          const { extractPdfLayout } = await import("@/lib/ap-intelligence/pdf-layout-extract");
          const { reconstructLineItemTable } = await import("@/lib/ap-intelligence/positioned-table-reconstruct");
          const { extractCanonicalLineItems } = await import("@/lib/ap-intelligence/canonical-line-item-extractor");
          const { DeterministicTaxonomyProvider } = await import("@/lib/ap-intelligence/economic-purpose-taxonomy");
          const layout = await extractPdfLayout(bytes.bytes);
          const table = reconstructLineItemTable(layout);

          // Slice 5 — canonical authority + purpose taxonomy trace.
          const canon = await extractCanonicalLineItems({ layout, flattenedText: layout.flattenedText, pageCount: layout.pageCount });
          const provider = new DeterministicTaxonomyProvider();
          const purposeCandidates = provider.classify(canon.lineItems, {
            supplierName: (analyseResult as { supplierGuessedName?: string })?.supplierGuessedName ?? null,
            fullDocumentText: layout.flattenedText,
          });
          (analyseResult as { canonicalLineItemsV2?: unknown }).canonicalLineItemsV2 = canon.lineItems.slice(0, 25).map((li) => ({
            description: li.description.slice(0, 120),
            quantity: li.quantity,
            unit: li.unit,
            unitPrice: li.unitPrice,
            extension: li.extension,
            role: li.role,
            sourceStrategy: li.sourceStrategy,
            arithmetic: li.arithmetic,
            validationConfidence: li.validationConfidence,
            page: li.page,
          }));
          (analyseResult as { canonicalDiagnostic?: unknown }).canonicalDiagnostic = canon.diagnostic;
          (analyseResult as { canonicalPages?: unknown }).canonicalPages = canon.pages;
          (analyseResult as { canonicalOcrPending?: unknown }).canonicalOcrPending = canon.ocrPending;
          (analyseResult as { canonicalRegionsCount?: unknown }).canonicalRegionsCount = canon.regions.length;
          (analyseResult as { canonicalRegions?: unknown }).canonicalRegions = canon.regions.map((r) => ({
            kind: r.kind, page: r.page, yTop: r.yTop, yBottom: r.yBottom,
            confidence: r.confidence, diagnostic: r.diagnostic,
          }));
          (analyseResult as { purposeTaxonomyTop3?: unknown }).purposeTaxonomyTop3 = purposeCandidates.slice(0, 3).map((p) => ({
            concept: p.concept, label: p.label, confidence: p.confidence,
            supportingCount: p.supporting.length,
            supportingSample: p.supporting.slice(0, 3).map((s) => ({
              cue: s.cue, strength: s.strength, reason: s.reason,
              lineItemDescription: s.lineItemDescription,
            })),
          }));

          const perPageItemCount = new Map<number, number>();
          for (const it of layout.items) {
            perPageItemCount.set(it.page, (perPageItemCount.get(it.page) ?? 0) + 1);
          }
          const perPageVisualLineCount = new Map<number, number>();
          for (const vl of layout.visualLines) {
            perPageVisualLineCount.set(vl.page, (perPageVisualLineCount.get(vl.page) ?? 0) + 1);
          }

          // Header-region sampling: if header found, take items /
          // visualLines within ±200 y-units on the header's page.
          // Otherwise take the first 120 items and first 40 lines in
          // document order.
          const headerPage = table.headerFound && table.headerRowY != null
            ? layout.visualLines.find((l) => l.y === table.headerRowY)?.page ?? 1
            : layout.items[0]?.page ?? 1;
          const headerY = table.headerRowY ?? layout.items[0]?.y ?? 0;

          const inRegion = (page: number, y: number) => {
            if (!table.headerFound) return true;
            return page === headerPage && Math.abs(y - headerY) <= 300;
          };

          const itemsInRegion = layout.items
            .filter((it) => inRegion(it.page, it.y))
            .slice(0, 150)
            .map((it) => ({
              text: it.text.slice(0, 80),
              page: it.page,
              x: it.x,
              y: it.y,
              width: it.width,
              height: it.height,
            }));
          const visualLinesInRegion = layout.visualLines
            .filter((vl) => inRegion(vl.page, vl.y))
            .slice(0, 60)
            .map((vl) => ({
              page: vl.page,
              y: vl.y,
              text: vl.text.slice(0, 200),
              itemCount: vl.items.length,
            }));

          // Arithmetic relationships from reconstructed rows.
          const arithmetic = table.lineItems
            .filter((li) => li.quantity != null && li.unitPrice != null && li.amount != null)
            .map((li) => {
              const expected = Math.round((li.quantity! * li.unitPrice!) * 100) / 100;
              const delta = Math.round((expected - li.amount!) * 100) / 100;
              return {
                page: li.page,
                rowY: li.rowY,
                qty: li.quantity,
                unit: li.unitPrice,
                amount: li.amount,
                expected,
                delta,
                withinTolerance: Math.abs(delta) <= 0.02,
              };
            })
            .slice(0, 30);

          // Header row context — the actual text of the visualLine
          // matched as header, if any.
          const headerLine = table.headerFound && table.headerRowY != null
            ? layout.visualLines.find((l) => l.y === table.headerRowY && l.page === headerPage)
            : null;

          positionalTrace = {
            pageCount: layout.pageCount,
            embeddedTextChars: layout.flattenedText.length,
            totalPositionedItems: layout.items.length,
            totalVisualLines: layout.visualLines.length,
            perPageItemCount: [...perPageItemCount.entries()].sort((a, b) => a[0] - b[0])
              .map(([page, count]) => ({ page, count })),
            perPageVisualLineCount: [...perPageVisualLineCount.entries()].sort((a, b) => a[0] - b[0])
              .map(([page, count]) => ({ page, count })),
            layoutFallback: layout.items.length === 0
              ? "COORDINATES_UNAVAILABLE_falling_back_to_flattened_text"
              : null,
            tableReconstruction: {
              headerFound: table.headerFound,
              headerRowY: table.headerRowY,
              headerRowText: headerLine ? headerLine.text.slice(0, 200) : null,
              headerRowItemCount: headerLine ? headerLine.items.length : 0,
              detectedColumns: table.detectedColumns,
              columnAlignmentConfidence: table.columnAlignmentConfidence,
              lineItemCount: table.lineItems.length,
              rejectedRowsCount: table.rejectedRows.length,
              lineItems: table.lineItems.slice(0, 20).map((li) => ({
                page: li.page,
                rowY: li.rowY,
                sku: li.sku,
                description: li.description.slice(0, 120),
                quantity: li.quantity,
                unitPrice: li.unitPrice,
                amount: li.amount,
                supportingCellCount: li.supportingCellCount,
                confidence: li.confidence,
              })),
              rejectedRows: table.rejectedRows.slice(0, 25).map((r) => ({
                y: r.y,
                text: r.text.slice(0, 100),
                reason: r.reason,
              })),
              arithmetic,
            },
            invoiceRegionItemsSample: itemsInRegion,
            visualLinesSample: visualLinesInRegion,
          };
        } catch (posErr) {
          positionalTrace = {
            error: posErr instanceof Error ? posErr.message : String(posErr),
          };
        }
      }

      if (parsed.data.extractorDiff) {
        try {
          // Use the flattened text from pdf-parse (the exact input the
          // production line-item extractors consume today).
          const pdfParse = (await import("pdf-parse")).default;
          const parsedPdf = await pdfParse(bytes.bytes);
          const text = (parsedPdf.text ?? "").trim();
          const pageCount = parsedPdf.numpages ?? 1;

          const { extractLineItemsFromText } = await import("@/lib/ap-intelligence/evidence/line-items");
          const { extractLineItems } = await import("@/lib/ap-intelligence/line-items-extract");
          const pathA = extractLineItemsFromText(text, pageCount);
          const pathB = extractLineItems(text);

          const pathADescs = new Set(pathA.lineItems.map((l) => l.description.value));
          const pathBDescs = new Set(pathB.map((l) => l.description));
          const onlyInA = [...pathADescs].filter((d) => !pathBDescs.has(d)).slice(0, 10);
          const onlyInB = [...pathBDescs].filter((d) => !pathADescs.has(d)).slice(0, 10);

          lineItemPaths = {
            pathA_build_canonical_evidence: {
              source: "src/lib/ap-intelligence/evidence/line-items.ts :: extractLineItemsFromText",
              lineItemCount: pathA.lineItems.length,
              creditCount: pathA.credits.length,
              surchargeCount: pathA.surcharges.length,
              interestOrPenaltyCount: pathA.interestOrPenalty.length,
              conflictCount: pathA.conflicts.length,
              lineItems: pathA.lineItems.slice(0, 15).map((l) => ({
                description: l.description.value.slice(0, 120),
                quantity: l.quantity?.value ?? null,
                unitPrice: l.unitPrice?.value ?? null,
                amount: l.amount.value,
              })),
              credits: pathA.credits.slice(0, 5).map((l) => ({
                description: l.description.value.slice(0, 120),
                amount: l.amount.value,
              })),
              surcharges: pathA.surcharges.slice(0, 5).map((l) => ({
                description: l.description.value.slice(0, 120),
                amount: l.amount.value,
              })),
              conflicts: pathA.conflicts.slice(0, 5),
            },
            pathB_analyse_pipeline: {
              source: "src/lib/ap-intelligence/line-items-extract.ts :: extractLineItems",
              lineItemCount: pathB.length,
              lineItems: pathB.slice(0, 15).map((l) => ({
                description: l.description.slice(0, 120),
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                amount: l.amount,
                taxTreatment: l.taxTreatment,
                confidence: l.confidence,
                evidence: l.evidence,
              })),
            },
            divergence: {
              descriptionsOnlyInPathA: onlyInA,
              descriptionsOnlyInPathB: onlyInB,
              countDelta: pathA.lineItems.length - pathB.length,
            },
          };
        } catch (diffErr) {
          lineItemPaths = {
            error: diffErr instanceof Error ? diffErr.message : String(diffErr),
          };
        }
      }
    } catch (bytesErr) {
      const msg = bytesErr instanceof Error ? bytesErr.message : String(bytesErr);
      if (parsed.data.positionalTrace) positionalTrace = { bytesError: msg };
      if (parsed.data.extractorDiff) lineItemPaths = { bytesError: msg };
    }
  }

  // ---- (7) Mailbox sync-job / ingest-history (BackgroundJob) --------
  // We look at the last 40 mailbox-related jobs for this club and
  // filter for anything that touched the message's graphMessageId (if
  // any). Payload is not exposed — only status / kind / times.
  const graphMsgIds = emailMsgs.map((m) => m.graphMessageId).filter(Boolean);
  const recentJobs = await prisma.backgroundJob.findMany({
    where: {
      clubId,
      kind: { in: [
        "MAILBOX_DELTA_SYNC", "MAILBOX_ATTACHMENT_FETCH", "AP_INTAKE_INGEST",
        "AP_INVOICE_ANALYSE", "MAILBOX_INITIAL_SYNC", "WORK_INTAKE_CLASSIFY",
      ] },
    },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true, kind: true, status: true, attempts: true, createdAt: true,
      finishedAt: true, payloadJson: true,
    },
  });
  // Filter to jobs that reference this message OR its attachments.
  const relatedJobs = recentJobs.filter((j) => {
    if (!j.payloadJson) return false;
    for (const g of graphMsgIds) if (j.payloadJson.includes(g)) return true;
    for (const a of attachments) if (j.payloadJson.includes(a.graphAttachmentId)) return true;
    for (const d of docs) if (j.payloadJson.includes(d.id)) return true;
    return false;
  }).slice(0, 20);

  // ---- (8) Graph LIVE probe (optional) -----------------------------
  let graphProbe: unknown = null;
  if (parsed.data.probeGraph && emailMsgs.length > 0) {
    try {
      const msg = emailMsgs[0];
      const conn = await prisma.mailboxConnection.findFirst({
        where: { id: msg.mailboxConnectionId, clubId, status: "CONNECTED" },
        select: { id: true, userId: true, externalUserId: true, connectedEmail: true },
      });
      if (!conn) {
        graphProbe = { ok: false, reason: "no CONNECTED mailboxConnection" };
      } else {
        const { getFreshDelegatedAccessToken } = await import("@/lib/mailbox/connect");
        const { getMicrosoftDelegatedProvider } = await import("@/lib/integrations/microsoft-graph-delegated");
        const token = await getFreshDelegatedAccessToken({
          mailboxConnectionId: conn.id,
          callerClubId: clubId,
          callerUserId: principal.id,
        });
        const provider = getMicrosoftDelegatedProvider();
        // We call listAttachmentMetadata directly. The response is
        // Graph's authoritative attachment list for this message.
        const graphAtts = await provider.listAttachmentMetadata({
          accessToken: token.accessToken,
          graphMessageId: msg.graphMessageId,
        });
        graphProbe = {
          ok: true,
          graphMessageIdTail: idTail(msg.graphMessageId, 8),
          attachmentCount: graphAtts.length,
          attachments: graphAtts.map((a) => ({
            graphAttachmentIdTail: idTail(a.id, 8),
            nameSuffix: (a.name ?? "").slice(-24),
            contentType: a.contentType,
            sizeBytes: a.size,
            isInline: a.isInline,
          })),
        };
      }
    } catch (err) {
      graphProbe = {
        ok: false,
        error: err instanceof Error ? (err as Error).name : "unknown",
        message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      };
    }
  }

  // ---- Sanitized response ------------------------------------------
  return NextResponse.json({
    ok: true,
    workIntakeItem: {
      idTail: idTail(wi.id, 10),
      status: wi.status,
      classification: wi.classification,
      classificationMethod: wi.classificationMethod,
      classificationRuleKey: wi.classificationRuleKey,
      classificationConfidence: wi.classificationConfidence,
      judgmentRequired: wi.judgmentRequired,
      displaySender: wi.displaySender,
      createdAt: wi.createdAt,
    },
    emailOrigins: emailOrigins.map((o) => ({
      idTail: idTail(o.id, 8), role: o.role, linkReason: o.linkReason,
      emailMessageIdTail: idTail(o.emailMessageId, 10), createdAt: o.createdAt,
    })),
    emailMessages: emailMsgs.map((m) => ({
      idTail: idTail(m.id, 10),
      graphMessageIdTail: idTail(m.graphMessageId, 10),
      internetMessageIdHash: hashTail(m.internetMessageId),
      conversationIdHash: hashTail(m.conversationId),
      senderAddressHash: hashTail(m.senderAddress),
      receivedAt: m.receivedAt,
      hasAttachments: m.hasAttachments,
      lastSyncedAt: m.lastSyncedAt,
      retryAttempts: m.retryAttempts,
      ingestFailedAt: m.ingestFailedAt,
      ingestFailReason: m.ingestFailReason,
      mailboxConnectionIdTail: idTail(m.mailboxConnectionId, 6),
    })),
    emailAttachments: attachments.map((a) => ({
      idTail: idTail(a.id, 8),
      emailMessageIdTail: idTail(a.emailMessageId, 10),
      graphAttachmentIdTail: idTail(a.graphAttachmentId, 8),
      filenameSuffix: a.filename.slice(-24),
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      isInline: a.isInline,
      storageState: a.storageState,
      hasStorageKey: !!a.storageKey,
      scanState: a.scanState,
      createdAt: a.createdAt,
    })),
    apIntakeSources: apSources.map((s) => ({
      idTail: idTail(s.id, 8),
      emailAttachmentIdTail: idTail(s.emailAttachmentId, 8),
      ingestedDocumentIdTail: idTail(s.ingestedDocumentId, 8),
      relationship: s.relationship,
      reason: s.reason,
      analysisVersionAtLink: s.analysisVersionAtLink,
      createdAt: s.createdAt,
    })),
    apIntakeSourcesByAttachment: apSourcesByAttachment.map((s) => ({
      idTail: idTail(s.id, 8),
      emailAttachmentIdTail: idTail(s.emailAttachmentId, 8),
      ingestedDocumentIdTail: idTail(s.ingestedDocumentId, 8),
      canonicalApIntakeIdTail: idTail(s.canonicalApIntakeId, 10),
      relationship: s.relationship,
      createdAt: s.createdAt,
    })),
    ingestedDocuments: docs.map((d) => ({
      idTail: idTail(d.id, 8),
      filenameSuffix: d.filename.slice(-24),
      mimeType: d.mimeType,
      sha256Prefix: d.sha256Hash?.slice(0, 12) ?? null,
      byteLength: d.byteLength,
      storageState: d.storageKey ? "STORED" : "NO_KEY",
      sourceKind: d.sourceKind,
      sourceReferenceIdTail: idTail(d.sourceReferenceId, 8),
      receivedAt: d.receivedAt,
      createdAt: d.createdAt,
    })),
    relatedBackgroundJobs: relatedJobs.map((j) => ({
      idTail: idTail(j.id, 6),
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    })),
    graphProbe,
    analyseResult,
    extractedTextSample,
    positionalTrace,
    lineItemPaths,
  });
}
