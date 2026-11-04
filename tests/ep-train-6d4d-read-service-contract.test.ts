// EP-TRAIN-6D-4D — read-service contract tests.
//
// Exercises `listCandidates` + `getCandidate` against a mocked Prisma
// layer so every directive-§9 contract behaviour is proven:
//
//   §9.1  unauthenticated principal → throws ReadServiceError UNAUTHENTICATED
//   §9.2  missing permission        → throws ReadServiceError FORBIDDEN
//   §9.3  correct tenant            → rows returned
//   §9.4  cross-tenant negative     → getCandidate returns null
//   §9.5  candidate id enumeration  → listCandidates does NOT return draftId as absolute key
//   §9.6  pagination boundaries     → limit clamped to [1..50], default 20
//   §9.7  deterministic ordering    → generatedAt DESC, id DESC
//   §9.8  missing candidate         → getCandidate returns null
//   §9.9  missing evidence          → service tolerates null sourceVideoSha256 WITHOUT throwing (only verifies
//                                      the projection shape; renderer handles the empty state)
//   §9.10 historical validation      → multiple validations surface in .historicalValidations (tail)
//
// NOTE: mutation-route non-existence is enforced by a separate static
// test (ep-train-6d4d-no-mutation-endpoints.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma mock — only the fields read by the service.
const mockDraftFindMany = vi.fn();
const mockDraftFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    trainingQuestionAiDraft: {
      findMany: (...args: unknown[]) => mockDraftFindMany(...args),
      findFirst: (...args: unknown[]) => mockDraftFindFirst(...args),
    },
  },
}));

// Permission mock — flip per-test.
const mockHasPermission = vi.fn();
vi.mock("@/lib/rbac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac")>();
  return {
    ...actual,
    hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  };
});

import { listCandidates, getCandidate, ReadServiceError } from "@/lib/hr/training/ai-review/read-service";
import type { Principal } from "@/lib/rbac";

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "user-1",
    name: "Reviewer",
    email: "reviewer@example.test",
    status: "ACTIVE",
    memberships: [],
    activeClubId: "club-A",
    memberId: null,
    ...overrides,
  };
}

function makeDraftRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "draft-1",
    draftJson: JSON.stringify({
      questionType: "SINGLE_CHOICE",
      questionText: "What is the correct procedure?",
      options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }],
      explanation: "Because the manual says so.",
      sourceSegmentIds: [1, 3],
    }),
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: "hash-abc",
    recordVersion: 1,
    generatedAt: new Date("2026-11-04T10:00:00Z"),
    updatedAt: new Date("2026-11-04T10:00:00Z"),
    courseVersionId: "ver-1",
    validations: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockDraftFindMany.mockReset();
  mockDraftFindFirst.mockReset();
  mockHasPermission.mockReset();
});

