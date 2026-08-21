// HR-2C B3 (2026-08-20) — Employee Portal training source-contract.
//
// Pins the architectural invariants the founder called out for B3:
//   §5-6  progress writes go through the canonical B1 monotonic service
//   §8    quiz payload has no answer-key metadata
//   §10   client submits selectedOptionId only; server does all grading
//   §17   Home summary is derived from the canonical eligibility resolver
//   §21   employee-portal principal (never an admin Principal) drives
//         every read/write on `/employee/**`
//
// Live behaviour (video/quiz walk) is exercised by the Playwright
// spec + the B1 behavioural regression already merged in B1.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * Strip line comments AND block comments so `expect(x).not.toMatch(/isCorrect/)`
 * doesn't collide with docstrings that mention what the file MUST NOT do.
 */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const DASHBOARD = "src/app/employee/(authed)/safety-training/page.tsx";
const COURSE_PAGE = "src/app/employee/(authed)/safety-training/[versionId]/page.tsx";
const PLAYER = "src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx";
const ACTIONS = "src/app/employee/(authed)/safety-training/_actions.ts";
const HOME = "src/app/employee/(authed)/page.tsx";

describe("HR-2C B3 · employee-portal training source-contract", () => {
  // raw source for permissive presence-checks
  const dashboardRaw = src(DASHBOARD);
  const coursePageRaw = src(COURSE_PAGE);
  const playerRaw = src(PLAYER);
  const actionsRaw = src(ACTIONS);
  const homeRaw = src(HOME);
  // comment-stripped source for forbidden-string checks
  const dashboard = code(DASHBOARD);
  const coursePage = code(COURSE_PAGE);
  const player = code(PLAYER);
  const actions = code(ACTIONS);
  const home = code(HOME);

  it("dashboard reads the canonical eligibility resolver (no ad-hoc joins)", () => {
    expect(dashboardRaw).toMatch(/resolveEmployeeSchedulingEligibility\(\s*principal\.employeeId/);
    // Never crawls prisma directly for training data.
    expect(dashboard).not.toMatch(/prisma\.training/);
    // Never surfaces isCorrect anywhere (comments stripped).
    expect(dashboard).not.toMatch(/isCorrect/);
  });

  it("dashboard guards on the employee-portal principal, never an admin Principal (§21)", () => {
    expect(dashboardRaw).toMatch(/getEmployeePortalPrincipal/);
    expect(dashboard).not.toMatch(/getCurrentPrincipal|from "@\/lib\/rbac"/);
  });

  it("course page uses the employee-safe view (§8, §27) and applicability gate (§16)", () => {
    expect(coursePageRaw).toMatch(/getEmployeeCourseView\(\s*principal\s*,\s*versionId/);
    expect(coursePageRaw).toMatch(/resolveApplicableCourses\(\s*principal\.employeeId/);
    // Never touches admin question models directly (no isCorrect read).
    expect(coursePage).not.toMatch(/isCorrect/);
    // Employee-portal principal only.
    expect(coursePageRaw).toMatch(/getEmployeePortalPrincipal/);
    expect(coursePage).not.toMatch(/getCurrentPrincipal/);
    // Same-shape 404 for inapplicable versions.
    expect(coursePageRaw).toMatch(/notFound\(\)/);
  });

  it("course page uses the canonical video threshold constant (§5, no local redefinition)", () => {
    expect(coursePageRaw).toMatch(/VIDEO_COMPLETION_THRESHOLD_PERCENT/);
    expect(coursePageRaw).toMatch(/from "@\/lib\/hr\/training\/attempts"/);
    // Player must NOT redefine the threshold constant — it must be
    // passed in as a prop.
    expect(player).not.toMatch(/const\s+VIDEO_COMPLETION_THRESHOLD_PERCENT/);
    // Player must render lock/unlock decisions off the prop.
    expect(playerRaw).toMatch(/thresholdPercent/);
  });

  it("player renders the video from the private same-origin proxy (§4, never a storage key)", () => {
    expect(playerRaw).toMatch(/\/api\/hr\/training\/versions\/\$\{encodeURIComponent\(versionId\)\}\/video/);
    expect(player).not.toMatch(/storageKey|videoStorageKey|r2\.|amazonaws|signedUrl/i);
  });

  it("player never surfaces isCorrect / correctAnswer / scoreKey / wasCorrect (§8, §10) — comments stripped", () => {
    for (const s of [player, coursePage, dashboard]) {
      expect(s).not.toMatch(/isCorrect|correctAnswer|scoreKey|wasCorrect/);
    }
  });

  it("player submits only selectedOptionId; grading result is server-computed (§10)", () => {
    // The payload builder maps to { questionId, selectedOptionId }
    // (whitespace-tolerant match).
    expect(playerRaw).toMatch(
      /questionId:\s*q\.id\s*,\s*selectedOptionId:\s*answers\[q\.id\]!/,
    );
    // No `passed` / `score` / `wasCorrect` are constructed client-side
    // and posted.
    const clientGradedRegex = /answers\.push\({[^}]*\b(passed|score|wasCorrect)\b/;
    expect(player).not.toMatch(clientGradedRegex);
  });

  it("player progress reporter is bounded (§6 — no unbounded per-timeupdate POST)", () => {
    // Threshold constant used to debounce reports.
    expect(playerRaw).toMatch(/REPORT_INTERVAL_SECONDS/);
    // Report is fired on pause / ended / pagehide for reliability.
    expect(playerRaw).toMatch(/onPause/);
    expect(playerRaw).toMatch(/onEnded/);
    expect(playerRaw).toMatch(/pagehide/);
    // Seek-jump guard: dt bounded so a huge jump doesn't credit
    // watch time (§5 no cheat).
    expect(playerRaw).toMatch(/MAX_DT_PER_TICK/);
  });

  it("server actions delegate to the canonical B1 attempt service (no direct prisma writes)", () => {
    expect(actionsRaw).toMatch(/from "@\/lib\/hr\/training\/attempts"/);
    for (const fn of ["recordVideoProgress", "startAttempt", "submitAttempt"]) {
      expect(actionsRaw).toContain(fn);
    }
    expect(actions).not.toMatch(
      /prisma\.training(Attempt|Progress|Completion|QuestionResponse)\.(create|update|upsert|delete|deleteMany|updateMany)/,
    );
    // Never returns / trusts a browser-provided score / passed / wasCorrect.
    const clientTrustRegex = /\b(passed|score|wasCorrect)\s*:\s*(input|args|body|data|answers)\b/;
    expect(actions).not.toMatch(clientTrustRegex);
  });

  it("server actions require the employee-portal principal (§21)", () => {
    expect(actionsRaw).toMatch(/getEmployeePortalPrincipal/);
    expect(actions).not.toMatch(/getCurrentPrincipal/);
  });

  it("server actions strip untrusted fields from the submitted answer payload (defence in depth)", () => {
    // Verify the shape-coercion step exists — the map body keeps only
    // questionId + selectedOptionId, dropping any other fields the
    // browser might have tried to slip in.
    expect(actionsRaw).toMatch(
      /questionId:\s*a\.questionId\s*,\s*selectedOptionId:\s*a\.selectedOptionId/,
    );
  });

  it("Home summary is restrained + non-gating; count comes from canonical resolver (§17)", () => {
    expect(homeRaw).toMatch(/resolveEmployeeSchedulingEligibility/);
    // Renders count only if outstanding > 0.
    expect(homeRaw).toMatch(/outstandingTraining\.length > 0/);
    // Home does NOT gate any navigation or hide any surface — the
    // scheduling/availability compliance gate is B4, not B3.
    expect(home).not.toMatch(/redirect\([^)]*safety-training/);
    // Testid so Playwright can prove the summary appears.
    expect(homeRaw).toMatch(/data-testid="portal-home-training-summary"/);
    expect(homeRaw).toMatch(/data-testid="portal-home-training-count"/);
  });

  it("sidebar tour anchor points at the real dashboard (§18)", () => {
    const nav = src("src/components/sidebar-nav-data.ts");
    // The Safety & Training entry sits in EMPLOYEE_NAV with the tour
    // target 'training'.
    expect(nav).toMatch(/href: "\/employee\/safety-training"[\s\S]{0,120}tourTarget: "training"/);
    // The dashboard file still owns the testid the sidebar link
    // effectively hands off to.
    expect(dashboardRaw).toMatch(/data-testid="portal-safety-training"/);
  });
});
