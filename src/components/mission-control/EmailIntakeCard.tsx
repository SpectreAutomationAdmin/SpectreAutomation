"use client";

// Sprint 3 Checkpoint 15I (2026-07-26) — Variant D card body.
// Phase 4R rev-7 (2026-08-15) — simplified 3-tab card model.
//
// Founder-approved design reference:
//   public/design-concepts/mission-control/variant-d-instrument.html
//
// Rev-7 interaction contract (supersedes the rev-6 Open/Collapse
// accordion):
//   • Every card exposes exactly three founder-facing tabs at the top:
//       Spectre Summary | Conversation | Attachments
//     The tab selection drives the ENTIRE card body — the Spectre
//     Summary is not persisted as a header above the other tabs.
//   • The default tab on first render is `spectre-summary`.
//   • Attachments tab renders only when the intake has at least one
//     attachment; the tab strip hides the entry otherwise.
//   • The former Invoice Review / Statement Review tabs are RETIRED
//     from founder-facing navigation — their content was a projection
//     of `ap-evidence` whose founder-visible fields (vendor / invoice
//     # / amount / category / confidence / recommendation) already
//     live inside the Spectre Summary. The underlying `ap-evidence`
//     endpoint remains for diagnostics + tests.
//   • The former Activity tab is retired — audit rows continue to
//     land in the `WorkIntakeAudit` table; the founder just does not
//     get a dedicated card tab for them.
//   • Read/unread: the previous rev-6 model fired mark-read on
//     Open-click. With Open removed, mark-read now fires on the first
//     tab interaction (any tab click). Merely rendering the card still
//     does not flip read state — same product rule.
//   • Resolve / Restore still fire POST { action: … } and trigger a
//     router.refresh().
//
// Preserves all Sprint 3 Checkpoint 15H behaviour:
//   • One canonical parent card per email conversation (loader-level
//     suppression of child AP / Statement intakes)
//   • Blob-URL PDF preview via DocumentPreviewModal (CSP object-src +
//     frame-src permit `blob:` per src/middleware.ts)
//   • Sender identity remains SEPARATE from extracted vendor identity.
//   • Tenant isolation preserved end-to-end.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import InlineConversationPanel, { type ConversationDetail } from "./InlineConversationPanel";
import ReplyComposer from "./ReplyComposer";
import DocumentPreviewModal from "./DocumentPreviewModal";
import CreateVendorAndPostModal from "./CreateVendorAndPostModal";
import { CategoryHoverAllocations } from "./CategoryHoverAllocations";
import { ApCardConfidenceDisclosure } from "./ApCardConfidenceDisclosure";
import type { LinkedIntelligenceForEmail, ApInvoiceCardIntelligence } from "@/lib/mission-control";
// 15P-5: the one canonical AP-action derivation. Both the primary-
// button label and the modal-open decision come from this function
// so they can never drift.
import { deriveApAction, type ApAction } from "@/lib/mission-control/ap-action";
// Sprint 3 · Checkpoint 16C (2026-08-04) — unified Work Intake
// amount formatter. Every amount surface routes through this helper.
import { formatWorkIntakeAmount } from "@/lib/ap-intelligence/format-amount";
// Sprint 3 · Checkpoint 16G Stage D (2026-08-04) — domain view-model.
// Non-AP cards render through this so AP fields never leak onto a
// membership / governance / general card.
import { buildDomainViewModel, type DomainCardViewModel } from "@/lib/mission-control/domain-view-models";

// -------------------------------------------------------------------------
// Public props
// -------------------------------------------------------------------------

export interface EmailFeedCardData {
  workIntakeItemId: string;
  emailMessageId: string;
  // Semantic state → left rail colour + pill variant (Variant D §3.6).
  state: "judgment" | "info" | "comm";
  idTag: string;
  situationTitle: string;
  contextLine: string;           // Sender line — the raw email `from` metadata.
  timestampLabel: string;
  synopsisText: string;
  evidence: Array<{
    // Existing label vocabulary — projected by the loader from the
    // analyser. Rendered as the 4-cell instrument-panel readout in
    // Variant D style. See src/lib/mission-control/index.ts →
    // WorkItemEvidenceCell.
    label: string;
    value: string;
    state: "found" | "ambiguous" | "not_found" | "not_extracted" | "extracted" | "duplicate" | "no_data";
  }>;
  recommendation?: string;
  isUnread: boolean;             // Projected per-user by the loader (Checkpoint 15I).
  isHighImportance: boolean;
  conversationMessageCount: number;
  workIntakeStatus?: string;     // OPEN | IN_PROGRESS | DEFERRED | RESOLVED | INFORMATIONAL | SUPPRESSED
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — typed AP-card
  // projection. The card's Variant D AP body consumes this shape
  // directly instead of the generic email-derived `evidence` array.
  linkedIntelligence?: LinkedIntelligenceForEmail;
  // Sprint 3 · Checkpoint 16G Stage B/D (2026-08-04) — work-domain
  // taxonomy. When workDomain is set to a non-AP value, the card
  // renderer uses the domain view-model and NEVER shows the AP
  // invoice grid or Invoice Review / Statement Review tabs.
  workDomain?: string;
  workIntent?: string;
  workSubtype?: string;
}

interface Props { data: EmailFeedCardData }

// Phase 4R rev-7 (2026-08-15) — founder-facing tab set. Reduced
// from five to three. `invoice` / `statement` / `activity` are
// retired for founder-facing navigation.
type Tab = "spectre-summary" | "conversation" | "attachments";

const PILL_LABEL: Record<EmailFeedCardData["state"], string> = {
  judgment: "Needs judgment",
  info: "Informational",
  comm: "Communication required",
};

// -------------------------------------------------------------------------
// Card
// -------------------------------------------------------------------------

