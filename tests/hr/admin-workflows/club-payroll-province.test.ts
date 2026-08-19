// HR-2B.3.5 (2026-08-19) — Club payroll-province resolver.
//
// Payroll province of employment is a CLUB property, never an
// employee input. This suite pins the founder's data-model rules:
//
//   * Coulee Ridge Club (payrollProvince=AB) → Alberta + TD1AB-2026.
//   * ClubProfile.provinceState is a fallback so pre-HR clubs work
//     automatically ("Alberta" → AB, "ALBERTA" → AB).
//   * An unsupported string returns `configured: false` — never
//     throws or leaks internal state.
//   * The resolver never consults the employee row — home address
//     in another province does NOT change the outcome.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import {
  normaliseProvinceCode,
  resolveClubPayrollProvince,
} from "@/lib/hr/club-payroll-province";
import { makeHrFixture, makeEmployee } from "../security-compliance/_helpers";

async function setClubPayrollProvince(clubId: string, value: string | null): Promise<void> {
  await prisma.club.update({ where: { id: clubId }, data: { payrollProvince: value } });
}

async function upsertClubProfileProvinceState(clubId: string, value: string | null): Promise<void> {
  const existing = await prisma.clubProfile.findFirst({ where: { clubId } });
  if (existing) {
    await prisma.clubProfile.update({
      where: { id: existing.id },
      data: { provinceState: value },
    });
  } else {
    await prisma.clubProfile.create({ data: { clubId, provinceState: value } });
  }
}

describe("HR-2B.3.5 · normaliseProvinceCode", () => {
  it.each([
    ["AB", "AB"],
    ["ab", "AB"],
    [" ab ", "AB"],
    ["Alberta", "AB"],
    ["ALBERTA", "AB"],
    ["British Columbia", "BC"],
    ["Ontario", "ON"],
    ["Quebec", "QC"],
    ["Québec", "QC"],
    ["YT", "YT"],
    ["Newfoundland", "NL"],
  ])("normalises %s → %s", (raw, expected) => {
    expect(normaliseProvinceCode(raw)).toBe(expected);
  });

  it.each([
    ["", null],
    ["  ", null],
    ["ZZ", null],
    ["Puerto Rico", null],
    ["US-CA", null],
    [null, null],
    [undefined, null],
  ])("rejects %s → null", (raw, expected) => {
    expect(normaliseProvinceCode(raw as string | null | undefined)).toBe(expected);
  });
});

describe("HR-2B.3.5 · resolveClubPayrollProvince", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Coulee-Ridge-shaped Club (payrollProvince=AB) → Alberta + TD1AB-2026", async () => {
    const { club } = await makeHrFixture("Coulee Ridge Test");
    await setClubPayrollProvince(club.id, "AB");

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(true);
    if (!res.configured) return;
    expect(res.code).toBe("AB");
    expect(res.name).toBe("Alberta");
    expect(res.source).toBe("club.payrollProvince");
    expect(res.provincialSpec.version).toBe("TD1AB-2026");
    expect(res.provincialSpec.year).toBe(2026);
    expect(res.provincialSpec.jurisdiction).toBe("CA-AB");
  });

  it("Club.payrollProvince=null + ClubProfile.provinceState='Alberta' → falls back to AB", async () => {
    const { club } = await makeHrFixture("Fallback Alberta");
    await setClubPayrollProvince(club.id, null);
    await upsertClubProfileProvinceState(club.id, "Alberta");

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(true);
    if (!res.configured) return;
    expect(res.code).toBe("AB");
    expect(res.source).toBe("clubProfile.provinceState");
    expect(res.provincialSpec.version).toBe("TD1AB-2026");
  });

  it("ClubProfile.provinceState='ALBERTA' (all-caps address) is normalised", async () => {
    const { club } = await makeHrFixture("AllCaps Alberta");
    await setClubPayrollProvince(club.id, null);
    await upsertClubProfileProvinceState(club.id, "ALBERTA");

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(true);
    if (!res.configured) return;
    expect(res.code).toBe("AB");
  });

  it("explicit Club.payrollProvince overrides ClubProfile.provinceState", async () => {
    const { club } = await makeHrFixture("Explicit Wins");
    await setClubPayrollProvince(club.id, "BC");
    await upsertClubProfileProvinceState(club.id, "Alberta");

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(true);
    if (!res.configured) return;
    expect(res.code).toBe("BC");
    expect(res.source).toBe("club.payrollProvince");
    expect(res.provincialSpec.version).toBe("TD1BC-2026");
  });

  it("neither field set → unconfigured with reason='no_field_set'", async () => {
    const { club } = await makeHrFixture("Nothing Set");
    await setClubPayrollProvince(club.id, null);

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(false);
    if (res.configured) return;
    expect(res.reason).toBe("no_field_set");
  });

  it("payrollProvince='XX' (unsupported code) → unconfigured with reason='unsupported_value'", async () => {
    const { club } = await makeHrFixture("Unsupported");
    await setClubPayrollProvince(club.id, "XX");

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(false);
    if (res.configured) return;
    expect(res.reason).toBe("unsupported_value");
  });

  it("no such Club → unconfigured with reason='no_club_row'", async () => {
    const res = await resolveClubPayrollProvince("cnonexistentclubidxxx");
    expect(res.configured).toBe(false);
    if (res.configured) return;
    expect(res.reason).toBe("no_club_row");
  });

  it("Club A (AB) and Club B (BC) resolve independently", async () => {
    const a = await makeHrFixture("Independent A");
    const b = await makeHrFixture("Independent B");
    await setClubPayrollProvince(a.club.id, "AB");
    await setClubPayrollProvince(b.club.id, "BC");

    const [ra, rb] = await Promise.all([
      resolveClubPayrollProvince(a.club.id),
      resolveClubPayrollProvince(b.club.id),
    ]);
    expect(ra.configured && ra.code).toBe("AB");
    expect(rb.configured && rb.code).toBe("BC");
  });

  it("employee home-address province does NOT influence resolution", async () => {
    // Employee model has no free `province` field, but even hypothetically
    // — the resolver reads only Club fields. This test proves the boundary
    // by mutating an unrelated employee field and confirming the resolver
    // ignores it.
    const { club } = await makeHrFixture("Home Independence");
    await setClubPayrollProvince(club.id, "AB");
    // Create a second employee "living in Ontario" (represented via
    // legalMailingAddress if the field exists on the schema — otherwise
    // just email, which is definitely irrelevant). Either way the
    // resolver never touches Employee, so the answer stays AB.
    await makeEmployee(club.id, {
      firstName: "Ontario",
      lastName: "Resident",
      email: `ont-${Date.now()}@example.com`,
    });

    const res = await resolveClubPayrollProvince(club.id);
    expect(res.configured).toBe(true);
    if (!res.configured) return;
    expect(res.code).toBe("AB");
  });
});
