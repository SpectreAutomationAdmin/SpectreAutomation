// v399 Slice-1 hardening (2026-09-15) — DRAFT invitation reissue refusal.
//
// Root cause context (see src/lib/hr/invitations.ts reissueInvitation
// block comment): the earlier version of REISSUE_ELIGIBLE_STATES
// included "DRAFT", which meant a caller reaching for `reissueInvitation`
// on a DRAFT session would issue an invitation without moving the
// session out of DRAFT. That's the exact class of bug that produced
// Chris's Submit failure — the session stayed in DRAFT while the
// employee completed every section, and the final `IN_PROGRESS → SUBMITTED`
// transition then refused.
//
// This suite proves:
//   1. `reissueInvitation` on a DRAFT session throws ConflictError
//      with a specific steering message pointing at the canonical
//      `transitionSession(→ INVITED)` primitive.
//   2. The DRAFT session's state is UNCHANGED by the refusal — no
//      side effects.
//   3. NO EmployeeOnboardingInvitation row is created by the refusal
//      (no partial state leaks).
//   4. `reissueInvitation` on an INVITED session still works
//      (existing behavior preserved).
//   5. `reissueInvitation` on an IN_PROGRESS session still works
//      (existing behavior preserved).
//   6. Cross-caller sanity: any code path that today reaches
//      `reissueInvitation` with a DRAFT session cannot silently
//      succeed with an unadvanced state — the refusal catches it.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { reissueInvitation } from "@/lib/hr/invitations";
import { ConflictError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

describe("reissueInvitation — DRAFT session refusal (v399 followup hardening)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("refuses to reissue for a DRAFT session with a steering error", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const session = await createSession(clubAdmin, employee.id);
    expect(session.state).toBe("DRAFT");

    await expect(
      reissueInvitation(clubAdmin, employee.id),
    ).rejects.toBeInstanceOf(ConflictError);

    // Same call, unwrap the message and assert it steers the caller.
    let msg = "";
    try {
      await reissueInvitation(clubAdmin, employee.id);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/DRAFT session/);
    expect(msg).toMatch(/transitionSession/);
    expect(msg).toMatch(/INVITED/);
  });

  it("DRAFT session state is unchanged by the refusal (no side effects)", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const session = await createSession(clubAdmin, employee.id);

    try { await reissueInvitation(clubAdmin, employee.id); } catch {}

    const after = await prisma.employeeOnboardingSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.state).toBe("DRAFT");
    // Employee pointer also unchanged.
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
    expect(emp.onboardingState).toBe("DRAFT");
  });

  it("no invitation row is created by the refusal", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    await createSession(clubAdmin, employee.id);
    const before = await prisma.employeeOnboardingInvitation.count({
      where: { employeeId: employee.id },
    });
    expect(before).toBe(0);

    try { await reissueInvitation(clubAdmin, employee.id); } catch {}

    const after = await prisma.employeeOnboardingInvitation.count({
      where: { employeeId: employee.id },
    });
    expect(after).toBe(0);
  });

  it("INVITED session still accepts reissue (behavior preserved)", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const created = await createSession(clubAdmin, employee.id);
    // First invitation via canonical primitive.
    const firstInvite = await transitionSession(clubAdmin, created.id, "INVITED", {
      ttlHours: 24,
      actorSource: "STAFF",
    });
    const firstToken = firstInvite.invitation!.rawToken;

    // Now reissue — session stays INVITED, fresh token.
    const reissued = await reissueInvitation(clubAdmin, employee.id);
    expect(reissued.rawToken).not.toBe(firstToken);
    expect(reissued.sessionState).toBe("INVITED");
    expect(reissued.supersededInvitationId).toBeTruthy();

    const session = await prisma.employeeOnboardingSession.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(session.state).toBe("INVITED");
  });

  it("IN_PROGRESS session still accepts reissue (behavior preserved)", async () => {
    const { employee, clubAdmin } = await makeHrFixture();
    const created = await createSession(clubAdmin, employee.id);
    await transitionSession(clubAdmin, created.id, "INVITED", {
      ttlHours: 24,
      actorSource: "STAFF",
    });
    await transitionSession(clubAdmin, created.id, "IN_PROGRESS", {
      actorSource: "EMPLOYEE",
      actorEmployeeId: employee.id,
    });

    const reissued = await reissueInvitation(clubAdmin, employee.id);
    expect(reissued.sessionState).toBe("IN_PROGRESS");

    const session = await prisma.employeeOnboardingSession.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(session.state).toBe("IN_PROGRESS");
  });
});
