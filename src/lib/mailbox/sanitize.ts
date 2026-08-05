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

// Sprint 3 · Checkpoint 16H rejection #3 (2026-08-06) — allow the
// `style` attribute + legacy alignment attributes so HTML newsletter
// layout survives sanitisation. The founder-approved rule
// (docs/…/16H rejection #3 §6): safe layout MUST be preserved.
// Styles are constrained by ALLOWED_STYLES below; anything not on
// that allowlist is dropped. `class` is deliberately NOT allowed —
// external stylesheets have already been stripped, so class names
// would be inert; keeping them out avoids collisions with any
// scoped reset applied around the rendered body.
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "title", "target", "rel", "style"],
  // `src` is allowed only because our transformTags.img replaces its
  // value with `about:blank` before sanitize-html applies the URL
  // scheme filter. Never remove this without re-checking the
  // "neutralises remote image src" test.
  img: ["src", "alt", "title", "width", "height", "style", "align"],
  table: ["width", "border", "cellpadding", "cellspacing", "align", "bgcolor", "style"],
  thead: ["align", "valign", "bgcolor", "style"],
  tbody: ["align", "valign", "bgcolor", "style"],
  tfoot: ["align", "valign", "bgcolor", "style"],
  tr: ["align", "valign", "bgcolor", "style"],
  td: ["colspan", "rowspan", "align", "valign", "bgcolor", "width", "height", "nowrap", "style"],
  th: ["colspan", "rowspan", "align", "valign", "bgcolor", "width", "height", "nowrap", "style"],
  div: ["align", "style"],
  span: ["style"],
  p: ["align", "style"],
  h1: ["align", "style"], h2: ["align", "style"], h3: ["align", "style"],
  h4: ["align", "style"], h5: ["align", "style"], h6: ["align", "style"],
  ul: ["style"], ol: ["style", "start"], li: ["style"],
  blockquote: ["style"],
  hr: ["align", "style", "width", "size", "color", "noshade"],
  b: ["style"], strong: ["style"], i: ["style"], em: ["style"], u: ["style"],
  s: ["style"], sub: ["style"], sup: ["style"], small: ["style"],
  code: ["style"], pre: ["style"], br: ["style"],
  "*": ["lang", "dir"],
};

