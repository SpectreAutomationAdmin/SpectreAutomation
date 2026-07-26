import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { TenantViolationError, ForbiddenError } from "@/lib/errors";
import {
  approveApplication,
  denyApplication,
  submitApplication,
  listApplications,
} from "@/lib/services/applications";
import { setMemberStatus } from "@/lib/services/members";
import { generateNoticeFromTemplate } from "@/lib/services/collections";
import {
  db,
  makeClub,
  makeMember,
  makeUser,
  resetDb,
  seedRbac,
  principalFor,
} from "./util/db";

describe("Tenant isolation — applications & members", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("an admin at club A cannot approve an application at club B", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "admin-a@example.com", role: "CLUB_ADMIN", clubId: clubA.id });
    const principal = await principalFor("admin-a@example.com");

    const applicantB = await submitApplication(clubB.id, {
      firstName: "Cross", lastName: "Tenant", email: "cross@example.com", consentCreditCheck: true, consentBackgroundCheck: true,
    });

    await expect(approveApplication(principal, applicantB.id)).rejects.toBeInstanceOf(TenantViolationError);

    // Verify state didn't change.
    const refreshed = await db().applicant.findUnique({ where: { id: applicantB.id } });
    expect(refreshed?.applicationStatus).toBe("SUBMITTED");
  });

  it("listApplications filters by tenant", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "admin-a@example.com", role: "CLUB_ADMIN", clubId: clubA.id });
    const principal = await principalFor("admin-a@example.com");

    await submitApplication(clubA.id, { firstName: "A", lastName: "1", email: "a1@example.com", consentCreditCheck: false, consentBackgroundCheck: false });
    await submitApplication(clubA.id, { firstName: "A", lastName: "2", email: "a2@example.com", consentCreditCheck: false, consentBackgroundCheck: false });
    await submitApplication(clubB.id, { firstName: "B", lastName: "1", email: "b1@example.com", consentCreditCheck: false, consentBackgroundCheck: false });

    const list = await listApplications(principal, clubA.id);
    expect(list.length).toBe(2);
    expect(list.every((a) => a.clubId === clubA.id)).toBe(true);

    // And cross-tenant list attempt is blocked.
    await expect(() => listApplications(principal, clubB.id)).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("a finance admin at club A cannot suspend a member at club B", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "fin-a@example.com", role: "FINANCE_ADMIN", clubId: clubA.id });
    const principal = await principalFor("fin-a@example.com");
    const memberB = await makeMember(clubB.id);

    await expect(setMemberStatus(principal, memberB.id, "SUSPENDED")).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("FINANCE_ADMIN does not have members:suspend even at their own club", async () => {
    // Demonstrates permission granularity. FINANCE_ADMIN has members:read
    // but not members:write or members:suspend.
    const club = await makeClub("Perm");
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const principal = await principalFor("fin@example.com");
    const member = await makeMember(club.id);

    await expect(setMemberStatus(principal, member.id, "SUSPENDED")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("SUPER_ADMIN can approve applications across any club", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "super@example.com", role: "SUPER_ADMIN", clubId: null });
    const principal = await principalFor("super@example.com");

    const applicantA = await submitApplication(clubA.id, {
      firstName: "S1", lastName: "S1", email: "s1@example.com", consentCreditCheck: false, consentBackgroundCheck: false,
    });
    const applicantB = await submitApplication(clubB.id, {
      firstName: "S2", lastName: "S2", email: "s2@example.com", consentCreditCheck: false, consentBackgroundCheck: false,
    });

    const r1 = await approveApplication(principal, applicantA.id);
    const r2 = await approveApplication(principal, applicantB.id);

    expect(r1.member.clubId).toBe(clubA.id);
    expect(r2.member.clubId).toBe(clubB.id);
  });

  it("CLUB_ADMIN at A can generate a notice for a member at A, but not at B", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "admin-a@example.com", role: "CLUB_ADMIN", clubId: clubA.id });
    const principal = await principalFor("admin-a@example.com");

    const memberA = await makeMember(clubA.id);
    const memberB = await makeMember(clubB.id);

    // Seed the OVER_30 template into each club used by this test.
    const { ensureClubCollectionsSeed } = await import("@/lib/services/collections");
    await ensureClubCollectionsSeed(clubA.id);
    await ensureClubCollectionsSeed(clubB.id);

    const notice = await generateNoticeFromTemplate(principal, memberA.id, "OVER_30");
    expect(notice.clubId).toBe(clubA.id);
    expect(notice.status).toBe("DRAFT");

    await expect(generateNoticeFromTemplate(principal, memberB.id, "OVER_30")).rejects.toBeInstanceOf(TenantViolationError);
  });
});

describe("Tenant isolation — denial reason", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  it("denyApplication rejects cross-tenant access", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "admin-a@example.com", role: "CLUB_ADMIN", clubId: clubA.id });
    const principal = await principalFor("admin-a@example.com");

    const a = await submitApplication(clubB.id, {
      firstName: "X", lastName: "Y", email: "xy@example.com", consentCreditCheck: false, consentBackgroundCheck: false,
    });
    await expect(denyApplication(principal, a.id, "no")).rejects.toBeInstanceOf(TenantViolationError);
  });
});
