// Sprint 3 Checkpoint 15D (2026-07-24) — Source-contract locks for
// the ingested-document layer. Reads the string contents of the
// checked-in files and asserts the invariants that make the layer
// safe: closed enums, immutability, tenant isolation, no-storage-key-
// leaks, categorically-banned MIMEs, etc.
//
// Any change to these behaviours is an intentional widening of the
// safety envelope and requires an explicit test update — that is the
// point of these locks.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = readFileSync(join(process.cwd(), "src/lib/documents/types.ts"), "utf8");
const SAFETY = readFileSync(join(process.cwd(), "src/lib/documents/safety.ts"), "utf8");
const CLASSIFY = readFileSync(join(process.cwd(), "src/lib/documents/classify.ts"), "utf8");
const INGEST = readFileSync(join(process.cwd(), "src/lib/documents/ingest.ts"), "utf8");
const RETRIEVE = readFileSync(join(process.cwd(), "src/lib/documents/retrieve.ts"), "utf8");
const STORAGE = readFileSync(join(process.cwd(), "src/lib/documents/storage.ts"), "utf8");
const HANDLERS = readFileSync(join(process.cwd(), "src/lib/queue/handlers.ts"), "utf8");
const MB_INGEST = readFileSync(join(process.cwd(), "src/lib/documents/mailbox-attachment-ingest.ts"), "utf8");
const META_ROUTE = readFileSync(join(process.cwd(), "src/app/api/documents/[id]/metadata/route.ts"), "utf8");
const PREVIEW_ROUTE = readFileSync(join(process.cwd(), "src/app/api/documents/[id]/preview/route.ts"), "utf8");
const DOWNLOAD_ROUTE = readFileSync(join(process.cwd(), "src/app/api/documents/[id]/download/route.ts"), "utf8");
const MC_DOCS_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/documents/route.ts"), "utf8");

describe("closed enumerations — types.ts", () => {
  it("SOURCE_KINDS is only EMAIL_ATTACHMENT for this checkpoint", () => {
    expect(TYPES).toMatch(/INGESTED_DOCUMENT_SOURCE_KINDS = \["EMAIL_ATTACHMENT"\]/);
  });
  it("CLASSIFICATIONS is a fixed closed set", () => {
    expect(TYPES).toMatch(/UNKNOWN[\s\S]*INVOICE[\s\S]*STATEMENT[\s\S]*CREDIT_NOTE[\s\S]*PURCHASE_ORDER[\s\S]*REMITTANCE[\s\S]*OTHER/);
  });
  it("STATUS values enumerate the four refusal reasons + STORED", () => {
    expect(TYPES).toMatch(/STORED/);
    expect(TYPES).toMatch(/REFUSED_UNSAFE_TYPE/);
    expect(TYPES).toMatch(/REFUSED_TOO_LARGE/);
    expect(TYPES).toMatch(/REFUSED_CORRUPT/);
    expect(TYPES).toMatch(/REFUSED_DUPLICATE_SUPERSEDED/);
  });
  it("EVIDENCE_TARGET_KINDS include WORK_INTAKE_ITEM (15D) and AP_INVOICE (15E)", () => {
    // Widening this list requires an explicit checkpoint change.
    expect(TYPES).toMatch(/INGESTED_DOCUMENT_EVIDENCE_TARGET_KINDS = \[[\s\S]*?"WORK_INTAKE_ITEM"[\s\S]*?"AP_INVOICE"[\s\S]*?\]/);
  });
  it("AUDIT actions include INGESTED and DUPLICATE_DETECTED", () => {
    expect(TYPES).toMatch(/INGESTED/);
    expect(TYPES).toMatch(/DUPLICATE_DETECTED/);
    expect(TYPES).toMatch(/RETRIEVED_METADATA/);
    expect(TYPES).toMatch(/RETRIEVED_PREVIEW/);
    expect(TYPES).toMatch(/RETRIEVED_DOWNLOAD/);
  });
});

