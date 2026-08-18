// HR-2B.3.1 (2026-08-18) §2 — Admin photo POST + DELETE boundary tests.
//
// Exercises POST /api/hr/employees/[id]/profile-photo and
// DELETE /api/hr/employees/[id]/profile-photo with a mocked
// `getCurrentPrincipal`. The route delegates to the canonical HR
// services (`uploadEmployeeDocument` + `setProfilePhoto`), so the
// same RBAC + audit + tenant discipline the employee-side upload
// path uses fires from the admin side too.
//
// Boundary coverage:
//   • CLUB_ADMIN can POST a fresh photo (pointer set, document row
//     created, storage round-trip verified).
//   • CLUB_ADMIN can POST a REPLACEMENT — pointer moves to the new
//     document id, previous document row is preserved (audit trail).
//   • AUDITOR_READ_ONLY (has hr:documents:read but NOT hr:employee:write)
//     is refused with a 404 (enumeration-guard shape).
//   • Cross-Club admin gets 404 (never 403 — same shape as unknown id).
//   • Non-image MIME rejected 422.
//   • Empty file rejected 422.
//   • Missing photo field rejected 422.
//   • DELETE clears the pointer; the EmployeeDocument row survives.
//   • The pointer set by the employee-onboarding upload flow is
//     read-back-visible via GET (confirms both write paths land on
//     the SAME canonical field).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { uploadEmployeeDocument } from "@/lib/hr/documents";
import { setProfilePhoto } from "@/lib/hr/employees";
import {
  resolveDocumentStorage,
  _resetMemoryDocumentStorage_TEST_ONLY,
} from "@/lib/documents/storage";
import { resetDb, seedRbac, principalFor } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

// ---------------------------------------------------------------------------
// Auth plumbing — stub principal BEFORE importing the route.
// ---------------------------------------------------------------------------
let currentPrincipal: Awaited<ReturnType<typeof principalFor>> | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentPrincipal,
}));

// eslint-disable-next-line import/first
import { GET, POST, DELETE } from "@/app/api/hr/employees/[id]/profile-photo/route";

const PNG_MIME = "image/png";

function makeGetRequest(id: string): NextRequest {
  return new NextRequest(
    `http://test.local/api/hr/employees/${id}/profile-photo`,
    { method: "GET" },
  );
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(
    `http://test.local/api/hr/employees/${id}/profile-photo`,
    { method: "DELETE" },
  );
}

/**
 * Build a NextRequest whose body is a real multipart/form-data with
 * a single `photo` field. Uses the WHATWG FormData → Request path
 * that Next.js's app-router File API expects.
 */
function makePostRequest(
  id: string,
  photo: { name: string; type: string; body: Buffer } | null,
): NextRequest {
  const fd = new FormData();
  if (photo) {
    // Buffer -> Uint8Array so the File constructor's BlobPart type
    // signature is satisfied (Buffer's ArrayBufferLike vs ArrayBuffer
    // widening trips TypeScript strict mode).
    const asU8 = new Uint8Array(photo.body);
    fd.set("photo", new File([asU8], photo.name, { type: photo.type }));
  }
  const req = new Request(
    `http://test.local/api/hr/employees/${id}/profile-photo`,
    { method: "POST", body: fd },
  );
  return new NextRequest(req);
}

function bytesFor(seed: string, size = 512): Buffer {
  const src = Buffer.from(seed, "utf8");
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = src[i % src.length]!;
  return out;
}

