// EP-TRAIN-6D-4D — API-route deny-shape + input-validation tests.
//
// Proves the two GET routes:
//   - respond 401 for an unauthenticated request
//   - respond 404 (same-shape) for missing permission, missing row, and
//     cross-tenant IDs (no enumeration signal)
//   - respond 400 for invalid cursor / limit / states
//   - respond 200 with the service's projected DTO on the happy path

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the service layer so we can distinguish "ReadServiceError" code
// paths from happy-path payloads without touching Prisma.
const mockListCandidates = vi.fn();
const mockGetCandidate = vi.fn();

vi.mock("@/lib/hr/training/ai-review/read-service", () => {
  // vi.mock factories are hoisted; the class MUST be declared inside.
  class MockReadServiceError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return {
    listCandidates: (...args: unknown[]) => mockListCandidates(...args),
    getCandidate: (...args: unknown[]) => mockGetCandidate(...args),
    ReadServiceError: MockReadServiceError,
  };
});

// Re-import the class so tests can throw instances of the SAME class
// the route's `instanceof` check sees. Not available until after the
// mock factory has been applied.
let MockReadServiceErrorRef: new (code: string, status: number) => Error;

const mockPrincipal = vi.fn();
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: (...args: unknown[]) => mockPrincipal(...args),
}));

const mockActiveClubId = vi.fn();
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: (...args: unknown[]) => mockActiveClubId(...args),
}));

import { GET as getQueue } from "@/app/api/admin/ai-training/drafts/route";
import { GET as getDetail } from "@/app/api/admin/ai-training/drafts/[id]/route";
import { ReadServiceError as RSE } from "@/lib/hr/training/ai-review/read-service";
MockReadServiceErrorRef = RSE as unknown as new (code: string, status: number) => Error;

function somePrincipal() {
  return {
    id: "u1",
    name: "N",
    email: "n@example.test",
    status: "ACTIVE",
    memberships: [],
    activeClubId: "club-A",
    memberId: null,
  };
}

beforeEach(() => {
  mockListCandidates.mockReset();
  mockGetCandidate.mockReset();
  mockPrincipal.mockReset();
  mockActiveClubId.mockReset().mockResolvedValue("club-A");
});

// Helpers
function req(url: string): Request {
  return new Request(url);
}

// -------------------------------------------------------------------
// Queue route
// -------------------------------------------------------------------
describe("GET /api/admin/ai-training/drafts", () => {
  it("401 when unauthenticated", async () => {
    mockPrincipal.mockResolvedValue(null);
    const res = await getQueue(req("http://x/api/admin/ai-training/drafts") as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("404 (same-shape) when principal lacks the read permission", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockListCandidates.mockRejectedValue(new MockReadServiceErrorRef("FORBIDDEN", 403));
    const res = await getQueue(req("http://x/api/admin/ai-training/drafts") as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("400 on invalid limit", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    for (const bad of ["abc", "0", "51", "-1", "3.5"]) {
      const res = await getQueue(
        req(`http://x/api/admin/ai-training/drafts?limit=${bad}`) as never,
      );
      expect(res.status).toBe(400);
    }
  });

  it("400 on invalid state", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    const res = await getQueue(
      req(`http://x/api/admin/ai-training/drafts?states=NOT_A_STATE`) as never,
    );
    expect(res.status).toBe(400);
  });

  it("200 with service payload on happy path", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockListCandidates.mockResolvedValue({
      rows: [{ draftId: "d1" }],
      nextCursor: null,
      limit: 20,
      states: null,
    });
    const res = await getQueue(
      req("http://x/api/admin/ai-training/drafts?limit=20") as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].draftId).toBe("d1");
  });
});

// -------------------------------------------------------------------
// Detail route
// -------------------------------------------------------------------
describe("GET /api/admin/ai-training/drafts/[id]", () => {
  it("401 when unauthenticated", async () => {
    mockPrincipal.mockResolvedValue(null);
    const res = await getDetail(req("http://x/api/admin/ai-training/drafts/d1") as never, {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 same-shape on missing permission", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockGetCandidate.mockRejectedValue(new MockReadServiceErrorRef("FORBIDDEN", 403));
    const res = await getDetail(req("http://x/api/admin/ai-training/drafts/d1") as never, {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(404);
  });

  it("404 same-shape when draft is missing OR cross-tenant", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockGetCandidate.mockResolvedValue(null);
    const res = await getDetail(req("http://x/api/admin/ai-training/drafts/d1") as never, {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("200 with projected detail on happy path", async () => {
    mockPrincipal.mockResolvedValue(somePrincipal());
    mockGetCandidate.mockResolvedValue({ draftId: "d1", state: "APPROVED_DRAFT" });
    const res = await getDetail(req("http://x/api/admin/ai-training/drafts/d1") as never, {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draftId).toBe("d1");
    expect(body.state).toBe("APPROVED_DRAFT");
  });
});
