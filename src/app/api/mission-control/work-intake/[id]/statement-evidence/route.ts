// Sprint 3 Checkpoint 15G (2026-07-24) — Vendor statement
// reconciliation review evidence.
//
// GET /api/mission-control/work-intake/[id]/statement-evidence
//
// Returns everything the Vendor Statement Reconciliation card needs:
//   * document metadata + preview URL (reuses C15D endpoints)
//   * statement header (period, opening/closing balance)
//   * canonical vendor + candidates
//   * ordered statement lines with match state, matched Spectre id,
//     amount / date differences, cross-link candidate
//   * findings grouped for review
//   * reconciliation state
//   * available reviewer actions
// READ-ONLY. Zero writes. Storage keys never returned.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { STATEMENT_REVIEWER_ACTIONS } from "@/lib/ap-statement-intelligence/types";
import { computeVendorBalanceAsOf } from "@/lib/ap-statement-intelligence/balance-validate";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: params.id, clubId, classification: "VENDOR_STATEMENT_REVIEW" },
    select: {
      id: true, status: true, classification: true, displaySubject: true, lastAnalysedAt: true,
      origins: { where: { role: "PRIMARY", kind: "INGESTED_DOCUMENT" }, select: { referenceId: true } },
      findings: {
        where: { state: { in: ["CONFIRMED", "OBSERVED", "USER_REJECTED"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, key: true, statement: true, state: true, severity: true, ruleKey: true, ruleVersion: true, createdAt: true },
      },
    },
  });
  if (!intake) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const docOrigin = intake.origins[0];
  if (!docOrigin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: docOrigin.referenceId, clubId },
    select: { id: true, filename: true, mimeType: true, byteLength: true, sha256Hash: true, receivedAt: true, ingestedAt: true, classification: true },
  });
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const reconciliation = await prisma.vendorStatementReconciliation.findFirst({
    where: { clubId, ingestedDocumentId: doc.id },
    include: {
      canonicalVendor: { select: { id: true, legalName: true, operatingName: true } },
      lines: {
        orderBy: { sequence: "asc" },
        include: { matches: true },
      },
    },
  });
  if (!reconciliation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Compute Spectre balance as of statement date for the card header.
  let spectreBalanceAsOf: string | null = null;
  if (reconciliation.canonicalVendorId && reconciliation.statementDate) {
    spectreBalanceAsOf = await computeVendorBalanceAsOf({
      clubId, vendorId: reconciliation.canonicalVendorId, asOf: reconciliation.statementDate,
    });
  }

  return NextResponse.json({
    intake: {
      id: intake.id,
      status: intake.status,
      classification: intake.classification,
      title: intake.displaySubject,
      lastAnalysedAt: intake.lastAnalysedAt?.toISOString() ?? null,
      ruleSource: "Spectre statement reconciliation rule v1",
    },
    document: {
      id: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      byteLength: doc.byteLength,
      sha256Hash: doc.sha256Hash,
      receivedAt: doc.receivedAt.toISOString(),
      ingestedAt: doc.ingestedAt.toISOString(),
      classification: doc.classification,
      previewUrl: `/api/documents/${doc.id}/preview`,
      downloadUrl: `/api/documents/${doc.id}/download`,
      metadataUrl: `/api/documents/${doc.id}/metadata`,
    },
    vendor: reconciliation.canonicalVendor ? {
      id: reconciliation.canonicalVendor.id,
      legalName: reconciliation.canonicalVendor.legalName,
      operatingName: reconciliation.canonicalVendor.operatingName,
    } : null,
    statementSummary: {
      statementDate: reconciliation.statementDate?.toISOString() ?? null,
      periodStart: reconciliation.periodStart?.toISOString() ?? null,
      periodEnd: reconciliation.periodEnd?.toISOString() ?? null,
      openingBalance: reconciliation.openingBalance?.toString() ?? "0",
      closingBalance: reconciliation.closingBalance?.toString() ?? "0",
      amountDue: reconciliation.amountDue?.toString() ?? "0",
      spectreBalanceAsOfStatementDate: spectreBalanceAsOf,
      netDifference: (spectreBalanceAsOf && reconciliation.closingBalance)
        ? String(Number(reconciliation.closingBalance) - Number(spectreBalanceAsOf))
        : null,
      currency: reconciliation.currency,
      extractionState: reconciliation.extractionState,
      reconciliationState: reconciliation.reconciliationState,
    },
    lines: reconciliation.lines.map((line) => ({
      id: line.id,
      sequence: line.sequence,
      transactionDate: line.transactionDate?.toISOString() ?? null,
      referenceNumber: line.referenceNumber,
      description: line.description,
      transactionKind: line.transactionKind,
      debitAmount: line.debitAmount?.toString() ?? "0",
      creditAmount: line.creditAmount?.toString() ?? "0",
      runningBalance: line.runningBalance?.toString() ?? null,
      extractionEvidence: line.extractionEvidence ? safeParseJson(line.extractionEvidence) : null,
      matches: line.matches.map((m) => ({
        id: m.id,
        targetKind: m.targetKind,
        targetReferenceId: m.targetReferenceId,
        matchState: m.matchState,
        matchBasis: m.matchBasis ? safeParseJson(m.matchBasis) : null,
        amountDifference: m.amountDifference?.toString() ?? null,
        dateDifferenceDays: m.dateDifferenceDays,
        reviewerDecision: m.reviewerDecision ? safeParseJson(m.reviewerDecision) : null,
      })),
    })),
    findings: intake.findings,
    availableActions: STATEMENT_REVIEWER_ACTIONS,
    // NEVER auto-post / auto-pay / auto-create.
    autoActionAvailable: false,
    autoActionReason: "Statement reconciliation never creates AP records automatically.",
  });
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}
