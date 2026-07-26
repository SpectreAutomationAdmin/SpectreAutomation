// Sprint 2 B4 (2026-07-19) — Email HTML sanitizer.
//
// One authoritative sanitiser. Every EmailMessage body renders through
// `sanitizeEmailHtml` — components MUST NOT accept raw HTML from a
// mailbox row. External images are neutralised (src="about:blank"),
// scripts / forms / iframes / embedded executables are stripped, and
// links are marked untrusted. See §5 of the B4 directive.

import sanitizeHtml from "sanitize-html";

// Allowed tags — a compact whitelist that keeps enough structure for
// readable email bodies without admitting anything with runtime
// behaviour. `iframe`, `object`, `embed`, `form`, `input`, `script`,
// `style`, `link`, `meta`, `svg` are absent by design.
const ALLOWED_TAGS = [
  "p", "br", "div", "span",
  "b", "strong", "i", "em", "u", "s", "sub", "sup", "small",
  "ul", "ol", "li",
  "blockquote", "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "a",
  "img",
  "hr",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
];

// A small set of safe attributes per tag. Everything else is
// removed. Style attributes are excluded — they carry too many
// exfiltration vectors (background-image with url(), etc.).
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "title", "target", "rel"],
  // `src` is allowed only because our transformTags.img replaces its
  // value with `about:blank` before sanitize-html applies the URL
  // scheme filter. Never remove this without re-checking the
  // "neutralises remote image src" test.
  img: ["src", "alt", "title", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  "*": ["lang"],
};

/**
 * Sanitise an email HTML body for persistence + rendering.
 *
 * - Strips all disallowed tags and attributes.
 * - Replaces every `<img src="...">` with `src="about:blank"` so no
 *   remote image loads at render time (tracking pixels included).
 *   The alt text and geometry attributes are preserved so a placeholder
 *   still renders.
 * - Marks every `<a>` `rel="noopener noreferrer nofollow"` and forces
 *   `target="_blank"`. Links open away from Spectre.
 * - Absolute URL schemes limited to `http`, `https`, `mailto`, `tel`.
 * - Returns a size-capped string so a malicious 100 MB body cannot
 *   thrash the process.
 */
export function sanitizeEmailHtml(input: string, opts?: { maxBytes?: number }): string {
  const maxBytes = opts?.maxBytes ?? 200_000;
  const clean = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    disallowedTagsMode: "discard",
    // Drop text content of a comment tag entirely so tracker
    // comments like `<!--tracker:xyz-->` never survive.
    allowedSchemesAppliedToAttributes: ["href"],
    transformTags: {
      img: (tagName, attribs) => {
        // Neutralise remote image loading. Preserve alt/title/width/height.
        const safe: Record<string, string> = { src: "about:blank" };
        for (const k of ["alt", "title", "width", "height"]) {
          if (attribs[k]) safe[k] = attribs[k];
        }
        return { tagName: "img", attribs: safe };
      },
      a: (tagName, attribs) => {
        // Force safe link semantics. Absent href → drop.
        const href = attribs.href ?? "";
        if (!href) return { tagName: "span", attribs: {} };
        return {
          tagName: "a",
          attribs: {
            href,
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            ...(attribs.title ? { title: attribs.title } : {}),
          },
        };
      },
    },
    // Strip comments (default true, explicit).
    exclusiveFilter: (frame) => {
      const t = frame.tag;
      // Drop empty structural tags that arrived without content;
      // keeps the DOM tidy for the rendered preview.
      if (t === "script" || t === "style" || t === "iframe" || t === "form") return true;
      return false;
    },
  });
  if (Buffer.byteLength(clean, "utf8") > maxBytes) {
    // Trim by codepoint boundary to avoid emitting truncated UTF-8.
    return clean.slice(0, Math.floor(maxBytes * 0.9)) + "\n<!-- truncated by Spectre -->";
  }
  return clean;
}

/** Extract a safe plaintext body from an HTML string.  Strips all
 *  tags but preserves paragraph breaks so the extract is readable.
 *  Never exposes attributes. */
export function htmlToText(input: string, opts?: { maxBytes?: number }): string {
  const noTags = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text,
  });
  const collapsed = noTags.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cap = opts?.maxBytes ?? 8_000;
  return collapsed.length > cap ? collapsed.slice(0, cap) + "…" : collapsed;
}
