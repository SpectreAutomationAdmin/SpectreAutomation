// HR-2B.3.1 (2026-08-18) — Regression pin for the founder's SIN-entry
// staging crash.
//
// Next.js 14 (App Router, strict-cookies mode) FORBIDS calls to
// `cookies().set(...)` or `cookies().delete(...)` inside any code that
// runs during a server component render — `page.tsx` and `layout.tsx`
// server components, plus anything they synchronously reach. The
// server runtime throws
//
//   Error: Cookies can only be modified in a Server Action or Route Handler.
//
// which propagates as a 500 to the browser. This crashed the
// founder's live payroll SIN entry because
// `src/app/hr/onboarding/payroll/layout.tsx` was doing a
// read-and-delete pattern on an "error banner" cookie during render.
//
// This test is a SOURCE-LEVEL PIN. It walks every server component in
// the HR onboarding tree (`page.tsx` + `layout.tsx` under
// `src/app/hr/onboarding/**`), scans for the forbidden call shapes,
// and fails loudly if any of them reappear.
//
// Server actions ("use server" files under the same tree) and route
// handlers are EXPLICITLY exempt — they legitimately set + delete
// cookies. The scanner recognises them by the leading `"use server"`
// directive.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ONBOARDING_ROOT = path.join(process.cwd(), "src", "app", "hr", "onboarding");

// Forbidden shapes anywhere inside a server component render path.
// Written as regex against source text — this test intentionally does
// not parse TypeScript; a substring match is the correct fidelity.
const FORBIDDEN = [
  /\bcookies\(\)\.set\s*\(/,
  /\bcookies\(\)\.delete\s*\(/,
  /\bcookieStore\.set\s*\(/,
  /\bcookieStore\.delete\s*\(/,
];

function isServerComponentFile(filePath: string): boolean {
  const base = path.basename(filePath);
  // Only page.tsx + layout.tsx are the server-render entry points that
  // trigger the strict-cookies rule. Client components and server
  // actions are exempt (server actions carry the "use server" directive).
  if (base !== "page.tsx" && base !== "layout.tsx") return false;
  const text = fs.readFileSync(filePath, "utf8");
  // Server actions are FILE-level "use server" directives (top of file).
  // A page.tsx / layout.tsx that begins with "use server" is a server
  // action file, not a server component render — exempt.
  const first200 = text.slice(0, 200);
  if (/^["']use server["']/m.test(first200)) return false;
  // Client components are "use client" — exempt (they don't touch cookies).
  if (/^["']use client["']/m.test(first200)) return false;
  return true;
}

function walk(dir: string, hits: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, hits);
    } else if (entry.isFile() && (entry.name === "page.tsx" || entry.name === "layout.tsx")) {
      hits.push(full);
    }
  }
  return hits;
}

describe("HR onboarding server components must not mutate cookies during render", () => {
  it("scans every page.tsx / layout.tsx under src/app/hr/onboarding/** and confirms no cookies().set/delete or cookieStore.set/delete calls", () => {
    const files = walk(ONBOARDING_ROOT, []).filter(isServerComponentFile);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) {
          const rel = path.relative(process.cwd(), file);
          violations.push(`${rel} matched forbidden pattern ${pattern}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} illegal cookie mutation(s) in HR onboarding server components:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\nNext.js 14 forbids cookies().set/delete inside a server-component render. " +
          "Move the mutation into a server action or route handler; if you need to " +
          "surface a one-shot error to the user, redirect with `?err=<safeMessage>` " +
          "and use the OnboardingStepErrorFromSearchParam client component to render it. " +
          "See HR-2B.3.1 checkpoint for the pattern.",
      );
    }
    expect(violations).toEqual([]);
  });
});
