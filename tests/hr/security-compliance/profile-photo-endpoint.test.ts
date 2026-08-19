// HR-2B.2 final (2026-08-19) — Profile-photo streamer route boundary tests.
//
// Exercises GET /api/hr/employees/[id]/profile-photo directly with a
// mocked `getCurrentPrincipal`. The endpoint is a canonical read that
// streams the raw bytes of the currently-selected profile-photo
// EmployeeDocument, gated by:
//   • Admin principal (401 if unauthenticated).
//   • `hr:documents:read` at the employee's clubId (404-shape on cap
//     failure so a caller lacking the capability cannot enumerate
//     employee ids by response code).
//   • Document category MUST be `profile_photo` (defence-in-depth
//     against a compromised pointer write path — the streamer is
//     NOT allowed to serve any other document category, even if the
//     Employee.profilePhotoDocumentId column somehow lands pointed
//     at a resume / tax form / bank doc).
//   • Tenant discipline: employee + document + principal must all
//     share the same club.
//
// All admin RBAC roles carry `hr:documents:read`, so the primary
// capability-failure boundary check is CROSS-TENANT: a principal in
// a foreign club has full `hr:documents:read` in THEIR club but no
// grant against the target employee's club. The route must return
// 404 (not 403) in that case — see the neutral-404 comment in
// `src/app/api/hr/employees/[id]/profile-photo/route.ts`.

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
import { GET } from "@/app/api/hr/employees/[id]/profile-photo/route";

function makeRequest(id: string): NextRequest {
  // NextRequest wraps the standard Request; the GET handler ignores
  // the body — the id comes in via `params`.
  return new NextRequest(
    `http://test.local/api/hr/employees/${id}/profile-photo`,
    { method: "GET" },
  );
}

const PNG_MIME = "image/png";

/**
 * Deterministic 1-KB synthetic image payload. The upload path does
 * not decode the bytes — it just measures + hashes + persists them —
 * so a byte pattern here is enough to prove round-trip fidelity.
 */
function makePhotoBytes(seed: string, sizeBytes = 1024): Buffer {
  const seedBuf = Buffer.from(seed, "utf8");
  const out = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 1) {
    out[i] = seedBuf[i % seedBuf.length]!;
  }
  return out;
}

/**
 * Full profile-photo upload path (admin-side):
 *  1. Put the raw bytes into the memory storage adapter (the route
 *     reads them back verbatim from `storage.get({storageKey})`).
 *  2. Create the EmployeeDocument row via `uploadEmployeeDocument`
 *     so the row carries the correct clubId + employeeId + category.
 *  3. Point Employee.profilePhotoDocumentId at the new row via
 *     `setProfilePhoto`.
 */
async function seedProfilePhoto(
  principal: Awaited<ReturnType<typeof principalFor>>,
  employeeId: string,
  clubId: string,
  opts?: { mimeType?: string; sizeBytes?: number; seed?: string },
) {
  const mimeType = opts?.mimeType ?? PNG_MIME;
  const bytes = makePhotoBytes(opts?.seed ?? employeeId, opts?.sizeBytes ?? 1024);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `hr/employees/${employeeId}/profile_photo/${sha256}`;
  const storage = await resolveDocumentStorage({ clubId });
  await storage.put({ storageKey, body: bytes, mimeType });
  const doc = await uploadEmployeeDocument(principal!, employeeId, {
    category: "profile_photo",
    storageKey,
    contentSha256: sha256,
    sizeBytes: bytes.length,
    mimeType,
    displayName: "test-photo.png",
  });
  await setProfilePhoto(principal!, employeeId, doc.id);
  return { doc, bytes, sha256, storageKey };
}

