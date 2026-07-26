// Admin → Club Settings — service contract + tenant isolation + monthly
// reporting integration.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeClub, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  getClubProfile,
  upsertClubProfile,
  readClubProfile,
  getFiscalPeriodForClub,
} from "@/lib/clubs/profile";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getMonthlyReportingPackage } from "@/lib/reporting/monthly-package";

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

async function makeClubAdmin(clubId: string, suffix = "") {
  const email = `cs-admin-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

// ===========================================================================
// CRUD
// ===========================================================================
describe("Club Settings — basic CRUD", () => {
  it("getClubProfile returns null on first visit", async () => {
    const club = await bootstrapAPClub("Profile Empty Club");
    const admin = await makeClubAdmin(club.id, "empty");
    expect(await getClubProfile(admin, club.id)).toBeNull();
  });

  it("upsertClubProfile creates a row + audits + getClubProfile returns it", async () => {
    const club = await bootstrapAPClub("Profile Create Club");
    const admin = await makeClubAdmin(club.id, "create");

    const saved = await upsertClubProfile(admin, club.id, {
      legalName: "Silver Springs Golf & Country Club Inc.",
      operatingName: "Silver Springs",
      yearFounded: 1962,
      fiscalYearEndMonth: 6,
      fiscalYearEndDay: 30,
      defaultCurrency: "CAD",
      gstStatus: "REGISTERED",
      gstFilingFrequency: "QUARTERLY",
      defaultGstRatePct: "5",
      generalEmail: "info@silversprings.club",
      websiteUrl: "silversprings.club",   // bare domain — schema auto-prefixes https://
    });

    expect(saved.clubId).toBe(club.id);
    expect(saved.fiscalYearEndMonth).toBe(6);
    expect(saved.fiscalYearEndDay).toBe(30);
    // bare domain → https:// auto-prefixed
    expect(saved.websiteUrl).toBe("https://silversprings.club");

    const audit = await db().auditLog.findFirst({
      where: { clubId: club.id, action: "club-profile.create" },
    });
    expect(audit).not.toBeNull();

    const read = await getClubProfile(admin, club.id);
    expect(read?.id).toBe(saved.id);
  });

  it("upsertClubProfile updates an existing row (action: update, not create)", async () => {
    const club = await bootstrapAPClub("Profile Update Club");
    const admin = await makeClubAdmin(club.id, "upd");
    await upsertClubProfile(admin, club.id, { legalName: "Old name" });
    await upsertClubProfile(admin, club.id, { legalName: "New name" });

    const row = await readClubProfile(club.id);
    expect(row?.legalName).toBe("New name");

    const updateAudits = await db().auditLog.count({
      where: { clubId: club.id, action: "club-profile.update" },
    });
    expect(updateAudits).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Tenant isolation
// ===========================================================================
describe("Club Settings — tenant isolation", () => {
  it("a club A admin cannot READ club B's profile", async () => {
    const a = await bootstrapAPClub("Iso A Read");
    const b = await bootstrapAPClub("Iso B Read");
    const adminA = await makeClubAdmin(a.id, "isoARead");
    // Seed a profile for B with adminB
    const adminB = await makeClubAdmin(b.id, "isoBRead");
    await upsertClubProfile(adminB, b.id, { legalName: "Club B only" });

    await expect(getClubProfile(adminA, b.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a club A admin cannot WRITE to club B's profile", async () => {
    const a = await bootstrapAPClub("Iso A Write");
    const b = await bootstrapAPClub("Iso B Write");
    const adminA = await makeClubAdmin(a.id, "isoAWrite");

    await expect(
      upsertClubProfile(adminA, b.id, { legalName: "Sneaky write" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cross-club account ids are REJECTED with ValidationError naming the field", async () => {
    const a = await bootstrapAPClub("Iso A Acct");
    const b = await makeClub("Iso B Acct");
    // Find an account that belongs to club B (the bootstrap helper
    // seeds the default chart).
    const adminA = await makeClubAdmin(a.id, "isoAAcct");

    // Pick an account that belongs to A — pretending the bad actor
    // tried to set the foreign club's id; we use any string that is
    // not owned by A to demonstrate the rejection.
    const fakeAcctId = `fake-not-in-club-a-${b.id}`;

    try {
      await upsertClubProfile(adminA, a.id, {
        defaultArAccountId: fakeAcctId,
      });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues[0].path).toBe("defaultArAccountId");
      expect((err as ValidationError).issues[0].message).toMatch(/does not belong to this club/);
    }
  });

  it("a same-club account is ACCEPTED (positive control)", async () => {
    const club = await bootstrapAPClub("Iso Same Acct");
    const admin = await makeClubAdmin(club.id, "isoSameAcct");
    const acct = await db().account.findFirst({ where: { clubId: club.id } });
    expect(acct).not.toBeNull();
    const saved = await upsertClubProfile(admin, club.id, {
      defaultArAccountId: acct!.id,
    });
    expect(saved.defaultArAccountId).toBe(acct!.id);
  });
});

// ===========================================================================
// Validation
// ===========================================================================
describe("Club Settings — validation", () => {
  it("rejects an invalid email", async () => {
    const club = await bootstrapAPClub("Val Email");
    const admin = await makeClubAdmin(club.id, "valEmail");
    try {
      await upsertClubProfile(admin, club.id, { generalEmail: "not-an-email" });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.path)).toContain("generalEmail");
    }
  });

  it("rejects a year founded in the future", async () => {
    const club = await bootstrapAPClub("Val Year");
    const admin = await makeClubAdmin(club.id, "valYear");
    const next = new Date().getUTCFullYear() + 5;
    try {
      await upsertClubProfile(admin, club.id, { yearFounded: next });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.path)).toContain("yearFounded");
    }
  });

  it("rejects an invalid URL (not auto-prefixable)", async () => {
    const club = await bootstrapAPClub("Val Url");
    const admin = await makeClubAdmin(club.id, "valUrl");
    try {
      await upsertClubProfile(admin, club.id, { websiteUrl: "::not a url::" });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.path)).toContain("websiteUrl");
    }
  });

  it("rejects an invalid fiscal year end (Feb 30)", async () => {
    const club = await bootstrapAPClub("Val Fye");
    const admin = await makeClubAdmin(club.id, "valFye");
    try {
      await upsertClubProfile(admin, club.id, {
        fiscalYearEndMonth: 2,
        fiscalYearEndDay: 30,
      });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.path)).toContain("fiscalYearEndDay");
    }
  });

  it("rejects a partial fiscal-year-end (one of two set)", async () => {
    const club = await bootstrapAPClub("Val Fye Partial");
    const admin = await makeClubAdmin(club.id, "valFyePartial");
    try {
      await upsertClubProfile(admin, club.id, {
        fiscalYearEndMonth: 6,
        // day intentionally missing
      });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.path)).toContain("fiscalYearEndDay");
    }
  });

  it("rejects a malformed Canadian GST number", async () => {
    const club = await bootstrapAPClub("Val Gst");
    const admin = await makeClubAdmin(club.id, "valGst");
    try {
      await upsertClubProfile(admin, club.id, { gstNumber: "ABC" });
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.path)).toContain("gstNumber");
    }
  });
});

// ===========================================================================
// getFiscalPeriodForClub — DB-backed wrapper around computeFiscalPeriod
// ===========================================================================
describe("getFiscalPeriodForClub", () => {
  const MAY_15_2026 = new Date(Date.UTC(2026, 4, 15));

  it("returns null when no profile is configured (fallback path)", async () => {
    const club = await bootstrapAPClub("FYE Missing");
    const r = await getFiscalPeriodForClub(club.id, MAY_15_2026);
    expect(r).toBeNull();
  });

  it("returns null when profile exists but fiscalYearEnd fields are not set", async () => {
    const club = await bootstrapAPClub("FYE Profile NoFye");
    const admin = await makeClubAdmin(club.id, "fyeProfileNoFye");
    await upsertClubProfile(admin, club.id, { legalName: "Just identity" });
    const r = await getFiscalPeriodForClub(club.id, MAY_15_2026);
    expect(r).toBeNull();
  });

  it("June 30 → period 11 of 12 for May 15, 2026", async () => {
    const club = await bootstrapAPClub("FYE Jun");
    const admin = await makeClubAdmin(club.id, "fyeJun");
    await upsertClubProfile(admin, club.id, { fiscalYearEndMonth: 6, fiscalYearEndDay: 30 });
    const r = await getFiscalPeriodForClub(club.id, MAY_15_2026);
    expect(r?.periodNumber).toBe(11);
    expect(r?.fiscalYearLabel).toBe("FY2026 (Jul-Jun)");
  });

  it("December 31 → period 5 of 12 for May 15, 2026", async () => {
    const club = await bootstrapAPClub("FYE Dec");
    const admin = await makeClubAdmin(club.id, "fyeDec");
    await upsertClubProfile(admin, club.id, { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
    const r = await getFiscalPeriodForClub(club.id, MAY_15_2026);
    expect(r?.periodNumber).toBe(5);
    expect(r?.fiscalYearLabel).toBe("FY2026 (Jan-Dec)");
  });

  it("January 31 → period 4 of 12 for May 15, 2026", async () => {
    const club = await bootstrapAPClub("FYE Jan");
    const admin = await makeClubAdmin(club.id, "fyeJan");
    await upsertClubProfile(admin, club.id, { fiscalYearEndMonth: 1, fiscalYearEndDay: 31 });
    const r = await getFiscalPeriodForClub(club.id, MAY_15_2026);
    expect(r?.periodNumber).toBe(4);
    expect(r?.fiscalYearLabel).toBe("FY2027 (Feb-Jan)");
  });
});

// ===========================================================================
// Monthly reporting integration — proves the fiscal-period helper flows
// through `getMonthlyReportingPackage` into the rendered header values.
// ===========================================================================
describe("Monthly reporting header consumes Club Settings", () => {
  it("default (no profile) → falls back to PERIOD-DERIVED labels, not a hardcoded May position", async () => {
    // 2026-06-26: the launcher now drives the package via the
    // supplied period. When a club has no fiscal-year-end config,
    // the package derives `fiscalYearLabel` + `ytdMonthsElapsed`
    // from the SUPPLIED period instead of hardcoding the historical
    // Silver Springs demo (FY2026 Jul-Jun, period 11) — that
    // hardcoded fallback was making EVERY selected period render
    // as May regardless of the URL.
    const club = await bootstrapAPClub("MR Default");
    const pkg = await getMonthlyReportingPackage(club.id);
    // Default period when no `period` opt is supplied is May 31, 2026.
    // Without fiscal config, calendar month is the period number.
    expect(pkg.period.fiscalYearLabel).toBe("FY2026");
    expect(pkg.period.ytdMonthsElapsed).toBe(5);
  });

  it("default (no profile) + supplied June 2026 → period 6, not the May fallback", async () => {
    const club = await bootstrapAPClub("MR Default Jun");
    const pkg = await getMonthlyReportingPackage(club.id, {
      period: {
        start: new Date(Date.UTC(2026, 5, 1)),
        end: new Date(Date.UTC(2026, 5, 30)),
      },
    });
    expect(pkg.period.fiscalYearLabel).toBe("FY2026");
    expect(pkg.period.ytdMonthsElapsed).toBe(6);
  });

  it("default (no profile) + supplied December 2026 → period 12, not 11", async () => {
    const club = await bootstrapAPClub("MR Default Dec");
    const pkg = await getMonthlyReportingPackage(club.id, {
      period: {
        start: new Date(Date.UTC(2026, 11, 1)),
        end: new Date(Date.UTC(2026, 11, 31)),
      },
    });
    expect(pkg.period.fiscalYearLabel).toBe("FY2026");
    expect(pkg.period.ytdMonthsElapsed).toBe(12);
  });

  it("default (no profile) + supplied January 2027 → period 1 + FY2027", async () => {
    const club = await bootstrapAPClub("MR Default Jan2027");
    const pkg = await getMonthlyReportingPackage(club.id, {
      period: {
        start: new Date(Date.UTC(2027, 0, 1)),
        end: new Date(Date.UTC(2027, 0, 31)),
      },
    });
    expect(pkg.period.fiscalYearLabel).toBe("FY2027");
    expect(pkg.period.ytdMonthsElapsed).toBe(1);
  });

  it("December 31 year-end → FY2026 (Jan-Dec), period 5", async () => {
    const club = await bootstrapAPClub("MR Dec");
    const admin = await makeClubAdmin(club.id, "mrDec");
    await upsertClubProfile(admin, club.id, { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.period.fiscalYearLabel).toBe("FY2026 (Jan-Dec)");
    expect(pkg.period.ytdMonthsElapsed).toBe(5);
  });

  it("January 31 year-end → FY2027 (Feb-Jan), period 4", async () => {
    const club = await bootstrapAPClub("MR Jan");
    const admin = await makeClubAdmin(club.id, "mrJan");
    await upsertClubProfile(admin, club.id, { fiscalYearEndMonth: 1, fiscalYearEndDay: 31 });
    const pkg = await getMonthlyReportingPackage(club.id);
    expect(pkg.period.fiscalYearLabel).toBe("FY2027 (Feb-Jan)");
    expect(pkg.period.ytdMonthsElapsed).toBe(4);
  });
});
