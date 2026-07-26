// Sprint 3 Checkpoint 15E (2026-07-24) — AP-invoice review evidence.
//
// GET /api/mission-control/work-intake/[id]/ap-evidence
//
// Returns everything the AP-review card needs:
//   * document metadata (filename, MIME, size)
//   * extraction summary (vendor / invoice # / date / total / lines)
//   * arithmetic + reconciliation + capital findings
//   * vendor candidates (MATCHED/AMBIGUOUS/NOT_FOUND)
//   * GL recommendation with reason
//   * document preview URL (reuses the C15D endpoint)
//   * available actions (approve/reject/correct/attach/create)
//
// READ-ONLY. Never writes. No writes are performed during page load.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { analyseIngestedInvoice } from "@/lib/ap-intelligence/analyse";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const workIntakeItemId = params.id;
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: workIntakeItemId, clubId },
    select: {
      id: true,
      status: true,
      classification: true,
      displaySubject: true,
      lastAnalysedAt: true,
      origins: { select: { kind: true, referenceId: true, role: true } },
      findings: {
        where: { state: { in: ["CONFIRMED", "OBSERVED", "USER_REJECTED"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, key: true, statement: true, state: true, severity: true, ruleKey: true, ruleVersion: true, createdAt: true },
      },
    },
  });
  if (!intake) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const documentOrigin = intake.origins.find((o) => o.kind === "INGESTED_DOCUMENT" && o.role === "PRIMARY");
  if (!documentOrigin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: documentOrigin.referenceId, clubId },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      byteLength: true,
      sha256Hash: true,
      classification: true,
      receivedAt: true,
      ingestedAt: true,
      sourceKind: true,
      sourceReferenceId: true,
    },
  });
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Recompute the analyser output for display. This is read-only and
  // never writes; findings shown on the card come from the persisted
  // rows above.
  const analysis = await analyseIngestedInvoice({
    clubId,
    ingestedDocumentId: doc.id,
  });

  // Sprint 3 Checkpoint 15H Remediation (2026-07-25) — cross-link
  // the source email correspondence. For attachment-derived documents,
  // resolve doc.sourceReferenceId (EmailAttachment.id) → EmailMessage
  // → EmailWorkIntakeOrigin(PRIMARY) → WorkIntakeItem. Present it as
  // provenance-only; the AP intake is a separate operational object.
  let sourceCorrespondence: null | {
    emailIntakeId: string;
    emailMessageId: string;
    senderAddress: string | null;
    senderName: string | null;
    subject: string | null;
    receivedAt: string;
  } = null;
  if (doc.sourceReferenceId) {
    const attachment = await prisma.emailAttachment.findFirst({
      where: { id: doc.sourceReferenceId, emailMessage: { clubId } },
      select: {
        emailMessage: {
          select: {
            id: true, senderAddress: true, senderName: true, subject: true, receivedAt: true,
            workIntakeOrigins: {
              where: { role: "PRIMARY" },
              select: { workIntakeItemId: true },
              take: 1,
            },
          },
        },
      },
    });
    if (attachment?.emailMessage) {
      const em = attachment.emailMessage;
      const emailIntakeId = em.workIntakeOrigins[0]?.workIntakeItemId ?? null;
      if (emailIntakeId) {
        sourceCorrespondence = {
          emailIntakeId,
          emailMessageId: em.id,
          senderAddress: em.senderAddress,
          senderName: em.senderName,
          subject: em.subject,
          receivedAt: em.receivedAt.toISOString(),
        };
      }
    }
  }

  const matchedApOrigin = intake.origins.find((o) => o.kind === "AP_INVOICE");
  const matchedApInvoice = matchedApOrigin
    ? await prisma.aPInvoice.findFirst({
        where: { id: matchedApOrigin.referenceId, clubId },
        select: {
          id: true, invoiceNumber: true, vendorReference: true, invoiceDate: true, total: true, status: true,
          vendor: { select: { id: true, legalName: true, operatingName: true } },
        },
      })
    : null;

  return NextResponse.json({
    intake: {
      id: intake.id,
      status: intake.status,
      classification: intake.classification,
      title: intake.displaySubject,
      lastAnalysedAt: intake.lastAnalysedAt?.toISOString() ?? null,
      ruleSource: "Spectre AP-invoice operational rule v1",
    },
    document: {
      id: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      byteLength: doc.byteLength,
      sha256Hash: doc.sha256Hash,
      classification: doc.classification,
      receivedAt: doc.receivedAt.toISOString(),
      ingestedAt: doc.ingestedAt.toISOString(),
      previewUrl: `/api/documents/${doc.id}/preview`,
      downloadUrl: `/api/documents/${doc.id}/download`,
      metadataUrl: `/api/documents/${doc.id}/metadata`,
    },
    extraction: {
      state: analysis.extraction.state,
      ruleVersion: analysis.ruleVersion,
      textChars: analysis.extraction.extractedTextChars,
      vendor: analysis.extraction.vendor,
      invoiceNumber: analysis.extraction.invoiceNumber,
      invoiceDate: analysis.extraction.invoiceDate,
      dueDate: analysis.extraction.dueDate,
      purchaseOrder: analysis.extraction.purchaseOrder,
      description: analysis.extraction.description,
      currency: analysis.extraction.currency,
      subtotal: analysis.extraction.subtotal,
      taxTotal: analysis.extraction.taxTotal,
      total: analysis.extraction.total,
      lineItemCount: analysis.extraction.lineItems.length,
      lineItems: analysis.extraction.lineItems.slice(0, 32),
      warnings: analysis.extraction.warnings,
      hints: analysis.extractionHints,
    },
    vendorResolution: {
      state: analysis.vendor.state,
      candidates: analysis.vendor.candidates.map((c) => ({
        id: c.id,
        legalName: c.legalName,
        operatingName: c.operatingName,
        matchSignals: c.matchSignals,
      })),
    },
    reconciliation: {
      state: analysis.reconcile.state,
      matchedApInvoiceId: analysis.reconcile.matchedApInvoiceId,
      matchedApInvoice,
      findings: analysis.reconcile.findings.map((f) => ({
        key: f.key,
        severity: f.severity,
        statement: f.statement,
        ruleKey: f.ruleKey,
        apInvoiceId: f.apInvoiceId,
      })),
    },
    capitalRecommendation: {
      state: analysis.capital.state,
      capitalClass: analysis.capital.capitalClass,
      reasoning: analysis.capital.reasoning,
      supportingEvidence: analysis.capital.supportingEvidence,
    },
    glRecommendation: {
      accountNumber: analysis.gl.accountNumber,
      accountName: analysis.gl.accountName,
      reason: analysis.gl.reason,
      source: analysis.gl.source,
    },
    persistedFindings: intake.findings,
    availableActions: {
      approveExtraction: true,
      rejectExtraction: true,
      correctVendor: analysis.vendor.state !== "MATCHED",
      correctGl: true,
      markOperating: analysis.capital.state !== "OPERATING",
      markCapital: analysis.capital.state !== "CAPITAL",
      attachToExistingApInvoice: analysis.reconcile.matchedApInvoiceId !== null || analysis.reconcile.state === "NOT_FOUND",
      createDraftApInvoice: analysis.reconcile.state === "NOT_FOUND" && analysis.vendor.state === "MATCHED" && !!analysis.extraction.total,
    },
    // Post — post-to-GL, submit-for-approval, and payment actions are
    // EXPLICITLY OUT OF SCOPE for this checkpoint. Reviewer creates the
    // draft; a separate authorised endpoint later approves + posts.
    postingActionAvailable: false,
    postingActionReason: "AP posting requires a separate controlled authorization checkpoint.",
    // Sprint 3 Checkpoint 15H Remediation — source correspondence link.
    sourceCorrespondence,
  });
}
