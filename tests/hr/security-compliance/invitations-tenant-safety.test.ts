// HR-1 security-compliance slice — invitation cross-tenant safety.
//
// The redeem path takes NO caller-supplied clubId. A leaked Club A
// token, no matter what surface it arrives on, resolves the
// invitation's OWN clubId + employeeId — it can never be used to
// mutate a different tenant.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import { issueInvitation, redeemInvitation } from "@/lib/hr/invitations";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("127.0.0.1|salt", "utf8").digest("hex");

describe("HR invitation redemption — cross-tenant boundary", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("redeemInvitation resolves clubId + employeeId from the invitation, not the caller", async () => {
    const a = await makeHrFixture("Club A");
    const b = await makeHrFixture("Club B");

    const { rawToken: aToken, invitationId: aInvId } = await issueInvitation(
      a.clubAdmin,
      a.employee.id,
    );

    const result = await redeemInvitation(aToken, { ipHash: IP_HASH });
    expect(result.invitationId).toBe(aInvId);
    // The returned clubId + employeeId are Club A's — even though the
    // fixture created Club B as well. The service exposes no
    // clubId-input parameter, so there's no way to spoof to Club B.
    expect(result.clubId).toBe(a.club.id);
    expect(result.employeeId).toBe(a.employee.id);
    expect(result.clubId).not.toBe(b.club.id);
    expect(result.employeeId).not.toBe(b.employee.id);
  });

  it("a Club-A invitation redeemed does NOT mutate Club-B invitations", async () => {
    const a = await makeHrFixture("Club A");
    const b = await makeHrFixture("Club B");
    const aIssue = await issueInvitation(a.clubAdmin, a.employee.id);
    const bIssue = await issueInvitation(b.clubAdmin, b.employee.id);

    await redeemInvitation(aIssue.rawToken, { ipHash: IP_HASH });

    // Club B's invitation is untouched.
    const bRow = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: bIssue.invitationId },
    });
    expect(bRow?.redeemedAt).toBeNull();
    expect(bRow?.clubId).toBe(b.club.id);
    expect(bRow?.employeeId).toBe(b.employee.id);
  });

  it("issueInvitation for a foreign-club employee is refused by tenant enforcement", async () => {
    const a = await makeHrFixture("Club A");
    const b = await makeHrFixture("Club B");
    // Club A's admin trying to issue an invitation for a Club B employee.
    await expect(issueInvitation(a.clubAdmin, b.employee.id)).rejects.toThrow();
  });
});