describe("HR-2B.2 · GET /api/hr/employees/[id]/profile-photo", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    _resetMemoryDocumentStorage_TEST_ONLY();
    currentPrincipal = null;
  });

  // --- Happy path ---------------------------------------------------------
  it("streams the current profile-photo bytes with matching Content-Type and size", async () => {
    const fx = await makeAdminHrFixture("Photo-Happy");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    const { bytes } = await seedProfilePhoto(
      currentPrincipal,
      fx.employee.id,
      fx.club.id,
      { seed: "happy-path-seed" },
    );

    const res = await GET(makeRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(PNG_MIME);
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(bytes.length);
    // Byte-for-byte fidelity — proves the storage round-trip did not
    // silently transcode or truncate the payload.
    expect(buf.equals(bytes)).toBe(true);
  });

  // --- No photo pointer ---------------------------------------------------
  it("returns 404 when the employee has no profile-photo pointer", async () => {
    const fx = await makeAdminHrFixture("Photo-Empty");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // Sanity check — the fixture Employee starts with a null pointer.
    const before = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { profilePhotoDocumentId: true },
    });
    expect(before?.profilePhotoDocumentId).toBeNull();

    const res = await GET(makeRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(res.status).toBe(404);
  });

  // --- Defence-in-depth: mis-categorised document ------------------------
  it("refuses to serve a non-profile_photo document even when the pointer is set (defence-in-depth)", async () => {
    const fx = await makeAdminHrFixture("Photo-Category");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // Land a resume in storage + DB (real, canonical path).
    const bytes = makePhotoBytes("resume-seed", 512);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `hr/employees/${fx.employee.id}/resume/${sha256}`;
    const storage = await resolveDocumentStorage({ clubId: fx.club.id });
    await storage.put({ storageKey, body: bytes, mimeType: "application/pdf" });
    const resume = await uploadEmployeeDocument(currentPrincipal, fx.employee.id, {
      category: "resume",
      storageKey,
      contentSha256: sha256,
      sizeBytes: bytes.length,
      mimeType: "application/pdf",
      displayName: "resume.pdf",
    });

    // Direct-inject the resume id into `profilePhotoDocumentId` —
    // simulates a compromised or buggy write path that lands a
    // non-photo id on the photo pointer. The route MUST NOT serve
    // it back.
    await prisma.employee.update({
      where: { id: fx.employee.id },
      data: { profilePhotoDocumentId: resume.id },
    });

    const res = await GET(makeRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(res.status).toBe(404);
  });

  // --- 401 unauthenticated ------------------------------------------------
  it("returns 401 when no principal is present", async () => {
    const fx = await makeAdminHrFixture("Photo-Unauth");
    // Seed a real photo so the ONLY reason to 401 is the missing
    // principal (proves the auth gate runs before any DB read).
    const seedingPrincipal = fx.clubAdmin;
    seedingPrincipal.activeClubId = fx.club.id;
    currentPrincipal = seedingPrincipal;
    await seedProfilePhoto(seedingPrincipal, fx.employee.id, fx.club.id, {
      seed: "unauth-seed",
    });

    // Drop the principal AFTER seeding — mimics an anonymous caller.
    currentPrincipal = null;

    const res = await GET(makeRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(res.status).toBe(401);
  });

  // --- Cross-tenant boundary ---------------------------------------------
  it("returns 404 to a principal in a foreign club (cross-tenant enumeration guard)", async () => {
    const fx = await makeAdminHrFixture("Photo-CrossTenant");
    // Seed the photo as the LEGITIMATE admin.
    const localAdmin = fx.clubAdmin;
    localAdmin.activeClubId = fx.club.id;
    currentPrincipal = localAdmin;
    await seedProfilePhoto(localAdmin, fx.employee.id, fx.club.id, {
      seed: "cross-tenant-seed",
    });

    // Swap to the foreign-club admin — CLUB_ADMIN in `fx.foreignClub`
    // carries `hr:documents:read` AT THEIR OWN CLUB but not at
    // `fx.club.id`. The route must respond 404 (same shape as
    // "no such employee") so an attacker cannot enumerate ids.
    const foreignAdmin = fx.foreignClubAdmin;
    foreignAdmin.activeClubId = fx.foreignClub.id;
    currentPrincipal = foreignAdmin;

    const res = await GET(makeRequest(fx.employee.id), {
      params: { id: fx.employee.id },
    });
    expect(res.status).toBe(404);
  });

  // --- Unknown employee id ------------------------------------------------
  it("returns 404 for an unknown employee id (probe defence)", async () => {
    const fx = await makeAdminHrFixture("Photo-Unknown");
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    const res = await GET(makeRequest("clx-nonexistent-id"), {
      params: { id: "clx-nonexistent-id" },
    });
    expect(res.status).toBe(404);
  });
});
