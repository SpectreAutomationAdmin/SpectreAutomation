// Sprint 3 Checkpoint 15D (2026-07-24) — Queue-driven mailbox
// attachment ingest.
//
// Called by the MAILBOX_ATTACHMENT_FETCH queue handler. Looks up the
// EmailAttachment row, fetches bytes via the shared Microsoft Graph
// provider, and hands off to the domain-agnostic `ingestAttachment`
// pipeline. On success:
//   • updates EmailAttachment.storageState to STORED
//   • records the WorkIntakeItem link if the email materialised into
//     one (auto-link via EmailWorkIntakeOrigin PRIMARY)
// On refusal:
//   • updates EmailAttachment.storageState to REFUSED_UNSAFE_TYPE /
//     REFUSED_TOO_LARGE / (existing) so operators can distinguish
//     "did not try" from "tried and refused"
// On transient failure:
//   • throws so the queue retry policy takes over

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { getMicrosoftDelegatedProvider } from "@/lib/integrations/microsoft-graph-delegated";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";
import { ingestAttachment } from "./ingest";

export interface MailboxAttachmentIngestArgs {
  emailAttachmentId: string;
  attachToWorkIntakeItemId?: string | null;
}

export interface MailboxAttachmentIngestResult {
  outcome:
    | "STORED_NEW"
    | "STORED_DUPLICATE_LINKED"
    | "REFUSED_UNSAFE_TYPE"
    | "REFUSED_TOO_LARGE"
    | "REFUSED_CORRUPT"
    | "SKIPPED_ALREADY_STORED"
    | "SKIPPED_ATTACHMENT_MISSING";
  documentId?: string;
  reason?: string;
}

