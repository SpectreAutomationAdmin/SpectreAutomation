// HR-1 admin-workflows — canonical onboarding-question resolver.
//
// Behaviours locked here:
//   - resolveEffectiveQuestions(clubA) merges globals + club-A rows;
//     club-A wins by shared `key`.
//   - Ordering is stable: by displayOrder ASC, then key ASC.
//   - Global writes (`clubId: null`) require BOTH the capability AND
//     super-admin. Non-super-admin callers are rejected before the
//     DB write.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import {
  resolveEffectiveQuestions,
  upsertOnboardingQuestion,
} from "@/lib/hr/onboarding-questions";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "./_helpers";

describe("HR admin-workflows · onboarding questions resolver", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("resolveEffectiveQuestions merges globals + club rows; club overrides on shared key", async () => {
    const fx = await makeAdminHrFixture();

    // Seed one global + one club-specific with different keys, plus
    // one shared key where the club version overrides the global.
    await upsertOnboardingQuestion(fx.superAdmin, {
      clubId: null,
      key: "contact.mobile_phone",
      section: "contact",
      prompt: "GLOBAL — What is your mobile phone?",
      answerKind: "PHONE",
      displayOrder: 10,
      required: true,
    });
    await upsertOnboardingQuestion(fx.superAdmin, {
      clubId: null,
      key: "contact.emergency_name",
      section: "contact",
      prompt: "GLOBAL — Emergency contact name",
      answerKind: "TEXT",
      displayOrder: 20,
    });
    // Club override: same key as the first global.
    await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id,
      key: "contact.mobile_phone",
      section: "contact",
      prompt: "CLUB — Preferred mobile phone (SMS-capable)",
      answerKind: "PHONE",
      displayOrder: 10,
      required: false,
    });
    // Club-only extra.
    await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id,
      key: "club.locker_number_preference",
      section: "misc",
      prompt: "CLUB — Preferred locker number?",
      answerKind: "TEXT",
      displayOrder: 30,
    });

    const rows = await resolveEffectiveQuestions(fx.club.id);
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Merged key comes from the CLUB row.
    const mobilePhone = byKey.get("contact.mobile_phone");
    expect(mobilePhone?.prompt.startsWith("CLUB")).toBe(true);
    expect(mobilePhone?.isClubOverride).toBe(true);
    expect(mobilePhone?.required).toBe(false); // club version's required flag wins

    // Global-only key survives.
    const emergencyName = byKey.get("contact.emergency_name");
    expect(emergencyName?.prompt.startsWith("GLOBAL")).toBe(true);
    expect(emergencyName?.isClubOverride).toBe(false);

    // Club-only key survives.
    expect(byKey.has("club.locker_number_preference")).toBe(true);

    // Order — displayOrder ascending. Contact.mobile_phone (10)
    // < contact.emergency_name (20) < club.locker_number_preference (30).
    expect(rows.map((r) => r.key)).toEqual([
      "contact.mobile_phone",
      "contact.emergency_name",
      "club.locker_number_preference",
    ]);
  });

  it("resolveEffectiveQuestions returns club-A-scoped rows and never leaks club-B rows", async () => {
    const fx = await makeAdminHrFixture();
    // Foreign-club admin writes a question specific to their club.
    await upsertOnboardingQuestion(fx.foreignClubAdmin, {
      clubId: fx.foreignClub.id,
      key: "foreign.only",
      section: "misc",
      prompt: "Foreign-club only",
      answerKind: "TEXT",
    });
    const primaryRows = await resolveEffectiveQuestions(fx.club.id);
    expect(primaryRows.find((r) => r.key === "foreign.only")).toBeUndefined();
  });

  it("upsertOnboardingQuestion({clubId:null}) REJECTS a non-super-admin caller (BEFORE any DB write)", async () => {
    const fx = await makeAdminHrFixture();
    await expect(
      upsertOnboardingQuestion(fx.clubAdmin, {
        clubId: null,
        key: "global.attempt",
        section: "misc",
        prompt: "Attempting a global write from a CLUB_ADMIN",
        answerKind: "TEXT",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Verify no row was written.
    const rows = await resolveEffectiveQuestions(fx.club.id);
    expect(rows.find((r) => r.key === "global.attempt")).toBeUndefined();
  });

  it("upsertOnboardingQuestion({clubId:null}) accepted for super-admin", async () => {
    const fx = await makeAdminHrFixture();
    const created = await upsertOnboardingQuestion(fx.superAdmin, {
      clubId: null,
      key: "global.ok",
      section: "misc",
      prompt: "Global-scope question set by super-admin",
      answerKind: "TEXT",
      displayOrder: 100,
    });
    expect(created.clubId).toBeNull();
    const rows = await resolveEffectiveQuestions(fx.club.id);
    expect(rows.find((r) => r.key === "global.ok")).toBeDefined();
  });

  it("upsertOnboardingQuestion updates an existing row instead of inserting a duplicate", async () => {
    const fx = await makeAdminHrFixture();
    const first = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "dup.key",
      section: "misc", prompt: "First", answerKind: "TEXT",
    });
    const second = await upsertOnboardingQuestion(fx.clubAdmin, {
      clubId: fx.club.id, key: "dup.key",
      section: "misc", prompt: "Second", answerKind: "TEXT",
    });
    expect(second.id).toBe(first.id);
    expect(second.prompt).toBe("Second");
  });
});
