"use client";

// Sprint 2 Checkpoint 14C (2026-07-23) — Inline conversation panel.
//
// Renders the canonical Microsoft-conversation newest-first inside
// an expanded Mission Control card. Replaces the C14B
// InlineEmailPanel which only rendered one email.
//
// Founder-approved ordering:
//   newest message (visually open by default)
//     ↓
//   older messages
//     ↓
//   oldest / original message
//
// Older messages are individually collapsible so a long thread does
// not blow the card height. The newest message is always open.
//
// Removed from C14B:
//   - "Open in Outlook on the web" external link (kept the user in
//     Spectre, no external navigation)
//   - single-email rendering
//
// Safety:
//   - The API returns `bodyHtmlSanitized` post-ingest-sanitizer.
//     Rendering via dangerouslySetInnerHTML is safe because the
//     trust boundary already ran server-side.
//   - Plain-text fallback when sanitized HTML is absent.
//   - Soft-deleted messages surface an audit notice — body content
//     is stripped server-side before it leaves the API.

import { useState, type ReactElement } from "react";
import type { ReplyComposerConsentState } from "./ReplyComposer";

export interface ConversationThreadMessage {
  id: string;
  subject: string;
  senderName: string;
  senderAddress: string;
  recipientsTo: string[];
  recipientsCc: string[];
  receivedAt: string;
  sentAt: string | null;
  importance: string;
  isRead: boolean;
  hasAttachments: boolean;
  bodyHtmlSanitized: string | null;
  bodyTextExtract: string | null;
  softDeleted: boolean;
}

export interface ConversationDetail {
  workIntakeItemId: string;
  conversationId: string | null;
  mailboxConnectedEmail: string;
  messageCount: number;
  messages: ConversationThreadMessage[];
  replyConsent: ReplyComposerConsentState;
}

interface Props {
  detail: ConversationDetail;
}

export default function InlineConversationPanel({ detail }: Props): ReactElement {
  const messages = detail.messages;

  return (
    <section
      className="spectre-mc-inline-thread"
      aria-label="Original email conversation"
      data-testid="inline-thread-panel"
      data-message-count={detail.messageCount}
    >
      <header className="spectre-mc-inline-thread-head">
        <span className="spectre-mc-inline-thread-eyebrow">Original conversation</span>
        <span className="spectre-mc-inline-thread-meta">
          {detail.messageCount === 1
            ? "1 message"
            : `${detail.messageCount} messages · newest first`}
          {" · "}
          {detail.mailboxConnectedEmail}
        </span>
      </header>

      <ol className="spectre-mc-inline-thread-list" data-testid="inline-thread-list">
        {messages.map((msg, idx) => (
          <ThreadMessage
            key={msg.id}
            msg={msg}
            openByDefault={idx === 0}
            positionLabel={
              messages.length === 1
                ? "Message"
                : idx === 0
                  ? "Most recent"
                  : idx === messages.length - 1
                    ? `Oldest · ${idx + 1} of ${messages.length}`
                    : `${idx + 1} of ${messages.length}`
            }
          />
        ))}
      </ol>
    </section>
  );
}

function ThreadMessage({
  msg,
  openByDefault,
  positionLabel,
}: {
  msg: ConversationThreadMessage;
  openByDefault: boolean;
  positionLabel: string;
}) {
  const [open, setOpen] = useState(openByDefault);
  const receivedLabel = formatDateTime(msg.receivedAt);

  return (
    <li className={`spectre-mc-inline-thread-item${open ? " open" : ""}`} data-testid="inline-thread-message">
      <button
        type="button"
        className="spectre-mc-inline-thread-summary"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        data-testid="inline-thread-toggle"
      >
        <span className="pos">{positionLabel}</span>
        <span className="sender" data-testid="inline-thread-sender">
          {msg.senderName}
          {msg.senderAddress ? (
            <span className="addr"> &lt;{msg.senderAddress}&gt;</span>
          ) : null}
        </span>
        <span className="subj">{msg.subject || "(no subject)"}</span>
        <span className="ts">{receivedLabel}</span>
        {msg.hasAttachments ? <span className="attach" title="Has attachments">◈</span> : null}
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="spectre-mc-inline-thread-body" data-testid="inline-thread-body">
          <dl className="spectre-mc-inline-thread-meta-block">
            {msg.recipientsTo.length > 0 ? (
              <div className="row">
                <dt>To</dt>
                <dd data-testid="inline-thread-to">{msg.recipientsTo.join(", ")}</dd>
              </div>
            ) : null}
            {msg.recipientsCc.length > 0 ? (
              <div className="row">
                <dt>Cc</dt>
                <dd data-testid="inline-thread-cc">{msg.recipientsCc.join(", ")}</dd>
              </div>
            ) : null}
          </dl>

          {msg.hasAttachments ? (
            <div className="spectre-mc-inline-thread-attach" data-testid="inline-thread-attach-hint">
              This message has attachments in the source mailbox. Attachment metadata is not fetched in this staging release.
            </div>
          ) : null}

          {msg.softDeleted ? (
            <div
              className="spectre-mc-inline-email-notice"
              role="note"
              data-testid="inline-thread-softdeleted"
            >
              This message was removed from the mailbox. The Work Intake record is preserved for audit.
            </div>
          ) : msg.bodyHtmlSanitized ? (
            <div
              className="spectre-mc-inline-thread-body-html prose prose-sm max-w-none"
              data-testid="inline-thread-body-html"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: msg.bodyHtmlSanitized }}
            />
          ) : msg.bodyTextExtract ? (
            <pre className="spectre-mc-inline-thread-body-text" data-testid="inline-thread-body-text">
              {msg.bodyTextExtract}
            </pre>
          ) : (
            <p className="spectre-mc-inline-thread-nobody" data-testid="inline-thread-nobody">
              No message body was captured for this email.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
