// EP-TRAIN-4Y-AD §8 — regression tests for the metadata-provenance
// gate. Covers every §8 scenario from the directive using the pure
// `evaluateMetadataWrite` + `validateProposedAiMetadata` helpers.

import { describe, it, expect } from "vitest";
import {
  evaluateMetadataWrite,
  inferCurrentSource,
  validateProposedAiMetadata,
  PROVISIONAL_TITLE,
  PROVISIONAL_CODE_PREFIX,
  type CurrentCourseMetadataSnapshot,
  type MetadataSource,
} from "@/lib/hr/training/ai-metadata/metadata-provenance";

function snap(overrides: Partial<CurrentCourseMetadataSnapshot> = {}): CurrentCourseMetadataSnapshot {
  return {
    title: "Employee Onboarding and Policies",
    code: "EMPLOYEE_ONBOARDING_AND_POLICIES_3F2A48",
    aiMetadataAttributionAt: new Date("2026-11-09T21:26:54.311Z"),
    aiMetadataAttributionSource: "ai",
    aiMetadataAttributedTitle: "Employee Onboarding and Policies",
    ...overrides,
  };
}

describe("inferCurrentSource", () => {
  it("classifies an unchanged AI write as 'ai'", () => {
    expect(inferCurrentSource(snap())).toBe("ai");
  });
  it("classifies an AI write whose title the manager edited as 'manager'", () => {
    expect(inferCurrentSource(snap({ title: "Employee Handbook Training" }))).toBe("manager");
  });
  it("classifies a deterministic baseline as 'deterministic'", () => {
    const s = snap({
      aiMetadataAttributionSource: "deterministic",
      aiMetadataAttributedTitle: "Getting Right Into It, …",
      title: "Getting Right Into It, …",
    });
    expect(inferCurrentSource(s)).toBe("deterministic");
  });
  it("classifies a fresh course (placeholders + no attribution) as 'provisional'", () => {
    const s = snap({
      aiMetadataAttributionAt: null,
      aiMetadataAttributionSource: null,
      aiMetadataAttributedTitle: null,
      title: PROVISIONAL_TITLE,
      code: `${PROVISIONAL_CODE_PREFIX}-XYZ`,
    });
    expect(inferCurrentSource(s)).toBe("provisional");
  });
  it("classifies a pre-attribution-era manager edit as 'manager'", () => {
    const s = snap({
      aiMetadataAttributionAt: null,
      aiMetadataAttributionSource: null,
      aiMetadataAttributedTitle: null,
      title: "A manually-edited title from before attribution existed",
      code: "SOMETHING_NOT_AUTO_DRAFT",
    });
    expect(inferCurrentSource(s)).toBe("manager");
  });
});