export default function EmailIntakeCard({ data }: Props) {
  const router = useRouter();
  const [readLocal, setReadLocal] = useState(!data.isUnread);
  // Phase 4R rev-7 (2026-08-15) — the card no longer has an
  // Open/Collapse state. Every card renders its tab body inline;
  // switching tabs replaces the entire body. Default tab is always
  // `spectre-summary`.
  const [tab, setTab] = useState<Tab>("spectre-summary");
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [pdfModal, setPdfModal] = useState<null | { documentId: string; filename: string }>(null);
  // Sprint 3 · Checkpoint 15L — vendor-first modal open state.
  const [cvapModalOpen, setCvapModalOpen] = useState(false);
  // 15P-2: when the AP primary is "Approve & post" (or "Review
  // coding") and the vendor is already matched, we open the same
  // modal directly at Step 2 with the matched vendor preselected.
  // For a new vendor the modal opens at Step 1 as before. Kept as a
  // discriminated shape so the props threaded to the modal are
  // never partially set.
  const [cvapModalMode, setCvapModalMode] = useState<
    | { kind: "STEP_1" }
    // 15P-4: `autoResolved` distinguishes the single-step AP-coding
    // modal (READY_FOR_APPROVAL) from the two-step-opened-at-Step-2
    // form used for NEEDS_JUDGMENT.
    | { kind: "STEP_2"; vendorId: string; vendorName: string; autoResolved: boolean }
  >({ kind: "STEP_1" });
  // Phase 4R rev-7 (2026-08-15) — apEvidence + statementEvidence
  // are no longer rendered as founder-facing tabs. The endpoints
  // remain (used by diagnostics, tests, and the CVAP modal) but
  // this component no longer proxies them into tab bodies.
  const [attachments, setAttachments] = useState<
    Array<{ id: string; filename: string; mimeType: string; byteLength: number; classification: string; receivedAt: string }> | null
  >(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Phase 4R rev-9 (2026-08-15) — per-card Summary baseline.
  // While the Spectre Summary panel is mounted (default tab), a
  // ResizeObserver captures the FRAME's natural outer height and
  // stores it as `summaryBaseline`. That value is then applied as
  // an inline `min-height` on the same frame when a non-Summary
  // tab is active, so switching to Attachments (or a short
  // Conversation) does not shrink the visible card and cause the
  // feed to jump.
  //
  // We measure the FRAME (not the summary body or shell) because
  // the project applies `box-sizing: border-box` globally — so
  // min-height on the frame is compared against the frame's outer
  // rectangle, not its content area. Measuring the frame's outer
  // rectangle and applying it back as min-height keeps the two
  // sides of the comparison in the same coordinate system.
  //
  // Attachments compresses to single-line row density (see
  // `.spectre-mc-attachment-list` in globals.css) so a typical
  // 4-6 attachment list fits within the Summary baseline. If
  // Conversation is longer than the baseline the frame grows
  // naturally — the min-height is a FLOOR, not a cap.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [summaryBaseline, setSummaryBaseline] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (tab !== "spectre-summary") return;
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Seed an initial measurement synchronously so the first
    // non-Summary tab click already has a baseline available.
    setSummaryBaseline((prev) => {
      const h = el.offsetHeight;
      return prev === h ? prev : h;
    });
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h =
          entry.borderBoxSize?.[0]?.blockSize ??
          (entry.target as HTMLElement).offsetHeight;
        // Only update on visually meaningful changes (≥ 1 px) so
        // sub-pixel jitter cannot start an update loop.
        setSummaryBaseline((prev) => (prev !== null && Math.abs(prev - h) < 1 ? prev : Math.round(h)));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [tab]);

  const isUnread = !readLocal;
  const isResolved = data.workIntakeStatus === "RESOLVED";
  const linked = data.linkedIntelligence;
  // Sprint 3 Checkpoint 15I-2 (2026-07-27) — AP-mode gate.
  //   `ap` is defined only when the loader projected a real
  //   ApInvoiceCardIntelligence (i.e. the intake has an attached
  //   invoice PDF that the analyser could process). Everything the
  //   AP-mode body renders is projected — no re-parse here.
  const ap: ApInvoiceCardIntelligence | null = linked?.invoiceSummary ?? null;

  const availableTabs = tabsFor(data);

  useEffect(() => {
    // If the linked intelligence changes and the current tab is no
    // longer in the available set, snap back to the Spectre Summary
    // default (which is always present).
    if (!availableTabs.includes(tab)) setTab("spectre-summary");
  }, [availableTabs, tab]);

  const loadConversationOnce = useCallback(async () => {
    if (detail || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(data.workIntakeItemId)}/thread`,
        { method: "GET" },
      );
      if (res.status === 404) { setError("not_found"); return; }
      if (!res.ok) { setError("load_failed"); return; }
      const body = (await res.json()) as ConversationDetail;
      setDetail(body);
    } catch { setError("load_failed"); }
    finally { setLoading(false); }
  }, [data.workIntakeItemId, detail, loading]);

  const loadAttachmentsOnce = useCallback(async () => {
    if (attachments !== null) return;
    try {
      const res = await fetch(
        `/api/mission-control/work-intake/${encodeURIComponent(data.workIntakeItemId)}/documents`,
        { method: "GET" },
      );
      if (!res.ok) { setAttachments([]); return; }
      const body = await res.json();
      setAttachments(body.documents ?? []);
    } catch { setAttachments([]); }
  }, [data.workIntakeItemId, attachments]);

  // Phase 4R rev-7 (2026-08-15) — loadApEvidenceOnce +
  // loadStatementEvidenceOnce retired with the invoice-review /
  // statement-review tabs. The underlying endpoints still exist for
  // tests + the CVAP modal (which fetches its own evidence lazily).

  // Fire the mark-read side effect the first time the user clicks
  // any tab. Idempotent server-side — repeated calls are no-ops.
  const markReadOnce = useCallback(async () => {
    if (readLocal || !data.workIntakeItemId) return;
    setReadLocal(true);
    try {
      await fetch("/api/work-intake/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "mark_read" }),
      });
    } catch {
      // Non-blocking. If the mark-read call fails, the UI state still
      // flips locally — a subsequent snapshot load will re-derive.
    }
  }, [readLocal, data.workIntakeItemId]);

  // Phase 4R rev-7 (2026-08-15) — the sole tab-change hook. Owns
  // read/unread transition + lazy load of the target tab's data.
  // Mark-read fires on ANY tab click (previously fired on Open) — a
  // user-intent gesture. Merely rendering the feed still does not
  // mark items read.
  const handleTabChange = useCallback((next: Tab) => {
    setTab(next);
    void markReadOnce();
    if (next === "conversation") void loadConversationOnce();
    if (next === "attachments") void loadAttachmentsOnce();
  }, [markReadOnce, loadConversationOnce, loadAttachmentsOnce]);

  const handleResolve = useCallback(async (evt: React.MouseEvent) => {
    evt.stopPropagation();
    if (resolving) return;
    setResolving(true);
    setResolveError(null);
    try {
      const res = await fetch("/api/work-intake/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "resolve" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResolveError(body.error ?? "resolve_failed");
        setResolving(false);
        return;
      }
      // Re-fetch the RSC snapshot. The active-feed filter will drop
      // this card automatically (loader now excludes RESOLVED). The
      // underlying WorkIntakeItem row + email + documents + findings
      // are preserved — resolve is a status transition, not a delete.
      router.refresh();
    } catch {
      setResolveError("network");
      setResolving(false);
    }
  }, [resolving, data.workIntakeItemId, router]);

  // Sprint 3 Checkpoint 15I-2 — Defer 24 hr. Uses the existing
  // `defer` action + WorkIntakeItem.deferredUntil. Loader excludes
  // items whose deferredUntil > now from the active feed; the item
  // remains fully preserved and reappears automatically after 24h.
  const [deferring, setDeferring] = useState(false);
  const handleDefer24h = useCallback(async (evt: React.MouseEvent) => {
    evt.stopPropagation();
    if (deferring) return;
    setDeferring(true);
    try {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch("/api/work-intake/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "defer", until }),
      });
      if (res.ok) router.refresh(); else setDeferring(false);
    } catch { setDeferring(false); }
  }, [deferring, data.workIntakeItemId, router]);

  // --- render ------------------------------------------------------------
  const semanticClass = isResolved ? "done" : data.state;
  // Phase 4R rev-9 — apply the measured Summary baseline as an
  // inline min-height on the frame ONLY when a non-Summary tab is
  // active. Applying it while Summary is active would freeze the
  // measurement against legitimate content shrinks (e.g. an
  // error-state that removes lines from the readout); the anti-
  // shrink invariant is only meaningful when the user has left
  // Summary for a shorter panel.
  const frameStyle =
    tab !== "spectre-summary" && summaryBaseline !== null
      ? { minHeight: `${summaryBaseline}px` }
      : undefined;

  return (
    <article
      className={`spectre-mc-item ${semanticClass}${isUnread ? " spectre-mc-item--unread" : ""}`}
      data-testid="email-intake-card"
      data-work-intake-item-id={data.workIntakeItemId}
      data-email-id={data.emailMessageId}
      data-unread={isUnread ? "true" : "false"}
      data-active-tab={tab}
      data-resolved={isResolved ? "true" : "false"}
      aria-labelledby={`title-${data.workIntakeItemId}`}
    >
      {/* Phase 4R rev-7 (2026-08-15) — tab bar at the top of the
          card. Card content BELOW is entirely tab-driven; the
          Spectre Summary is no longer a persistent header above the
          other tabs. Phase 4R rev-9 (2026-08-15) — tabs are OUTSIDE
          the visible frame; each tab visually protrudes above the
          frame and merges into its top border. */}
      <CardTabBar
        available={availableTabs}
        active={tab}
        onChange={handleTabChange}
      />

      {/* Phase 4R rev-9 (2026-08-15) — visible frame. Carries the
          border, background, shadow, rounded corners, left-accent,
          and interior padding. Per-card Summary baseline is applied
          as inline min-height when a non-Summary tab is active so
          the outer frame does not shrink on tab swaps. */}
      <div
        ref={frameRef}
        className="spectre-mc-item-frame"
        data-testid="card-frame"
        style={frameStyle}
      >
      {tab === "spectre-summary" && (
        // Phase 4R rev-9.1 (2026-08-15) — summaryRef sits on this
        // wrapper (NOT on the body div alone) so the measured
        // baseline includes both the Summary body AND the actions
        // row below it. Applying only the body's height as
        // min-height leaves the Attachments frame shorter by the
        // actions row's height (~40 px), reintroducing the exact
        // "card visibly shrinks on tab swap" defect founder review
        // called out.
        <div ref={summaryRef} data-testid="card-summary-shell">
          {/* Spectre Summary body. Same collapsed-body render helpers
              the previous accordion used — the founder-approved
              intelligence hierarchy (pill · title · sender · Spectre
              narrative · 4-cell readout · recommendation) is
              unchanged. `expanded` prop kept as a compat argument
              to the AP renderer; it no longer controls layout. */}
          <div className="spectre-mc-item-body" data-testid="card-summary">
            {ap
              ? renderApCollapsedBody(data, ap, false, () => setCvapModalOpen(true))
              : data.workDomain && data.workDomain !== "ACCOUNTS_PAYABLE"
                ? renderDomainCollapsedBody(data)
                : renderEmailCollapsedBody(data)}
          </div>

          {/* Actions row — queue-level. Lives inside the Spectre
              Summary tab per the rev-7 conceptual split (Summary =
              understand + act). No wrapping click handler here — the
              card body no longer toggles a collapsed state. */}
          <div
            className="spectre-mc-actions"
            role="presentation"
          >
        {isResolved ? (
          // Sprint 3 · Checkpoint 16H completion §11-13 — completed
          // cards render a Restore action (not a static label).
          // Marker span preserved for backward compatibility with
          // tests that read data-testid=card-resolved-marker.
          <>
            <span className="spectre-mc-aux" data-testid="card-resolved-marker">
              Completed
            </span>
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary spectre-btn--sm"
              onClick={async (e) => {
                e.stopPropagation();
                if (resolving) return;
                setResolving(true);
                setResolveError(null);
                try {
                  const res = await fetch("/api/work-intake/action", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ workIntakeItemId: data.workIntakeItemId, action: "restore" }),
                  });
                  if (!res.ok) {
                    setResolveError("restore_failed");
                    setResolving(false);
                    return;
                  }
                  router.refresh();
                } catch {
                  setResolveError("network");
                  setResolving(false);
                }
              }}
              disabled={resolving}
              data-testid="card-restore"
            >
              {resolving ? "Restoring…" : "Restore to Work Intake Feed"}
            </button>
            {resolveError ? (
              <span className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">
                Could not restore — please retry.
              </span>
            ) : null}
          </>
        ) : ap ? (
          <ApActionRow
            ap={ap}
            workIntakeItemId={data.workIntakeItemId}
            onDefer={handleDefer24h}
            onPrimary={() => {
              // Sprint 3 · Checkpoint 15P-5 — click handler consults
              // the SAME `deriveApAction` function that renders the
              // button. Founder rule: "the action button and the
              // modal must never disagree." The derivation is pure —
              // no client state, no cached decision — so a re-render
              // driven by a fresh projection (post vendor create /
              // delete / post) yields a NEW action whose `.modal`
              // block dictates the correct shape.
              if (!ap) return;
              const action = deriveApAction(ap);
              if (action.modal.open) {
                if (action.modal.initialStep === "AP_CODING") {
                  setCvapModalMode({
                    kind: "STEP_2",
                    vendorId: action.modal.vendorId,
                    vendorName: action.modal.vendorName,
                    autoResolved: action.modal.autoResolved,
                  });
                } else {
                  setCvapModalMode({ kind: "STEP_1" });
                }
                setCvapModalOpen(true);
                void markReadOnce();
                return;
              }
              // Phase 4R rev-7 (2026-08-15) — non-modal actions
              // (duplicate, missing info, COA required) previously
              // jumped to the Invoice Review tab. That tab has been
              // retired; the equivalent founder-facing information
              // now lives in the Spectre Summary body the card is
              // already showing. Fire mark-read and let the summary
              // stand.
              void markReadOnce();
            }}
            onOpenPdf={ap.primaryAttachment
              ? () => setPdfModal({ documentId: ap.primaryAttachment!.documentId, filename: ap.primaryAttachment!.filename })
              : undefined
            }
          />
        ) : (
          <>
            <button
              type="button"
              className="spectre-btn spectre-btn--secondary spectre-btn--sm"
              onClick={handleResolve}
              disabled={resolving}
              data-testid="card-resolve"
            >
              {resolving ? "Resolving…" : "Resolve"}
            </button>
            {resolveError ? (
              <span className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">
                Could not resolve — please retry.
              </span>
            ) : null}
          </>
        )}
          </div>
        </div>
      )}

      {/* Conversation tab body — the card body when
          tab === "conversation". Spectre Summary content is NOT
          rendered above this. */}
      {tab === "conversation" && (
        <div className="spectre-mc-tab-body" data-testid="card-conversation">
          {
              loading ? <div className="spectre-mc-inline-status" role="status">Loading conversation…</div>
              : error ? <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">Could not load the conversation.</div>
              : detail ? (
                <>
                  <InlineConversationPanel detail={detail} />
                  {replyOpen ? (
                    <ReplyComposer
                      workIntakeItemId={data.workIntakeItemId}
                      emailMessageId={data.emailMessageId}
                      seedRecommendation={data.recommendation}
                      consentState={detail.replyConsent}
                      onCancel={() => setReplyOpen(false)}
                    />
                  ) : (
                    <div className="spectre-mc-tab-actions">
                      <button
                        type="button"
                        className="spectre-btn spectre-btn--secondary spectre-btn--sm"
                        onClick={() => setReplyOpen(true)}
                        data-testid="tab-conversation-reply"
                      >
                        Reply
                      </button>
                    </div>
                  )}
                </>
              )
              : null
          }
        </div>
      )}

      {/* Attachments tab body — the card body when
          tab === "attachments". Spectre Summary content is NOT
          rendered above this. */}
      {tab === "attachments" && (
        <div className="spectre-mc-tab-body" data-testid="card-attachments">
          {attachments === null ? (
            <div className="spectre-mc-inline-status" role="status">Loading attachments…</div>
          ) : (
            <ul className="spectre-mc-attachment-list" data-testid="unified-attachment-list">
              {attachments.length === 0 ? <li>No attachments.</li> : null}
              {attachments.map((a) => (
                <li key={a.id} data-testid={`unified-attachment-${a.id}`}>
                  {/* Phase 4R rev-9 (2026-08-15) — single-line row
                      density: filename + meta collapse into one
                      column; buttons sit right-aligned on the
                      same row. Compact enough that a 4-6 file
                      list fits within the Summary baseline. */}
                  <div>
                    <strong>{a.filename}</strong>
                    <span className="spectre-review-muted"> · {Math.round(a.byteLength / 1024)} KB</span>
                  </div>
                  <div>
                    <button
                      type="button"
                      className="spectre-btn spectre-btn--sm spectre-btn--secondary"
                      onClick={() => setPdfModal({ documentId: a.id, filename: a.filename })}
                      data-testid={`unified-attachment-preview-${a.id}`}
                    >
                      View
                    </button>
                    <a
                      href={`/api/documents/${encodeURIComponent(a.id)}/download`}
                      className="spectre-btn spectre-btn--sm spectre-btn--ghost"
                      download={a.filename}
                    >
                      Download
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>

      {pdfModal ? (
        <DocumentPreviewModal
          documentId={pdfModal.documentId}
          filename={pdfModal.filename}
          open={true}
          onClose={() => setPdfModal(null)}
          contextLabel={`From: ${data.contextLine} · ${data.timestampLabel}`}
        />
      ) : null}

      {ap ? (
        <CreateVendorAndPostModal
          open={cvapModalOpen}
          onClose={() => {
            setCvapModalOpen(false);
            // Reset mode so the next open (unless explicitly set by
            // a primary-action click) starts at Step 1 again.
            setCvapModalMode({ kind: "STEP_1" });
          }}
          ap={ap}
          workIntakeItemId={data.workIntakeItemId}
          initialStep={cvapModalMode.kind === "STEP_2" ? "AP_CODING" : "PROFILE"}
          preselectedVendorId={cvapModalMode.kind === "STEP_2" ? cvapModalMode.vendorId : undefined}
          preselectedVendorName={cvapModalMode.kind === "STEP_2" ? cvapModalMode.vendorName : undefined}
          autoResolvedVendor={cvapModalMode.kind === "STEP_2" ? cvapModalMode.autoResolved : false}
        />
      ) : null}
    </article>
  );
}

// -------------------------------------------------------------------------
// Tab plumbing (Phase 4R rev-7 · 2026-08-15)
// -------------------------------------------------------------------------

function tabsFor(data: EmailFeedCardData): Tab[] {
  // Spectre Summary + Conversation always present. Attachments only
  // when the intake actually has one — otherwise the tab entry hides.
  const linked = data.linkedIntelligence;
  const tabs: Tab[] = ["spectre-summary", "conversation"];
  if ((linked?.attachmentCount ?? 0) > 0) tabs.push("attachments");
  return tabs;
}

const CARD_TAB_LABEL: Record<Tab, string> = {
  "spectre-summary": "Spectre Summary",
  conversation:      "Conversation",
  attachments:       "Attachments",
};

function CardTabBar({ available, active, onChange }: { available: Tab[]; active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="spectre-mc-tabs spectre-mc-tabs--card" role="tablist" data-testid="card-tabs">
      {available.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={active === t}
          className={`spectre-mc-tab${active === t ? " spectre-mc-tab--active" : ""}`}
          onClick={(e) => { e.stopPropagation(); onChange(t); }}
          data-testid={`card-tab-${t}`}
        >
          {CARD_TAB_LABEL[t]}
        </button>
      ))}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Sprint 3 Checkpoint 15I-2 (2026-07-27) — Variant D AP-invoice card body.
//
// This helper renders the collapsed AP-mode body for cards that have a
// linked AP child intake (invoice PDF attached to the email). It renders
// EVERY visible cell from the typed ApInvoiceCardIntelligence projection —
// no re-parse of the PDF, no fallback to email-only heuristics.
//
// Region mapping (Ace Foods reference · variant-d-instrument.html):
//   status pill · id tag · timestamp
//   h3: <Vendor> invoice #<Number> — <Currency Amount> · <Category>
//   sender line: <address> · <cadence> · <terms>
//   work paragraph: accounting-specific narrative
//   4-cell readout: AMOUNT · PO/INVOICE · CATEGORY · CONFIDENCE
//   recommendation strip: workflow-specific action language
//
// Sender identity is provenance only — it NEVER labels the vendor.
// ---------------------------------------------------------------------------

function renderApCollapsedBody(
  data: EmailFeedCardData,
  ap: ApInvoiceCardIntelligence,
  expanded: boolean,
  onOpenCreateVendor: () => void,
) {
  const pill = pillForApWorkflow(ap.workflowState);
  const senderLine = buildApSenderLine(ap);
  const linked = data.linkedIntelligence;

  // Post-Slice-3 lifecycle contract (2026-08-09) — §5, §13, §14.
  //
  // While the projection reports ANALYSIS_PENDING the card MUST NOT
  // draw the ReadoutCell row (which would render dashes for Amount /
  // Invoice / Category), MUST NOT render the confidence disclosure
  // (which would report NEEDS_REVIEW off null fields), and MUST NOT
  // give the founder an accounting action based on non-existent
  // facts. It draws a compact pending shell instead: pill · sender ·
  // attachment filename · "Spectre is reading the attached invoice."
  //
  // Note that ApActionRow's `deriveApAction` already short-circuits
  // ANALYSIS_PENDING to EXPAND_ONLY at src/lib/mission-control/ap-action.ts,
  // so the primary action button is safe. This branch handles the
  // card body — the readout row and the recommendation strip.
  if (ap.workflowState === "ANALYSIS_PENDING") {
    const filename = ap.primaryAttachment?.filename ?? null;
    return (
      <>
        <div className="spectre-mc-item-head">
          <span className={`spectre-mc-pill ${pill.tone}`} data-testid="ap-workflow-pill">{pill.label}</span>
          <span className="spectre-mc-id-tag">{data.idTag}</span>
          <span className="spectre-mc-ts">{data.timestampLabel}</span>
        </div>
        <h3 id={`title-${data.workIntakeItemId}`} data-testid="ap-title">
          <span className="spectre-mc-pending-title">Analysis pending</span>
        </h3>
        <p className="spectre-mc-work" data-testid="ap-work-summary-pending">
          Spectre is reading the attached invoice{filename ? ` (${filename})` : ""}. Founder-facing facts will
          publish together once the canonical analysis completes.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="spectre-mc-item-head">
        <span className={`spectre-mc-pill ${pill.tone}`} data-testid="ap-workflow-pill">{pill.label}</span>
        <span className="spectre-mc-id-tag">{data.idTag}</span>
        {data.conversationMessageCount > 1 ? (
          <span className="spectre-mc-convo-count" data-testid="email-convo-count">
            {data.conversationMessageCount} messages
          </span>
        ) : null}
        <span className="spectre-mc-ts">{data.timestampLabel}</span>
      </div>

      <h3 id={`title-${data.workIntakeItemId}`} data-testid="ap-title">
        <ApTitle ap={ap} onVendorClick={onOpenCreateVendor} />
      </h3>

      <div className="spectre-mc-sender" data-testid="ap-sender-line">
        <span className="from">{senderLine}</span>
      </div>

      {/* Sprint 3 · 221178 next slice · PART B (2026-08-10) — duplicate-
           submission surface. When the projection identifies the
           email as a RETRANSMISSION of an earlier submission of the
           same underlying invoice (SHA-dedup at IngestedDocument),
           render a compact "Duplicate of an earlier submission" chip
           so the founder can see that both cards represent one
           invoice instance. Accounting arithmetic is already
           isolated per card; posting is idempotent at
           `wi.status === "RESOLVED"`. This chip is a visibility aid,
           not an enforcement gate. */}
      {(linked?.duplicateSubmissionRelationship === "RETRANSMISSION"
        || linked?.duplicateSubmissionRelationship === "POSSIBLE_DUPLICATE") ? (
        <div
          className="spectre-mc-dup-chip"
          data-testid="ap-duplicate-submission"
          data-relationship={linked.duplicateSubmissionRelationship}
          data-duplicate-of={linked.duplicateOfEmailIntakeId ?? ""}
        >
          <span className="lbl">Duplicate submission</span>
          <span className="detail">
            {linked.duplicateSubmissionRelationship === "POSSIBLE_DUPLICATE"
              ? "This document may already have been submitted."
              : "This is a retransmit of an earlier submission of the same document. Both cards reference one invoice; only one can post."}
          </span>
        </div>
      ) : null}

      <p className="spectre-mc-work" data-testid="ap-work-summary">
        <ApWorkSummary ap={ap} />
      </p>

      <div className="spectre-mc-readout" data-testid="ap-readout">
        <ReadoutCell k="Amount" v={formatAmountReadout(ap.gross.amount, ap.gross.currency, ap.currencyShowCode !== false)} testid="ap-readout-amount" />
        <ReadoutCell
          k={ap.purchaseOrder.poNumber ? "PO" : "Invoice"}
          v={ap.purchaseOrder.poNumber
            ? `#${ap.purchaseOrder.poNumber}`
            : (ap.invoiceNumber ? `#${ap.invoiceNumber}` : "—")}
          tone={ap.purchaseOrder.poNumber || ap.invoiceNumber ? undefined : "observation"}
          testid="ap-readout-po-or-invoice"
        />
        <CategoryHoverAllocations
          category={ap.category.label ?? null}
          allocations={ap.allocations ?? null}
          currency={ap.gross.currency ?? "CAD"}
          currencyShowCode={ap.currencyShowCode !== false}
          testid="ap-readout-category"
          purposeLabel={ap.category.purposeLabel ?? null}
          purposeReason={ap.category.purposeReason ?? null}
        />
        {/* Sprint 3 · Phase 5 · Slice 1 (2026-08-09) — decision-
            specific confidence disclosure replaces the generic
            "Confidence: 95 %" cell. Preserves data-testid + cell
            position + column count for existing source-contract test
            (c15i2-variant-d-ap-card-source-contract). */}
        <ApCardConfidenceDisclosure ap={ap} testid="ap-readout-confidence" />
      </div>

      <div className="spectre-mc-rec" data-testid="ap-recommendation">
        <span className="k">Recommended</span>
        <span className="v">{ap.workflowReason}</span>
      </div>
    </>
  );
}

