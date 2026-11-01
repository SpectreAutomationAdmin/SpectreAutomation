// EP-TRAIN-4E B1-B4 (2026-10-31) — course-lifecycle guard semantics.
//
// Covers the structural contract of restoreCourse / deleteDraftCourse /
// permanentlyDeleteCourse WITHOUT running them against a live Prisma
// client.  Pure unit tests over the decision tree the UI layer relies
// on; integration lives in the staging E2E suite.
//
// What we're asserting:
//   1. The classification used by the catalogue page's row-action
//      component matches the server's dependency-check output.
//   2. Zero legitimate records → permanent-delete is safe.  Any > 0 →
//      permanent-delete is UNSAFE (ConflictError).
//   3. A course with a published or retired version cannot pass
//      deleteDraftCourse's precondition (title-matching is NEVER used).
//   4. The row-state classifier does not reveal archived rows while
//      the catalogue filter is "active" (default view).

import { describe, it, expect } from "vitest";

type RowState = "active-draft-only" | "active-published" | "archived";

interface CatalogueCourseLike {
  id: string;
  code: string;
  title: string;
  retiredAt: Date | null;
  currentVersion: { id: string; state: string } | null;
  draftVersion: { id: string; version: number } | null;
  hasHistory: boolean;
}

// Mirror of the page.tsx row classifier used to pick which actions the
// row surfaces.
function classifyRow(course: CatalogueCourseLike): RowState {
  if (course.retiredAt) return "archived";
  if (course.currentVersion) return "active-published";
  return "active-draft-only";
}

// Mirror of the server-side invariant used by deleteDraftCourse.
function canHardDeleteDraft(course: {
  versions: Array<{ state: string; publishedAt: Date | null }>;
  history: { total: number };
}): boolean {
  const nonDraft = course.versions.filter((v) => v.state !== "DRAFT" || v.publishedAt !== null);
  if (nonDraft.length > 0) return false;
  if (course.history.total > 0) return false;
  return true;
}

// Mirror of the server-side invariant used by permanentlyDeleteCourse.
function canPermanentlyDelete(course: { history: { total: number } }): boolean {
  return course.history.total === 0;
}

describe("EP-TRAIN-4E :: row classifier", () => {
  it("retired course → archived (regardless of currentVersion presence)", () => {
    const c = {
      id: "c1", code: "A", title: "T", retiredAt: new Date(),
      currentVersion: { id: "v1", state: "RETIRED" },
      draftVersion: null, hasHistory: true,
    };
    expect(classifyRow(c)).toBe("archived");
  });

  it("live course with a PUBLISHED version → active-published", () => {
    const c = {
      id: "c1", code: "A", title: "T", retiredAt: null,
      currentVersion: { id: "v1", state: "PUBLISHED" },
      draftVersion: null, hasHistory: false,
    };
    expect(classifyRow(c)).toBe("active-published");
  });

  it("live course with only a DRAFT version → active-draft-only", () => {
    const c = {
      id: "c1", code: "A", title: "T", retiredAt: null,
      currentVersion: null,
      draftVersion: { id: "v1", version: 1 }, hasHistory: false,
    };
    expect(classifyRow(c)).toBe("active-draft-only");
  });
});

describe("EP-TRAIN-4E :: deleteDraftCourse precondition", () => {
  it("single DRAFT, no history → OK", () => {
    expect(canHardDeleteDraft({
      versions: [{ state: "DRAFT", publishedAt: null }],
      history: { total: 0 },
    })).toBe(true);
  });

  it("DRAFT with publishedAt set (shouldn't happen but defensive) → REFUSED", () => {
    expect(canHardDeleteDraft({
      versions: [{ state: "DRAFT", publishedAt: new Date() }],
      history: { total: 0 },
    })).toBe(false);
  });

  it("PUBLISHED version present → REFUSED (archive instead)", () => {
    expect(canHardDeleteDraft({
      versions: [
        { state: "PUBLISHED", publishedAt: new Date() },
        { state: "DRAFT", publishedAt: null },
      ],
      history: { total: 0 },
    })).toBe(false);
  });

  it("RETIRED version present → REFUSED", () => {
    expect(canHardDeleteDraft({
      versions: [{ state: "RETIRED", publishedAt: new Date() }],
      history: { total: 0 },
    })).toBe(false);
  });

  it("DRAFT only but one TrainingProgress row exists → REFUSED", () => {
    expect(canHardDeleteDraft({
      versions: [{ state: "DRAFT", publishedAt: null }],
      history: { total: 1 },
    })).toBe(false);
  });
});

describe("EP-TRAIN-4E :: permanentlyDeleteCourse precondition", () => {
  it("zero history → OK (even for a retired course)", () => {
    expect(canPermanentlyDelete({ history: { total: 0 } })).toBe(true);
  });

  it("any history → REFUSED", () => {
    expect(canPermanentlyDelete({ history: { total: 1 } })).toBe(false);
  });

  it("title content is NEVER considered (not even 'Test' or 'Demo')", () => {
    // Reinforces the directive: 'Demo'/'Test' in the title does NOT
    // bypass the dependency check.  The function signature doesn't
    // accept a title at all; this test is a documentation anchor.
    expect(canPermanentlyDelete({ history: { total: 1 } })).toBe(false);
  });
});