describe("evaluateMetadataWrite — the ladder", () => {
  // --- §8 scenario: deterministic cannot demote AI (the founder's regression) ---
  it("REFUSES deterministic overwrite of AI (regression from 2026-11-10T15:59:46Z)", () => {
    const d = evaluateMetadataWrite({ currentSnapshot: snap(), proposedSource: "deterministic" });
    expect(d.allow).toBe(false);
    expect(d.reasonCode).toBe("REFUSED_AI_AUTHORED");
    expect(d.currentSource).toBe("ai");
  });

  // --- §8 scenario: manager-edited metadata takes precedence over any retry ---
  it("REFUSES deterministic overwrite of manager edit", () => {
    const d = evaluateMetadataWrite({
      currentSnapshot: snap({ title: "Manager-overridden title" }),
      proposedSource: "deterministic",
    });
    expect(d.allow).toBe(false);
    expect(d.reasonCode).toBe("REFUSED_MANAGER_EDIT_PRESENT");
  });
  it("REFUSES ai overwrite of manager edit", () => {
    const d = evaluateMetadataWrite({
      currentSnapshot: snap({ title: "Manager-overridden title" }),
      proposedSource: "ai",
    });
    expect(d.allow).toBe(false);
    expect(d.reasonCode).toBe("REFUSED_MANAGER_EDIT_PRESENT");
  });

  // --- §8 scenario: AI may refresh its own prior AI write (retry is safe) ---
  it("ALLOWS ai→ai refresh (retry)", () => {
    const d = evaluateMetadataWrite({ currentSnapshot: snap(), proposedSource: "ai" });
    expect(d.allow).toBe(true);
    expect(d.reasonCode).toBe("ALLOWED_EQUAL_AUTHORITY_REFRESH");
  });

  // --- §8 scenario: AI may upgrade a deterministic baseline ---
  it("ALLOWS ai writing over deterministic", () => {
    const s = snap({
      aiMetadataAttributionSource: "deterministic",
      aiMetadataAttributedTitle: "Getting Right Into It",
      title: "Getting Right Into It",
    });
    const d = evaluateMetadataWrite({ currentSnapshot: s, proposedSource: "ai" });
    expect(d.allow).toBe(true);
    expect(d.reasonCode).toBe("ALLOWED_HIGHER_AUTHORITY");
  });

  // --- §8 scenario: deterministic may upgrade provisional (new course) ---
  it("ALLOWS deterministic writing over provisional", () => {
    const s = snap({
      aiMetadataAttributionAt: null,
      aiMetadataAttributionSource: null,
      aiMetadataAttributedTitle: null,
      title: PROVISIONAL_TITLE,
      code: `${PROVISIONAL_CODE_PREFIX}-ABC`,
    });
    const d = evaluateMetadataWrite({ currentSnapshot: s, proposedSource: "deterministic" });
    expect(d.allow).toBe(true);
    expect(d.reasonCode).toBe("ALLOWED_HIGHER_AUTHORITY");
  });

  // --- §8 scenario: manager overrides everything ---
  it("ALLOWS manager writing over ai", () => {
    const d = evaluateMetadataWrite({ currentSnapshot: snap(), proposedSource: "manager" });
    expect(d.allow).toBe(true);
    expect(d.reasonCode).toBe("ALLOWED_HIGHER_AUTHORITY");
  });

  // --- §8 scenario: cache invalidation + failed AI cannot demote ---
  it("REFUSES provisional downgrade of ai (defensive)", () => {
    const d = evaluateMetadataWrite({ currentSnapshot: snap(), proposedSource: "provisional" });
    expect(d.allow).toBe(false);
    expect(d.reasonCode).toBe("REFUSED_AI_AUTHORED");
  });
  it("REFUSES provisional downgrade of deterministic (defensive)", () => {
    const s = snap({
      aiMetadataAttributionSource: "deterministic",
      aiMetadataAttributedTitle: "Any deterministic text",
      title: "Any deterministic text",
    });
    const d = evaluateMetadataWrite({ currentSnapshot: s, proposedSource: "provisional" });
    expect(d.allow).toBe(false);
    expect(d.reasonCode).toBe("REFUSED_DETERMINISTIC_ALREADY_FINALISED");
  });

  // --- §8 scenario: provisional source can be upgraded by anyone ---
  for (const proposed of ["deterministic", "ai", "manager"] as MetadataSource[]) {
    it(`ALLOWS ${proposed} writing over a brand-new provisional course`, () => {
      const s = snap({
        aiMetadataAttributionAt: null,
        aiMetadataAttributionSource: null,
        aiMetadataAttributedTitle: null,
        title: PROVISIONAL_TITLE,
        code: `${PROVISIONAL_CODE_PREFIX}-XYZ`,
      });
      const d = evaluateMetadataWrite({ currentSnapshot: s, proposedSource: proposed });
      expect(d.allow).toBe(true);
    });
  }
});

describe("validateProposedAiMetadata — directive §5 validation", () => {
  it("accepts the live-staging accepted baseline", () => {
    const r = validateProposedAiMetadata({
      title: "Employee Onboarding and Policies",
      description:
        "This course covers essential information for new team members at Silver Springs, including pay stub access, workplace conduct, and member service expectations. Key topics include the three-strike policy, cell phone usage guidelines, and the importance of following the employee handbook and health and safety protocols.",
    });
    expect(r.ok).toBe(true);
  });

  it("flags transcript-fragment title ('Getting Right Into It, …')", () => {
    const r = validateProposedAiMetadata({
      title: "Getting Right Into It, The Most Frequently Asked Question We Have Is How Do We",
      description: "Legitimate description.",
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("TITLE_LOOKS_LIKE_TRANSCRIPT_FRAGMENT");
  });

  it("flags transcript-opener title ('Hello everyone …')", () => {
    const r = validateProposedAiMetadata({
      title: "Hello everyone and welcome to Silver Springs",
      description: "Legitimate description.",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("TITLE_LOOKS_LIKE_TRANSCRIPT_FRAGMENT");
  });

  it("flags transcript-opener description", () => {
    const r = validateProposedAiMetadata({
      title: "Reasonable title",
      description:
        "Hello everyone and welcome to the Silver Springs Golf and Country Club. We're happy to have you as a team member. I'm Randy and I'll be your host for today's session.",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("DESCRIPTION_LOOKS_LIKE_TRANSCRIPT_OPENER");
  });

  it("flags titles longer than 120 chars", () => {
    const r = validateProposedAiMetadata({
      title: "x".repeat(121),
      description: "ok ok ok ok ok ok ok ok",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("TITLE_TOO_LONG");
  });
});
