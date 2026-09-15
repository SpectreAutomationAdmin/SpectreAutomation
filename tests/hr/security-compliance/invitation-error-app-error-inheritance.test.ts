// 2026-09-14 — HR onboarding invitation crash regression.
//
// Root cause of the "Begin onboarding" 500 (Fly digest 3544159346):
// `InvitationRevokedError` extended plain `Error`, so the
// /hr/onboarding/[token] server action's `isAppError(err)` gate
// didn't catch it. When the self-start route issued an invitation
// against an employee with no `EmployeeOnboardingSession` row, the
// welcome-page redemption path threw InvitationRevokedError,
// isAppError returned false, the catch re-threw, and Next.js
// surfaced a 500 to the browser.
//
// This test proves the DEFENSIVE half of the fix: every
// Invitation*Error now extends `AppError`, so any future variant of
// the same crash degrades to a graceful `?err=<safe>` banner
// instead of a page-level 500.
//
// The PRIMARY half of the fix (self-start creating a
// DRAFT session before issuing) is exercised end-to-end via the
// Playwright staging acceptance spec — it can't be unit-tested
// against a Next.js server component without a live server.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  issueInvitation,
  acquireInvitationContext,
  InvitationNotFoundError,
  InvitationExpiredError,
  InvitationRevokedError,
  InvitationAlreadyRedeemedError,
} from "@/lib/hr/invitations";
import { AppError, isAppError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("127.0.0.1|salt", "utf8").digest("hex");

describe("HR invitation errors — AppError inheritance (crash regression)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("InvitationNotFoundError extends AppError with a safe message", () => {
    const e = new InvitationNotFoundError();
    expect(e).toBeInstanceOf(AppError);
    expect(isAppError(e)).toBe(true);
    expect(e.code).toBe("INVITATION_NOT_FOUND");
    expect(e.httpStatus).toBe(404);
    expect(typeof e.safeMessage).toBe("string");
    expect(e.safeMessage.length).toBeGreaterThan(0);
    // The safe message must never leak internal detail — it's user-
    // facing copy shown as a `?err=` banner. Assert it doesn't
    // contain the raw internal name.
    expect(e.safeMessage.toLowerCase()).not.toContain("not found");
  });

  it("InvitationExpiredError extends AppError with a safe message", () => {
    const e = new InvitationExpiredError();
    expect(e).toBeInstanceOf(AppError);
    expect(isAppError(e)).toBe(true);
    expect(e.code).toBe("INVITATION_EXPIRED");
    expect(e.httpStatus).toBe(410);
  });

  it("InvitationRevokedError extends AppError with a safe message", () => {
    const e = new InvitationRevokedError();
    expect(e).toBeInstanceOf(AppError);
    expect(isAppError(e)).toBe(true);
    expect(e.code).toBe("INVITATION_REVOKED");
    expect(e.httpStatus).toBe(410);
  });

  it("InvitationAlreadyRedeemedError extends AppError with a safe message", () => {
    const e = new InvitationAlreadyRedeemedError();
    expect(e).toBeInstanceOf(AppError);
    expect(isAppError(e)).toBe(true);
    expect(e.code).toBe("INVITATION_ALREADY_REDEEMED");
    expect(e.httpStatus).toBe(409);
  });

  // Reproduces the Chris staging scenario:
  //   Invitation issued via self-start, but no EmployeeOnboardingSession
  //   exists → acquireInvitationContext throws InvitationRevokedError.
  // Before the fix this would surface as a 500. After the fix, the
  // thrown error is an AppError and the server action's
  // `isAppError(err) ? redirect(errRedirectUrl(...)) : throw` gate
  // catches it → graceful `?err=<safeMessage>` banner.
  it("acquireInvitationContext with NO session throws an AppError-descended InvitationRevokedError", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    // Issue an invitation. Note: makeHrFixture does NOT create a
    // session — that mirrors the pre-fix self-start bug exactly.
    const { rawToken } = await issueInvitation(clubAdmin, employee.id);

    // Confirm precondition: no session for this employee.
    const priorSession = await prisma.employeeOnboardingSession.findFirst({
      where: { employeeId: employee.id, clubId: employee.clubId },
    });
    expect(priorSession).toBeNull();

    // The error is thrown AND is an AppError. This is the assertion
    // that would have failed before today's fix — the pre-fix class
    // extended plain Error, and `isAppError` returned false.
    await expect(
      acquireInvitationContext(rawToken, { ipHash: IP_HASH }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof InvitationRevokedError &&
        isAppError(err) &&
        typeof (err as AppError).safeMessage === "string" &&
        (err as AppError).safeMessage.length > 0
      );
    });
  });
});
