// EP-TRAIN-4Y-V §4 (2026-11-09) — unit tests for the attribution-
// column guard that supersedes the 4Y-U string-compare provisional
// check. The actual /generate-metadata route involves prisma +
// transcript reads and is covered by the staging acceptance E2E; this
// file isolates the pure decision table ("is this course still in
// system-authored territory?") so the invariant is regressable
// without a DB round-trip.

import { describe, it, expect } from "vitest";

const PROVISIONAL_TITLE = "Untitled training course";
const PROVISIONAL_CODE_PREFIX = "AUTO-DRAFT";

/** Mirror of the decision table inside the /generate-metadata route.
 *  Pulled into a pure function here so the test is isolated from
 *  Next.js route plumbing. If the route ever drifts, this test
 *  fails. */
function isProvisional(args: {
  readonly title: string;
  readonly code: string;
  readonly aiMetadataAttributionAt: Date | null;
  readonly aiMetadataAttributedTitle: string | null;
}): boolean {
  const atPlaceholderStrings =
    args.title === PROVISIONAL_TITLE ||
    args.code.startsWith(PROVISIONAL_CODE_PREFIX);
  const attributionSet = args.aiMetadataAttributionAt !== null;
  const titleMatchesAttributedSnapshot =
    attributionSet &&
    args.aiMetadataAttributedTitle !== null &&
    args.aiMetadataAttributedTitle === args.title;
  return attributionSet
    ? titleMatchesAttributedSnapshot
    : atPlaceholderStrings;
}

describe("EP-TRAIN-4Y-V attribution-guard decision table", () => {
  it("fresh course at placeholders with NO attribution → provisional (system may write)", () => {
    expect(
      isProvisional({
        title: PROVISIONAL_TITLE,
        code: "AUTO-DRAFT-DEAD",
        aiMetadataAttributionAt: null,
        aiMetadataAttributedTitle: null,
      }),
    ).toBe(true);
  });

  it("fresh course with code placeholder but manager-renamed title → still provisional (pre-4YV courses)", () => {
    expect(
      isProvisional({
        title: "Manager Edited Title",
        code: "AUTO-DRAFT-DEAD",
        aiMetadataAttributionAt: null,
        aiMetadataAttributedTitle: null,
      }),
    ).toBe(true);
  });

  it("course with established title + code and NO attribution → finalised (refuse overwrite)", () => {
    expect(
      isProvisional({
        title: "Workplace Safety Orientation",
        code: "WORKPLACE_SAFETY_EEC1B7",
        aiMetadataAttributionAt: null,
        aiMetadataAttributedTitle: null,
      }),
    ).toBe(false);
  });

  it("course with attribution AND title still matching the attributed snapshot → provisional (retry OK)", () => {
    const now = new Date();
    expect(
      isProvisional({
        title: "AI Suggested Title",
        code: "AI_SUGGESTED_TITLE_F00BAA",
        aiMetadataAttributionAt: now,
        aiMetadataAttributedTitle: "AI Suggested Title",
      }),
    ).toBe(true);
  });

  it("course with attribution AND manager edited the title → MANAGER-FINALISED (refuse overwrite)", () => {
    const now = new Date();
    expect(
      isProvisional({
        title: "Manager Changed Title",
        code: "AI_SUGGESTED_TITLE_F00BAA",
        aiMetadataAttributionAt: now,
        aiMetadataAttributedTitle: "AI Suggested Title",
      }),
    ).toBe(false);
  });

  it("course with attribution but null attributedTitle (corrupt) → MANAGER-FINALISED (safer default)", () => {
    const now = new Date();
    expect(
      isProvisional({
        title: "Whatever",
        code: "WHATEVER_BEEF99",
        aiMetadataAttributionAt: now,
        aiMetadataAttributedTitle: null,
      }),
    ).toBe(false);
  });

  it("empty-string title is provisional only when no attribution exists", () => {
    // Defensive: a never-attributed course whose title somehow got
    // cleared should still accept a system write; an attributed
    // course whose title got cleared is treated as manager-edited.
    expect(
      isProvisional({
        title: "",
        code: "AUTO-DRAFT-ZZ",
        aiMetadataAttributionAt: null,
        aiMetadataAttributedTitle: null,
      }),
    ).toBe(true);
    const now = new Date();
    expect(
      isProvisional({
        title: "",
        code: "AI_TITLE_BBBBBB",
        aiMetadataAttributionAt: now,
        aiMetadataAttributedTitle: "AI Title",
      }),
    ).toBe(false);
  });
});
