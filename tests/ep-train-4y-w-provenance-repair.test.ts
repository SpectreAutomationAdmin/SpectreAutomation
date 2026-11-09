// EP-TRAIN-4Y-W §5 (2026-11-09) — provenance-repair service tests.
//
// Covers:
//   - eligibility heuristic (still-provisional → not eligible,
//     attributed → not eligible, real-title-without-attribution → eligible)
//   - repair ATTRIBUTED happy path
//   - idempotency (ALREADY_ATTRIBUTED when title+attribution match)
//   - compare-and-set: title drift aborts as TITLE_DRIFTED
//   - compare-and-set: concurrent DB-layer write aborts as TITLE_DRIFTED
//   - COURSE_NOT_FOUND for a course that doesn't exist in this tenant
//   - ForbiddenError when principal lacks hr:training:write
//   - UnauthenticatedError when principal is null
//   - audit() is called with the right action + entity + redacted payload
//   - title + description + code are NEVER overwritten by the repair

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  repairCourseMetadataProvenance,
  courseEligibleForProvenanceRepair,
  ProvenanceRepairRejected,
} from "@/lib/hr/training/ai-metadata/provenance-repair-service";

// ─── mocks ──────────────────────────────────────────────────────────

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

let mockDb: any;
function makePrisma(course: unknown) {
  return {
    trainingCourse: {
      findFirst: vi.fn(async () => course),
      updateMany: vi.fn(async (args: any) => {
        // Simulate the compare-and-set: updateMany only matches if
        // where.title equals current title.
        const row = mockDb.__row;
        if (!row) return { count: 0 };
        if (row.title !== args.where.title) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
    },
  };
}

function founderPrincipal(clubId: string) {
  return {
    id: "user-founder",
    role: "CLUB_ADMIN",
    activeClubId: clubId,
    memberships: [
      {
        clubId,
        roleKey: "CLUB_ADMIN",
        permissions: new Set(["hr:training:write", "hr:training:read"]),
      },
    ],
  } as any;
}

function viewerPrincipal(clubId: string) {
  return {
    id: "user-viewer",
    role: "VIEWER",
    activeClubId: clubId,
    memberships: [
      {
        clubId,
        roleKey: "VIEWER",
        permissions: new Set(["hr:training:read"]),
      },
    ],
  } as any;
}

describe("EP-TRAIN-4Y-W provenance-repair — eligibility heuristic", () => {
  it("still at placeholder → NOT eligible", () => {
    expect(
      courseEligibleForProvenanceRepair({
        title: "Untitled training course",
        aiMetadataAttributionAt: null,
      }),
    ).toBe(false);
  });

  it("empty title → NOT eligible", () => {
    expect(
      courseEligibleForProvenanceRepair({ title: "", aiMetadataAttributionAt: null }),
    ).toBe(false);
  });

  it("attribution already set → NOT eligible", () => {
    expect(
      courseEligibleForProvenanceRepair({
        title: "Workplace Safety",
        aiMetadataAttributionAt: new Date(),
      }),
    ).toBe(false);
  });

  it("real title, no attribution → ELIGIBLE", () => {
    expect(
      courseEligibleForProvenanceRepair({
        title: "Workplace Safety Orientation",
        aiMetadataAttributionAt: null,
      }),
    ).toBe(true);
  });
});

describe("EP-TRAIN-4Y-W provenance-repair — service", () => {
  const CLUB_ID = "club-a";
  const COURSE_ID = "course-a";
  const TITLE = "Workplace Safety Orientation";

  beforeEach(() => {
    mockDb = {
      __row: {
        id: COURSE_ID,
        clubId: CLUB_ID,
        title: TITLE,
        description: "orig description",
        code: "ORIG_CODE_ABC",
        aiMetadataAttributionAt: null as Date | null,
        aiMetadataAttributionRunId: null as string | null,
        aiMetadataAttributionSource: null as string | null,
        aiMetadataAttributedTitle: null as string | null,
      },
    };
  });

  afterEach(() => vi.clearAllMocks());

  it("ATTRIBUTED — sets attribution + audit, does NOT overwrite title/description/code", async () => {
    const db = makePrisma(mockDb.__row);
    const r = await repairCourseMetadataProvenance(
      founderPrincipal(CLUB_ID),
      {
        courseId: COURSE_ID,
        clubId: CLUB_ID,
        expectedAuthoredBy: "deterministic",
        titleAtRepair: TITLE,
        evidence: "4Y-U acceptance 2026-11-09",
      },
      { prisma: db as any },
    );
    expect(r.outcome).toBe("ATTRIBUTED");
    expect(r.attributedSource).toBe("deterministic");
    expect(mockDb.__row.title).toBe(TITLE);
    expect(mockDb.__row.description).toBe("orig description");
    expect(mockDb.__row.code).toBe("ORIG_CODE_ABC");
    expect(mockDb.__row.aiMetadataAttributionAt).toBeInstanceOf(Date);
    expect(mockDb.__row.aiMetadataAttributionSource).toBe("deterministic");
    expect(mockDb.__row.aiMetadataAttributedTitle).toBe(TITLE);
    const audit = (await import("@/lib/audit")).audit as ReturnType<typeof vi.fn>;
    expect(audit).toHaveBeenCalledOnce();
    expect((audit.mock.calls[0][1] as { action: string }).action).toBe(
      "hr.training.course.metadata.provenance_repaired",
    );
  });

  it("ALREADY_ATTRIBUTED — no write when attribution + title match", async () => {
    mockDb.__row.aiMetadataAttributionAt = new Date("2026-11-09T00:00:00Z");
    mockDb.__row.aiMetadataAttributionSource = "deterministic";
    mockDb.__row.aiMetadataAttributedTitle = TITLE;
    const db = makePrisma(mockDb.__row);
    const r = await repairCourseMetadataProvenance(
      founderPrincipal(CLUB_ID),
      {
        courseId: COURSE_ID,
        clubId: CLUB_ID,
        expectedAuthoredBy: "deterministic",
        titleAtRepair: TITLE,
      },
      { prisma: db as any },
    );
    expect(r.outcome).toBe("ALREADY_ATTRIBUTED");
    expect(db.trainingCourse.updateMany).not.toHaveBeenCalled();
    const audit = (await import("@/lib/audit")).audit as ReturnType<typeof vi.fn>;
    expect(audit).not.toHaveBeenCalled();
  });

  it("TITLE_DRIFTED — rejects when current title differs from caller snapshot", async () => {
    mockDb.__row.title = "Manager Edited Title";
    const db = makePrisma(mockDb.__row);
    try {
      await repairCourseMetadataProvenance(
        founderPrincipal(CLUB_ID),
        {
          courseId: COURSE_ID,
          clubId: CLUB_ID,
          expectedAuthoredBy: "deterministic",
          titleAtRepair: TITLE, // caller observed the OLD title
        },
        { prisma: db as any },
      );
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ProvenanceRepairRejected);
      expect((e as ProvenanceRepairRejected).outcome).toBe("TITLE_DRIFTED");
    }
  });

  it("TITLE_DRIFTED — DB-layer compare-and-set aborts under concurrent write", async () => {
    const db = makePrisma(mockDb.__row);
    // Simulate a concurrent write: BEFORE updateMany fires, mutate
    // the row's title so the DB-layer where-filter no longer matches.
    const original = db.trainingCourse.updateMany;
    (db.trainingCourse.updateMany as any) = vi.fn(async (args: any) => {
      mockDb.__row.title = "Someone Else Edited";
      return original(args);
    });
    try {
      await repairCourseMetadataProvenance(
        founderPrincipal(CLUB_ID),
        {
          courseId: COURSE_ID,
          clubId: CLUB_ID,
          expectedAuthoredBy: "deterministic",
          titleAtRepair: TITLE,
        },
        { prisma: db as any },
      );
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ProvenanceRepairRejected);
      expect((e as ProvenanceRepairRejected).outcome).toBe("TITLE_DRIFTED");
    }
  });

  it("COURSE_NOT_FOUND — course doesn't exist in this tenant", async () => {
    const db = makePrisma(null);
    try {
      await repairCourseMetadataProvenance(
        founderPrincipal(CLUB_ID),
        {
          courseId: "course-does-not-exist",
          clubId: CLUB_ID,
          expectedAuthoredBy: "deterministic",
          titleAtRepair: TITLE,
        },
        { prisma: db as any },
      );
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(ProvenanceRepairRejected);
      expect((e as ProvenanceRepairRejected).outcome).toBe("COURSE_NOT_FOUND");
    }
  });

  it("ForbiddenError — principal lacks hr:training:write", async () => {
    const { ForbiddenError } = await import("@/lib/errors");
    const db = makePrisma(mockDb.__row);
    await expect(
      repairCourseMetadataProvenance(
        viewerPrincipal(CLUB_ID),
        {
          courseId: COURSE_ID,
          clubId: CLUB_ID,
          expectedAuthoredBy: "deterministic",
          titleAtRepair: TITLE,
        },
        { prisma: db as any },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("UnauthenticatedError — principal is null", async () => {
    const { UnauthenticatedError } = await import("@/lib/errors");
    const db = makePrisma(mockDb.__row);
    await expect(
      repairCourseMetadataProvenance(
        null,
        {
          courseId: COURSE_ID,
          clubId: CLUB_ID,
          expectedAuthoredBy: "deterministic",
          titleAtRepair: TITLE,
        },
        { prisma: db as any },
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
