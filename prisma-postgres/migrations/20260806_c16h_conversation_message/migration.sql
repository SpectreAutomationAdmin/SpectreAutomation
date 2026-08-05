-- Sprint 3 · Checkpoint 16H rejection (2026-08-06) — canonical
-- provider-neutral conversation message. Owns Spectre-originated
-- outbound replies whose graphMessageId does not exist at send time
-- (Microsoft /reply returns 202 with an empty body). Extends the
-- Conversation tab so it composes inbound (EmailMessage) + outbound
-- (ConversationMessage) into one thread. See prisma/schema.prisma
-- for the full contract + rationale.

CREATE TABLE "ConversationMessage" (
  "id"                    TEXT NOT NULL,
  "clubId"                TEXT NOT NULL,
  "mailboxConnectionId"   TEXT NOT NULL,
  "workIntakeItemId"      TEXT,
  "conversationId"        TEXT NOT NULL,

  "direction"             TEXT NOT NULL,
  "source"                TEXT NOT NULL,

  "providerMessageId"     TEXT,
  "internetMessageId"     TEXT,
  "replyMutationId"       TEXT,

  "senderName"            TEXT NOT NULL,
  "senderAddress"         TEXT NOT NULL,
  "recipientsJson"        TEXT NOT NULL,
  "subject"               TEXT NOT NULL,

  "bodyHtmlSanitized"     TEXT,
  "bodyTextExtract"       TEXT,
  "bodyCiphertext"        TEXT,
  "bodySecretRef"         TEXT,

  "sentAt"                TIMESTAMP(3),
  "receivedAt"            TIMESTAMP(3),
  "providerReconciledAt"  TIMESTAMP(3),
  "reconciliationStatus"  TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',

  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- One canonical outbound message per successful reply mutation (§4).
CREATE UNIQUE INDEX "ConversationMessage_replyMutationId_key"
  ON "ConversationMessage" ("replyMutationId");

-- No duplicate reconciled provider message per mailbox (§10).
CREATE UNIQUE INDEX "ConversationMessage_mailboxConnectionId_providerMessageId_key"
  ON "ConversationMessage" ("mailboxConnectionId", "providerMessageId");

CREATE INDEX "ConversationMessage_clubId_workIntakeItemId_idx"
  ON "ConversationMessage" ("clubId", "workIntakeItemId");

-- Primary thread-loader read path.
CREATE INDEX "ConversationMessage_mailboxConnectionId_conversationId_idx"
  ON "ConversationMessage" ("mailboxConnectionId", "conversationId");

CREATE INDEX "ConversationMessage_workIntakeItemId_idx"
  ON "ConversationMessage" ("workIntakeItemId");

-- Reconciliation worker scans this to find PENDING outbounds.
CREATE INDEX "ConversationMessage_reconciliationStatus_idx"
  ON "ConversationMessage" ("reconciliationStatus");
