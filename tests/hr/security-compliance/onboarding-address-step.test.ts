// HR mobile-hotfix (2026-08-30) §1 — Address in Onboarding
// behavioural tests. Pins:
//   * updateOnboardingHomeAddress writes the row + audits without
//     leaking the plaintext street address into audit meta.
//   * empty street OR empty city refused with a ValidationError.
//   * ack row (kind=about_you_address_confirmation) written by
//     acknowledgeSelfAddressStep.
//   * continuation resolver: after Name + Contact acks, next step is
//     /about-you/address; after Address ack, next step is /employment.
//   * admin optional prefill: createEmployee + updateEmployee accept
//     homeAddress* fields and persist them.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createEmployee, updateEmployee } from "@/lib/hr/employees";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import {
  acknowledgeSelfAddressStep,
  acknowledgeSelfContactStep,
  acknowledgeSelfNameStep,
  getOnboardingHomeAddress,
  updateOnboardingHomeAddress,
} from "@/lib/hr/employee-self-service";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  ONBOARDING_CONTINUATION_URLS,
  resolveOnboardingContinuation,
} from "@/lib/hr/onboarding-continuation";
import { ValidationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");

async function actorForFixture(): Promise<{
  actor: EmployeeOnboardingActor;
  employeeId: string;
  clubId: string;
  clubAdmin: import("@/lib/rbac").Principal;
}> {
  const { employee, clubAdmin } = await makeHrFixture(`Address ${Math.random().toString(36).slice(2, 6)}`);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: ctx.invitationId,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
  return { actor, employeeId: employee.id, clubId: employee.clubId, clubAdmin };
}

describe("HR mobile-hotfix · §1 Address in onboarding — service behaviour", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("writes the six home address fields and audits presence-only meta", async () => {
    const { actor, employeeId } = await actorForFixture();
    await updateOnboardingHomeAddress(actor, {
      homeAddressLine1: "  123 Fairway Lane  ",
      homeAddressLine2: "Unit 4",
      homeCity: "Calgary",
      homeProvince: "ab",
      homePostalCode: "T2P 3H7",
      homeCountry: "ca",
    });

    const row = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        homeAddressLine1: true, homeAddressLine2: true, homeCity: true,
        homeProvince: true, homePostalCode: true, homeCountry: true,
      },
    });
    expect(row?.homeAddressLine1).toBe("123 Fairway Lane"); // trimmed
    expect(row?.homeAddressLine2).toBe("Unit 4");
    expect(row?.homeCity).toBe("Calgary");
    expect(row?.homeProvince).toBe("AB"); // uppercased
    expect(row?.homePostalCode).toBe("T2P 3H7");
    expect(row?.homeCountry).toBe("CA");

    // Audit should be written with the compact meta only.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.employee.self_service.home_address.update" },
      orderBy: { createdAt: "desc" },
      select: { beforeJson: true, afterJson: true },
    });
    expect(audit).not.toBeNull();
    const auditJson = `${audit?.beforeJson ?? ""}${audit?.afterJson ?? ""}`;
    // Street address (line1 / line2) MUST NOT appear in the audit.
    expect(auditJson).not.toContain("123 Fairway Lane");
    expect(auditJson).not.toContain("Unit 4");
    // City / province presence is expected.
    expect(auditJson).toMatch(/hadLine1/);
  });

  it("refuses empty street with a ValidationError (accidental Continue click)", async () => {
    const { actor } = await actorForFixture();
    await expect(updateOnboardingHomeAddress(actor, {
      homeAddressLine1: "",
      homeCity: "Calgary",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses empty city with a ValidationError", async () => {
    const { actor } = await actorForFixture();
    await expect(updateOnboardingHomeAddress(actor, {
      homeAddressLine1: "123 Fairway Lane",
      homeCity: "",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("acknowledgeSelfAddressStep persists an about_you_address_confirmation ack", async () => {
    const { actor } = await actorForFixture();
    await updateOnboardingHomeAddress(actor, {
      homeAddressLine1: "1 Green Way",
      homeCity: "Banff",
    });
    await acknowledgeSelfAddressStep(actor);
    const ack = await prisma.employeeOnboardingAcknowledgement.findFirst({
      where: {
        sessionId: actor.sessionId,
        kind: "about_you_address_confirmation",
      },
    });
    expect(ack).not.toBeNull();
  });

  it("getOnboardingHomeAddress returns the persisted values (for prefill)", async () => {
    const { actor } = await actorForFixture();
    await updateOnboardingHomeAddress(actor, {
      homeAddressLine1: "555 Ridge Rd", homeCity: "Cochrane",
      homeProvince: "AB", homePostalCode: "T4C 1B2",
    });
    const got = await getOnboardingHomeAddress(actor);
    expect(got.homeAddressLine1).toBe("555 Ridge Rd");
    expect(got.homeCity).toBe("Cochrane");
    expect(got.homeProvince).toBe("AB");
  });
});

describe("HR mobile-hotfix · §1 continuation resolver routes address between contact + employment", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("after Name+Contact acks and no Address ack, next URL is /about-you/address", async () => {
    const { actor } = await actorForFixture();
    await transitionSession(
      { id: "sys", email: null, roleKey: null, clubId: actor.clubId, name: null, employeeId: null } as any,
      actor.sessionId, "IN_PROGRESS", { actorSource: "EMPLOYEE" },
    ).catch(() => {}); // best-effort — the ack writers auto-transition
    await acknowledgeSelfNameStep(actor);
    await acknowledgeSelfContactStep(actor);

    const url = await resolveOnboardingContinuation({
      sessionId: actor.sessionId, employeeId: actor.employeeId, clubId: actor.clubId,
    });
    expect(url).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouAddress);
  });

  it("after Address ack, next URL is /about-you/employment", async () => {
    const { actor } = await actorForFixture();
    await acknowledgeSelfNameStep(actor);
    await acknowledgeSelfContactStep(actor);
    await updateOnboardingHomeAddress(actor, {
      homeAddressLine1: "77 Meadow", homeCity: "Cochrane",
    });
    await acknowledgeSelfAddressStep(actor);

    const url = await resolveOnboardingContinuation({
      sessionId: actor.sessionId, employeeId: actor.employeeId, clubId: actor.clubId,
    });
    expect(url).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouEmployment);
  });
});

describe("HR mobile-hotfix · §1 admin optional prefill", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("createEmployee accepts homeAddress* prefill fields and persists them", async () => {
    const { clubAdmin, clubId } = await actorForFixture();
    const created = await createEmployee(clubAdmin, clubId, {
      firstName: "Prefill",
      lastName: "Home",
      homeAddressLine1: "88 Elm",
      homeCity: "Airdrie",
      homeProvince: "ab",
      homePostalCode: "T4B 0G1",
      homeCountry: "ca",
    });
    const row = await prisma.employee.findUnique({
      where: { id: created.id },
      select: {
        homeAddressLine1: true, homeCity: true, homeProvince: true, homeCountry: true,
      },
    });
    expect(row?.homeAddressLine1).toBe("88 Elm");
    expect(row?.homeCity).toBe("Airdrie");
    expect(row?.homeProvince).toBe("AB");
    expect(row?.homeCountry).toBe("CA");
  });

  it("updateEmployee patches homeAddress* fields on an existing employee", async () => {
    const { clubAdmin, employeeId } = await actorForFixture();
    await updateEmployee(clubAdmin, employeeId, {
      homeAddressLine1: "42 Bow Ave",
      homeCity: "Banff",
      homeProvince: "AB",
    });
    const row = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { homeAddressLine1: true, homeCity: true, homeProvince: true },
    });
    expect(row?.homeAddressLine1).toBe("42 Bow Ave");
    expect(row?.homeCity).toBe("Banff");
    expect(row?.homeProvince).toBe("AB");
  });
});
