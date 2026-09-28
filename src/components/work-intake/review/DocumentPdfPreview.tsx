// WI-2B.2 (2026-09-27) — inline PDF preview for the Work Intake
// review page's Invoice Details card.
//
// Fetches PDF bytes from /api/documents/{ingestedDocumentId}/preview
// via an authenticated same-origin fetch, converts the response to
// a blob: URL, and renders it inside an <iframe>. This is REQUIRED
// because the global middleware sends `X-Frame-Options: DENY`
// (src/middleware.ts:138), which blocks direct
// `<iframe src="/api/documents/.../preview">` even for same-origin
// documents. The middleware CSP already permits blob: framing
// (`object-src 'self' blob:; frame-src 'self' blob:`) and the
// blob-fetch pattern is the same one used by
// mission-control/DocumentPreviewModal.tsx.
//
// Auth model: the `/api/documents/{id}/preview` endpoint enforces
// clubId + WorkIntakeItem evidence-link tenant scope inside
// loadReadable() (src/lib/documents/retrieve.ts:66). This component
// adds no extra privilege — a user who cannot read the document
// receives HTTP 401/403/404 from the server and sees the failure
// state below.

"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  ingestedDocumentId: string;
  filename: string;
}

export default function DocumentPdfPreview({ ingestedDocumentId, filename }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentBlobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/documents/${encodeURIComponent(ingestedDocumentId)}/preview`,
          {
            method: "GET",
            credentials: "same-origin",
            headers: { accept: "application/pdf,application/octet-stream" },
          },
        );
        if (cancelled) return;
        if (res.status === 401) { setError("Session expired."); return; }
        if (res.status === 403) { setError("You do not have access to this document."); return; }
        if (res.status === 404) { setError("Preview not available."); return; }
        if (!res.ok) { setError(`Preview server returned ${res.status}.`); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        currentBlobRef.current = url;
        setBlobUrl(url);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Preview request failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (currentBlobRef.current) {
        URL.revokeObjectURL(currentBlobRef.current);
        currentBlobRef.current = null;
      }
    };
  }, [ingestedDocumentId]);

  if (loading) {
    return (
      <div
        className="wi-review-doc"
        role="status"
        aria-live="polite"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 220, color: "var(--wi-ink-3)", fontSize: 11 }}
      >
        Loading {filename}…
      </div>
    );
  }
  if (error || !blobUrl) {
    return (
      <div
        className="wi-review-doc"
        role="alert"
        style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 220, color: "var(--wi-ink-3)", fontSize: 11, padding: 16, textAlign: "center" }}
      >
        <div style={{ marginBottom: 4, fontWeight: 500 }}>{filename}</div>
        <div>{error ?? "Preview unavailable."}</div>
      </div>
    );
  }
  return (
    <div
      className="wi-review-doc"
      style={{ padding: 0, overflow: "hidden" }}
      data-testid="wi-review-doc-pdf"
      data-document-id={ingestedDocumentId}
    >
      <iframe
        title={filename}
        src={blobUrl}
        // No sandbox: the server already sends
        // `Content-Security-Policy: default-src 'none'; sandbox;` on
        // the preview response, and a blob: iframe of a same-origin
        // fetch honours it. A duplicate sandbox="" here would remove
        // the PDF viewer's own scripting and break navigation
        // controls inside the built-in Chrome viewer.
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", minHeight: 220, border: "none", background: "#f5f0e4" }}
      />
    </div>
  );
}
