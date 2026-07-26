// Sprint 3 Checkpoint 15D (2026-07-24) — MIME allowlist + size caps
// + filename sanitisation for the ingested-document layer.
//
// Everything here is deterministic and executes BEFORE bytes are
// downloaded from Graph. The founder gate: an attachment is never
// trusted merely because Microsoft returned it — the sender's
// contentType claim gets cross-checked at store time against the
// downloaded bytes' signature.
//
// The MIME allowlist is deliberately narrow. Widening it requires
// an explicit checkpoint change and a re-review of the signature
// map + tests.

import { DocumentError } from "./types";

// Ingestion size caps. attachmentSizeCapBytes mirrors the mailbox
// sync cap in src/lib/mailbox/sync-scope.ts — one attachment never
// exceeds that ceiling.
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const DOCUMENT_MIN_BYTES = 8; // magic-number check needs at least a header

// The four supported classes. Every other class is refused with
// storageState = REFUSED_UNSAFE_TYPE and NO storage adapter is called.
export const SUPPORTED_MIME_ALLOWLIST = [
  "application/pdf",
  "image/tiff",
  "image/png",
  "image/jpeg",
] as const;

export type SupportedMime = (typeof SUPPORTED_MIME_ALLOWLIST)[number];

// Categorically banned senders' contentType strings. Executable + script
// + archive kinds are refused BEFORE the download. Kept explicit so a
// reviewer can see the boundary at a glance.
export const CATEGORICALLY_BANNED_MIMES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/octet-stream", // opaque; treat as banned until content-signature validation is added
  "application/x-sh",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-tar",
  "application/x-msi",
  "text/x-shellscript",
  "text/javascript",
  "application/javascript",
  "text/x-python",
  "text/x-perl",
]);

// Filename characters we categorically strip. Preserves letters, digits,
// spaces, dashes, underscores, periods, parentheses, plus signs. Anything
// else — including path separators, null bytes, control chars — is dropped.
const SAFE_FILENAME_CHAR = /[A-Za-z0-9 ._()+-]/;
const FILENAME_MAX_LENGTH = 220;

export function sanitiseFilename(raw: string): string {
  const cleaned = raw
    .split("")
    .map((c) => (SAFE_FILENAME_CHAR.test(c) ? c : "_"))
    .join("")
    .replace(/_+/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  const trimmed = cleaned.length > FILENAME_MAX_LENGTH
    ? cleaned.slice(0, FILENAME_MAX_LENGTH)
    : cleaned;
  return trimmed.length > 0 ? trimmed : "document";
}

export function isSupportedMime(mime: string | null | undefined): mime is SupportedMime {
  if (!mime) return false;
  return (SUPPORTED_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

export interface PreflightArgs {
  contentType: string | null | undefined;
  sizeBytes: number;
  filename: string;
  isInline: boolean;
}

export type PreflightVerdict =
  | { ok: true; mime: SupportedMime; sizeBytes: number; sanitisedFilename: string }
  | { ok: false; reason: "UNSAFE_MIME" | "OVERSIZED" | "TOO_SMALL"; message: string };

// Runs BEFORE any Graph byte download. If it returns { ok: false } the
// caller MUST refuse the attachment and record the refusal — no bytes
// come across the network.
export function preflightAttachment(args: PreflightArgs): PreflightVerdict {
  const mime = (args.contentType ?? "").toLowerCase();
  if (CATEGORICALLY_BANNED_MIMES.has(mime)) {
    return {
      ok: false,
      reason: "UNSAFE_MIME",
      message: `MIME type ${mime} is categorically banned from ingest.`,
    };
  }
  if (!isSupportedMime(mime)) {
    return {
      ok: false,
      reason: "UNSAFE_MIME",
      message: `MIME type ${mime || "(missing)"} is not on the ingest allowlist.`,
    };
  }
  if (args.sizeBytes > DOCUMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: "OVERSIZED",
      message: `Attachment size ${args.sizeBytes}B exceeds ${DOCUMENT_MAX_BYTES}B cap.`,
    };
  }
  if (args.sizeBytes < DOCUMENT_MIN_BYTES) {
    return {
      ok: false,
      reason: "TOO_SMALL",
      message: `Attachment size ${args.sizeBytes}B is below the minimum for signature validation.`,
    };
  }
  return {
    ok: true,
    mime,
    sizeBytes: args.sizeBytes,
    sanitisedFilename: sanitiseFilename(args.filename),
  };
}

// -----------------------------------------------------------------------------
// Content-signature validation — runs AFTER bytes are downloaded and BEFORE
// storage. Cross-checks the claimed MIME against the file's magic number so
// a malicious sender cannot ship an .exe declaring itself a PDF.
// -----------------------------------------------------------------------------

interface MagicNumberCheck {
  mime: SupportedMime;
  matches: (buf: Buffer) => boolean;
}

const MAGIC_NUMBERS: MagicNumberCheck[] = [
  {
    mime: "application/pdf",
    matches: (b) => b.length >= 5 && b.slice(0, 5).toString("ascii") === "%PDF-",
  },
  {
    mime: "image/tiff",
    matches: (b) =>
      b.length >= 4 &&
      // Little-endian: 49 49 2A 00; Big-endian: 4D 4D 00 2A
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)),
  },
  {
    mime: "image/png",
    matches: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    matches: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
];

export function assertContentMatchesMime(bytes: Buffer, claimedMime: SupportedMime): void {
  const check = MAGIC_NUMBERS.find((m) => m.mime === claimedMime);
  if (!check) {
    throw new DocumentError(
      "UNSAFE_MIME",
      `Unknown claimed MIME ${claimedMime} — signature map missing.`,
    );
  }
  if (!check.matches(bytes)) {
    throw new DocumentError(
      "CORRUPT_DOWNLOAD",
      `Downloaded bytes do not match the ${claimedMime} magic number — refusing to store.`,
    );
  }
}
