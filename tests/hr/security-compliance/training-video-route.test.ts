// HR-2C B3 §4, §19 (2026-08-20) — Employee-facing video route boundary.
//
// GET /api/hr/training/versions/[id]/video is the ONLY employee-facing
// binary surface introduced by B3. It must:
//   1. return the bytes ONLY to an employee-portal principal in the
//      same club whose applicable courses include this version, OR an
//      admin with hr:training:read;
//   2. return a same-shape 404 for every deny — no enumeration signal;
//   3. never leak the storageKey, r2 URL, or club id in headers.
//
// The upload path (POST) is already covered by admin-photo-write in
// spirit — the video route follows the same POST guard shape. This
// test focuses on the READ path because that is the surface employees
// hit and it accepts BOTH principal kinds.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";
import { createCourse, publishDraft, updateDraft } from "@/lib/hr/training/courses";
import { createQuestion } from "@/lib/hr/training/questions";
import { uploadTrainingVideo } from "@/lib/hr/training/video";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

// Auth doubles: swap in the principal-mock scaffolding used by
// admin-photo-write, but for BOTH auth surfaces the video route reads.
let currentAdminPrincipal: unknown = null;
let currentPortalPrincipal: EmployeePortalPrincipal | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentAdminPrincipal,
}));
vi.mock("@/lib/employee-portal-session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/employee-portal-session")>(
    "@/lib/employee-portal-session",
  );
  return {
    ...actual,
    getEmployeePortalPrincipal: async () => currentPortalPrincipal,
  };
});

// eslint-disable-next-line import/first
import { GET } from "@/app/api/hr/training/versions/[id]/video/route";

async function makeEmployee(clubId: string, opts?: {
  departmentId?: string | null;
  positionId?: string | null;
}) {
  const emp = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "T", lastName: "E",
      personalEmail: `t-${Date.now()}-${Math.floor(Math.random() * 9999)}@x.test`,
      departmentId: opts?.departmentId ?? null,
      positionId: opts?.positionId ?? null,
    },
  });
  const actor: EmployeePortalPrincipal = {
    employeeId: emp.id,
    clubId: emp.clubId,
    generation: 1,
    establishedAt: new Date().toISOString(),
  };
  return { emp, actor };
}

async function publishApplicableCourse(fx: AdminHrFixture): Promise<string> {
  const { courseId, versionId } = await createCourse(fx.clubAdmin, fx.club.id, {
    code: `VIDEO_${Math.floor(Math.random() * 90000 + 10000)}`,
    title: "Safety Basics",
    category: "Safety",
    description: null,
    version1Defaults: { required: true, appliesToAll: true },
  });
  void courseId;
  await updateDraft(fx.clubAdmin, versionId, { appliesToAll: true, requiresKnowledgeTest: true });
  await uploadTrainingVideo(fx.clubAdmin, versionId, {
    bytes: Buffer.from("fake-video-bytes"), mimeType: "video/mp4", durationSec: 30,
  });
  await createQuestion(fx.clubAdmin, versionId, {
    prompt: "Sample prompt for boundary tests?", options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: true }],
  });
  await publishDraft(fx.clubAdmin, versionId);
  return versionId;
}

function req(versionId: string): NextRequest {
  return new NextRequest(`http://test.local/api/hr/training/versions/${versionId}/video`);
}

describe("HR-2C B3 · GET /api/hr/training/versions/[id]/video — boundary", () => {
  let fx: AdminHrFixture;

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CB3Vid");
    currentAdminPrincipal = null;
    currentPortalPrincipal = null;
  });

  it("employee in same club with applicable course → 200 + video bytes", async () => {
    const versionId = await publishApplicableCourse(fx);
    const { actor } = await makeEmployee(fx.club.id);
    currentPortalPrincipal = actor;
    const res = await GET(req(versionId), { params: { id: versionId } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/video\/mp4/);
    // Never surfaces storage key, R2 URL, or club id in headers.
    for (const [k, v] of res.headers.entries()) {
      expect(v.toLowerCase()).not.toMatch(/storage.?key|r2\.|amazonaws|club/i);
      void k;
    }
  });

  it("employee in a different club → 404 same-shape (no enumeration)", async () => {
    const versionId = await publishApplicableCourse(fx);
    const { actor } = await makeEmployee(fx.foreignClub.id);
    currentPortalPrincipal = actor;
    const res = await GET(req(versionId), { params: { id: versionId } });
    expect(res.status).toBe(404);
  });

  it("employee whose applicability does not include the version → 404", async () => {
    // Publish a course targeting a specific department the employee doesn't belong to.
    const dept = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GROUNDS", name: "Grounds", sortOrder: 5 },
    });
    const { courseId, versionId } = await createCourse(fx.clubAdmin, fx.club.id, {
      code: `SCOPED_${Math.floor(Math.random() * 90000 + 10000)}`,
      title: "Grounds Only",
      category: "Safety",
      description: null,
      version1Defaults: { required: true, appliesToAll: false },
    });
    void courseId;
    await updateDraft(fx.clubAdmin, versionId, {
      appliesToAll: false,
      appliesToDeptIds: [dept.id],
      requiresKnowledgeTest: true,
    });
    await uploadTrainingVideo(fx.clubAdmin, versionId, {
      bytes: Buffer.from("fake"), mimeType: "video/mp4", durationSec: 30,
    });
    await createQuestion(fx.clubAdmin, versionId, {
      prompt: "Sample prompt for boundary tests?", options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: true }],
    });
    await publishDraft(fx.clubAdmin, versionId);

    const { actor } = await makeEmployee(fx.club.id); // no dept
    currentPortalPrincipal = actor;
    const res = await GET(req(versionId), { params: { id: versionId } });
    expect(res.status).toBe(404);
  });

  it("no principal at all → 404", async () => {
    const versionId = await publishApplicableCourse(fx);
    const res = await GET(req(versionId), { params: { id: versionId } });
    expect(res.status).toBe(404);
  });

  it("unknown version id → 404", async () => {
    const { actor } = await makeEmployee(fx.club.id);
    currentPortalPrincipal = actor;
    const res = await GET(req("nonexistent-id-abc123"), { params: { id: "nonexistent-id-abc123" } });
    expect(res.status).toBe(404);
  });

  it("admin with hr:training:read in same club → 200", async () => {
    const versionId = await publishApplicableCourse(fx);
    currentAdminPrincipal = fx.clubAdmin;
    const res = await GET(req(versionId), { params: { id: versionId } });
    expect(res.status).toBe(200);
  });

  it("admin in foreign club → 404 (never 403 — same shape as unknown id)", async () => {
    const versionId = await publishApplicableCourse(fx);
    currentAdminPrincipal = fx.foreignClubAdmin;
    const res = await GET(req(versionId), { params: { id: versionId } });
    expect(res.status).toBe(404);
  });
});