export async function runMailboxAttachmentIngest(
  args: MailboxAttachmentIngestArgs,
): Promise<MailboxAttachmentIngestResult> {
  const att = await prisma.emailAttachment.findUnique({
    where: { id: args.emailAttachmentId },
    include: {
      emailMessage: {
        select: {
          id: true,
          clubId: true,
          mailboxConnectionId: true,
          graphMessageId: true,
          receivedAt: true,
          senderAddress: true,
          subject: true,
          bodyTextExtract: true,
        },
      },
    },
  });
  if (!att) {
    return { outcome: "SKIPPED_ATTACHMENT_MISSING", reason: "EmailAttachment row not found" };
  }
  if (att.storageState === "STORED") {
    // Sprint 3 Checkpoint 15H Remediation (2026-07-25) — Even when the
    // attachment bytes are already in R2, we still need to run the AP
    // / Statement materialiser for docs that were ingested BEFORE the
    // materialise hook shipped. The materialiser is idempotent: the
    // canonical intake natural key + finding semantic identity prevent
    // duplicates on rerun.
    await maybeMaterialiseInvoiceOrStatement({
      clubId: att.emailMessage.clubId,
      attachmentId: att.id,
    });
    return { outcome: "SKIPPED_ALREADY_STORED", reason: "Attachment already ingested" };
  }
  if (att.storageState === "REFUSED_TOO_LARGE") {
    // Never fetch bytes; the /messages metadata size cap already refused.
    return { outcome: "REFUSED_TOO_LARGE", reason: "Sender-declared size exceeds ingest cap" };
  }
  const msg = att.emailMessage;

  // Auto-link to an existing PRIMARY EmailWorkIntakeOrigin if the
  // caller did not supply one explicitly.
  let autoAttachTo: { targetKind: "WORK_INTAKE_ITEM"; targetReferenceId: string; role?: "EVIDENCE"; reason?: string } | null =
    args.attachToWorkIntakeItemId
      ? {
          targetKind: "WORK_INTAKE_ITEM",
          targetReferenceId: args.attachToWorkIntakeItemId,
          role: "EVIDENCE",
          reason: "Attached to intake by explicit request",
        }
      : null;
  if (!autoAttachTo) {
    const primary = await prisma.emailWorkIntakeOrigin.findFirst({
      where: { emailMessageId: msg.id, role: "PRIMARY" },
      select: { workIntakeItemId: true },
    });
    if (primary) {
      autoAttachTo = {
        targetKind: "WORK_INTAKE_ITEM",
        targetReferenceId: primary.workIntakeItemId,
        role: "EVIDENCE",
        reason: "Auto-linked via email primary intake origin",
      };
    }
  }

  // Fetch an access token for the connection.
  const conn = await prisma.mailboxConnection.findUnique({
    where: { id: msg.mailboxConnectionId },
    select: { id: true, clubId: true, userId: true },
  });
  if (!conn) {
    return { outcome: "SKIPPED_ATTACHMENT_MISSING", reason: "Mailbox connection missing" };
  }
  let accessToken: string;
  try {
    const token = await getFreshDelegatedAccessToken({
      mailboxConnectionId: conn.id,
      callerClubId: conn.clubId,
      callerUserId: conn.userId,
    });
    accessToken = token.accessToken;
  } catch (err) {
    logger.warn("documents.ingest.token_failure", {
      clubId: msg.clubId,
      emailAttachmentIdTail: att.id.slice(-6),
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const provider = getMicrosoftDelegatedProvider();
  const result = await ingestAttachment({
    clubId: msg.clubId,
    sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: att.id,
    claimedContentType: att.contentType,
    claimedSizeBytes: att.sizeBytes,
    originalFilename: att.filename,
    receivedAt: msg.receivedAt,
    isInline: att.isInline,
    bytes: {
      async fetchBytes() {
        return provider.getAttachmentBytes({
          accessToken,
          graphMessageId: msg.graphMessageId,
          graphAttachmentId: att.graphAttachmentId,
        });
      },
    },
    classifySignals: {
      emailSubject: msg.subject,
      senderAddress: msg.senderAddress,
      emailBodyExcerpt: (msg.bodyTextExtract ?? "").slice(0, 500),
    },
    autoAttachTo,
    actorUserId: null,
  });

  // Reflect ingest outcome on the EmailAttachment row so operators
  // can see the terminal state from the mailbox side.
  const nextState =
    result.outcome === "STORED_NEW" || result.outcome === "STORED_DUPLICATE_LINKED"
      ? "STORED"
      : result.outcome === "REFUSED_UNSAFE_TYPE"
        ? "REFUSED_UNSAFE_TYPE"
        : result.outcome === "REFUSED_TOO_LARGE"
          ? "REFUSED_TOO_LARGE"
          : result.outcome === "REFUSED_CORRUPT"
            ? "REFUSED_UNSAFE_TYPE"
            : att.storageState;
  const nextStorageKey =
    (result.outcome === "STORED_NEW" || result.outcome === "STORED_DUPLICATE_LINKED") && result.storageKey
      ? result.storageKey
      : att.storageKey;
  if (nextState !== att.storageState || nextStorageKey !== att.storageKey) {
    await prisma.emailAttachment.update({
      where: { id: att.id },
      data: { storageState: nextState, storageKey: nextStorageKey },
    });
  }

  const outcomesThatMaterialise = new Set(["STORED_NEW", "STORED_DUPLICATE_LINKED"]);
  if (outcomesThatMaterialise.has(result.outcome)) {
    await maybeMaterialiseInvoiceOrStatement({
      clubId: msg.clubId,
      attachmentId: att.id,
      classificationHint: result.classification ?? null,
      documentIdHint: result.documentId ?? null,
    });
  }

  return { outcome: result.outcome, documentId: result.documentId, reason: result.reason };
}

// Sprint 3 Checkpoint 15H Remediation (2026-07-25) — Shared hook.
// Called both after a fresh ingest and when an already-stored
// attachment is re-enqueued. Idempotent — the AP + Statement
// materialisers use canonical intake natural keys.
async function maybeMaterialiseInvoiceOrStatement(args: {
  clubId: string;
  attachmentId: string;
  classificationHint?: string | null;
  documentIdHint?: string | null;
}): Promise<void> {
  let docId = args.documentIdHint ?? null;
  let classification = args.classificationHint ?? null;
  if (!docId || !classification) {
    const doc = await prisma.ingestedDocument.findFirst({
      where: { clubId: args.clubId, sourceKind: "EMAIL_ATTACHMENT", sourceReferenceId: args.attachmentId },
      select: { id: true, classification: true },
    });
    if (doc) {
      docId = doc.id;
      classification = doc.classification;
    }
  }
  if (!docId) return;
  // Sprint 3 · Checkpoint 15S (2026-07-29) — resolve the EmailMessage
  // for this attachment so the AP materialiser can persist the
  // ApIntakeSource link. Same-tenant guard is enforced downstream
  // in upsertApIntakeSource.
  const attMeta = await prisma.emailAttachment.findFirst({
    where: { id: args.attachmentId },
    select: { id: true, emailMessageId: true, emailMessage: { select: { clubId: true } } },
  });
  const sourceContext = attMeta && attMeta.emailMessage?.clubId === args.clubId
    ? { emailAttachmentId: attMeta.id, emailMessageId: attMeta.emailMessageId }
    : undefined;
  if (classification === "INVOICE") {
    try {
      const { materialiseSingleInvoiceDocument } = await import("../ap-intelligence/materialise");
      await materialiseSingleInvoiceDocument({
        clubId: args.clubId,
        ingestedDocumentId: docId,
        sourceContext,
      });
    } catch (err) {
      logger.warn("documents.mailbox_ingest.ap_materialise_failed", {
        clubId: args.clubId, documentIdTail: docId.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
      // Sprint 3 · Post-16H P0-hardening (2026-08-07) — automatic
      // recovery. The inline materialiser failed for this attachment;
      // enqueue the recovery job so a bounded-retry worker rerun
      // catches it. Idempotent (dedup by ingestedDocumentId).
      try {
        const { enqueueApMaterialiseRecovery } = await import("../ap-intelligence/materialise-recovery");
        await enqueueApMaterialiseRecovery({
          clubId: args.clubId,
          ingestedDocumentId: docId,
          emailAttachmentId: sourceContext?.emailAttachmentId,
          emailMessageId: sourceContext?.emailMessageId,
        });
      } catch (queueErr) {
        logger.warn("documents.mailbox_ingest.recovery_enqueue_failed", {
          clubId: args.clubId, documentIdTail: docId.slice(-6),
          error: queueErr instanceof Error ? queueErr.message : String(queueErr),
        });
      }
    }
  } else if (classification === "STATEMENT") {
    try {
      const { materialiseSingleStatementDocument } = await import("../ap-statement-intelligence/materialise");
      await materialiseSingleStatementDocument({ clubId: args.clubId, ingestedDocumentId: docId });
    } catch (err) {
      logger.warn("documents.mailbox_ingest.statement_materialise_failed", {
        clubId: args.clubId, documentIdTail: docId.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
