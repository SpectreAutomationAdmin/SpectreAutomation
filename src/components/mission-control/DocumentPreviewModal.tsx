"use client";
// Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
// PDF preview modal.
//
// Chrome blocks the raw `<iframe src="/api/documents/[id]/preview">`
// because the app's global middleware sets `X-Frame-Options: DENY`
// AND `object-src 'none'` in the Content-Security-Policy. That fires
// even for same-origin iframes.
//
// Fix: authenticated fetch → Blob → object URL. blob: URLs are not
// subject to X-Frame-Options (they synthesize a local document, no
// response headers). The iframe then renders inside a modal that:
//   * traps focus while open
//   * closes on Escape
//   * restores focus to the opener on close
//   * exposes a Download action as a fallback
//   * never leaks storage keys, bucket, or Graph IDs

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  documentId: string;
  filename: string;
  open: boolean;
  onClose: () => void;
  // Rendered in the modal header — never mutates.
  contextLabel?: string;
}

export default function DocumentPreviewModal({ documentId, filename, open, onClose, contextLabel }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<null | { code: string; message: string }>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActive = useRef<HTMLElement | null>(null);

  // Load PDF via authenticated fetch → blob URL.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let currentBlobUrl: string | null = null;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/preview`, {
          method: "GET",
          credentials: "same-origin",
          headers: { "accept": "application/pdf,application/octet-stream,image/*" },
        });
        if (cancelled) return;
        if (res.status === 401) { setError({ code: "unauth", message: "Session expired." }); return; }
        if (res.status === 404) { setError({ code: "not_found", message: "Preview not available for this document." }); return; }
        if (!res.ok) { setError({ code: "http_" + res.status, message: `Preview server returned ${res.status}.` }); return; }
        const blob = await res.blob();
        currentBlobUrl = URL.createObjectURL(blob);
        setBlobUrl(currentBlobUrl);
      } catch (e) {
        if (!cancelled) setError({ code: "network", message: (e instanceof Error ? e.message : "Preview request failed.") });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    };
  }, [open, documentId]);

  // Focus trap + Escape close + focus restore.
  useEffect(() => {
    if (!open) return;
    previousActive.current = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex='-1'])",
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previousActive.current?.focus?.();
    };
  }, [open, onClose]);

  // Clear blob URL when closing.
  useEffect(() => {
    if (open) return;
    setBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setError(null);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="spectre-doc-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spectre-doc-preview-title"
      data-testid="doc-preview-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="spectre-doc-preview-dialog"
        tabIndex={-1}
      >
        <header className="spectre-doc-preview-head">
          <div className="spectre-doc-preview-titles">
            <h2 id="spectre-doc-preview-title">{filename}</h2>
            {contextLabel ? <p className="spectre-doc-preview-context">{contextLabel}</p> : null}
          </div>
          <div className="spectre-doc-preview-actions">
            <a
              href={`/api/documents/${encodeURIComponent(documentId)}/download`}
              className="spectre-btn spectre-btn--sm spectre-btn--secondary"
              download={filename}
              data-testid="doc-preview-download"
            >
              Download
            </a>
            <button
              type="button"
              className="spectre-btn spectre-btn--sm spectre-btn--ghost"
              onClick={onClose}
              data-testid="doc-preview-close"
              aria-label="Close preview"
            >
              Close
            </button>
          </div>
        </header>
        <div className="spectre-doc-preview-body">
          {loading ? (
            <div className="spectre-mc-inline-status" role="status">Loading preview…</div>
          ) : error ? (
            <div className="spectre-mc-inline-status spectre-mc-inline-status--error" role="alert">
              {error.code === "unauth" ? "Session expired — please sign in again."
                : error.code === "not_found" ? "This document is no longer available."
                : `Preview could not be loaded (${error.code}). Use Download to open the file locally.`}
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              title={`Preview: ${filename}`}
              data-testid="doc-preview-iframe"
              style={{ width: "100%", height: "100%", border: "0" }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
