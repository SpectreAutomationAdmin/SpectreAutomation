// EP-TRAIN-6D-4G (2026-11-04) — Shared database-URL redactor.
//
// Purpose
// -------
// Produce a human-readable fingerprint of a Postgres (or any
// URL-shaped) connection string that is safe to print in logs,
// audit trails, telemetry, acceptance documents and terminal
// output.
//
// Why it exists
// -------------
// An earlier scratchpad preflight script used a hand-rolled regex
// (`/\/([^?]+)(\?|$)/`) to "extract the database name" from a
// Postgres connection URL. Because `[^?]+` is greedy and the URL
// starts with `postgres://user:pass@host:port/db?params`, the
// capture group ran from the FIRST literal slash after the scheme
// all the way through the userinfo, host, port, and database name
// — printing the password into the terminal scrollback whenever
// the preflight ran.
//
// Rule
// ----
// Never parse connection strings with ad-hoc regex. Parse them
// with the WHATWG `URL` constructor, then render ONLY the
// unambiguously non-sensitive fields:
//
//   - protocol (e.g. "postgresql:")
//   - host     (hostname + port)
//   - pathname (database name)
//
// Everything else — username, password, query params, hash — is
// dropped. The query/hash are dropped because they can carry
// `password=…`, `sslpassword=…`, or `options=…` payloads that
// embed secrets even when the URL authority section looks clean.
//
// The result is a non-reversible fingerprint. It is NOT an
// alternative connection string; it is a label.
//
// Tests: `tests/security-db-url-redact.test.ts` uses ONLY
// synthetic credentials (`sekret-synthetic-*`) and asserts that
// no part of a synthetic secret can ever appear in the redacted
// output across the full input matrix.

const REDACTED = "<hidden>";

function safeHost(u: URL): string {
  // URL.host includes the port when present; URL.hostname does
  // not. We want host:port in the fingerprint so the operator can
  // tell pooled (-pooler) and direct endpoints apart.
  return u.host || "<unknown-host>";
}

function safePath(u: URL): string {
  // The pathname of a PG URL is "/<dbname>". Strip the leading
  // slash for readability. Multi-segment paths are kept verbatim
  // because they never carry a secret in a well-formed URL.
  const trimmed = (u.pathname || "").replace(/^\/+/, "");
  return trimmed || "<unknown-db>";
}

export interface DbUrlFingerprint {
  readonly protocol: string;
  readonly host: string;
  readonly database: string;
  /**
   * Compact single-line form:
   *   `postgresql://<user>:<hidden>@host:port/db?<params>`
   * Suitable for log lines and audit meta.
   */
  readonly compact: string;
}

/**
 * Parse a connection string and return a safe fingerprint.
 *
 * - On success: {protocol, host, database, compact}. No field
 *   contains the original password, username, query parameters,
 *   or fragment.
 * - On any parse failure (missing scheme, invalid URL, null,
 *   undefined, empty string, unexpected type): returns a
 *   constant `<invalid-url>` fingerprint. The function never
 *   throws. Callers that want to assert "URL must be valid"
 *   should check `fingerprint.compact !== "<invalid-url>"`.
 *
 * The function is pure and has no I/O.
 */
export function redactDbUrl(raw: unknown): DbUrlFingerprint {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      protocol: "<invalid-url>",
      host: "<invalid-url>",
      database: "<invalid-url>",
      compact: "<invalid-url>",
    };
  }
  try {
    const u = new URL(raw);
    const protocol = u.protocol || "<unknown-scheme>";
    const host = safeHost(u);
    const database = safePath(u);
    return {
      protocol,
      host,
      database,
      compact: `${protocol}//<user>:${REDACTED}@${host}/${database}?<params>`,
    };
  } catch {
    return {
      protocol: "<invalid-url>",
      host: "<invalid-url>",
      database: "<invalid-url>",
      compact: "<invalid-url>",
    };
  }
}

/**
 * Convenience helper: scan arbitrary text (e.g. an error message,
 * a stack trace, or a process-environment dump) and return the
 * text with every substring that looks like a `scheme://...@host`
 * authority section replaced by the redacted fingerprint of that
 * URL. Non-URL text is passed through unchanged.
 *
 * Intended for exception logging where an underlying library
 * (Prisma, pg) echoed the full URL into `err.message`.
 */
export function redactUrlsInText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  // Match `scheme://userinfo@host[:port][/path][?query][#frag]`.
  // We lean conservative: the scheme is 2+ alphanumeric chars, then
  // `://`, then a run of non-whitespace. We extract that run, pass
  // it through redactDbUrl, and substitute the compact form.
  return text.replace(/\b[a-z][a-z0-9+.\-]+:\/\/\S+/gi, (match) => {
    const fp = redactDbUrl(match);
    return fp.compact;
  });
}