describe("HR-2B.3.1 §2 · POST + DELETE /api/hr/employees/[id]/profile-photo", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    _resetMemoryDocumentStorage_TEST_ONLY();
    currentPrincipal = null;
  });

  // ---------- Happy path — first upload ----------
  it("CLUB_ADMIN can POST a fresh photo; pointer set + document row created", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-Fresh");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    const bytes = bytesFor("post-fresh", 512);
    const res = await POST(
      makePostRequest(fx.employee.id, { name: "me.png", type: PNG_MIME, body: bytes }),
      { params: { id: fx.employee.id } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.documentId).toBe("string");
    expect(typeof body.uploadedAt).toBe("string");

    // Pointer updated.
    const employee = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { profilePhotoDocumentId: true },
    });
    expect(employee?.profilePhotoDocumentId).toBe(body.documentId);

    // Document row is canonical shape.
    const doc = await prisma.employeeDocument.findUnique({ where: { id: body.documentId } });
    expect(doc?.category).toBe("profile_photo");
    expect(doc?.sensitivity).toBe("STANDARD");
    expect(doc?.mimeType).toBe(PNG_MIME);
    expect(doc?.sizeBytes).toBe(bytes.length);
    // sha256 matches the actual bytes.
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    expect(doc?.contentSha256).toBe(expectedSha);

    // GET round-trips the bytes.
    const getRes = await GET(makeGetRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(getRes.status).toBe(200);
    const back = Buffer.from(await getRes.arrayBuffer());
    expect(back.equals(bytes)).toBe(true);
  });

  // ---------- Replacement ----------
  it("CLUB_ADMIN can POST a REPLACEMENT; pointer moves to new document; prior row preserved", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-Replace");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // First upload.
    const bytesA = bytesFor("post-replace-A", 512);
    const resA = await POST(
      makePostRequest(fx.employee.id, { name: "a.png", type: PNG_MIME, body: bytesA }),
      { params: { id: fx.employee.id } },
    );
    expect(resA.status).toBe(201);
    const bodyA = await resA.json();

    // Second upload.
    const bytesB = bytesFor("post-replace-B-different", 640);
    const resB = await POST(
      makePostRequest(fx.employee.id, { name: "b.png", type: PNG_MIME, body: bytesB }),
      { params: { id: fx.employee.id } },
    );
    expect(resB.status).toBe(201);
    const bodyB = await resB.json();
    expect(bodyB.documentId).not.toBe(bodyA.documentId);

    // Pointer now on the new one.
    const employee = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { profilePhotoDocumentId: true },
    });
    expect(employee?.profilePhotoDocumentId).toBe(bodyB.documentId);

    // Both document rows still exist — audit trail preserved.
    const docs = await prisma.employeeDocument.findMany({
      where: { employeeId: fx.employee.id, category: "profile_photo" },
      orderBy: { uploadedAt: "asc" },
    });
    expect(docs.length).toBe(2);
    expect(docs.map((d) => d.id).sort()).toEqual([bodyA.documentId, bodyB.documentId].sort());
  });

  // ---------- Unauthorized role ----------
  it("AUDITOR_READ_ONLY without hr:employee:write is refused (404 enumeration shape)", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-Auditor");
    currentPrincipal = fx.auditor;
    currentPrincipal.activeClubId = fx.club.id;

    const res = await POST(
      makePostRequest(fx.employee.id, {
        name: "au.png",
        type: PNG_MIME,
        body: bytesFor("auditor", 512),
      }),
      { params: { id: fx.employee.id } },
    );
    expect(res.status).toBe(404);
    // Confirms no document was created.
    const count = await prisma.employeeDocument.count({
      where: { employeeId: fx.employee.id },
    });
    expect(count).toBe(0);
  });

  // ---------- Cross-Club admin ----------
  it("cross-Club admin gets 404 (never 403) — no cross-tenant enumeration", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-CrossClub");
    // Admin from the foreign club — has CLUB_ADMIN grants at THEIR
    // club, no grant against fx.club.id.
    const foreignAdmin = fx.foreignClubAdmin;
    foreignAdmin.activeClubId = fx.foreignClub.id;
    currentPrincipal = foreignAdmin;

    const res = await POST(
      makePostRequest(fx.employee.id, {
        name: "x.png",
        type: PNG_MIME,
        body: bytesFor("cross", 512),
      }),
      { params: { id: fx.employee.id } },
    );
    expect(res.status).toBe(404);
    const count = await prisma.employeeDocument.count({
      where: { employeeId: fx.employee.id },
    });
    expect(count).toBe(0);
  });

  // ---------- Non-image MIME ----------
  it("rejects a non-image MIME (application/pdf) with 422", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-BadMime");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    const res = await POST(
      makePostRequest(fx.employee.id, {
        name: "resume.pdf",
        type: "application/pdf",
        body: bytesFor("pdf-bytes", 256),
      }),
      { params: { id: fx.employee.id } },
    );
    expect(res.status).toBe(422);
    const count = await prisma.employeeDocument.count({
      where: { employeeId: fx.employee.id },
    });
    expect(count).toBe(0);
  });

  // ---------- Empty file ----------
  it("rejects an empty file with 422", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-Empty");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    const res = await POST(
      makePostRequest(fx.employee.id, {
        name: "e.png",
        type: PNG_MIME,
        body: Buffer.alloc(0),
      }),
      { params: { id: fx.employee.id } },
    );
    expect(res.status).toBe(422);
  });

  // ---------- Missing field ----------
  it("rejects a POST with no photo field (422)", async () => {
    const fx = await makeAdminHrFixture("Photo-Post-Missing");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    const res = await POST(
      makePostRequest(fx.employee.id, null),
      { params: { id: fx.employee.id } },
    );
    expect(res.status).toBe(422);
  });

  // ---------- DELETE clears pointer; row preserved ----------
  it("DELETE clears Employee.profilePhotoDocumentId; document row remains", async () => {
    const fx = await makeAdminHrFixture("Photo-Delete");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // Seed a photo via POST.
    const bytes = bytesFor("to-delete", 256);
    const postRes = await POST(
      makePostRequest(fx.employee.id, { name: "z.png", type: PNG_MIME, body: bytes }),
      { params: { id: fx.employee.id } },
    );
    expect(postRes.status).toBe(201);
    const posted = await postRes.json();

    // DELETE the pointer.
    const delRes = await DELETE(makeDeleteRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(delRes.status).toBe(200);

    // Pointer nulled.
    const employee = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { profilePhotoDocumentId: true },
    });
    expect(employee?.profilePhotoDocumentId).toBeNull();

    // Document row survives.
    const doc = await prisma.employeeDocument.findUnique({
      where: { id: posted.documentId },
    });
    expect(doc).not.toBeNull();
    expect(doc?.category).toBe("profile_photo");
  });

  // ---------- Cross-write-path: the pointer set by employee-side upload is read back via GET ----------
  it("read-back via GET works whether the pointer was set by admin POST or the employee-onboarding uploadSelfPhoto path", async () => {
    const fx = await makeAdminHrFixture("Photo-CrossWritePath");
    // Seed via the CANONICAL SERVICE (mirroring the uploadSelfPhoto
    // path — same setProfilePhoto call).
    const bytes = bytesFor("employee-side", 512);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `hr/employees/${fx.employee.id}/profile_photo/${sha256}`;
    const storage = await resolveDocumentStorage({ clubId: fx.club.id });
    await storage.put({ storageKey, body: bytes, mimeType: PNG_MIME });
    const seedingPrincipal = fx.clubAdmin;
    seedingPrincipal.activeClubId = fx.club.id;
    const doc = await uploadEmployeeDocument(seedingPrincipal, fx.employee.id, {
      category: "profile_photo",
      storageKey,
      contentSha256: sha256,
      sizeBytes: bytes.length,
      mimeType: PNG_MIME,
      displayName: "employee-upload.png",
    });
    await setProfilePhoto(seedingPrincipal, fx.employee.id, doc.id);

    // Read back via GET, as an admin.
    currentPrincipal = seedingPrincipal;
    const res = await GET(makeGetRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(res.status).toBe(200);
    const back = Buffer.from(await res.arrayBuffer());
    expect(back.equals(bytes)).toBe(true);
  });
});
