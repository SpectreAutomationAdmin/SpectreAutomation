// Sprint 3 Checkpoint 15H Unified Remediation (2026-07-25) —
// Regression guard for the PDF preview render bug.
//
// Root cause of the founder-reported "modal opens but PDF does not
// render" bug: the middleware CSP shipped `object-src 'none'`, which
// blocks Chrome's built-in PDF viewer's <embed> element from
// spawning inside the blob-URL iframe. The blob-URL bypass fixed
// X-Frame-Options DENY (the modal opens) but the PDF viewer itself
// couldn't render.
//
// This test locks the two CSP directives that must stay in place for
// the PDF preview to keep working across the entire admin surface:
//   * object-src must permit 'self' and blob:
//   * frame-src must permit 'self' and blob:
// (frame-src is added explicitly so browsers that don't inherit
// frame-src from default-src still allow the blob iframe nav.)

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIDDLEWARE = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");

describe("middleware CSP — PDF preview modal must render", () => {
  it("object-src permits 'self' and blob:", () => {
    // Full-line match — a future change that flips this back to
    // 'none' (or drops blob:) will trip the guard.
    expect(MIDDLEWARE).toMatch(/"object-src 'self' blob:"/);
    expect(MIDDLEWARE).not.toMatch(/"object-src 'none'"/);
  });
  it("frame-src permits 'self' and blob:", () => {
    expect(MIDDLEWARE).toMatch(/"frame-src 'self' blob:"/);
  });
  it("still forbids arbitrary external <object>/<embed> plugins (no wildcard)", () => {
    // Defense-in-depth: no matter what future edits do, don't let
    // the fix widen to `object-src *`.
    expect(MIDDLEWARE).not.toMatch(/object-src[^;"]*\*/);
    expect(MIDDLEWARE).not.toMatch(/object-src[^;"]*https:/);
  });
  it("still ships strict CSP baseline (no relaxation of the other directives)", () => {
    // Quick sanity — make sure widening object-src/frame-src didn't
    // sneak in unrelated relaxations.
    expect(MIDDLEWARE).toMatch(/"frame-ancestors 'none'"/);
    expect(MIDDLEWARE).toMatch(/"default-src 'self'"/);
    expect(MIDDLEWARE).toMatch(/"base-uri 'self'"/);
    expect(MIDDLEWARE).toMatch(/"form-action 'self'"/);
  });
});
