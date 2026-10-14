// AP-MOTION-1 (2026-10-13) — contract tests for the isolated AP
// Review motion prototype.
//
// Pure data-layer tests + source-grep assertions.  Verifies:
//   §A — scenes.ts emits 6 deterministic scenes with the correct
//        per-scene population + vendor-match state progression.
//   §B — The prototype component imports from scenes.ts + the
//        playback hook; does NOT import a server action, a
//        mutation helper, or an accounting service.
//   §C — The prototype route exists on the dedicated path and
//        renders ONLY the prototype component (no production AP
//        review coupling).

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildScenes, DEMO_INVOICE } from "@/components/work-intake/review-prototype/scenes";

const REPO = path.resolve(__dirname, "..");

describe("AP-MOTION-1 §A — scene progression is deterministic + grounded", () => {
  const scenes = buildScenes();

  it("exposes exactly 6 scenes in the directive order", () => {
    expect(scenes).toHaveLength(6);
    expect(scenes.map((s) => s.key)).toEqual([
      "scene-1-received",
      "scene-2-extraction",
      "scene-3-classification",
      "scene-4-exception",
      "scene-5-intervention",
      "scene-6-resolution",
    ]);
  });

  it("scene 1 — nothing populated; stage 1 active; vendor-match idle", () => {
    const s = scenes[0];
    expect(s.populated.size).toBe(0);
    expect(s.activeStageIndex).toBe(1);
    expect(s.vendorMatchState).toBe("idle");
  });

  it("scene 2 — identity fields populated; stage 2 active; vendor-match still idle", () => {
    const s = scenes[1];
    ["vendor", "invoiceNumber", "invoiceDate", "dueDate", "total"].forEach((f) =>
      expect(s.populated.has(f as never)).toBe(true),
    );
    // Accounting fields NOT yet populated.
    expect(s.populated.has("category" as never)).toBe(false);
    expect(s.populated.has("glAccount" as never)).toBe(false);
    expect(s.activeStageIndex).toBe(2);
    expect(s.vendorMatchState).toBe("idle");
  });

  it("scene 3 — classification fields populated; vendor-match still idle", () => {
    const s = scenes[2];
    expect(s.populated.has("category" as never)).toBe(true);
    expect(s.populated.has("glAccount" as never)).toBe(true);
    expect(s.vendorMatchState).toBe("idle");
  });

  it("scene 4 — vendor-match ATTENTION; fields remain populated", () => {
    const s = scenes[3];
    expect(s.vendorMatchState).toBe("attention");
    expect(s.populated.size).toBe(7); // 5 identity + 2 accounting
  });

  it("scene 5 — attention persists while reviewer interacts", () => {
    const s = scenes[4];
    expect(s.vendorMatchState).toBe("attention");
  });

  it("scene 6 — vendor-match RESOLVED (not idle)", () => {
    const s = scenes[5];
    expect(s.vendorMatchState).toBe("resolved");
  });

  it("DEMO_INVOICE carries the directive-named vendor + total $778.16 CAD", () => {
    expect(DEMO_INVOICE.vendor).toBe("Club Support Inc");
    expect(DEMO_INVOICE.total).toBe("$778.16 CAD");
  });
});

describe("AP-MOTION-1 §B — Isolation: no mutation / server-action imports in the prototype module", () => {
  const protoSrc = fs.readFileSync(
    path.join(REPO, "src/components/work-intake/review-prototype/ReviewMotionPrototype.tsx"),
    "utf-8",
  );
  const scenesSrc = fs.readFileSync(
    path.join(REPO, "src/components/work-intake/review-prototype/scenes.ts"),
    "utf-8",
  );
  const hookSrc = fs.readFileSync(
    path.join(REPO, "src/components/work-intake/review-prototype/useScenePlayback.ts"),
    "utf-8",
  );
  const pageSrc = fs.readFileSync(
    path.join(REPO, "src/app/app/admin/work-intake/review-prototype/page.tsx"),
    "utf-8",
  );
  const allSources = [protoSrc, scenesSrc, hookSrc, pageSrc].join("\n");

  it("does NOT import any `_post-ap-invoice-actions` / `_create-vendor-actions` server action", () => {
    expect(allSources).not.toMatch(/_post-ap-invoice-actions/);
    expect(allSources).not.toMatch(/_create-vendor-actions/);
    expect(allSources).not.toMatch(/_create-vendor-and-post-actions/);
    expect(allSources).not.toMatch(/postApInvoiceAction/);
    expect(allSources).not.toMatch(/createVendorAction/);
  });

  it("does NOT import the real-data detail reader / view-model", () => {
    expect(allSources).not.toMatch(/loadWorkIntakeDetail/);
    expect(allSources).not.toMatch(/toRealReviewData/);
    expect(allSources).not.toMatch(/review-detail-view-model/);
  });

  it("does NOT import the production `WorkIntakeReviewReal` component", () => {
    // Audit-trail comments may mention the production component by
    // name; only an actual import or JSX reference is prohibited.
    // Line-start-anchored to ignore block-comment prose.
    expect(allSources).not.toMatch(/^import[^;\n]*WorkIntakeReviewReal/m);
    expect(allSources).not.toMatch(/<WorkIntakeReviewReal/);
  });

  it("prototype component imports the scene machine + playback hook ONLY", () => {
    expect(protoSrc).toMatch(/from "\.\/scenes"/);
    expect(protoSrc).toMatch(/from "\.\/useScenePlayback"/);
  });

  it("the \"use client\" directive is present on the prototype component (hook state is client-side)", () => {
    expect(protoSrc).toMatch(/"use client"/);
  });
});