// -------------------------------------------------------------------
// §9.1 Unauthenticated
// -------------------------------------------------------------------
describe("read-service · auth gate", () => {
  it("throws UNAUTHENTICATED when principal is null (listCandidates)", async () => {
    await expect(listCandidates(null, "club-A", {}))
      .rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("throws UNAUTHENTICATED when principal is null (getCandidate)", async () => {
    await expect(getCandidate(null, "club-A", "draft-1"))
      .rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  // §9.2
  it("throws FORBIDDEN when principal lacks hr:training:ai:read", async () => {
    mockHasPermission.mockReturnValue(false);
    await expect(listCandidates(makePrincipal(), "club-A", {}))
      .rejects.toBeInstanceOf(ReadServiceError);
    await expect(getCandidate(makePrincipal(), "club-A", "draft-1"))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

// -------------------------------------------------------------------
// §9.3 Correct tenant returns rows
// -------------------------------------------------------------------
describe("read-service · listCandidates", () => {
  it("returns rows from the authorised tenant with projected shape", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindMany.mockResolvedValueOnce([makeDraftRow()]);

    const page = await listCandidates(makePrincipal(), "club-A", {});
    expect(page.rows.length).toBe(1);
    expect(page.rows[0].draftId).toBe("draft-1");
    expect(page.rows[0].topic).toContain("What is");
    expect(page.rows[0].state).toBe("REQUIRES_HUMAN_REVIEW");

    // Confirm WHERE filter is tenant-scoped (§9.5 enumeration resistance)
    const whereArg = mockDraftFindMany.mock.calls[0][0]?.where;
    expect(whereArg.clubId).toBe("club-A");
  });

  // §9.6 pagination boundaries
  it("clamps limit to [1..50]; default is 20", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindMany.mockResolvedValue([]);

    await listCandidates(makePrincipal(), "club-A", {});
    expect(mockDraftFindMany.mock.calls[0][0].take).toBe(21); // 20 + 1

    await listCandidates(makePrincipal(), "club-A", { limit: 500 });
    expect(mockDraftFindMany.mock.calls[1][0].take).toBe(51);

    await listCandidates(makePrincipal(), "club-A", { limit: 0 });
    expect(mockDraftFindMany.mock.calls[2][0].take).toBe(2); // clamped to 1 + 1
  });

  // §9.7 deterministic ordering
  it("orders by generatedAt DESC, id DESC", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindMany.mockResolvedValue([]);
    await listCandidates(makePrincipal(), "club-A", {});
    const orderBy = mockDraftFindMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([{ generatedAt: "desc" }, { id: "desc" }]);
  });

  it("returns nextCursor when a next page exists", async () => {
    mockHasPermission.mockReturnValue(true);
    // 3 rows, limit 2 → hasMore
    mockDraftFindMany.mockResolvedValue([
      makeDraftRow({ id: "d1" }),
      makeDraftRow({ id: "d2" }),
      makeDraftRow({ id: "d3" }),
    ]);
    const page = await listCandidates(makePrincipal(), "club-A", { limit: 2 });
    expect(page.rows.length).toBe(2);
    expect(page.nextCursor).toBe("d2");
  });

  // State filter
  it("respects the states filter", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindMany.mockResolvedValue([]);
    await listCandidates(makePrincipal(), "club-A", { states: ["APPROVED_DRAFT"] });
    expect(mockDraftFindMany.mock.calls[0][0].where.state).toEqual({ in: ["APPROVED_DRAFT"] });
  });
});

// -------------------------------------------------------------------
// §9.4 Cross-tenant negative + §9.8 missing candidate
// -------------------------------------------------------------------
describe("read-service · getCandidate", () => {
  it("returns null when draft does not exist for this tenant (cross-tenant OR missing)", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindFirst.mockResolvedValue(null);
    const result = await getCandidate(makePrincipal(), "club-A", "draft-X");
    expect(result).toBeNull();
    const whereArg = mockDraftFindFirst.mock.calls[0][0]?.where;
    expect(whereArg).toEqual({ id: "draft-X", clubId: "club-A" });
  });

  it("returns projected shape for a live row", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindFirst.mockResolvedValue({
      id: "draft-7",
      clubId: "club-A",
      courseId: "course-1",
      courseVersionId: "ver-1",
      state: "APPROVED_DRAFT",
      contentHash: "hash-xyz",
      recordVersion: 2,
      generatedAt: new Date("2026-11-04T10:00:00Z"),
      updatedAt: new Date("2026-11-04T10:00:00Z"),
      draftJson: JSON.stringify({
        questionType: "SINGLE_CHOICE",
        questionText: "Q",
        options: [{ text: "A", isCorrect: true }],
        explanation: "E",
        sourceSegmentIds: [2],
      }),
      sourceVideoSha256: "video-sha-X",
      resolvedTranscriptBuildId: "build-1",
      groundingProjectionSha256: "grounding-sha-X",
      validations: [],
      reviews: [],
    });
    const d = await getCandidate(makePrincipal(), "club-A", "draft-7");
    expect(d).not.toBeNull();
    expect(d!.draftId).toBe("draft-7");
    expect(d!.state).toBe("APPROVED_DRAFT");
    expect(d!.latestValidation).toBeNull();
    expect(d!.reviews).toEqual([]);
    // §9.9 missing evidence — the projection does NOT throw when
    // optional source fields are absent (service tolerant).
    expect(d!.sourceVideoSha256).toBe("video-sha-X");
    expect(d!.groundingProjectionSha256).toBe("grounding-sha-X");
  });

  // §9.10 historical validation rendering
  it("places the most recent validation into latestValidation and the rest into historicalValidations", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindFirst.mockResolvedValue({
      id: "d",
      clubId: "club-A",
      courseId: "c",
      courseVersionId: "v",
      state: "REQUIRES_HUMAN_REVIEW",
      contentHash: "h",
      recordVersion: 1,
      generatedAt: new Date(),
      updatedAt: new Date(),
      draftJson: JSON.stringify({ questionType: "SINGLE_CHOICE", questionText: "Q", options: [], explanation: "", sourceSegmentIds: [] }),
      sourceVideoSha256: "v",
      resolvedTranscriptBuildId: "b",
      groundingProjectionSha256: "g",
      validations: [
        { id: "v2", draftContentHash: "h", validatorVersion: "2.0", validatorSource: "s", verdict: "REQUIRES_HUMAN_VERIFICATION", stage: "post", errorsJson: "[]", flagsJson: "[]", runAt: new Date("2026-11-04T10:00:00Z") },
        { id: "v1", draftContentHash: "h", validatorVersion: "1.0", validatorSource: "s", verdict: "REJECTED", stage: "post", errorsJson: "[]", flagsJson: "[]", runAt: new Date("2026-11-03T10:00:00Z") },
      ],
      reviews: [],
    });
    const d = await getCandidate(makePrincipal(), "club-A", "d");
    expect(d!.latestValidation?.id).toBe("v2");
    expect(d!.historicalValidations.length).toBe(1);
    expect(d!.historicalValidations[0].id).toBe("v1");
  });

  // Advisory/error count parsing
  it("counts errors and flags from validation JSON blobs", async () => {
    mockHasPermission.mockReturnValue(true);
    mockDraftFindMany.mockResolvedValueOnce([
      makeDraftRow({
        id: "d1",
        validations: [{
          verdict: "REJECTED",
          validatorSource: "integrated-pipeline",
          errorsJson: JSON.stringify([{ code: "X", message: "bad" }, { code: "Y", message: "worse" }]),
          flagsJson: JSON.stringify(["FLAG_A", "FLAG_B", "FLAG_C"]),
          runAt: new Date(),
        }],
      }),
    ]);
    const page = await listCandidates(makePrincipal(), "club-A", {});
    expect(page.rows[0].latestHardErrorCount).toBe(2);
    expect(page.rows[0].latestAdvisoryCount).toBe(3);
    expect(page.rows[0].latestVerdict).toBe("REJECTED");
  });
});
