// Sprint 2 B4 (2026-07-19) — Centralized initial-sync scope.
//
// Per §2 of the B4 directive: "The synchronization scope must be
// centralized and configurable. Do not scatter 14 days, 500, or
// Inbox folder identifiers across handlers." Every mailbox handler
// reads from this file.

export const SYNC_SCOPE = {
  /** Graph folder well-known name — only the Inbox is read in B4. */
  folder: "inbox",
  /** Lookback window: only messages received within this many days
   *  are ingested during initial sync. */
  lookbackDays: 14,
  /** Hard cap on messages fetched in a single initial-sync run. */
  messageCap: 500,
  /** Page size for Graph list requests. */
  pageSize: 50,
  /** Maximum body size (bytes) we will sanitise + persist. Larger
   *  bodies are truncated to preview + text-extract only. */
  maxBodyBytes: 200_000,
  /** Preview truncation cap for the display column. */
  previewCap: 240,
  /** Attachment metadata is fetched during initial sync; bytes are
   *  NOT retrieved in B4. Attachments over this size are marked
   *  REFUSED_TOO_LARGE and their bytes will not be retrievable
   *  even after B4 lazy-fetch ships in a later phase. */
  attachmentSizeCapBytes: 25 * 1024 * 1024, // 25 MB
} as const;

/** Human-readable disclosure for the Connected Accounts UI. */
export const SYNC_SCOPE_DISCLOSURE = {
  primaryLine: "Only your Inbox is read. Sent Items, Deleted Items, Junk, and Archive are ignored.",
  detailBullets: [
    `Up to ${SYNC_SCOPE.messageCap} recent messages, from the last ${SYNC_SCOPE.lookbackDays} days.`,
    "Attachment names and metadata only. Attachment bytes are not downloaded during this phase.",
    "Nothing in your mailbox is modified: no sends, no reads-marked, no moves, no deletes.",
  ],
} as const;
