// EP-TRAIN-4Y-T §5 — deterministic contract for the grounded
// course-metadata generator. Covers:
//   - A representative transcript produces a sane title + description
//   - Title is capped at TITLE_MAX_LEN, description at DESCRIPTION_MAX_LEN
//   - Code is SCREAMING_SNAKE_CASE, 2-64 chars, alphanumeric/underscore
//   - Code suffix differs on repeated runs (collision-safe)
//   - Topical cues anchor the title when present
//   - The AI integration boundary returns AI_METADATA_NOT_YET_WIRED

import { describe, it, expect } from "vitest";
import {
  generateCourseMetadata,
  generateCourseMetadataDeterministic,
  generateCourseMetadataViaAi,
  TITLE_MIN_LEN,
  TITLE_MAX_LEN,
  DESCRIPTION_MAX_LEN,
} from "../src/lib/hr/training/ai-metadata/course-metadata-generator";

const SILVER_SPRINGS = [
  { segmentIndex: 0, text: "Hello and welcome to Silver Springs Golf and Country Club." },
  { segmentIndex: 1, text: "Today we're going to cover workplace safety for all new team members." },
  { segmentIndex: 2, text: "Safety on the course is the single most important thing we do every day." },
  { segmentIndex: 3, text: "You'll learn about hazard identification, incident reporting, and emergency procedures." },
  { segmentIndex: 4, text: "Pay stubs are accessed via the SIN last-four portal that you'll set up in HR." },
];

describe("EP-TRAIN-4Y-T §5 course metadata generator", () => {
  it("produces a title + description + code for a representative transcript", () => {
    const r = generateCourseMetadataDeterministic({ segments: SILVER_SPRINGS });
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_MIN_LEN);
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_LEN);
    expect(r.description.length).toBeGreaterThan(10);
    expect(r.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN);
    expect(r.code).toMatch(/^[A-Z0-9][A-Z0-9_-]{1,63}$/);
    expect(r.inferenceSource).toBe("deterministic");
  });

  it("prefers a topical sentence for the title when present", () => {
    const r = generateCourseMetadataDeterministic({ segments: SILVER_SPRINGS });
    // The transcript has strong safety + workplace + emergency cues;
    // the title should pick one of them rather than the "hello" intro.
    expect(r.title.toLowerCase()).toMatch(/safet|workplace|orientation|emergenc|hazard/);
  });

  it("falls back to a placeholder when the transcript is empty", () => {
    const r = generateCourseMetadataDeterministic({ segments: [] });
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_MIN_LEN);
    expect(r.description.length).toBeGreaterThan(0);
    expect(r.code).toMatch(/^[A-Z0-9][A-Z0-9_-]{1,63}$/);
  });

  it("produces collision-safe codes across runs", () => {
    const a = generateCourseMetadataDeterministic({ segments: SILVER_SPRINGS });
    const b = generateCourseMetadataDeterministic({ segments: SILVER_SPRINGS });
    // The base is deterministic; only the 6-hex suffix differs.
    expect(a.title).toBe(b.title);
    expect(a.code).not.toBe(b.code);
  });

  it("AI integration boundary reports NOT_YET_WIRED by default", async () => {
    const r = await generateCourseMetadataViaAi({ segments: SILVER_SPRINGS });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("AI_METADATA_NOT_YET_WIRED");
    }
  });

  it("entry point falls back to deterministic when AI is not wired, even with preferAi: true", async () => {
    const r = await generateCourseMetadata({
      segments: SILVER_SPRINGS,
      preferAi: true,
    });
    expect(r.inferenceSource).toBe("deterministic");
    expect(r.note).toContain("extractive summarisation");
  });

  it("title caps at TITLE_MAX_LEN even for a very long topical sentence", () => {
    const long = {
      segments: [
        {
          segmentIndex: 0,
          text: "Workplace safety orientation training module covering policy adherence equipment protocol emergency procedures hazard identification incident reporting and ongoing compliance for every employee of the Club.",
        },
      ],
    };
    const r = generateCourseMetadataDeterministic(long);
    expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX_LEN);
  });
});
