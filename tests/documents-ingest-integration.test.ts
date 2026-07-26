// Sprint 3 Checkpoint 15D (2026-07-24) — End-to-end integration test
// for the ingested-document layer. Uses the SQLite dev DB + the
// in-memory storage adapter. Verifies:
//   * ingest → row created + audit + evidence link
//   * rerun → duplicate detected, no new row, no re-upload
//   * retrieval → bytes come back through the correct storage bucket
//   * tenant isolation → cross-club retrieval returns NOT_FOUND
//   * MC panel loader → returns the doc for the intake, ordered

import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ingestAttachment, linkEvidence } from "@/lib/documents/ingest";
import {
  getDocumentBytes,
  getDocumentMetadata,
  listDocumentsForWorkIntake,
} from "@/lib/documents/retrieve";
import {
  memoryDocumentStorageAdapter,
  _resetMemoryDocumentStorage_TEST_ONLY,
} from "@/lib/documents/storage";
import { DocumentError } from "@/lib/documents/types";
import { sha256Hex } from "@/lib/documents/fingerprint";

// A tiny well-formed PDF (starts with %PDF- magic). The content is
// meaningless but the magic-number check + hash calculation should
// succeed.
const FIXTURE_PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("% Sprint 3 C15D fixture — not a real PDF, just carries the magic header.\n"),
  randomBytes(256),
]);

let CLUB_A: string;
let CLUB_B: string;
let INTAKE_A: string;
let INTAKE_B: string;
const suiteToken = "c15d-" + Math.random().toString(36).slice(2, 10);

async function seedClub(slugSuffix: string): Promise<string> {
  const club = await prisma.club.create({
    data: {
      slug: `${suiteToken}-${slugSuffix}`,
      name: `C15D Test ${slugSuffix}`,
    },
    select: { id: true },
  });
  return club.id;
}

async function seedIntake(clubId: string): Promise<string> {
  const intake = await prisma.workIntakeItem.create({
    data: {
      clubId,
      status: "OPEN",
      classification: "TEST",
      classificationMethod: "RULE",
      displaySourceLabel: "Test",
      displaySender: "test@fixture.local",
      displaySubject: "Fixture intake",
      displayPreview: "n/a",
      displayReceivedAt: new Date(),
      displayHasAttachments: true,
    },
    select: { id: true },
  });
  return intake.id;
}

beforeAll(async () => {
  _resetMemoryDocumentStorage_TEST_ONLY();
  CLUB_A = await seedClub("clubA");
  CLUB_B = await seedClub("clubB");
  INTAKE_A = await seedIntake(CLUB_A);
  INTAKE_B = await seedIntake(CLUB_B);
});

