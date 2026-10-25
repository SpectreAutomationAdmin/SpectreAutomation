// SIGNUP-2 Phase 2C (2026-10-25) -- Admin diagnostic contract tests.
//
// Pins the least-privilege, read-only, audited diagnostic surface
// per founder §7:
//   • Super-admin only (equivalent to platform:signups:read scope).
//   • Never surfaces registryPayloadJson (the raw adapter output).
//   • Every call is audited.
//   • Only tails of user ids / registration ids leak.
//   • Returns 401 on no session, 403 on non-super-admin, 404 on
//     unknown registration.
//   • Zero writes (read-only).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIAG = readFileSync(
  join(ROOT, "src/app/api/admin/signup-ops/registration/[id]/verification/route.ts"),
  "utf8",
);
const COMPLETE_PAGE = readFileSync(
  join(ROOT, "src/app/signup/t/[token]/authority/complete/page.tsx"),
  "utf8",
);

describe("SIGNUP-2 Phase 2C · admin diagnostic access gates", () => {
  it("401 unauthenticated → explicit JSON error", () => {
    expect(DIAG).toMatch(/if \(!principal\)/);
    expect(DIAG).toMatch(/"unauthenticated"/);
  });

  it("403 non-super-admin → explicit JSON error (least-privilege)", () => {
    expect(DIAG).toMatch(/if \(!isSuperAdmin\(principal\)\)/);
    expect(DIAG).toMatch(/"forbidden"/);
  });

  it("validates path parameter before DB read", () => {
    expect(DIAG).toMatch(/if \(!id \|\| typeof id !== "string" \|\| id\.length < 10\)/);
  });
});

describe("SIGNUP-2 Phase 2C · admin diagnostic never surfaces raw payload", () => {
  it("findFirst on EntityStandingCheck DOES NOT select registryPayloadJson", () => {
    const block = DIAG.match(/entityStandingCheck\.findFirst\({[\s\S]+?\}\);/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/registryPayloadJson:\s*true/);
    // Comment confirms the omission is deliberate.
    expect(block![0]).toMatch(/registryPayloadJson deliberately NOT selected/);
  });

  it("response body does NOT include registryPayloadJson", () => {
    const resp = DIAG.match(/return NextResponse\.json\({[\s\S]+?\}\);/)![0];
    expect(resp).not.toMatch(/registryPayloadJson/);
  });
});

describe("SIGNUP-2 Phase 2C · admin diagnostic audit emission", () => {
  it("calls audit() with signup.verification.diagnostic_read", () => {
    expect(DIAG).toMatch(/action:\s*"signup\.verification\.diagnostic_read"/);
  });

  it("audit meta uses tails only (no raw ids)", () => {
    const auditCall = DIAG.match(/action:\s*"signup\.verification\.diagnostic_read"[\s\S]+?\}\s*\);/)![0];
    expect(auditCall).toMatch(/registrationIdTail/);
    expect(auditCall).toMatch(/operatorUserIdTail/);
    // No raw ids outside the tail convention.
    expect(auditCall).not.toMatch(/principal\.id,/);
  });

  it("logger.info also uses tails only", () => {
    const logs = DIAG.match(/logger\.(?:info|warn|error)\([^)]*\)/g) ?? [];
    for (const l of logs) {
      expect(l).not.toMatch(/\btoken\b/i);
      expect(l).not.toMatch(/\bprincipal\.id\b/);
    }
  });
});

describe("SIGNUP-2 Phase 2C · admin diagnostic is read-only", () => {
  it("never writes to prisma", () => {
    expect(DIAG).not.toMatch(/prisma\.[a-z]+\.create/);
    expect(DIAG).not.toMatch(/prisma\.[a-z]+\.update/);
    expect(DIAG).not.toMatch(/prisma\.[a-z]+\.upsert/);
    expect(DIAG).not.toMatch(/prisma\.[a-z]+\.delete/);
    expect(DIAG).not.toMatch(/prisma\.[a-z]+\.updateMany/);
  });

  it("exposes only GET (no POST / PATCH / DELETE)", () => {
    expect(DIAG).toMatch(/export async function GET\(/);
    expect(DIAG).not.toMatch(/export async function POST\(/);
    expect(DIAG).not.toMatch(/export async function PATCH\(/);
    expect(DIAG).not.toMatch(/export async function DELETE\(/);
  });

  it("returns the three verification concepts separately (registration + attestation + standing-check)", () => {
    // The handler has multiple NextResponse.json(...) returns (401 /
    // 403 / 400 / 404); the SUCCESS one is the last and contains the
    // three top-level keys.  Match on content directly.
    expect(DIAG).toMatch(/registration:\s*{/);
    expect(DIAG).toMatch(/attestation:/);
    expect(DIAG).toMatch(/entityStandingCheck:/);
  });
});

describe("SIGNUP-2 Phase 2C · applicant-facing surface is feature-flagged", () => {
  it("authority/complete page reads SPECTRE_SIGNUP_2C_VERIFICATION_LIVE", () => {
    expect(COMPLETE_PAGE).toMatch(/process\.env\.SPECTRE_SIGNUP_2C_VERIFICATION_LIVE === "1"/);
  });

  it("defaults to the pre-2C copy when the flag is off (fail-closed)", () => {
    expect(COMPLETE_PAGE).toMatch(/const verificationLive =/);
    expect(COMPLETE_PAGE).toMatch(/verificationLive \? \(/);
  });

  it("renders four distinct verification states with stable test-ids", () => {
    expect(COMPLETE_PAGE).toMatch(/data-testid="signup-verification-pending"/);
    expect(COMPLETE_PAGE).toMatch(/data-testid="signup-verification-pass"/);
    expect(COMPLETE_PAGE).toMatch(/data-testid="signup-verification-hold"/);
    expect(COMPLETE_PAGE).toMatch(/data-testid="signup-verification-reject"/);
  });

  it("the hold copy does NOT disclose the hold-category classification", () => {
    const holdBlock = COMPLETE_PAGE.match(/data-testid="signup-verification-hold"[\s\S]+?<\/p>/)![0];
    // Hold copy must not leak internal signal names to the applicant.
    expect(holdBlock).not.toMatch(/ENTITY_VERIFICATION/);
    expect(holdBlock).not.toMatch(/SIGNING_AUTHORITY/);
    expect(holdBlock).not.toMatch(/CONFLICTING_EVIDENCE/);
    expect(holdBlock).not.toMatch(/INSUFFICIENT_EVIDENCE/);
    expect(holdBlock).not.toMatch(/SUSPECTED_IMPERSONATION/);
  });

  it("the reject copy routes to a neutral contact address, not an error page", () => {
    const rejectBlock = COMPLETE_PAGE.match(/data-testid="signup-verification-reject"[\s\S]+?<\/p>/)![0];
    expect(rejectBlock).toMatch(/mailto:hello@spectreautomation\.com/);
  });
});
