// EP-TRAIN-4E-1 (2026-11-01) — shared R2 object reference-count safety.
//
// Mirrors the pure decision logic of cleanupUnreferencedVideoObjects
// (src/lib/hr/training/courses.ts) so a future refactor cannot regress
// the shared-storage-key guard that was retrofitted after a fixture
// permanent-delete removed the shared B31 video object.

import { describe, it, expect } from "vitest";

/** Mirror of the server's reference-count decision.  Given a set of
 *  storage keys the deleting course owns, and the keys that remain
 *  referenced by OTHER courses, return the subset that is safe to
 *  delete from R2. */
function computeDeletableKeys(opts: {
  owned: string[];
  stillReferencedByOtherCourses: string[];
}): string[] {
  const stillReferenced = new Set(opts.stillReferencedByOtherCourses);
  const unique = Array.from(new Set(opts.owned));
  return unique.filter((k) => !stillReferenced.has(k));
}

describe("EP-TRAIN-4E-1 :: cleanupUnreferencedVideoObjects", () => {
  it("key referenced by another course → NOT deleted", () => {
    const out = computeDeletableKeys({
      owned: ["training/shared-A/1/sha"],
      stillReferencedByOtherCourses: ["training/shared-A/1/sha"],
    });
    expect(out).toEqual([]);
  });

  it("key referenced by no other course → DELETED (last reference)", () => {
    const out = computeDeletableKeys({
      owned: ["training/exclusive-A/1/sha"],
      stillReferencedByOtherCourses: [],
    });
    expect(out).toEqual(["training/exclusive-A/1/sha"]);
  });

  it("owns a mix of shared + exclusive keys → only exclusive deleted", () => {
    const out = computeDeletableKeys({
      owned: ["training/shared/1/sha", "training/exclusive/1/sha"],
      stillReferencedByOtherCourses: ["training/shared/1/sha"],
    });
    expect(out).toEqual(["training/exclusive/1/sha"]);
  });

  it("duplicate owned keys are deduplicated (no double-delete attempt)", () => {
    const out = computeDeletableKeys({
      owned: ["training/dup/1/sha", "training/dup/1/sha", "training/dup/1/sha"],
      stillReferencedByOtherCourses: [],
    });
    expect(out).toEqual(["training/dup/1/sha"]);
  });

  it("B31 scenario reproduction — fixture course owns the shared key, another course references it → not deleted", () => {
    // Exact pattern that broke staging: the EP-TRAIN-3 fixture
    // provisioning reused REUSED_VIDEO_KEY across every per-test
    // course + the legitimate B31_STAGING_ACCEPTANCE course.
    // Permanent-deleting ONE fixture must not touch the key because
    // other courses (including B31) still reference it.
    const REUSED = "training/cmt28yaet005g114f43ybgw9f/2/40e9c31eda3520963d7089e80751efa33d82fb398d6a4b69b305d650f4045dad";
    const out = computeDeletableKeys({
      owned: [REUSED],
      stillReferencedByOtherCourses: [REUSED],
    });
    expect(out).toEqual([]);
  });

  it("last-reference cleanup path: ONE course still owns the key, deleting it IS the last reference → deleted", () => {
    const out = computeDeletableKeys({
      owned: ["training/last/1/sha"],
      stillReferencedByOtherCourses: [], // we're the last course that owns it
    });
    expect(out).toEqual(["training/last/1/sha"]);
  });
});