describe("AP-MOTION-1 §C — Route isolation: production AP review path untouched", () => {
  it("the dedicated route file exists at the prototype path", () => {
    const pagePath = path.join(REPO, "src/app/app/admin/work-intake/review-prototype/page.tsx");
    expect(fs.existsSync(pagePath)).toBe(true);
  });

  it("the production review route (review/[id]) still exists and still mounts WorkIntakeReviewReal", () => {
    const prodPath = path.join(REPO, "src/app/app/admin/work-intake/review/[id]/page.tsx");
    expect(fs.existsSync(prodPath)).toBe(true);
    const src = fs.readFileSync(prodPath, "utf-8");
    expect(src).toMatch(/WorkIntakeReviewReal/);
  });

  it("the restored production WorkIntakeReviewReal has NO AP-UX-1a imports", () => {
    const real = fs.readFileSync(
      path.join(REPO, "src/components/work-intake/review/WorkIntakeReviewReal.tsx"),
      "utf-8",
    );
    expect(real).not.toMatch(/IntelligenceStrip/);
    expect(real).not.toMatch(/ExceptionNotice/);
  });
});

describe("AP-MOTION-1 §D — Playback controls contract", () => {
  it("Playback-hook module exposes play / pause / replay / next / prev / goTo", () => {
    const src = fs.readFileSync(
      path.join(REPO, "src/components/work-intake/review-prototype/useScenePlayback.ts"),
      "utf-8",
    );
    expect(src).toMatch(/\bplay\b/);
    expect(src).toMatch(/\bpause\b/);
    expect(src).toMatch(/\breplay\b/);
    expect(src).toMatch(/\bnext\b/);
    expect(src).toMatch(/\bprev\b/);
    expect(src).toMatch(/\bgoTo\b/);
  });
});

describe("AP-MOTION-1 §E — Motion vocabulary + reduced-motion safety", () => {
  const css = fs.readFileSync(path.join(REPO, "src/app/globals.css"), "utf-8");

  it("defines the field-level keyframes (populated / shimmer / attention pulse / doc flash / rail swap)", () => {
    expect(css).toMatch(/@keyframes ap-motion-populated/);
    expect(css).toMatch(/@keyframes ap-motion-shimmer/);
    expect(css).toMatch(/@keyframes ap-motion-attention-pulse/);
    expect(css).toMatch(/@keyframes ap-motion-doc-flash/);
    expect(css).toMatch(/@keyframes ap-motion-rail-swap/);
    expect(css).toMatch(/@keyframes ap-motion-stage-done-pop/);
    expect(css).toMatch(/@keyframes ap-motion-resolved-pop/);
  });

  it("prefers-reduced-motion suppresses every ap-motion-* animation", () => {
    const anchor = css.indexOf("@keyframes ap-motion-resolved-pop");
    expect(anchor).toBeGreaterThan(-1);
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)", anchor);
    expect(start).toBeGreaterThan(-1);
    const after = css.indexOf("/* ---------- Spectre intelligence rail", start);
    const scope = css.slice(start, after > start ? after : start + 3_000);
    expect(scope).toMatch(/\.ap-motion-field--processing/);
    expect(scope).toMatch(/\.ap-motion-field--populated/);
    expect(scope).toMatch(/\.ap-motion-field-attention-dot/);
    expect(scope).toMatch(/\.ap-motion-rail-swap/);
    expect(scope).toMatch(/\.ap-motion-popover/);
    expect(scope).toMatch(/animation: none !important/);
  });
});
