// Sprint 2 B4.1 (2026-07-19) — Work Intake detail-page reader.
//
// Single tenant + mailbox-visibility scoped loader for
// /app/user/work-intake/[id]. Enforces owner-only access on personal
// mailbox items — Club Admin / Super Admin do NOT bypass ownership.
// Never exposes internal IDs, raw Graph payloads, tenant identifiers,
// or unsanitized HTML.

import { prisma } from "@/lib/prisma";
import { workIntakeReadableByPrincipal } from "@/lib/work-intake/tenant";
import type { Principal } from "@/lib/rbac";

export interface WorkIntakeDetail {
  id: string;
  status: string;
  classification: string | null;
  classificationReason: string | null;
  classificationMethod: string | null;
  classificationConfidence: number | null;
  classificationConfidenceLabel: string;
  judgmentRequired: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  deferredUntil: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** WI-2B.3 — the canonical primary PDF document for this Work
   *  Intake, if one is evidence-linked to it. Sourced via
   *  IngestedDocumentEvidenceLink (targetKind = WORK_INTAKE_ITEM),
   *  which is the join Spectre already uses in
   *  /api/mission-control/work-intake/[id]/documents. Independent of
   *  EmailAttachment.sourceReferenceId — that join breaks whenever
   *  the same PDF was seen previously and the promoted IngestedDocument
   *  row was deduped by SHA to a different EmailAttachment.id. */
  primaryDocument: {
    ingestedDocumentId: string;
    filename: string;
    mimeType: string;
    byteLength: number;
  } | null;
  display: {
    sourceLabel: string;
    sender: string;
    subject: string;
    receivedAt: string;
    hasAttachments: boolean;
  };
  email: {
    senderName: string;
    senderAddress: string;
    subject: string;
    recipientsTo: string[];
    recipientsCc: string[];
    receivedAt: string;
    sentAt: string | null;
    bodyHtmlSanitized: string | null;
    bodyTextExtract: string | null;
    webLink: string | null;
    isSoftDeleted: boolean;
    mailboxConnectedEmail: string;
    attachments: Array<{
      id: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      storageState: string;
      /** WI-2B.2 — canonical promoted `IngestedDocument.id` for this
       *  email attachment. Populated when a `sourceKind=EMAIL_ATTACHMENT`
       *  IngestedDocument row exists with `sourceReferenceId` matching
       *  this EmailAttachment.id. The review page uses this to hit
       *  `GET /api/documents/{ingestedDocumentId}/preview` for the
       *  actual PDF bytes; null when ingest has not run or refused. */
      ingestedDocumentId: string | null;
    }>;
  } | null;
  activity: Array<{
    id: string;
    action: string;
    fromValue: string | null;
    toValue: string | null;
    note: string | null;
    createdAt: string;
    actorName: string | null;
  }>;
}

