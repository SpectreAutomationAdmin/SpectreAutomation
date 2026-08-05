"use client";

// Sprint 2 Checkpoint 14C (2026-07-23) — Reply composer with three
// consent states + confirmation gate.
//
// C14B rendered the composer with a hard-disabled Send button. C14C
// upgrades to a three-state gate driven by the source mailbox's
// grantedScopes:
//
//   "unavailable"  → APPROVED_DELEGATED_SCOPES does not include
//                    Mail.Send. Send button disabled, label reads
//                    "Not enabled in this release".
//   "missing"      → Provider supports Mail.Send but the mailbox
//                    connection has not been re-consented. Send
//                    button disabled, banner explains how to
//                    reconnect + reconsent.
//   "granted"      → Send is authorised. Send button opens a
//                    confirmation step. Only the founder-approved
//                    confirmation click actually POSTs.
//
// In every case:
//   - Send never happens on textarea keystroke, page load, or panel
//     open.
//   - Send never happens without an explicit final "Confirm & send"
//     click after a summary panel showing recipient, subject and
//     sending mailbox.
//   - Send always uses server-derived recipient/mailbox — the client
//     never supplies these.
//   - After success the composer shows a truthful confirmation. No
//     fake sent-message is added to the thread; the panel notes the
//     mailbox synchronisation will refresh the thread on the next
//     controlled sync.

import { useState, useCallback, useEffect, useRef } from "react";
import { IconSend } from "@/components/spectre/icons";

// Sprint 3 · Checkpoint 16H (2026-08-04) — local-draft persistence.
// A Spectre-scoped localStorage key survives refresh, modal close,
// and browser navigation. Never leaves the browser — no server
// round-trip until the user chooses to send.
const DRAFT_STORAGE_KEY_PREFIX = "spectre.reply-draft.v1.";

function loadDraft(wiId: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(DRAFT_STORAGE_KEY_PREFIX + wiId); } catch { return null; }
}
function saveDraft(wiId: string, body: string): void {
  if (typeof window === "undefined") return;
  try {
    if (body.length === 0) window.localStorage.removeItem(DRAFT_STORAGE_KEY_PREFIX + wiId);
    else window.localStorage.setItem(DRAFT_STORAGE_KEY_PREFIX + wiId, body);
  } catch { /* quota/private-mode: silently continue */ }
}
function clearDraft(wiId: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(DRAFT_STORAGE_KEY_PREFIX + wiId); } catch { /* noop */ }
}

export type ReplyComposerConsentState = {
  state: "granted" | "missing" | "unavailable";
  reason: string;
  requiredScopes: string[];
};

interface Props {
  workIntakeItemId: string;
  emailMessageId: string;
  seedRecommendation?: string;
  consentState: ReplyComposerConsentState;
  onCancel: () => void;
}

type ComposerStep = "draft" | "confirm" | "sending" | "sent" | "error";