// Sprint 3 · Checkpoint 16G Stage D — domain-specific renderer for
// non-AP cards. Uses buildDomainViewModel to pick the label set,
// primary actions, and tabs appropriate to workDomain. NEVER emits
// VENDOR / INVOICE / AP STATUS / AMOUNT fields — those live only in
// the AP renderer above.
function renderDomainCollapsedBody(data: EmailFeedCardData) {
  const vm = buildDomainViewModel({
    workDomain: data.workDomain,
    workSubtype: data.workSubtype,
    workIntent: data.workIntent,
    senderDisplay: data.contextLine.split("·")[0].trim(),
    receivedLabel: data.timestampLabel,
    responseStatus: data.workIntakeStatus === "RESOLVED" ? "Resolved"
      : data.workIntakeStatus === "IN_PROGRESS" ? "In progress"
      : data.workIntakeStatus === "DEFERRED" ? "Deferred"
      : "Awaiting reply",
    linkedIntelligenceInvoiceCount: data.linkedIntelligence?.invoiceAttachmentCount ?? 0,
    linkedIntelligenceStatementCount: data.linkedIntelligence?.statementAttachmentCount ?? 0,
    linkedIntelligenceAttachmentCount: data.linkedIntelligence?.attachmentCount ?? 0,
  });
  return (
    <>
      <div className="spectre-mc-item-head">
        <span className={`spectre-mc-pill ${data.state}`}>{PILL_LABEL[data.state]}</span>
        <span className="spectre-mc-id-tag">{data.idTag}</span>
        <span className="spectre-mc-domain-badge" data-testid="domain-badge" data-domain={vm.domain}>
          {vm.domainLabel}
        </span>
        {data.isHighImportance ? (
          <span className="spectre-mc-flag" data-testid="email-importance-high" title="High importance in the source mailbox">
            High importance
          </span>
        ) : null}
        {data.conversationMessageCount > 1 ? (
          <span className="spectre-mc-convo-count" data-testid="email-convo-count">
            {data.conversationMessageCount} messages
          </span>
        ) : null}
        <span className="spectre-mc-ts">{data.timestampLabel}</span>
      </div>
      <h3 id={`title-${data.workIntakeItemId}`}>{data.situationTitle}</h3>
      <div className="spectre-mc-sender">
        <span className="from">{data.contextLine}</span>
      </div>
      <p className="spectre-mc-work" data-testid={`domain-synopsis-${vm.domain.toLowerCase()}`}>{data.synopsisText}</p>
      {vm.fields.length > 0 ? (
        <div className="spectre-mc-readout" data-testid={`domain-readout-${vm.domain.toLowerCase()}`}>
          {vm.fields.slice(0, 4).map((cell) => (
            <div key={cell.label} className="cell" data-testid={`domain-field-${cell.label.toLowerCase().replace(/\s+/g, "-")}`}>
              <div className="k">{cell.label}</div>
              <div className={`v${cell.state === "not_found" || cell.state === "not_extracted" ? " observation" : ""}`}>
                {cell.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {data.recommendation ? (
        <div className="spectre-mc-rec">
          <span className="k">Recommended</span>
          <span className="v">{data.recommendation}</span>
        </div>
      ) : null}
    </>
  );
}

// Fallback renderer — for email-derived cards that do NOT have an AP
// child (member correspondence, informational email, etc.). Preserves
// the pre-15I-2 rendering path unchanged.
function renderEmailCollapsedBody(data: EmailFeedCardData) {
  return (
    <>
      <div className="spectre-mc-item-head">
        <span className={`spectre-mc-pill ${data.state}`}>{PILL_LABEL[data.state]}</span>
        <span className="spectre-mc-id-tag">{data.idTag}</span>
        {data.isHighImportance ? (
          <span className="spectre-mc-flag" data-testid="email-importance-high" title="High importance in the source mailbox">
            High importance
          </span>
        ) : null}
        {data.conversationMessageCount > 1 ? (
          <span className="spectre-mc-convo-count" data-testid="email-convo-count">
            {data.conversationMessageCount} messages
          </span>
        ) : null}
        <span className="spectre-mc-ts">{data.timestampLabel}</span>
      </div>
      <h3 id={`title-${data.workIntakeItemId}`}>{data.situationTitle}</h3>
      <div className="spectre-mc-sender">
        <span className="from">{data.contextLine}</span>
      </div>
      <p className="spectre-mc-work" data-testid="email-synopsis">{data.synopsisText}</p>
      {data.evidence.length > 0 ? (
        <div className="spectre-mc-readout" data-testid="email-readout">
          {data.evidence.slice(0, 4).map((cell) => (
            <div key={cell.label} className="cell" data-testid={`readout-${cell.label.toLowerCase().replace(/\s+/g, "-")}`}>
              <div className="k">{cell.label}</div>
              <div className={`v${cell.state === "not_found" || cell.state === "not_extracted" ? " observation" : ""}${cell.state === "found" ? " confidence" : ""}`}>
                {cell.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {data.recommendation ? (
        <div className="spectre-mc-rec">
          <span className="k">Recommended</span>
          <span className="v">{data.recommendation}</span>
        </div>
      ) : null}
    </>
  );
}

function ReadoutCell({ k, v, tone, testid }: { k: string; v: string; tone?: "observation" | "confidence"; testid?: string }) {
  return (
    <div className="cell" data-testid={testid}>
      <div className="k">{k}</div>
      <div className={`v${tone ? ` ${tone}` : ""}`}>{v}</div>
    </div>
  );
}

// ---- Pill / title / sender / work helpers ---------------------------------

function pillForApWorkflow(state: ApInvoiceCardIntelligence["workflowState"]): { label: string; tone: string } {
  switch (state) {
    case "READY_FOR_APPROVAL":         return { label: "Ready for approval",       tone: "approval" };
    case "VENDOR_MATCH_REQUIRED":      return { label: "Vendor match required",    tone: "judgment" };
    case "MISSING_INFORMATION":        return { label: "Missing information",      tone: "judgment" };
    case "POSSIBLE_DUPLICATE":         return { label: "Possible duplicate",       tone: "judgment" };
    case "CHART_OF_ACCOUNTS_REQUIRED": return { label: "Chart of accounts required", tone: "judgment" };
    // Sprint 3 · Post-16H Phase 3.1 (2026-08-06) — new canonical
    // states surfaced through the same Variant D pill treatment.
    case "ANALYSIS_PENDING":           return { label: "Analysis pending",         tone: "info" };
    case "UNSUPPORTED":                return { label: "Needs review",             tone: "judgment" };
    case "NEEDS_JUDGMENT":
    default:                           return { label: "Needs judgment",           tone: "judgment" };
  }
}

/**
 * Sprint 3 · Checkpoint 15M — factual title as a React fragment so
 * the vendor name segment can be an anchor. When the vendor exists,
 * it links to the permanent vendor timeline; when the vendor is
 * only extracted (no record yet), it links to the provisional
 * timeline view keyed to the extracted identity + Work Intake id
 * so the pre-creation history survives vendor creation.
 *
 * Only the vendor-name span is interactive — the invoice number,
 * amount, and category are plain text (§Phase 2: "Only Microsoft
 * Corporation should act as the vendor link.").
 *
 * Sprint 3 · Checkpoint 15M currency (Phase 8): amount renders as
 * `$31.29 CAD` (locale-aware symbol + trailing code) via the
 * shared money formatter, not the pre-15M `CAD 31.29` shape.
 */
function ApTitle({
  ap,
  onVendorClick,
}: {
  ap: ApInvoiceCardIntelligence;
  onVendorClick: () => void;
}) {
  const vendorLabel = ap.vendorMatch.matchedName ?? ap.extractedVendor.name;
  const invoiceNumber = ap.invoiceNumber ? `invoice #${ap.invoiceNumber}` : (vendorLabel ? "invoice" : null);
  // 16C — unified formatter. Same $X,XXX.XX CAD shape as the
  // Amount readout cell, regardless of currency presence.
  const amount = ap.gross.amount
    ? formatWorkIntakeAmount({ amount: ap.gross.amount, currency: ap.gross.currency })
    : null;
  const category = ap.category.label ?? null;

  // Sprint 3 · Checkpoint 15O — vendor-name click behaviour.
  //
  //   MATCHED       → link to /app/admin/ap/vendors/[id]/timeline
  //                    (the real, permanent vendor timeline).
  //   NOT_FOUND / AMBIGUOUS / INSUFFICIENT_SIGNAL
  //                 → button that OPENS the Create Vendor modal.
  //                    No provisional route, no fake vendor entity.
  //                    (§Phase 1 — provisional timeline REMOVED.)
  //
  // The vendor label is always visually emphasised — the linked-vs-
  // action distinction is only in the underlying element.
  if (vendorLabel && ap.vendorMatch.state === "MATCHED" && ap.vendorMatch.matchedVendorId) {
    const href = `/app/admin/ap/vendors/${encodeURIComponent(ap.vendorMatch.matchedVendorId)}/timeline`;
    return (
      <>
        <a
          href={href}
          className="spectre-mc-vendor-link"
          data-testid="ap-title-vendor-link"
          onClick={(e) => e.stopPropagation()}
        >
          {vendorLabel}
        </a>
        {invoiceNumber ? <> {invoiceNumber}</> : null}
        {amount ? <> — {amount}</> : null}
        {category ? <> · {category}</> : null}
      </>
    );
  }
  if (vendorLabel) {
    return (
      <>
        <button
          type="button"
          className="spectre-mc-vendor-link"
          data-testid="ap-title-vendor-button"
          onClick={(e) => { e.stopPropagation(); onVendorClick(); }}
          title="Open Create Vendor — this vendor is not yet on file"
        >
          {vendorLabel}
        </button>
        {invoiceNumber ? <> {invoiceNumber}</> : null}
        {amount ? <> — {amount}</> : null}
        {category ? <> · {category}</> : null}
      </>
    );
  }
  return (
    <>
      AP invoice
      {invoiceNumber ? <> {invoiceNumber}</> : null}
      {amount ? <> — {amount}</> : null}
      {category ? <> · {category}</> : null}
    </>
  );
}

// Sprint 3 · Checkpoint 15M money formatter for operational surfaces
// (Mission Control cards, AP screens, vendor timelines, transaction
// previews). Locale-aware currency symbol + optional trailing ISO
// code. Never used inside the monthly reporting package (which has
// its own bg-club-cream / bg-club-green palette + its own money
// helpers).
function formatOperationalMoney(rawAmount: string, currency: string, showCurrencyCode: boolean): string {
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return `${currency} ${rawAmount}`;
  // For CAD/USD/AUD/NZD — all use `$`. For EUR — €. For GBP — £.
  const localized = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).format(n);
  return showCurrencyCode ? `${localized} ${currency}` : localized;
}

/**
 * Source and relationship line. When the sender is a forwarding
 * employee, clearly label them — never let sender-as-vendor confusion
 * back in.
 */
function buildApSenderLine(ap: ApInvoiceCardIntelligence): string {
  const bits: string[] = [];
  if (ap.sender.relationship === "EMPLOYEE_FORWARD" && ap.sender.email) {
    bits.push(`Forwarded by ${ap.sender.email}`);
    if (ap.extractedVendor.name) bits.push(`PDF vendor: ${ap.extractedVendor.name}`);
  } else if (ap.sender.email) {
    bits.push(ap.sender.email);
  } else if (ap.sender.name) {
    bits.push(ap.sender.name);
  }
  if (ap.invoiceCadenceThisQuarter != null && ap.invoiceCadenceThisQuarter >= 1) {
    bits.push(cadenceLabel(ap.invoiceCadenceThisQuarter));
  }
  if (ap.paymentTerms) bits.push(ap.paymentTerms);
  return bits.join(" · ") || "Accounts payable · pending analysis";
}

function cadenceLabel(n: number): string {
  const ord = ordinal(n);
  return `${ord} invoice this quarter`;
}
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Sprint 3 · Checkpoint 15L — accounting-specific work summary
 * rendered as a React fragment so we can emphasise the Ace Foods
 * reference tokens the founder approved:
 *   • bold "Spectre" attribution at the start
 *   • emphasised gross amount as a chip / ref
 *   • emphasised GL account number+name as a chip / ref
 *   • emphasised PO reference where matched
 *   • emphasised PO variance where present
 *
 * Only mentions work Spectre actually completed. Never invents
 * cadence, never a generic "vendor reports invoice unpaid" line.
 * GST language appears ONLY when the GST rate was verified via the
 * extracted subtotal + tax arithmetic (see ap.gstVerification).
 */
function ApWorkSummary({ ap }: { ap: ApInvoiceCardIntelligence }) {
  const vendor = ap.vendorMatch.matchedName ?? ap.extractedVendor.name ?? "the vendor";
  // 16C — unified formatter.
  const grossToken = ap.gross.amount
    ? formatWorkIntakeAmount({ amount: ap.gross.amount, currency: ap.gross.currency })
    : null;
  const glToken = ap.category.glAccountNumber && ap.category.glAccountName
    ? `GL ${ap.category.glAccountNumber} ${ap.category.glAccountName}`
    : null;

  return (
    <>
      <span className="a" data-testid="ap-work-attribution"><strong>Spectre</strong></span>{" "}
      classified the attached PDF as an invoice and extracted the vendor as {vendor}.
      {ap.invoiceNumber ? <>{" "}Invoice #{ap.invoiceNumber}.</> : null}
      {ap.gstVerification === "VERIFIED" && ap.gstRatePercent != null
        ? <>{" "}Verified GST at {formatRate(ap.gstRatePercent)} %.</>
        : ap.gstVerification === "EXTRACTED_UNVERIFIED"
        ? <>{" "}Tax was extracted from the PDF but the rate could not be reconciled — reviewer must confirm.</>
        : ap.gstVerification === "NOT_PRESENT"
        ? <>{" "}No GST detected on the PDF.</>
        : null}
      {(() => {
        switch (ap.vendorMatch.state) {
          case "MATCHED":
            return <>{" "}Matched to Spectre vendor <strong>{ap.vendorMatch.matchedName}</strong>.</>;
          case "AMBIGUOUS":
            return <>{" "}Multiple Spectre vendor candidates matched — reviewer must select the correct one.</>;
          case "NOT_FOUND":
            return <>{" "}No matching vendor record exists.</>;
          case "INSUFFICIENT_SIGNAL":
            return <>{" "}Vendor match indeterminate — extracted signals were insufficient.</>;
        }
      })()}
      {/* Sprint 3 · 221178 follow-on (Correction D) — Multiple
           allocation branch. When the canonical allocation authority
           says the invoice splits across ≥2 accounts, the narrative
           must NOT claim the invoice posts wholly to one GL. Copy is
           deliberately compact. Unresolved allocations get a
           truthful "requires review" trailer. */}
      {ap.allocations && ap.allocations.entries.length >= 2 ? (() => {
        const n = ap.allocations.entries.length;
        const unresolvedCount = ap.allocations.entries.filter((e) => e.recommendedAccount == null).length;
        if (unresolvedCount > 0) {
          return (
            <>{" "}
              Prepared a proposed split entry across {n} accounting allocations with{" "}
              <strong data-testid="ap-work-unresolved-count">{unresolvedCount}</strong> requiring review.
            </>
          );
        }
        return (
          <>{" "}
            Prepared a proposed split entry across{" "}
            <strong data-testid="ap-work-allocation-count">{n}</strong> accounting allocations.
          </>
        );
      })() : grossToken && glToken ? (
        <>
          {" "}Prepared a proposed entry to post{" "}
          <span className="ref" data-testid="ap-work-gross-ref"><strong>{grossToken}</strong></span>{" "}
          to <span className="ref" data-testid="ap-work-gl-ref"><strong>{glToken}</strong></span>.
        </>
      ) : glToken ? (
        <>{" "}Draft GL: <span className="ref" data-testid="ap-work-gl-ref"><strong>{glToken}</strong></span>.</>
      ) : ap.category.label ? (
        <>{" "}Recommended category: <strong>{ap.category.label}</strong>.</>
      ) : null}
      {ap.purchaseOrder.poNumber ? (
        <>{" "}Matched to <span className="ref"><strong>PO #{ap.purchaseOrder.poNumber}</strong></span>.
          {ap.purchaseOrder.variance != null
            ? <> Variance from PO: <strong data-testid="ap-work-po-variance">{formatVariance(ap.purchaseOrder.variance, ap.gross.currency ?? "CAD")}</strong>.</>
            : null}
        </>
      ) : (
        <>{" "}No purchase order was identified.</>
      )}
      {ap.paymentTerms
        ? <>{" "}Payment terms: <strong>{ap.paymentTerms}</strong>.</>
        : null}
      {ap.unresolvedFindingCount > 0
        ? <>{" "}<strong>{ap.unresolvedFindingCount}</strong> finding{ap.unresolvedFindingCount === 1 ? "" : "s"} for review.</>
        : null}
    </>
  );
}

function formatRate(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function formatVariance(v: string, currency: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${currency} ${v}`;
  const sign = n === 0 ? "" : n > 0 ? "+" : "";
  return `${sign}${currency} ${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAmountReadout(amount: string | null, currency: string | null, _showCurrencyCode: boolean): string {
  // Sprint 3 · Checkpoint 16C (2026-08-04) — SINGLE unified Work
  // Intake amount formatter. Every amount cell / token / chip
  // routes through this helper to guarantee "$X,XXX.XX CAD"
  // format regardless of card variant / vendor state / workflow
  // state. The `_showCurrencyCode` parameter is retained for the
  // signature but ignored — the unified format always includes
  // both symbol and ISO code when available.
  return formatWorkIntakeAmount({ amount, currency });
}

function formatBareAmount(rawAmount: string): string {
  return formatWorkIntakeAmount({ amount: rawAmount, currency: null });
}

function formatDecimal(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- AP action row --------------------------------------------------------
// Primary action is the domain action for the current workflow state.
// Assignment + Defer + attachment aux link follow the Ace Foods layout.

function ApActionRow({
  ap,
  workIntakeItemId,
  onDefer,
  onPrimary,
  onOpenPdf,
}: {
  ap: ApInvoiceCardIntelligence;
  workIntakeItemId: string;
  onDefer: (e: React.MouseEvent) => void;
  onPrimary: () => void;
  onOpenPdf?: () => void;
}) {
  // 15P-5: label + icon derive from the SAME shared function the
  // card's onPrimary click handler consults — see EmailIntakeCard
  // §onPrimary. Guarantees the button and the modal never disagree.
  const primary = deriveApAction(ap);
  return (
    <>
      <button
        type="button"
        className="spectre-btn spectre-btn--primary spectre-btn--sm"
        data-testid="ap-action-primary"
        data-workflow-state={ap.workflowState}
        // Sprint 3 Checkpoint 15I-2 (2026-07-27) — the primary AP
        // action expands the card and switches directly to the
        // Invoice Review tab where the canonical domain workflow
        // controls live (matched to the founder's brief §3.7:
        // "It is acceptable for the collapsed primary button to
        // expand the card and activate the correct Invoice Review
        // subsection if the final accounting transaction requires
        // a deeper confirmation.").
        //
        // The Invoice Review tab is the same real UI already
        // exercised by Checkpoint 15H — Approve & post, Match
        // vendor, Request information all live there and remain
        // wired to their real server actions.
        onClick={(e) => { e.stopPropagation(); onPrimary(); }}
        aria-label={primary.label}
      >
        {/* Sprint 3 · Checkpoint 15M — inline white icon matching
            the Ace Foods reference. Icon is decorative (label
            carries the action name); rendered with aria-hidden. */}
        <PrimaryActionIcon kind={primary.icon} />
        {primary.label}
      </button>
      {/* Sprint 3 Checkpoint 15I-2 — Assign is a real capability
          on the founder-approved gold standard, but full delegation
          (user picker + tenant-scoped user list + audited ownership
          transition) is scoped to a follow-up ticket. Rather than
          ship a button that does nothing, the control is rendered
          visibly DISABLED with an accessible explanation. Truthful
          omission is better than a false control. */}
      <button
        type="button"
        className="spectre-btn spectre-btn--secondary spectre-btn--sm"
        data-testid="ap-action-assign"
        disabled
        aria-disabled="true"
        title="Assignment to another Spectre user lands in a follow-up ticket. This control is intentionally disabled — click Match vendor or Approve & post above to advance the item."
        onClick={(e) => e.stopPropagation()}
      >
        Assign
      </button>
      <button
        type="button"
        className="spectre-btn spectre-btn--tertiary spectre-btn--sm"
        data-testid="ap-action-defer"
        onClick={onDefer}
      >
        Defer 24 hr
      </button>
      <div className="grow" />
      {onOpenPdf ? (
        <button
          type="button"
          className="spectre-mc-aux-link"
          data-testid="ap-attachment-footer"
          onClick={(e) => { e.stopPropagation(); onOpenPdf(); }}
          title="Open the invoice PDF"
        >
          Invoice · PDF
        </button>
      ) : null}
    </>
  );
}

type PrimaryIconKind =
  | "check" | "vendor-plus" | "envelope" | "document-check" | "duplicate" | "coa"
  // Phase 3.1: "pending" for ANALYSIS_PENDING; "review" for UNSUPPORTED.
  | "pending" | "review";

// Sprint 3 · Checkpoint 15P-5 — `primaryActionForApWorkflow` is
// retired. The card now consumes `deriveApAction` (imported at the
// top of the file) so the button label AND the modal-open decision
// come from the same function. See src/lib/mission-control/ap-action.ts.

// Sprint 3 · Checkpoint 15M — the small white inline icon that sits
// at the start of every dark-green Work Intake primary action.
// Matches the icon family used by the Variant D reference: stroke
// 2.2, square line caps, currentColor. Sized to match the button
// text (14px). aria-hidden — the label carries the semantic action.
function PrimaryActionIcon({ kind }: { kind: PrimaryIconKind }) {
  const common = {
    className: "spectre-mc-action-icon",
    "aria-hidden": true,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "check":
      return <svg {...common}><path d="M5 12l5 5L20 7" /></svg>;
    case "vendor-plus":
      // Person + small plus — vendor create/onboard glyph.
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M3 20c0-3.5 3-6 6-6s6 2.5 6 6" />
          <path d="M18 6v6M15 9h6" />
        </svg>
      );
    case "envelope":
      return (
        <svg {...common}>
          <path d="M3 6h18v12H3z" />
          <path d="M3 6l9 7 9-7" />
        </svg>
      );
    case "document-check":
      return (
        <svg {...common}>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M9 14l2 2 4-4" />
        </svg>
      );
    case "duplicate":
      return (
        <svg {...common}>
          <path d="M9 4h9v13H9z" />
          <path d="M4 8h9v13H4z" />
        </svg>
      );
    case "coa":
      // Ledger — three horizontal rules inside a book/spine.
      return (
        <svg {...common}>
          <path d="M4 4h14v16H4z" />
          <path d="M8 4v16" />
          <path d="M11 9h5M11 12h5M11 15h5" />
        </svg>
      );
    case "pending":
      // Clock — analysis in progress.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "review":
      // Magnifier over a document — review the source.
      return (
        <svg {...common}>
          <path d="M4 4h11l4 4v12H4z" />
          <circle cx="11" cy="13" r="2.5" />
          <path d="M13 15l2 2" />
        </svg>
      );
  }
}