describe("safety.ts — allowlist + banned + size cap", () => {
  it("allowlist is exactly PDF / TIFF / PNG / JPEG", () => {
    expect(SAFETY).toMatch(/"application\/pdf"/);
    expect(SAFETY).toMatch(/"image\/tiff"/);
    expect(SAFETY).toMatch(/"image\/png"/);
    expect(SAFETY).toMatch(/"image\/jpeg"/);
    // No .docx / .xlsx / .zip in the allowlist.
    expect(SAFETY).not.toMatch(/SUPPORTED_MIME_ALLOWLIST[\s\S]*application\/msword/);
  });
  it("categorically bans executables + archives + scripts", () => {
    expect(SAFETY).toMatch(/application\/x-msdownload/);
    expect(SAFETY).toMatch(/application\/zip/);
    expect(SAFETY).toMatch(/application\/x-sh/);
    expect(SAFETY).toMatch(/text\/javascript/);
  });
  it("byte cap is 25 MB (matches sync-scope)", () => {
    expect(SAFETY).toMatch(/DOCUMENT_MAX_BYTES = 25 \* 1024 \* 1024/);
  });
  it("sanitiseFilename regex does not permit path separators", () => {
    // Extract only the character class between the leading `[` and the
    // matching `]` so the surrounding `/` regex delimiters don't
    // false-positive against a slash check.
    const line = SAFETY.split("\n").find((l) => l.includes("SAFE_FILENAME_CHAR"));
    expect(line).toBeTruthy();
    const classMatch = line!.match(/\[([^\]]+)\]/);
    expect(classMatch).toBeTruthy();
    const charClass = classMatch![1];
    expect(charClass).not.toMatch(/[\\/]/);
  });
  it("assertContentMatchesMime cross-checks magic numbers before storage", () => {
    expect(SAFETY).toMatch(/assertContentMatchesMime/);
    expect(SAFETY).toMatch(/CORRUPT_DOWNLOAD/);
    expect(SAFETY).toMatch(/%PDF-/);
  });
});

describe("classify.ts — deterministic rules only", () => {
  it("has no LLM / OCR imports", () => {
    // Guard against runtime imports; the file may DESCRIBE the boundary
    // in comments ("No OCR. No LLM.") but must not IMPORT any such lib.
    const importLines = CLASSIFY.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/openai|anthropic|@aws-sdk\/client-textract|tesseract/i);
    }
  });
  it("exports a stable rules version", () => {
    expect(CLASSIFY).toMatch(/CLASSIFY_RULES_VERSION = 1/);
  });
  it("returns UNKNOWN with ruleKey unclassified when no rule matches", () => {
    expect(CLASSIFY).toMatch(/classification: "UNKNOWN"/);
    expect(CLASSIFY).toMatch(/ruleKey: "unclassified"/);
  });
});