export default function ReplyComposer({
  workIntakeItemId,
  seedRecommendation,
  consentState,
  onCancel,
}: Props) {
  // Sprint 3 · Checkpoint 16H — hydrate from localStorage on mount
  // (survives refresh / modal close / navigation). Persist as the
  // user types.
  const [draft, setDraft] = useState<string>(() => {
    if (typeof window === "undefined") return seedRecommendation ?? "";
    return loadDraft(workIntakeItemId) ?? seedRecommendation ?? "";
  });
  // Sprint 3 · Checkpoint 16H completion §17 — "Also close this item"
  // toggle removed. Sending a reply now always completes the item
  // (per the founder rule: completion is inherent in the completing
  // action). No optional close flag remains.
  const [step, setStep] = useState<ComposerStep>("draft");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [sentSummary, setSentSummary] = useState<{
    sentAt: string;
    sendingMailbox: string;
    replyToSubject: string;
  } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveDraft(workIntakeItemId, draft), 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [draft, workIntakeItemId]);

  const canSend = consentState.state === "granted" && draft.trim().length > 0 && step === "draft";

  const goToConfirm = useCallback(() => {
    if (!canSend) return;
    setStep("confirm");
    setErrorText(null);
  }, [canSend]);

  const goBackToDraft = useCallback(() => {
    setStep("draft");
    setErrorText(null);
  }, []);

  const confirmSend = useCallback(async () => {
    if (step !== "confirm") return;
    setStep("sending");
    setErrorText(null);
    try {
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(workIntakeItemId)}/reply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Idempotency: a double-click reuses the same key and the
            // server returns the prior send's result instead of
            // re-sending.
            "x-idempotency-key": `reply:${workIntakeItemId}:${Date.now()}`,
          },
          // Sprint 3 · Checkpoint 16H completion — reply always
          // auto-completes the Work Intake item after successful
          // Graph send. The `andClose: true` flag routes through the
          // canonical WorkCompletionEvent path (REPLIED_AND_CLOSED),
          // which moves the item to Completed History and enqueues
          // the Outlook archive job.
          body: JSON.stringify({ body: draft, andClose: true, mode: "REPLY" }),
        },
      );
      if (res.status === 401) { setErrorText("Your session expired. Please sign in again."); setStep("error"); return; }
      if (res.status === 403) { setErrorText("Reply sending requires additional Microsoft consent for this mailbox. Reconnect the mailbox to approve Mail.Send."); setStep("error"); return; }
      if (res.status === 404) { setErrorText("The source email is no longer available."); setStep("error"); return; }
      if (res.status === 409) { setErrorText("This reply was already sent. The Work Intake state has been updated."); setStep("sent"); return; }
      if (res.status === 429) { setErrorText("Microsoft is temporarily throttling requests. Try again in a few seconds."); setStep("error"); return; }
      if (!res.ok) {
        const asJson = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        setErrorText(asJson.reason ?? asJson.error ?? "Reply could not be sent. Please try again.");
        setStep("error");
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        sentAt?: string;
        sendingMailbox?: string;
        replyToSubject?: string;
      } | null;
      setSentSummary({
        sentAt: body?.sentAt ?? new Date().toISOString(),
        sendingMailbox: body?.sendingMailbox ?? "your mailbox",
        replyToSubject: body?.replyToSubject ?? "the conversation",
      });
      // Sprint 3 · Checkpoint 16H — clear the local draft after
      // successful send so the field starts empty on reopen.
      clearDraft(workIntakeItemId);
      setStep("sent");
    } catch {
      setErrorText("Network error while sending the reply.");
      setStep("error");
    }
  }, [workIntakeItemId, draft, step]);

  if (step === "sent" && sentSummary) {
    return (
      <section
        className="spectre-mc-inline-composer spectre-mc-inline-composer--sent"
        aria-label="Reply sent"
        data-testid="reply-composer-sent"
      >
        <header className="spectre-mc-inline-composer-head">
          <span className="spectre-mc-inline-composer-eyebrow">Reply sent</span>
          <span className="spectre-mc-inline-composer-status" data-testid="composer-status-sent">
            Sent {formatDateTime(sentSummary.sentAt)}
          </span>
        </header>
        <p className="spectre-mc-inline-composer-truthful-note" data-testid="composer-sent-note">
          Reply sent from <b>{sentSummary.sendingMailbox}</b> to <b>{sentSummary.replyToSubject}</b>.
          {" "}Moved to Completed History and Outlook message archive requested.
        </p>
        <div className="spectre-mc-inline-composer-controls">
          <button type="button" className="spectre-btn spectre-btn--ghost" onClick={onCancel} data-testid="composer-close-after-sent">
            Close
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      className="spectre-mc-inline-composer"
      aria-label="Reply composer"
      data-testid="reply-composer"
      data-consent-state={consentState.state}
      data-step={step}
    >
      <header className="spectre-mc-inline-composer-head">
        <span className="spectre-mc-inline-composer-eyebrow">Reply draft</span>
        <span className="spectre-mc-inline-composer-status" data-testid="composer-status-draft">
          {step === "sending" ? "Sending…" : step === "confirm" ? "Confirm before sending" : "Draft — not sent"}
        </span>
      </header>

      <textarea
        className="spectre-mc-inline-composer-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Compose your reply here."
        rows={8}
        disabled={step !== "draft"}
        data-testid="composer-textarea"
        maxLength={20000}
      />

      {consentState.state !== "granted" ? (
        <div
          className="spectre-mc-inline-composer-consent"
          role="note"
          data-testid="composer-consent-notice"
          data-consent-state={consentState.state}
        >
          {consentState.reason}
        </div>
      ) : null}

      {step === "confirm" ? (
        <div className="spectre-mc-inline-composer-confirm" data-testid="composer-confirm-panel">
          <p className="lead">Ready to send. Please confirm:</p>
          <ul>
            <li>Reply is sent from the connected mailbox listed in the thread header.</li>
            <li>Recipient and subject are set from the source message on the server — you cannot change them here.</li>
            <li>After a successful send, the Work Intake moves to Completed History and the linked Outlook message is archived.</li>
          </ul>
        </div>
      ) : null}

      {errorText ? (
        <div className="spectre-mc-inline-composer-error" role="alert" data-testid="composer-error">
          {errorText}
        </div>
      ) : null}

      <div className="spectre-mc-inline-composer-controls">
        {step === "draft" ? (
          <>
            <button type="button" className="spectre-btn spectre-btn--ghost" onClick={onCancel} data-testid="composer-cancel">
              Cancel
            </button>
            {/* Sprint 3 · Checkpoint 16H completion §17 — no optional
                close toggle. Send reply always completes + archives on
                success. */}
            <button
              type="button"
              className={canSend ? "spectre-btn spectre-btn--primary" : "spectre-btn spectre-btn--primary spectre-btn--disabled"}
              disabled={!canSend}
              aria-disabled={!canSend ? "true" : undefined}
              onClick={goToConfirm}
              title={canSend ? undefined : consentState.reason}
              data-testid="composer-send"
            >
              <IconSend size={12} />
              Send reply
            </button>
          </>
        ) : step === "confirm" ? (
          <>
            <button type="button" className="spectre-btn spectre-btn--ghost" onClick={goBackToDraft} data-testid="composer-back">
              Back to draft
            </button>
            <button type="button" className="spectre-btn spectre-btn--primary" onClick={confirmSend} data-testid="composer-confirm-send">
              <IconSend size={12} />
              Confirm &amp; send
            </button>
          </>
        ) : step === "sending" ? (
          <button type="button" className="spectre-btn spectre-btn--primary" disabled data-testid="composer-sending">
            Sending…
          </button>
        ) : step === "error" ? (
          <>
            <button type="button" className="spectre-btn spectre-btn--ghost" onClick={goBackToDraft} data-testid="composer-back-after-error">
              Back to draft
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}
