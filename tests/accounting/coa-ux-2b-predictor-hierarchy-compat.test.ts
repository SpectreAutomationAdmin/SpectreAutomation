// COA-UX-2b (2026-09-29) — Predictor / classification hierarchy compatibility guard.
//
// The UI's Category → FS Group filter and the import predictor's
// (type, categoryKey, fsGroupKey) outputs both consume the SAME
// canonical `FS_GROUP_TO_CATEGORY` constant. This test asserts they
// cannot drift apart: every (categoryKey, fsGroupKey) pair the
// predictor can emit MUST also be considered valid by the UI's
// hierarchy helper.

import { describe, expect, it } from "vitest";
import { FS_GROUP_TO_CATEGORY } from "../../src/lib/imports/coa-predictor";
import {
  isFsGroupValidForCategory,
  CATEGORY_TO_FS_GROUPS,
} from "../../src/lib/imports/classification-hierarchy";

describe("COA-UX-2b · predictor ↔ hierarchy compatibility (§12)", () => {
  it("every (fsGroupKey → categoryKey) pair in FS_GROUP_TO_CATEGORY passes isFsGroupValidForCategory", () => {
    for (const [fsGroupKey, categoryKey] of Object.entries(FS_GROUP_TO_CATEGORY)) {
      const ok = isFsGroupValidForCategory(fsGroupKey, categoryKey);
      if (!ok) throw new Error(`${fsGroupKey} → ${categoryKey} rejected`);
      expect(ok).toBe(true);
    }
  });

  it("every FS Group in CATEGORY_TO_FS_GROUPS is claimed by exactly one Category", () => {
    const seen = new Set<string>();
    for (const [_categoryKey, fsGroupKeys] of Object.entries(CATEGORY_TO_FS_GROUPS)) {
      for (const key of fsGroupKeys) {
        if (seen.has(key)) throw new Error(`${key} appears under multiple Categories`);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(Object.keys(FS_GROUP_TO_CATEGORY).length);
  });

  it("no orphan Category — every Category the predictor emits has at least one FS Group under it", () => {
    const emittedCategories = new Set(Object.values(FS_GROUP_TO_CATEGORY));
    for (const c of emittedCategories) {
      const list = CATEGORY_TO_FS_GROUPS[c];
      if (!list || list.length === 0) throw new Error(`Category ${c} has no FS Groups in inverse map`);
      expect(list.length).toBeGreaterThan(0);
    }
  });
});
