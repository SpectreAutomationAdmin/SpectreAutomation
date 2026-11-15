/**
 * EP-TRAIN-4Y-BF §1 — the upload entry point.
 *
 * Whether an upload is a test is decided by WHO is logged in, never by a
 * request header. These tests drive the real route handler against the
 * real (SQLite) database; only the session lookup, the byte storage and
 * the orchestrator hand-off are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import type { Principal } from "@/lib/rbac";

const session = vi.hoisted(() => ({ current: null as unknown }));
const stored = vi.hoisted(() => ({ upload: vi.fn() }));
const orchestrator = vi.hoisted(() => ({ advance: vi.fn() }));

vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => session.current,
}));
vi.mock("@/lib/hr/training/video", async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return { ...actual, uploadTrainingVideo: stored.upload };
});
vi.mock("@/lib/hr/training/preparation-orchestrator", () => ({ advancePreparation: orchestrator.advance }));

const MANAGED_ENV = ["TRAINING_MOCK_INFERENCE_ALLOWED", "TRAINING_TEST_PRINCIPAL_USER_IDS", "TRAINING_BILLABLE_INFERENCE"] as const;
const savedEnv: Record<string, string | undefined> = {};

interface World { clubId: string; manager: Principal; testPrincipal: Principal; reserved: Principal }

async function world(): Promise<World> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  const club = await prisma.club.create({
    data: { name: `BF Route ${stamp}`, slug: `bf-route-${stamp}`, region: "Test", salesTaxRegion: "GST", foundedYear: 2000 },
  });
  await makeUser({ email: `manager-${stamp}@t.local`, role: "CLUB_ADMIN", clubId: club.id });
  await makeUser({ email: `listed-${stamp}@t.local`, role: "CLUB_ADMIN", clubId: club.id });
  await makeUser({ email: `e2e-${stamp}@example.test`, role: "CLUB_ADMIN", clubId: club.id });
  return {
    clubId: club.id,
    manager: (await principalFor(`manager-${stamp}@t.local`)) as Principal,
    testPrincipal: (await principalFor(`listed-${stamp}@t.local`)) as Principal,
    reserved: (await principalFor(`e2e-${stamp}@example.test`)) as Principal,
  };
}

async function makeVersion(w: World, createdBy: Principal): Promise<string> {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000_000);
  const course = await prisma.trainingCourse.create({
    data: { clubId: w.clubId, code: `BFR-${stamp}`, title: "Course", category: "ORIENTATION", createdByUserId: createdBy.id },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: { courseId: course.id, version: 1, state: "DRAFT", title: "V1" },
  });
  return version.id;
}

async function post(versionId: string, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import("@/app/api/hr/training/versions/[id]/video/route");
  const form = new FormData();
  form.set("video", new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" }));
  const req = new NextRequest(`http://localhost/api/hr/training/versions/${versionId}/video`, {
    method: "POST",
    body: form,
    headers,
  });
  return POST(req, { params: { id: versionId } });
}

async function rows(versionId: string) {
  const all = await prisma.auditLog.findMany({
    where: { entityId: versionId, action: { in: ["hr.training.generation.authorize", "hr.training.test_isolation.mark"] } },
    orderBy: { createdAt: "asc" },
    select: { action: true, afterJson: true, userId: true },
  });
  return {
    markers: all.filter((r) => r.action === "hr.training.test_isolation.mark"),
    authorizations: all
      .filter((r) => r.action === "hr.training.generation.authorize")
      .map((r) => JSON.parse(r.afterJson ?? "{}") as { inferenceMode?: string; source?: string; mockFault?: string }),
  };
}

beforeEach(async () => {
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  await resetDb();
  await seedRbac();
  delete process.env.TRAINING_BILLABLE_INFERENCE;
  delete process.env.TRAINING_TEST_PRINCIPAL_USER_IDS;
  process.env.TRAINING_MOCK_INFERENCE_ALLOWED = "true";
  stored.upload.mockReset();
  stored.upload.mockImplementation(async () => ({ storageKey: "k", sizeBytes: 16, sha256: "ab".repeat(32) }));
  orchestrator.advance.mockReset();
  orchestrator.advance.mockImplementation(async () => ({ action: "TRANSCRIPTION_ENQUEUED", detail: "" }));
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("EP-TRAIN-4Y-BF §1 — upload route: a real manager", () => {
  it("a plain upload stays automatic: stored, authorized as a real course, preparation started", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    session.current = w.manager;
    const res = await post(versionId);
    expect(res.status).toBe(201);
    expect(stored.upload).toHaveBeenCalledTimes(1);
    expect(orchestrator.advance).toHaveBeenCalledWith({ clubId: w.clubId, courseVersionId: versionId, trigger: "UPLOAD" });
    const r = await rows(versionId);
    expect(r.markers).toEqual([]);
    expect(r.authorizations).toMatchObject([{ inferenceMode: "LIVE", source: "UPLOAD" }]);
  });

  it.each([
    ["the old mock marker", { "x-spectre-training-inference": "mock" }],
    ["a pacing control", { "x-spectre-training-mock-delay-ms": "3000" }],
    ["a fault control", { "x-spectre-training-mock-fault": "drop-first-checkpoint" }],
    ["a hold control", { "x-spectre-training-hold": "1" }],
  ])("test controls from a non-test account are refused and nothing is stored: %s", async (_label, headers) => {
    const w = await world();
    const versionId = await makeVersion(w, w.manager);
    session.current = w.manager;
    const res = await post(versionId, headers);
    expect(res.status).toBe(409);
    expect(stored.upload).not.toHaveBeenCalled();
    expect(orchestrator.advance).not.toHaveBeenCalled();
    const r = await rows(versionId);
    expect(r.markers).toEqual([]);
    expect(r.authorizations).toEqual([]);
  });

  it("cannot upload into a course that belongs to automated testing", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    session.current = w.manager;
    const res = await post(versionId);
    expect(res.status).toBe(409);
    expect(stored.upload).not.toHaveBeenCalled();
    expect((await rows(versionId)).authorizations).toEqual([]);
  });
});

describe("EP-TRAIN-4Y-BF §1 — upload route: a test principal", () => {
  it("NO test header at all → still simulated: durable marker first, then a MOCK authorization", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    session.current = w.testPrincipal;
    const res = await post(versionId);
    expect(res.status).toBe(201);
    const r = await rows(versionId);
    expect(r.markers.length).toBe(1);
    expect(r.markers[0].userId).toBe(w.testPrincipal.id);
    expect(r.authorizations).toMatchObject([{ inferenceMode: "MOCK", source: "UPLOAD" }]);
  });

  it("the marker is written BEFORE the bytes are stored (it survives a failed upload)", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    session.current = w.testPrincipal;
    let markersWhenStoring = -1;
    stored.upload.mockImplementationOnce(async () => {
      markersWhenStoring = (await rows(versionId)).markers.length;
      throw new Error("storage unavailable");
    });
    const res = await post(versionId);
    expect(res.status).toBe(500);
    expect(markersWhenStoring).toBe(1);
    const r = await rows(versionId);
    expect(r.markers.length).toBe(1);
    expect(r.authorizations).toEqual([]);
  });

  it("recognised by the reserved e-mail domain alone — no configured list needed", async () => {
    const w = await world();
    const versionId = await makeVersion(w, w.reserved);
    session.current = w.reserved;
    const res = await post(versionId);
    expect(res.status).toBe(201);
    const r = await rows(versionId);
    expect(r.markers.length).toBe(1);
    expect(r.authorizations).toMatchObject([{ inferenceMode: "MOCK" }]);
  });

  it("test controls are honoured and can only tune the simulation", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    session.current = w.testPrincipal;
    const res = await post(versionId, { "x-spectre-training-mock-fault": "formatting-defects", "x-spectre-training-inference": "live" });
    expect(res.status).toBe(201);
    expect((await rows(versionId)).authorizations).toMatchObject([{ inferenceMode: "MOCK", mockFault: "FORMATTING_DEFECTS" }]);
  });

  it("where simulated processing is not allowed, the upload is refused — it does not become a real one", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    delete process.env.TRAINING_MOCK_INFERENCE_ALLOWED;
    const versionId = await makeVersion(w, w.testPrincipal);
    session.current = w.testPrincipal;
    const res = await post(versionId);
    expect(res.status).toBe(409);
    expect(stored.upload).not.toHaveBeenCalled();
    const r = await rows(versionId);
    expect(r.markers).toEqual([]);
    expect(r.authorizations).toEqual([]);
  });

  it("cannot upload to a real manager's course, and leaves no marker on it", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.manager);
    session.current = w.testPrincipal;
    const res = await post(versionId);
    expect(res.status).toBe(409);
    expect(stored.upload).not.toHaveBeenCalled();
    const r = await rows(versionId);
    expect(r.markers).toEqual([]);
    expect(r.authorizations).toEqual([]);
    // The manager's own upload afterwards is a normal real upload.
    session.current = w.manager;
    expect((await post(versionId)).status).toBe(201);
    expect((await rows(versionId)).authorizations).toMatchObject([{ inferenceMode: "LIVE" }]);
  });

  it("the hold control stores the video and starts nothing", async () => {
    const w = await world();
    process.env.TRAINING_TEST_PRINCIPAL_USER_IDS = w.testPrincipal.id;
    const versionId = await makeVersion(w, w.testPrincipal);
    session.current = w.testPrincipal;
    const res = await post(versionId, { "x-spectre-training-hold": "1" });
    expect(res.status).toBe(201);
    expect(orchestrator.advance).not.toHaveBeenCalled();
    const r = await rows(versionId);
    expect(r.markers.length).toBe(1);
    expect(r.authorizations).toEqual([]);
  });
});

describe("EP-TRAIN-4Y-BF §1 — isolation status endpoint", () => {
  async function status(): Promise<Response> {
    const { GET } = await import("@/app/api/admin/training/test-isolation/route");
    return GET();
  }

  it("answers a test principal with the three switches", async () => {
    const w = await world();
    session.current = w.reserved;
    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      testPrincipal: true,
      recognisedBy: { configuredList: false, reservedEmailDomain: true },
      simulationAllowed: true,
      billableInference: "LOCKED",
    });
    process.env.TRAINING_BILLABLE_INFERENCE = "enabled";
    expect(((await (await status()).json()) as { billableInference: string }).billableInference).toBe("ENABLED");
  });

  it("is a plain 404 for anyone else, signed in or not", async () => {
    const w = await world();
    session.current = w.manager;
    expect((await status()).status).toBe(404);
    session.current = null;
    expect((await status()).status).toBe(404);
  });
});
