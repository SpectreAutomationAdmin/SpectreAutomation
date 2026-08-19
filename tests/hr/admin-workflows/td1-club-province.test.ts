// HR-2B.3.5 (2026-08-19) — TD1 federal / provincial action pinning.
//
// Founder invariants:
//   * A browser-supplied `province` in the FormData MUST be ignored.
//     The persisted EmployeeTaxProfile.province is the CLUB's payroll
//     province, resolved server-side. No employee override is ever
//     accepted.
//   * If the Club is unconfigured, the action DOES NOT persist a
//     tax profile row (fail-safe).
//   * Club A and Club B resolve independently.
//   * Existing TD1 effective-dating + form-version + KMS-encryption
//     behaviour of `submitSelfTaxProfile` is unchanged.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { TD1_FEDERAL_CURRENT } from "@/lib/hr/td1-forms";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "../security-compliance/_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

// The Server Actions module calls `redirect()` from `next/navigation`,
// which throws an internal Next error to unwind the request. In a
// vitest environment we intercept it so assertions can run after
// the action returns. Cookies are mocked away — the federal action
// stashes a short-lived cookie carrying the federal claim forward
// to the provincial step; that flow isn't under test here.
type RedirectCall = { url: string };
let redirectCalls: RedirectCall[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectCalls.push({ url });
    throw new Error(`__REDIRECT__:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

// The action calls `requireEmployeeOnboardingActor()` which reads the
// iron-session cookie via `next/headers`. Mock the resolver so we can
// install an actor per-test.
let currentActor: EmployeeOnboardingActor | null = null;
vi.mock("@/lib/hr/employee-actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hr/employee-actor")>();
  return {
    ...actual,
    requireEmployeeOnboardingActor: async () => {
      if (!currentActor) throw new actual.EmployeeOnboardingActorNotAuthenticatedError();
      return currentActor;
    },
    resolveEmployeeOnboardingActor: async () => currentActor,
  };
});

// eslint-disable-next-line import/first
import { saveFederalTd1Action } from "@/app/hr/onboarding/payroll/_actions";

async function actorForFixture(clubName: string): Promise<EmployeeOnboardingActor> {
  const { employee, clubAdmin } = await makeHrFixture(clubName);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  return {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: ctx.invitationId,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
}

function fdFederal(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("attestation", "1");
  fd.set("claim_mode", "basic");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

async function callAction(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<RedirectCall | null> {
  redirectCalls = [];
  try {
    await action(fd);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__REDIRECT__:")) throw e;
  }
  return redirectCalls[0] ?? null;
}

describe("HR-2B.3.5 · saveFederalTd1Action · province is Club-derived", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    redirectCalls = [];
    currentActor = null;
  });

  it("Club payrollProvince=AB → persists province=AB, ignores FormData province=ON", async () => {
    currentActor = await actorForFixture("Coulee-like AB");
    await prisma.club.update({
      where: { id: currentActor.clubId },
      data: { payrollProvince: "AB" },
    });

    const redirect = await callAction(saveFederalTd1Action, fdFederal({ province: "ON" }));
    expect(redirect?.url).toBe("/hr/onboarding/payroll/td1-provincial");

    const row = await prisma.employeeTaxProfile.findFirst({
      where: { employeeId: currentActor.employeeId },
      select: { province: true, td1FormVersion: true },
    });
    expect(row?.province).toBe("AB");
    // Federal step persists federal form version — the provincial
    // step later overwrites with the provincial form version.
    expect(row?.td1FormVersion).toBe(TD1_FEDERAL_CURRENT.version);
  });

  it("Malicious FormData with unsupported / bogus / all-caps values → still Club's AB", async () => {
    currentActor = await actorForFixture("Ignore Bogus");
    await prisma.club.update({
      where: { id: currentActor.clubId },
      data: { payrollProvince: "AB" },
    });

    for (const bogus of ["ON", "XX", "ALBERTA", "california", "", "  ", "on"]) {
      redirectCalls = [];
      // Wipe any prior persisted row so each attempt writes fresh.
      await prisma.employeeTaxProfile.deleteMany({
        where: { employeeId: currentActor.employeeId },
      });
      await callAction(saveFederalTd1Action, fdFederal({ province: bogus }));
      const row = await prisma.employeeTaxProfile.findFirst({
        where: { employeeId: currentActor.employeeId },
        select: { province: true },
      });
      expect(row?.province, `bogus="${bogus}" produced ${row?.province}`).toBe("AB");
    }
  });

  it("Club A (AB) and Club B (BC) resolve independently on the same call surface", async () => {
    const a = await actorForFixture("Independent A");
    const b = await actorForFixture("Independent B");
    await prisma.club.update({ where: { id: a.clubId }, data: { payrollProvince: "AB" } });
    await prisma.club.update({ where: { id: b.clubId }, data: { payrollProvince: "BC" } });

    currentActor = a;
    await callAction(saveFederalTd1Action, fdFederal({ province: "ON" }));
    currentActor = b;
    await callAction(saveFederalTd1Action, fdFederal({ province: "ON" }));

    const ra = await prisma.employeeTaxProfile.findFirst({
      where: { employeeId: a.employeeId }, select: { province: true },
    });
    const rb = await prisma.employeeTaxProfile.findFirst({
      where: { employeeId: b.employeeId }, select: { province: true },
    });
    expect(ra?.province).toBe("AB");
    expect(rb?.province).toBe("BC");
  });

  it("Unconfigured Club (null payrollProvince, no profile province) → redirects back, NO row persisted", async () => {
    currentActor = await actorForFixture("Unconfigured");
    await prisma.club.update({
      where: { id: currentActor.clubId },
      data: { payrollProvince: null },
    });
    // Also clear any profile fallback.
    const profile = await prisma.clubProfile.findFirst({
      where: { clubId: currentActor.clubId },
    });
    if (profile) {
      await prisma.clubProfile.update({
        where: { id: profile.id },
        data: { provinceState: null },
      });
    }

    const redirect = await callAction(saveFederalTd1Action, fdFederal({ province: "AB" }));
    // Redirect stays on the federal step — page renders neutral copy.
    expect(redirect?.url).toBe("/hr/onboarding/payroll/td1-federal");

    const row = await prisma.employeeTaxProfile.findFirst({
      where: { employeeId: currentActor.employeeId },
    });
    expect(row, "no tax profile row must be persisted when Club is unconfigured").toBeNull();
  });

  it("ClubProfile.provinceState='Alberta' fallback (payrollProvince null) → persists AB", async () => {
    currentActor = await actorForFixture("Fallback Path");
    await prisma.club.update({
      where: { id: currentActor.clubId },
      data: { payrollProvince: null },
    });
    const existing = await prisma.clubProfile.findFirst({
      where: { clubId: currentActor.clubId },
    });
    if (existing) {
      await prisma.clubProfile.update({
        where: { id: existing.id },
        data: { provinceState: "Alberta" },
      });
    } else {
      await prisma.clubProfile.create({
        data: { clubId: currentActor.clubId, provinceState: "Alberta" },
      });
    }

    await callAction(saveFederalTd1Action, fdFederal({ province: "ON" }));
    const row = await prisma.employeeTaxProfile.findFirst({
      where: { employeeId: currentActor.employeeId },
      select: { province: true },
    });
    expect(row?.province).toBe("AB");
  });

  it("KMS encryption + effective-dating invariants preserved (federalClaim ciphertext + Jan-1 anchor)", async () => {
    currentActor = await actorForFixture("Invariant Preserved");
    await prisma.club.update({
      where: { id: currentActor.clubId },
      data: { payrollProvince: "AB" },
    });

    await callAction(saveFederalTd1Action, fdFederal({ province: "ON" }));

    const row = await prisma.employeeTaxProfile.findFirst({
      where: { employeeId: currentActor.employeeId },
      select: {
        federalClaimSecretRef: true,
        provincialClaimSecretRef: true,
        additionalDeductionSecretRef: true,
        effectiveFrom: true,
      },
    });
    // Encrypted-secret pointers must be present, not the plaintext.
    expect(row?.federalClaimSecretRef).toBeTruthy();
    expect(row?.provincialClaimSecretRef).toBeTruthy();
    // The federal step doesn't ask for an additional deduction.
    expect(row?.additionalDeductionSecretRef).toBeNull();
    // effectiveFrom is anchored to Jan-1 of the current UTC year.
    const y = new Date().getUTCFullYear();
    expect(row?.effectiveFrom.toISOString()).toBe(new Date(Date.UTC(y, 0, 1)).toISOString());
  });
});