export async function loadWorkIntakeDetail(args: {
  principal: Principal;
  clubId: string;
  intakeId: string;
}): Promise<WorkIntakeDetail | null> {
  const where = workIntakeReadableByPrincipal({
    userId: args.principal.id,
    clubId: args.clubId,
    isClubAdmin: false,
    isSuperAdmin: false,
  });
  const intake = await prisma.workIntakeItem.findFirst({
    where: { AND: [{ id: args.intakeId }, where] },
    include: {
      owner: { select: { id: true, name: true } },
      emailOrigins: {
        take: 1,
        orderBy: { createdAt: "asc" },
        include: {
          emailMessage: {
            include: {
              attachments: true,
              mailboxConnection: { select: { connectedEmail: true } },
            },
          },
        },
      },
      activity: {
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { actor: { select: { id: true, name: true } } },
      },
    },
  });
  if (!intake) return null;

  const email = intake.emailOrigins[0]?.emailMessage;
  const parsedRecipients = safeParseRecipients(email?.recipientsJson ?? null);

  // WI-2B.3 — resolve the canonical primary document via
  // IngestedDocumentEvidenceLink. This is the join Spectre already
  // uses in /api/mission-control/work-intake/[id]/documents, and it
  // is robust to SHA-dedup of the promoted IngestedDocument row
  // (which is why WI-2B.2's `sourceReferenceId = EmailAttachment.id`
  // join returned nothing on staging for the real PAY NOW record).
  //
  // We surface only the FIRST evidence-linked STORED PDF; any
  // additional documents remain accessible through the existing
  // documents API.
  const primaryDocRows = await prisma.ingestedDocumentEvidenceLink.findMany({
    where: {
      targetKind: "WORK_INTAKE_ITEM",
      targetReferenceId: intake.id,
      ingestedDocument: {
        clubId: args.clubId,
        status: "STORED",
        mimeType: { startsWith: "application/pdf" },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 1,
    select: {
      ingestedDocument: {
        select: {
          id: true, mimeType: true, byteLength: true,
          filename: true, originalFilename: true,
        },
      },
    },
  });
  const primaryDoc = primaryDocRows[0]?.ingestedDocument;

  // Best-effort: also resolve per-attachment promoted document id via
  // both the sourceReferenceId join (fresh promotions) AND the
  // evidence link back-fill (dedup case). Any attachment matching by
  // filename to the primary doc inherits its id. Kept for backward
  // compatibility with earlier consumers.
  const attachmentIds = (email?.attachments ?? []).map((a) => a.id);
  const ingestedByAttachment = new Map<string, string>();
  if (attachmentIds.length > 0) {
    const docs = await prisma.ingestedDocument.findMany({
      where: {
        clubId: args.clubId,
        sourceKind: "EMAIL_ATTACHMENT",
        sourceReferenceId: { in: attachmentIds },
      },
      select: { id: true, sourceReferenceId: true },
    });
    for (const d of docs) {
      if (d.sourceReferenceId) ingestedByAttachment.set(d.sourceReferenceId, d.id);
    }
  }
  if (primaryDoc) {
    for (const a of email?.attachments ?? []) {
      if (
        !ingestedByAttachment.has(a.id) &&
        (a.filename === primaryDoc.filename || a.filename === primaryDoc.originalFilename)
      ) {
        ingestedByAttachment.set(a.id, primaryDoc.id);
      }
    }
  }

  return {
    id: intake.id,
    status: intake.status,
    classification: intake.classification,
    classificationReason: intake.classificationReason,
    classificationMethod: intake.classificationMethod,
    classificationConfidence: intake.classificationConfidence,
    classificationConfidenceLabel: confidenceLabel(intake.classificationConfidence),
    judgmentRequired: intake.judgmentRequired,
    ownerUserId: intake.ownerUserId,
    ownerName: intake.owner?.name ?? null,
    deferredUntil: intake.deferredUntil?.toISOString() ?? null,
    resolvedAt: intake.resolvedAt?.toISOString() ?? null,
    createdAt: intake.createdAt.toISOString(),
    updatedAt: intake.updatedAt.toISOString(),
    primaryDocument: primaryDoc
      ? {
          ingestedDocumentId: primaryDoc.id,
          filename: primaryDoc.filename ?? primaryDoc.originalFilename ?? "document.pdf",
          mimeType: primaryDoc.mimeType,
          byteLength: primaryDoc.byteLength,
        }
      : null,
    display: {
      sourceLabel: intake.displaySourceLabel,
      sender: intake.displaySender,
      subject: intake.displaySubject,
      receivedAt: intake.displayReceivedAt.toISOString(),
      hasAttachments: intake.displayHasAttachments,
    },
    email: email
      ? {
          senderName: email.senderName,
          senderAddress: email.senderAddress,
          subject: email.subject,
          recipientsTo: parsedRecipients.to,
          recipientsCc: parsedRecipients.cc,
          receivedAt: email.receivedAt.toISOString(),
          sentAt: email.sentAt?.toISOString() ?? null,
          bodyHtmlSanitized: email.bodyHtmlSanitized,
          bodyTextExtract: email.bodyTextExtract,
          webLink: safeWebLink(email.webLink),
          isSoftDeleted: email.softDeletedAt != null,
          mailboxConnectedEmail: email.mailboxConnection.connectedEmail,
          attachments: email.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            storageState: a.storageState,
            ingestedDocumentId: ingestedByAttachment.get(a.id) ?? null,
          })),
        }
      : null,
    activity: intake.activity.map((a) => ({
      id: a.id,
      action: a.action,
      fromValue: a.fromValue,
      toValue: a.toValue,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
      actorName: a.actor?.name ?? null,
    })),
  };
}

function safeParseRecipients(json: string | null): { to: string[]; cc: string[] } {
  if (!json) return { to: [], cc: [] };
  try {
    const parsed = JSON.parse(json) as { to?: string[]; cc?: string[] };
    return { to: parsed.to ?? [], cc: parsed.cc ?? [] };
  } catch {
    return { to: [], cc: [] };
  }
}

// Only allow http/https Microsoft-hosted or generic web links. Never
// forward a javascript: or data: URL to the browser via <a href>.
function safeWebLink(link: string | null): string | null {
  if (!link) return null;
  if (!/^https?:\/\//i.test(link)) return null;
  return link;
}

// Human-readable confidence for the UI. Never expose raw floats to
// avoid implying analytic precision beyond what a rule can offer.
function confidenceLabel(c: number | null): string {
  if (c == null) return "not classified";
  if (c >= 0.8) return "high";
  if (c >= 0.55) return "medium";
  if (c > 0) return "low";
  return "not classified";
}
