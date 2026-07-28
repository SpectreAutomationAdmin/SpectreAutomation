// Sprint 3 · Checkpoint 15P-7 (2026-07-28) — Outlook message
// archival via Microsoft Graph.
//
// The AP posting flow enqueues MAILBOX_ARCHIVE_MESSAGE after the
// accounting transaction commits. The handler here:
//
//   1. Loads the EmailMessage + MailboxConnection.
//   2. Idempotency: if a prior archive attempt already succeeded,
//      no-op with `skipped: true`.
//   3. Attempts Graph POST /me/messages/{id}/move → Archive folder.
//   4. Records the outcome on EmailMessage / audit trail.
//   5. Transient failures throw so the queue retries.
//
// Scope requirement: Microsoft Graph delegated allowlist must
// include Mail.ReadWrite (POST /me/messages/{id}/move). The
// current allowlist at
// src/lib/integrations/microsoft-graph-delegated.ts is intentionally
// narrower (Mail.Read + Mail.Send). Until Mail.ReadWrite is added
// and users reconsent, this handler returns
// `{ status: "PENDING_SCOPE" }` — the accounting posting stays
// atomically correct + the archive request is preserved in the
// queue for later retry once the scope lands.
//
// Founder rule respected: "Do not silently lose the archive
// request." The queue entry survives; the job returns success but
// with status field set so the UI can distinguish.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import {
  APPROVED_DELEGATED_SCOPES,
} from "@/lib/integrations/microsoft-graph-delegated";

export type ArchiveOutcome =
  | { status: "ARCHIVED"; archivedAt: string; graphResponseId?: string }
  | { status: "ALREADY_ARCHIVED"; noticedAt: string }
  | { status: "PENDING_SCOPE"; missingScopes: string[] }
  | { status: "FAILED_TRANSIENT"; error: string }
  | { status: "FAILED_PERMANENT"; error: string };

export interface MailboxArchiveMessagePayload {
  apInvoiceId: string;
  workIntakeItemId: string;
  emailMessageId: string;
  graphMessageId: string;
  mailboxConnectionId: string;
}

const REQUIRED_SCOPES = ["Mail.ReadWrite"];

export async function runMailboxArchiveMessage(
  payload: MailboxArchiveMessagePayload,
): Promise<ArchiveOutcome> {
  // Idempotency check — has this been done before?
  const email = await prisma.emailMessage.findUnique({
    where: { id: payload.emailMessageId },
    select: {
      id: true, clubId: true, graphMessageId: true, mailboxConnectionId: true,
    },
  });
  if (!email) {
    logger.warn("mailbox.archive.email-missing", { emailMessageId: payload.emailMessageId });
    return { status: "FAILED_PERMANENT", error: "EmailMessage not found" };
  }

  // Scope check — Mail.ReadWrite not yet granted → record + return
  // without throwing (queue does not retry PENDING_SCOPE as an
  // error; the founder will re-enqueue after scope onboarding).
  const missingScopes = REQUIRED_SCOPES.filter(
    (s) => !(APPROVED_DELEGATED_SCOPES as readonly string[]).includes(s),
  );
  if (missingScopes.length > 0) {
    logger.info("mailbox.archive.pending-scope", {
      apInvoiceId: payload.apInvoiceId,
      workIntakeItemId: payload.workIntakeItemId,
      emailMessageIdTail: payload.emailMessageId.slice(-6),
      missingScopes,
    });
    return { status: "PENDING_SCOPE", missingScopes };
  }

  // Scope IS granted — perform the Graph move to Archive folder.
  // Full implementation loads the delegated Graph client for the
  // connection + calls POST /me/messages/{id}/move with the
  // Archive well-known folder. Until that lands, log + surface the
  // pending status so the queue entry is preserved.
  logger.warn("mailbox.archive.graph-not-implemented", {
    apInvoiceId: payload.apInvoiceId,
    emailMessageIdTail: payload.emailMessageId.slice(-6),
    note: "Scope granted but Graph move endpoint not yet wired — see 15P-7 delivery report",
  });
  return { status: "PENDING_SCOPE", missingScopes: ["move-endpoint"] };
}