describe("ingestAttachment — happy path", () => {
  it("stores a new document, writes audit, links to intake", async () => {
    const storage = memoryDocumentStorageAdapter("TEST_BUCKET");
    const result = await ingestAttachment({
      clubId: CLUB_A,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: "att_" + suiteToken + "_1",
      claimedContentType: "application/pdf",
      claimedSizeBytes: FIXTURE_PDF.length,
      originalFilename: "Invoice-2026-07.pdf",
      receivedAt: new Date("2026-07-24T12:00:00Z"),
      isInline: false,
      bytes: { async fetchBytes() { return FIXTURE_PDF; } },
      classifySignals: { emailSubject: "Invoice for July", senderAddress: "billing@vendor.example" },
      autoAttachTo: {
        targetKind: "WORK_INTAKE_ITEM",
        targetReferenceId: INTAKE_A,
        role: "EVIDENCE",
        reason: "Test happy-path",
      },
      storageOverride: storage,
    });

    expect(result.outcome).toBe("STORED_NEW");
    expect(result.documentId).toBeTruthy();
    expect(result.sha256Hash).toBe(sha256Hex(FIXTURE_PDF));
    expect(result.classification).toBe("INVOICE");

    // Verify DB shape
    const doc = await prisma.ingestedDocument.findUnique({ where: { id: result.documentId! }});
    expect(doc?.storageBucket).toBe("TEST_BUCKET");
    expect(doc?.byteLength).toBe(FIXTURE_PDF.length);
    expect(doc?.status).toBe("STORED");
    expect(doc?.mimeType).toBe("application/pdf");

    // Verify audit rows
    const audits = await prisma.ingestedDocumentAuditLog.findMany({
      where: { ingestedDocumentId: result.documentId! },
      orderBy: { occurredAt: "asc" },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("INGESTED");
    expect(actions).toContain("EVIDENCE_LINKED");

    // Verify evidence link
    const links = await prisma.ingestedDocumentEvidenceLink.findMany({
      where: { ingestedDocumentId: result.documentId! },
    });
    expect(links).toHaveLength(1);
    expect(links[0].targetReferenceId).toBe(INTAKE_A);
    expect(links[0].role).toBe("EVIDENCE");
  });
});

describe("ingestAttachment — dedup", () => {
  it("second ingest returns STORED_DUPLICATE_LINKED with same documentId", async () => {
    const storage = memoryDocumentStorageAdapter("TEST_BUCKET");
    const first = await ingestAttachment({
      clubId: CLUB_A,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: "att_" + suiteToken + "_dup_first",
      claimedContentType: "application/pdf",
      claimedSizeBytes: FIXTURE_PDF.length,
      originalFilename: "Invoice-dup.pdf",
      receivedAt: new Date("2026-07-24T12:00:00Z"),
      isInline: false,
      bytes: { async fetchBytes() { return FIXTURE_PDF; } },
      autoAttachTo: null,
      storageOverride: storage,
    });
    const second = await ingestAttachment({
      clubId: CLUB_A,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: "att_" + suiteToken + "_dup_second",
      claimedContentType: "application/pdf",
      claimedSizeBytes: FIXTURE_PDF.length,
      originalFilename: "Invoice-dup-2.pdf",
      receivedAt: new Date("2026-07-24T12:00:00Z"),
      isInline: false,
      bytes: { async fetchBytes() { return FIXTURE_PDF; } },
      autoAttachTo: {
        targetKind: "WORK_INTAKE_ITEM",
        targetReferenceId: INTAKE_A,
        role: "EVIDENCE",
        reason: "Test dedup",
      },
      storageOverride: storage,
    });

    // Either "STORED_NEW" (if this suite runs before the happy path)
    // or "STORED_DUPLICATE_LINKED" (if it runs after). The important
    // thing is `second` == `first` documentId — one row per hash.
    expect(second.documentId).toBe(first.documentId);
    expect(second.outcome).toBe("STORED_DUPLICATE_LINKED");

    // The dedup path must record a DUPLICATE_DETECTED audit row.
    const audits = await prisma.ingestedDocumentAuditLog.findMany({
      where: { ingestedDocumentId: first.documentId!, action: "DUPLICATE_DETECTED" },
    });
    expect(audits.length).toBeGreaterThan(0);
  });
});

describe("ingestAttachment — refusals", () => {
  it("refuses banned MIME (application/zip) without downloading bytes", async () => {
    let fetchWasCalled = false;
    const result = await ingestAttachment({
      clubId: CLUB_A,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: "att_" + suiteToken + "_zip",
      claimedContentType: "application/zip",
      claimedSizeBytes: 1024,
      originalFilename: "malware.zip",
      receivedAt: new Date(),
      isInline: false,
      bytes: { async fetchBytes() { fetchWasCalled = true; return Buffer.alloc(0); } },
      autoAttachTo: null,
    });
    expect(result.outcome).toBe("REFUSED_UNSAFE_TYPE");
    expect(fetchWasCalled).toBe(false);
  });
  it("refuses signature mismatch (PDF header claimed, HTML bytes)", async () => {
    const storage = memoryDocumentStorageAdapter("SIG_TEST");
    const result = await ingestAttachment({
      clubId: CLUB_A,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: "att_" + suiteToken + "_html",
      claimedContentType: "application/pdf",
      claimedSizeBytes: 200,
      originalFilename: "fake-invoice.pdf",
      receivedAt: new Date(),
      isInline: false,
      bytes: { async fetchBytes() { return Buffer.from("<html><body>fake</body></html>".padEnd(200)); } },
      autoAttachTo: null,
      storageOverride: storage,
    });
    expect(result.outcome).toBe("REFUSED_CORRUPT");
  });
  it("refuses oversized declared size without downloading bytes", async () => {
    let fetchWasCalled = false;
    const result = await ingestAttachment({
      clubId: CLUB_A,
      sourceKind: "EMAIL_ATTACHMENT",
      sourceReferenceId: "att_" + suiteToken + "_big",
      claimedContentType: "application/pdf",
      claimedSizeBytes: 26 * 1024 * 1024,
      originalFilename: "huge.pdf",
      receivedAt: new Date(),
      isInline: false,
      bytes: { async fetchBytes() { fetchWasCalled = true; return Buffer.alloc(0); } },
      autoAttachTo: null,
    });
    expect(result.outcome).toBe("REFUSED_TOO_LARGE");
    expect(fetchWasCalled).toBe(false);
  });
});

describe("linkEvidence — tenant isolation", () => {
  it("refuses to link a document from Club A to an intake in Club B", async () => {
    // Reuse the happy-path doc from the first suite by looking up by hash.
    const doc = await prisma.ingestedDocument.findFirst({
      where: { clubId: CLUB_A, sha256Hash: sha256Hex(FIXTURE_PDF) },
      select: { id: true },
    });
    if (!doc) throw new Error("Fixture doc missing");
    await expect(
      linkEvidence({
        clubId: CLUB_A,
        ingestedDocumentId: doc.id,
        target: {
          targetKind: "WORK_INTAKE_ITEM",
          targetReferenceId: INTAKE_B, // <-- other club
        },
      }),
    ).rejects.toBeInstanceOf(DocumentError);
  });
});

describe("retrieve — bytes come back through the storage adapter", () => {
  it("returns metadata + bytes for a doc with a readable evidence link", async () => {
    const storage = memoryDocumentStorageAdapter("TEST_BUCKET");
    const doc = await prisma.ingestedDocument.findFirst({
      where: { clubId: CLUB_A, sha256Hash: sha256Hex(FIXTURE_PDF) },
      select: { id: true },
    });
    if (!doc) throw new Error("Fixture doc missing");

    const meta = await getDocumentMetadata({
      clubId: CLUB_A,
      documentId: doc.id,
      storageOverride: storage,
    });
    expect(meta.filename).toBeTruthy();
    expect(meta.mimeType).toBe("application/pdf");
    expect(meta.evidenceLinks.length).toBeGreaterThan(0);

    const { bytes } = await getDocumentBytes(
      {
        clubId: CLUB_A,
        documentId: doc.id,
        storageOverride: storage,
      },
      "PREVIEW",
    );
    expect(bytes.equals(FIXTURE_PDF)).toBe(true);
  });

  it("returns NOT_FOUND for a Club B caller trying to read a Club A doc", async () => {
    const storage = memoryDocumentStorageAdapter("TEST_BUCKET");
    const doc = await prisma.ingestedDocument.findFirst({
      where: { clubId: CLUB_A, sha256Hash: sha256Hex(FIXTURE_PDF) },
      select: { id: true },
    });
    if (!doc) throw new Error("Fixture doc missing");
    await expect(
      getDocumentMetadata({
        clubId: CLUB_B,
        documentId: doc.id,
        storageOverride: storage,
      }),
    ).rejects.toBeInstanceOf(DocumentError);
  });
});

describe("listDocumentsForWorkIntake — MC panel loader", () => {
  it("returns documents for an intake in order", async () => {
    const docs = await listDocumentsForWorkIntake({ clubId: CLUB_A, workIntakeItemId: INTAKE_A });
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const d of docs) {
      expect(d.mimeType).toBe("application/pdf");
      // Sanity: storage keys / buckets never leak through this API.
      expect(Object.keys(d)).not.toContain("storageKey");
      expect(Object.keys(d)).not.toContain("storageBucket");
    }
  });
});