describe("ingest.ts — pipeline invariants", () => {
  it("preflights BEFORE fetching bytes (refusal short-circuits)", () => {
    const preIdx = INGEST.indexOf("preflightAttachment(");
    const fetchIdx = INGEST.indexOf("bytes.fetchBytes(");
    expect(preIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(preIdx).toBeLessThan(fetchIdx);
  });
  it("checks signature after fetch and before storage put", () => {
    const sigIdx = INGEST.indexOf("assertContentMatchesMime(");
    const putIdx = INGEST.indexOf("storage.put(");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(putIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeLessThan(putIdx);
  });
  it("computes sha256 before dedup lookup", () => {
    const shaIdx = INGEST.indexOf("sha256Hex(");
    const dedupIdx = INGEST.indexOf("prisma.ingestedDocument.findUnique");
    expect(shaIdx).toBeLessThan(dedupIdx);
  });
  it("dedup path records DUPLICATE_DETECTED audit + can add evidence link", () => {
    expect(INGEST).toMatch(/action: "DUPLICATE_DETECTED"/);
    expect(INGEST).toMatch(/STORED_DUPLICATE_LINKED/);
  });
  it("stores new document then writes INGESTED audit + optional evidence link", () => {
    expect(INGEST).toMatch(/action: "INGESTED"/);
    expect(INGEST).toMatch(/linkEvidence\(/);
  });
  it("never calls storage.delete on the happy path", () => {
    // The delete method exists on the adapter for GDPR / retention wipes,
    // but the ingest pipeline itself must not invoke it. Guard against
    // an accidental introduction.
    expect(INGEST).not.toMatch(/storage\.delete\(/);
  });
  it("evidence link enforces per-club existence check on the target", () => {
    expect(INGEST).toMatch(/assertTargetExistsForClub/);
    expect(INGEST).toMatch(/TENANT_MISMATCH/);
  });
});

describe("retrieve.ts — auth + tenant + no-leak", () => {
  it("readable-through-linkage: doc must have an evidence link into the club", () => {
    expect(RETRIEVE).toMatch(/readable = true/);
    expect(RETRIEVE).toMatch(/NOT_FOUND/);
  });
  it("audit rows are written on every read path", () => {
    expect(RETRIEVE).toMatch(/RETRIEVED_METADATA/);
    expect(RETRIEVE).toMatch(/RETRIEVED_PREVIEW/);
    expect(RETRIEVE).toMatch(/RETRIEVED_DOWNLOAD/);
  });
  it("metadata payload never includes storage keys or bucket names", () => {
    // The toMetadata() helper is the ONLY constructor of DocumentMetadata.
    // Slice from its declaration up to the next top-level `export` /
    // `function` boundary so we don't pick up unrelated symbols.
    const start = RETRIEVE.indexOf("function toMetadata");
    expect(start).toBeGreaterThan(-1);
    const rest = RETRIEVE.slice(start);
    // First closing "^}" at column 0 after the function definition ends
    // the function body — index 0 is the "f" of "function".
    const endMatch = rest.match(/\n\}\n/);
    expect(endMatch).toBeTruthy();
    const helper = rest.slice(0, (endMatch?.index ?? rest.length) + 3);
    expect(helper).not.toMatch(/storageKey/);
    expect(helper).not.toMatch(/storageBucket/);
  });
});

describe("storage.ts — immutability + bucket boundary", () => {
  it("memory adapter refuses to overwrite an existing key", () => {
    expect(STORAGE).toMatch(/if \(MEMORY_MAP\.has\(key\)\)/);
    expect(STORAGE).toMatch(/Immutability contract/);
  });
  it("resolveDocumentStorage prefers R2 (mailboxAttachmentStorageAdapter) then falls back", () => {
    expect(STORAGE).toMatch(/mailboxAttachmentStorageAdapter/);
    expect(STORAGE).toMatch(/memoryDocumentStorageAdapter\("MEMORY"\)/);
  });
});

describe("queue handlers — MAILBOX_ATTACHMENT_FETCH is LIVE", () => {
  it("promotes attachment fetch to IMPLEMENTED", () => {
    expect(HANDLERS).toMatch(/MAILBOX_ATTACHMENT_FETCH: "IMPLEMENTED"/);
  });
  it("registers a real handler for it (no NOT_IMPLEMENTED throw)", () => {
    // Slice from the registerHandler call for MAILBOX_ATTACHMENT_FETCH
    // up to the next `registerHandler(` or `for (const kind of` boundary
    // — this isolates JUST our handler body.
    const marker = "registerHandler<";
    const startAll = HANDLERS.indexOf("MAILBOX_ATTACHMENT_FETCH\"");
    expect(startAll).toBeGreaterThan(-1);
    // Find the enclosing registerHandler call by walking back.
    const start = HANDLERS.lastIndexOf(marker, startAll);
    expect(start).toBeGreaterThan(-1);
    const after = HANDLERS.slice(start + 1);
    const nextBoundary = after.search(/\n(registerHandler<|for \(const kind of )/);
    const slice = HANDLERS.slice(start, start + 1 + (nextBoundary >= 0 ? nextBoundary : after.length));
    expect(slice).toMatch(/runMailboxAttachmentIngest/);
    expect(slice).not.toMatch(/NOT_IMPLEMENTED/);
  });
  it("wrapper delegates to shared ingest pipeline", () => {
    expect(MB_INGEST).toMatch(/ingestAttachment\(/);
    expect(MB_INGEST).toMatch(/sourceKind: "EMAIL_ATTACHMENT"/);
  });
  it("wrapper reflects the outcome on EmailAttachment.storageState", () => {
    expect(MB_INGEST).toMatch(/emailAttachment\.update/);
    expect(MB_INGEST).toMatch(/"STORED"/);
  });
});

describe("HTTP routes — 404-on-mismatch, never 403", () => {
  it("metadata route returns 404 on NOT_FOUND / TENANT_MISMATCH", () => {
    expect(META_ROUTE).toMatch(/status: 404/);
    expect(META_ROUTE).toMatch(/TENANT_MISMATCH/);
  });
  it("preview + download routes return 404 (never 403) on tenant mismatch", () => {
    expect(PREVIEW_ROUTE).toMatch(/status: 404/);
    expect(PREVIEW_ROUTE).not.toMatch(/status: 403/);
    expect(DOWNLOAD_ROUTE).toMatch(/status: 404/);
    expect(DOWNLOAD_ROUTE).not.toMatch(/status: 403/);
  });
  it("preview route sets Content-Disposition: inline + sandbox CSP", () => {
    expect(PREVIEW_ROUTE).toMatch(/Content-Disposition["'\s:]*[^\n]*inline/);
    expect(PREVIEW_ROUTE).toMatch(/sandbox/);
    expect(PREVIEW_ROUTE).toMatch(/X-Content-Type-Options["'\s:]*[^\n]*nosniff/);
  });
  it("download route sets Content-Disposition: attachment", () => {
    expect(DOWNLOAD_ROUTE).toMatch(/Content-Disposition["'\s:]*[^\n]*attachment/);
  });
});

describe("Mission Control documents route — read-only, storage-key-safe", () => {
  it("is GET-only (no POST/PATCH/DELETE)", () => {
    expect(MC_DOCS_ROUTE).toMatch(/export async function GET/);
    expect(MC_DOCS_ROUTE).not.toMatch(/export async function POST/);
    expect(MC_DOCS_ROUTE).not.toMatch(/export async function PATCH/);
    expect(MC_DOCS_ROUTE).not.toMatch(/export async function DELETE/);
  });
  it("guards intake-in-club before returning payload", () => {
    expect(MC_DOCS_ROUTE).toMatch(/intakeInClub/);
    expect(MC_DOCS_ROUTE).toMatch(/status: 404/);
  });
  it("returned entries never include storage keys or bucket names", () => {
    expect(MC_DOCS_ROUTE).not.toMatch(/storageKey/);
    expect(MC_DOCS_ROUTE).not.toMatch(/storageBucket/);
  });
});