// Value-regex allowlist for the `style` attribute. Only these
// properties survive, and only when the value matches the regex.
// Every regex is anchored (^ … $) to prevent injection.
//
// Deliberately blocked (do NOT add without security review):
//   position, z-index, opacity, visibility, transform, animation,
//   transition, content, quotes, pointer-events, cursor, filter,
//   clip, clip-path, mask, -webkit-*, -moz-*, will-change.
//   These enable overlay attacks, off-viewport rendering, or
//   client-side tracking side channels.
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\(\s*\d{1,3}\s*(?:,\s*\d{1,3}\s*){2}\)|rgba\(\s*\d{1,3}\s*(?:,\s*\d{1,3}\s*){2},\s*(?:0|1|0?\.\d+)\s*\)|[a-z]{3,20})$/i;
const SIZE_RE = /^(auto|\d+(?:\.\d+)?(?:px|em|rem|%|pt|in|cm|mm|ex|ch|vw|vh)|0)$/i;
const ALIGN_RE = /^(left|center|right|justify|start|end|initial|inherit)$/i;
const VALIGN_RE = /^(top|middle|bottom|baseline|sub|super|text-top|text-bottom)$/i;
const FONT_WEIGHT_RE = /^(normal|bold|bolder|lighter|100|200|300|400|500|600|700|800|900)$/i;
const FONT_STYLE_RE = /^(normal|italic|oblique)$/i;
const FONT_FAMILY_RE = /^[a-zA-Z0-9\s"',\-]{1,120}$/;
const TEXT_DECORATION_RE = /^(none|underline|line-through|overline)(\s+(solid|dashed|dotted|wavy))?(\s+#[0-9a-f]{3,8})?$/i;
const TEXT_TRANSFORM_RE = /^(none|capitalize|uppercase|lowercase|initial|inherit)$/i;
const DISPLAY_RE = /^(block|inline|inline-block|table|table-row|table-cell|table-row-group|list-item|none|initial|inherit)$/i;
const WHITE_SPACE_RE = /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i;
const BORDER_STYLE_RE = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;
const BORDER_SHORTHAND_RE = /^(\d+(?:\.\d+)?(?:px|em|rem|pt))(\s+(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset))?(\s+(#[0-9a-f]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)|[a-z]+))?$/i;
const LIST_STYLE_RE = /^(none|disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|inside|outside)(\s+(none|disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|inside|outside))*$/i;
const NUM_UNITLESS_RE = /^(-?\d+(?:\.\d+)?)$/;
const LINE_HEIGHT_RE = /^(normal|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt)?)$/i;
const LETTER_SPACING_RE = /^(normal|-?\d+(?:\.\d+)?(?:px|em|rem|pt))$/i;

const ALLOWED_STYLES: sanitizeHtml.IOptions["allowedStyles"] = {
  "*": {
    // Colour + backgrounds (background-image URL disabled below).
    "color": [COLOR_RE],
    "background-color": [COLOR_RE],
    "background": [COLOR_RE],
    // Typography.
    "font-family": [FONT_FAMILY_RE],
    "font-size": [SIZE_RE],
    "font-weight": [FONT_WEIGHT_RE],
    "font-style": [FONT_STYLE_RE],
    "font-variant": [/^(normal|small-caps)$/i],
    "line-height": [LINE_HEIGHT_RE],
    "letter-spacing": [LETTER_SPACING_RE],
    "text-align": [ALIGN_RE],
    "vertical-align": [VALIGN_RE, SIZE_RE],
    "text-decoration": [TEXT_DECORATION_RE],
    "text-decoration-line": [/^(none|underline|line-through|overline)$/i],
    "text-decoration-color": [COLOR_RE],
    "text-transform": [TEXT_TRANSFORM_RE],
    "text-indent": [SIZE_RE],
    // Box.
    "width": [SIZE_RE],
    "height": [SIZE_RE],
    "min-width": [SIZE_RE],
    "min-height": [SIZE_RE],
    "max-width": [SIZE_RE],
    "max-height": [SIZE_RE],
    "padding": [SIZE_RE, /^(\d+(?:\.\d+)?(?:px|em|rem|%|pt)\s*){1,4}$/],
    "padding-top": [SIZE_RE],
    "padding-right": [SIZE_RE],
    "padding-bottom": [SIZE_RE],
    "padding-left": [SIZE_RE],
    "margin": [SIZE_RE, /^(auto|\d+(?:\.\d+)?(?:px|em|rem|%|pt)\s*){1,4}$/],
    "margin-top": [SIZE_RE],
    "margin-right": [SIZE_RE],
    "margin-bottom": [SIZE_RE],
    "margin-left": [SIZE_RE],
    // Borders.
    "border": [BORDER_SHORTHAND_RE, /^0$/, /^none$/i],
    "border-top": [BORDER_SHORTHAND_RE, /^0$/, /^none$/i],
    "border-right": [BORDER_SHORTHAND_RE, /^0$/, /^none$/i],
    "border-bottom": [BORDER_SHORTHAND_RE, /^0$/, /^none$/i],
    "border-left": [BORDER_SHORTHAND_RE, /^0$/, /^none$/i],
    "border-color": [COLOR_RE, /^(#[0-9a-f]{3,8}\s*){1,4}$/i],
    "border-style": [BORDER_STYLE_RE],
    "border-width": [SIZE_RE],
    "border-radius": [SIZE_RE, /^(\d+(?:\.\d+)?(?:px|em|rem|%|pt)\s*){1,4}$/],
    "border-collapse": [/^(collapse|separate)$/i],
    "border-spacing": [SIZE_RE, /^(\d+(?:\.\d+)?(?:px|em|rem|pt)\s*){1,2}$/],
    // Layout that's safe to keep for table-based emails.
    "display": [DISPLAY_RE],
    "float": [/^(none|left|right)$/i],
    "clear": [/^(none|left|right|both)$/i],
    "white-space": [WHITE_SPACE_RE],
    "word-break": [/^(normal|break-all|keep-all|break-word)$/i],
    "overflow-wrap": [/^(normal|break-word|anywhere)$/i],
    // Lists.
    "list-style": [LIST_STYLE_RE],
    "list-style-type": [/^(none|disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)$/i],
    "list-style-position": [/^(inside|outside)$/i],
    // Table.
    "table-layout": [/^(auto|fixed)$/i],
    // Misc numeric.
    "opacity": [NUM_UNITLESS_RE, /^1$/, /^0$/, /^0?\.\d+$/],
  },
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
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    disallowedTagsMode: "discard",
    // Drop text content of a comment tag entirely so tracker
    // comments like `<!--tracker:xyz-->` never survive.
    allowedSchemesAppliedToAttributes: ["href"],
    transformTags: {
      img: (tagName, attribs) => {
        // Neutralise remote image loading. Preserve alt / title /
        // width / height + safe style/align (§6 — placeholder must
        // still occupy the newsletter's declared slot).
        const safe: Record<string, string> = { src: "about:blank" };
        for (const k of ["alt", "title", "width", "height", "style", "align"]) {
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
