/**
 * EP-TRAIN-4Y-BD — CP prompt employee-facing text purity clause +
 * 10-15 min bucket 5-CP default.
 *
 * The forensic trace of the one completed run on cmwgl11wv002jh25jb8gfzlwi
 * showed Qwen writing "Segment ID 54" / "Segment ID 46" / "Segment ID 48"
 * into the EXPLANATION of the single CP proposal returned. The
 * employee-facing-text sanitiser (correctly) dropped the proposal under
 * EXPLICIT_SEGMENT_ID_REFERENCE, leaving zero CP drafts persisted on a
 * run that produced 1 live proposal.
 *
 * Root cause: the CP prompt (buildCheckpointSystemPromptCtxV1) lacked
 * the EMPLOYEE-FACING TEXT PURITY constraint that the FA prompt
 * (buildFinalSystemPromptCtxV1) has carried since 4Y-AJ.
 *
 * This test avoids a full worker-handler import (which pulls in the
 * Prisma client at module scope). It reads the prompt-builder source
 * and asserts the exact clauses needed to prevent future sanitiser
 * drops on provenance leakage. The duration-sizing portion stays an
 * ordinary unit test — that module is pure and Prisma-free.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sizeForDuration, DURATION_SIZING_POLICY, clampToBucket } from "@/lib/hr/training/generation/duration-sizing";

const WORKER_HANDLER_PATH = path.resolve(process.cwd(), "src/lib/hr/training/generation/worker-handler.ts");
const workerSrc = readFileSync(WORKER_HANDLER_PATH, "utf-8");

function extractFunctionSource(name: string): string {
  const needle = `export function ${name}(`;
  const idx = workerSrc.indexOf(needle);
  if (idx < 0) throw new Error(`function ${name} not found`);
  // Find the next top-level export, function, or end-of-file that begins
  // at column 0 and is NOT nested inside the target function body.
  // Simple heuristic: the next line starting with `export function ` or
  // `async function ` or `function ` at col 0 after idx.
  const afterNeedle = workerSrc.slice(idx + needle.length);
  const nextExportRel = afterNeedle.search(/\nexport (?:async )?function /);
  const nextPlainRel  = afterNeedle.search(/\n(?:async )?function (?!extractFunctionSource)/);
  const candidates = [nextExportRel, nextPlainRel].filter((n) => n >= 0);
  const endRel = candidates.length === 0 ? afterNeedle.length : Math.min(...candidates);
  return workerSrc.slice(idx, idx + needle.length + endRel);
}

describe("EP-TRAIN-4Y-BD §3 — CP prompt employee-facing text purity", () => {
  const cpSrc = extractFunctionSource("buildCheckpointSystemPromptCtxV1");
  const faSrc = extractFunctionSource("buildFinalSystemPromptCtxV1");

  it("CP prompt now carries the EMPLOYEE-FACING TEXT PURITY header (it previously did not)", () => {
    expect(cpSrc).toContain("EMPLOYEE-FACING TEXT PURITY");
  });

  it("CP prompt bans the exact words the sanitiser rejects on", () => {
    // These are the same literal phrases the FA prompt uses — the fix
    // lifts the FA clause verbatim so sanitiser rules fire identically.
    expect(cpSrc).toMatch(/MUST NOT contain the words.*"segment",\s+"segments",\s+"transcript"/s);
    expect(cpSrc).toMatch(/passage id/);
    expect(cpSrc).toMatch(/bracketed numbers like.*\[12\]/s);
    expect(cpSrc).toMatch(/any digit used as a provenance reference/);
  });

  it("CP prompt bans provenance-pointer leader phrases", () => {
    expect(cpSrc).toMatch(/According to the transcript/);
    expect(cpSrc).toMatch(/According to the training material/);
    expect(cpSrc).toMatch(/According to the course content/);
    expect(cpSrc).toMatch(/Per the transcript/);
    expect(cpSrc).toMatch(/As stated in the video/);
    expect(cpSrc).toMatch(/Based on the presentation/);
  });

  it("CP prompt frames the bracketed tag as internal metadata for sourceSegmentIds only", () => {
    // The prompt lives in a template literal, so its backticks are escaped in the source.
    expect(cpSrc).toMatch(/INTERNAL METADATA for the \\?`sourceSegmentIds\\?` JSON field ONLY/);
    expect(cpSrc).toMatch(/Cite 1-3 tags per question; do NOT list the whole passage set/);
  });

  it("CP prompt still enforces the §1 evidence-window rule (no forward-looking questions)", () => {
    expect(cpSrc).toMatch(/Assess ONLY material covered in the evidence window/);
    expect(cpSrc).toMatch(/Do NOT ask about anything later in the course/);
  });

  it("CP prompt still carries the explanation rule and the application / judgment preference", () => {
    expect(cpSrc).toMatch(/\\?`explanation\\?` is grounded context for WHY the correct option is correct/);
    expect(cpSrc).toMatch(/Do NOT append the explanation to the stem/);
    expect(cpSrc).toMatch(/tests APPLICATION or JUDGMENT/);
  });

  it("CP and FA share the same purity-clause body (CP is now lock-step with FA)", () => {
    // The precise sentence is long; comparing a mid-sentence slice is
    // enough to detect drift.
    const kernel =
      'They MUST NOT contain the words "segment", "segments", "transcript"';
    expect(cpSrc).toContain(kernel);
    expect(faSrc).toContain(kernel);
    const kernel2 = "any similar pointer that cites, quotes or refers to the source document";
    expect(cpSrc).toContain(kernel2);
    expect(faSrc).toContain(kernel2);
  });

  it("CP prompt still renders priorTopics when non-empty (§10)", () => {
    expect(cpSrc).toMatch(/10\. The following question topics have ALREADY been generated/);
  });
});

describe("EP-TRAIN-4Y-BD §2 — 10-15 min bucket 5-CP default", () => {
  it("643-sec video gets 5 CP + 8 FA (not 4 + 8)", () => {
    const r = sizeForDuration(643);
    expect(r.bucket.label).toBe("10-15 minutes");
    expect(r.checkpointCount).toBe(5);
    expect(r.finalCount).toBe(8);
    expect(r.totalCount).toBe(13);
  });

  it("the 10-15 min bucket's min floor is 5 (published floor per BD)", () => {
    const bucket = DURATION_SIZING_POLICY.find((b) => b.label === "10-15 minutes")!;
    expect(bucket.checkpointMin).toBe(5);
    expect(bucket.defaultCheckpointCount).toBe(5);
    // The max widens to 7 so managers can still ask for a modest bump.
    expect(bucket.checkpointMax).toBe(7);
  });

  it("asking for 1 CP on a 10-15 min video clamps UP to the 5-CP floor", () => {
    const bucket = DURATION_SIZING_POLICY.find((b) => b.label === "10-15 minutes")!;
    // A caller passing checkpointCount: 1 (e.g. legacy plan) MUST not
    // under-size a course for which the published floor is 5. This is
    // the contract the shortfall-only recovery relies on when BD asks
    // the baseline builder for exactly 5 CP.
    expect(clampToBucket(bucket, { checkpointCount: 1 })).toEqual({ checkpointCount: 5, finalCount: 8 });
  });

  it("asking for 100 CP on a 10-15 min video clamps DOWN to the 7-CP ceiling", () => {
    const bucket = DURATION_SIZING_POLICY.find((b) => b.label === "10-15 minutes")!;
    expect(clampToBucket(bucket, { checkpointCount: 100 })).toEqual({ checkpointCount: 7, finalCount: 8 });
  });
});
