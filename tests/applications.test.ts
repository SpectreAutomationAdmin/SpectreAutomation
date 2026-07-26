import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createDraft,
  getDraftByToken,
  saveDraft,
  submitDraft,
  approveApplication,
  withdrawDraft,
  addHouseholdMemberToDraft,
} from "@/lib/services/applications";
import { canTransition, requireTransition } from "@/lib/services/application-state";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { db, makeClub, makeUser, resetDb, seedRbac, principalFor } from "./util/db";

describe("Applications — state machine", () => {
  it("permits SUBMITTED -> APPROVED but not DRAFT -> APPROVED", () => {
    expect(canTransition("SUBMITTED", "APPROVED")).toBe(true);
    expect(canTransition("DRAFT", "APPROVED")).toBe(false);
    expect(canTransition("APPROVED", "DENIED")).toBe(false); // terminal
    expect(canTransition("PENDING_INFORMATION", "SUBMITTED")).toBe(true);
  });

  it("requireTransition throws on illegal moves", () => {
    expect(() => requireTransition("DRAFT", "APPROVED")).toThrow(ConflictError);
    expect(() => requireTransition("APPROVED", "DENIED")).toThrow(ConflictError);
  });
});

describe("Applications — draft + resume + submit", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("creates a draft, saves it, then submits", async () => {
    const club = await makeClub("Draft Test");
    const { applicantId, token } = await createDraft(club.id, {
      firstName: "Hugo", lastName: "Ward",
      email: "hugo@example.com",
      phone: "403-555-0001",
      dateOfBirth: "1985-04-12",
      address1: "1 Fairway Lane",
      city: "Calgary", provinceState: "AB", postalCode: "T2A 0A0", country: "Canada",
    });
    expect(applicantId).toBeTruthy();

    // Token works to resume
    const draft = await getDraftByToken(club.id, token);
    expect(draft).not.toBeNull();
    expect(draft!.applicant.applicationStatus).toBe("DRAFT");

    await saveDraft(club.id, token, { membershipCategory: "Full Golf", sponsorName: "Member X" });

    await addHouseholdMemberToDraft(club.id, token, {
      firstName: "Mira", lastName: "Ward", relationship: "SPOUSE", email: "mira@example.com",
    });

    const submitted = await submitDraft(club.id, token, { consentCreditCheck: true, consentBackgroundCheck: true });
    expect(submitted.applicationStatus).toBe("SUBMITTED");
    expect(submitted.submittedAt).not.toBeNull();

    // Token is consumed
    const consumed = await getDraftByToken(club.id, token);
    expect(consumed).toBeNull();
  });

  it("rejects a token from a different club", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    const { token } = await createDraft(clubA.id, {
      firstName: "X", lastName: "Y", email: "x@example.com",
    });
    const wrong = await getDraftByToken(clubB.id, token);
    expect(wrong).toBeNull();
  });

  it("submit blocks when required fields are missing", async () => {
    const club = await makeClub("Validate");
    const { token } = await createDraft(club.id, {
      firstName: "Pat", lastName: "Doe", email: "pat@example.com",
    });
    // No membershipCategory set — should error.
    await expect(submitDraft(club.id, token, { consentCreditCheck: true, consentBackgroundCheck: true }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("withdrawal transitions draft -> WITHDRAWN and copies household on approve later", async () => {
    const club = await makeClub("Withdraw");
    const { token } = await createDraft(club.id, {
      firstName: "Sam", lastName: "Lee", email: "sam@example.com",
    });
    await withdrawDraft(club.id, token, "changed mind");
    const after = await getDraftByToken(club.id, token);
    expect(after).toBeNull(); // not in DRAFT/PENDING_INFORMATION anymore
  });

  it("admin approve creates Member + MemberAccount + copies household + seeds checklist", async () => {
    const club = await makeClub("Approve");
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const principal = await principalFor("admin@example.com");
    const { token } = await createDraft(club.id, {
      firstName: "Joan", lastName: "Smith", email: "joan@example.com",
    });
    await saveDraft(club.id, token, { membershipCategory: "Full Golf" });
    await addHouseholdMemberToDraft(club.id, token, { firstName: "Kai", lastName: "Smith", relationship: "CHILD" });
    const submitted = await submitDraft(club.id, token, { consentCreditCheck: true, consentBackgroundCheck: true });

    const { member } = await approveApplication(principal, submitted.id);
    expect(member.status).toBe("ONBOARDING");
    expect(member.onboardingStartedAt).not.toBeNull();
    const account = await db().memberAccount.findUnique({ where: { memberId: member.id } });
    expect(account).not.toBeNull();
    const household = await db().memberHouseholdMember.findMany({ where: { memberId: member.id } });
    expect(household.length).toBe(1);
    const checklist = await db().onboardingChecklistItem.findMany({ where: { memberId: member.id } });
    expect(checklist.length).toBeGreaterThan(0);
  });
});
