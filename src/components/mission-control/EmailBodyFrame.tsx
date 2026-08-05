"use client";

// Sprint 3 · Checkpoint 16H rejection #3 (2026-08-06) — sandboxed
// HTML-email renderer.
//
// Founder §4: HTML email must render inside an isolated content
// boundary so newsletter styles cannot affect Spectre and Spectre
// styles cannot destroy the email.
//
// Isolation model:
//   • <iframe sandbox="allow-same-origin"> — scripts, forms, top
//     navigation, popups, downloads all BLOCKED by default. Same-
//     origin access is granted so the parent can ResizeObserver
//     iframe.contentDocument.body to size the frame to its content.
//     Scripts remain blocked because `allow-scripts` is not granted.
//     (The `sanitizeEmailHtml` sanitiser already strips <script> +
//     event handlers server-side — the sandbox is defence-in-depth.)
//   • srcDoc renders a full HTML document (doctype + <head> + reset
//     CSS + body). The email content lives inside body. Because it
//     is a separate document, Spectre's global CSS cannot reach in
//     and the email's declared styles cannot leak out.
//   • A minimal in-frame reset (max-width:100%, word-wrap:break-word,
//     img{max-width:100%; height:auto;}) prevents 800px newsletter
//     tables from horizontally overflowing the card at narrow
//     viewports while still respecting the newsletter's own layout.
//
// Height auto-sizing: ResizeObserver on the inner body. Falls back
// to `contentDocument.body.scrollHeight` when ResizeObserver is
// unavailable. Capped at 4000px to guard against runaway content.

import { useEffect, useRef, useState, type ReactElement } from "react";

interface Props {
  /** Server-sanitised HTML from `sanitizeEmailHtml`. Must NEVER be
   *  raw user-supplied HTML. */
  html: string;
  /** Optional debug label surfaced via data-testid. */
  testId?: string;
}

const MAX_IFRAME_HEIGHT = 4000;
const MIN_IFRAME_HEIGHT = 60;

function buildSrcDoc(sanitizedBody: string): string {
  // A minimal reset that:
  //   - collapses default body margin so the newsletter starts at
  //     0,0 inside the frame
  //   - constrains image + table width to prevent horizontal overflow
  //     on narrow viewports without overriding declared layout
  //   - preserves the newsletter's own colour + typography choices
  //   - blocks link default focus rings that would look foreign
  //     against email content
  // NOTE: this <style> is INSIDE the iframe's document so it CANNOT
  //   leak into Spectre. The parent's CSS is likewise excluded.
  const reset = `
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      font-size: 14px; line-height: 1.5; color: #1a1a1a;
      word-wrap: break-word; overflow-wrap: break-word;
    }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    a { color: #1a4d7a; }
    /* Placeholder frame around neutralised images so a broken
       remote image renders as a subtle grey rectangle rather than
       a browser broken-image glyph. */
    img[src="about:blank"] {
      display: inline-block;
      background: #f0eee9;
      border: 1px dashed #cbc7bd;
      min-width: 12px; min-height: 12px;
    }
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${reset}</style></head><body>${sanitizedBody}</body></html>`;
}

export default function EmailBodyFrame({ html, testId }: Props): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(MIN_IFRAME_HEIGHT);
  const [failed, setFailed] = useState<boolean>(false);

  const srcDoc = buildSrcDoc(html);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    let rafHandle: number | null = null;

    const measure = () => {
      try {
        const doc = el.contentDocument;
        if (!doc || !doc.body) return;
        const scroll = doc.body.scrollHeight;
        const clamped = Math.min(Math.max(scroll + 2, MIN_IFRAME_HEIGHT), MAX_IFRAME_HEIGHT);
        setHeight(clamped);
      } catch {
        // Same-origin access blocked (sandboxed unique origin) — fall
        // back to a reasonable default. Never crash the Conversation
        // tab.
        setHeight(MIN_IFRAME_HEIGHT * 6);
        setFailed(true);
      }
    };

    const onLoad = () => {
      // Initial measurement after srcDoc renders.
      measure();
      try {
        const doc = el.contentDocument;
        if (!doc || !doc.body || typeof ResizeObserver === "undefined") return;
        observer = new ResizeObserver(() => {
          if (rafHandle != null) cancelAnimationFrame(rafHandle);
          rafHandle = requestAnimationFrame(measure);
        });
        observer.observe(doc.body);
      } catch {
        // Sandboxed unique origin — parent cannot ResizeObserver.
        // A fixed reasonable height ships without breaking the UI.
      }
    };

    el.addEventListener("load", onLoad);
    return () => {
      el.removeEventListener("load", onLoad);
      if (observer) observer.disconnect();
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      title="Email body"
      data-testid={testId ?? "inline-thread-body-frame"}
      data-render-failed={failed ? "true" : "false"}
      // Empty sandbox = every restriction applied.  We ONLY relax
      // `allow-same-origin` so the parent can size the frame to its
      // content.  Scripts / forms / top navigation / popups / modals
      // remain fully blocked.  Sanitiser already stripped scripts;
      // this is defence-in-depth.
      sandbox="allow-same-origin"
      // referrerpolicy=no-referrer belongs on a normal iframe but is
      // less meaningful for a srcDoc that has no outbound requests
      // beyond the (blocked) remote images.  Kept explicit for
      // future-proofing if remote images are ever proxied.
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{
        display: "block",
        width: "100%",
        height: `${height}px`,
        border: "0",
        background: "transparent",
      }}
    />
  );
}
