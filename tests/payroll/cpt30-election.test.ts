// Payroll-3B-5B-1 — CPT30 admin service: eligibility, effective-date
// derivation, same-year revocation refusal, election history.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  recordCppStopElection,
  recordCppRevocation,
  listCppElections,
  resolveActiveElectionOn,
} from "@/lib/payroll/cpp-election";
import { resolveCppContributionEligibility } from "@/lib/payroll/statutory/cpp-eligibility";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function scenario() {
  const club = await makeClub("Club A");
  const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "pa@a.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  return { club, paP };
}

async function makeEmp(clubId: string, dobYear: number, dobMonth: number, dobDay: number, employeeNumber: string) {
  return db().employee.create({
    data: {
      clubId, firstName: "Test", lastName: employeeNumber,
      email: `${employeeNumber}@a.test`, hireDate: d(2000, 1, 1),
      dateOfBirth: d(dobYear, dobMonth, dobDay), status: "ACTIVE",
      employeeNumber,
    },
  });
}

describe("Payroll-3B-5B-1 — CPT30 admin service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  // ---- Eligibility ----------------------------------------------------

  it("age 64 → stop election refused (must be at least 65)", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1962, 6, 15, "E-64"); // 64 at 2026-06-15
    await expect(
      recordCppStopElection(s.paP, s.club.id, {
        employeeId: emp.id,
        pensionType: "CPP",
        retirementPensionReceived: true,
        employeeSignedOn: d(2026, 6, 10),
        receivedOn: d(2026, 6, 15),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("age 65 without retirement-pension declaration → refused", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1961, 6, 15, "E-65-NP");
    await expect(
      recordCppStopElection(s.paP, s.club.id, {
        employeeId: emp.id,
        pensionType: "CPP",
        retirementPensionReceived: false, // ← the CRA prerequisite is missing
        employeeSignedOn: d(2026, 8, 1),
        receivedOn: d(2026, 8, 5),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("age 65 with valid retirement pension declaration → accepted; effective first-of-next-month", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1961, 6, 15, "E-65-OK");
    const view = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "CPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2026, 8, 1),
      receivedOn: d(2026, 8, 5),
    });
    expect(view.kind).toBe("ELECTION_TO_STOP");
    expect(view.effectiveOn.toISOString()).toBe(d(2026, 9, 1).toISOString());
    expect(view.pensionType).toBe("CPP");
    expect(view.retirementPensionReceived).toBe(true);
  });

  it("age 69 with valid form → accepted", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1957, 6, 15, "E-69-OK");
    const view = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "QPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2026, 8, 1),
      receivedOn: d(2026, 8, 5),
    });
    expect(view.pensionType).toBe("QPP");
  });

  it("age 70 → refused (CPP stops automatically per age-70 rule)", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1955, 6, 15, "E-70");
    await expect(
      recordCppStopElection(s.paP, s.club.id, {
        employeeId: emp.id,
        pensionType: "CPP",
        retirementPensionReceived: true,
        employeeSignedOn: d(2026, 8, 1),
        receivedOn: d(2026, 8, 5),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ---- Effective-date derivation --------------------------------------

  it("form received in May → derived effective date is first of June", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1960, 6, 15, "E-DERIVE-1");
    const view = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "CPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2026, 5, 4),
      receivedOn: d(2026, 5, 20),
    });
    expect(view.effectiveOn.toISOString()).toBe(d(2026, 6, 1).toISOString());
  });

  it("employeeSignedOn > receivedOn → refused (impossible)", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1961, 6, 15, "E-BAD-ORDER");
    await expect(
      recordCppStopElection(s.paP, s.club.id, {
        employeeId: emp.id,
        pensionType: "CPP",
        retirementPensionReceived: true,
        employeeSignedOn: d(2026, 8, 10),
        receivedOn: d(2026, 8, 5), // BEFORE signed date
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ---- Revocation same-year rule --------------------------------------

  it("same-year revocation refused with structured error", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1960, 6, 15, "E-REV-SAME");
    const election = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "CPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2026, 5, 4),
      receivedOn: d(2026, 5, 20),
    });
    await expect(
      recordCppRevocation(s.paP, s.club.id, {
        employeeId: emp.id,
        revokesElectionId: election.id,
        employeeSignedOn: d(2026, 9, 1),
        receivedOn: d(2026, 9, 5),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("following-year revocation accepted; effective floored to Jan 1 when derived date is earlier", async () => {
    const s = await scenario();
    // Use a historic scenario (stop 2024, revocation 2025) so all
    // form dates land in the past relative to today's clock.
    const emp = await makeEmp(s.club.id, 1958, 6, 15, "E-REV-NEXT");
    const election = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "CPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2024, 5, 4),
      receivedOn: d(2024, 5, 20),
    });
    // Revocation filed early 2025 — derived date is Feb 1 2025.
    const rev = await recordCppRevocation(s.paP, s.club.id, {
      employeeId: emp.id,
      revokesElectionId: election.id,
      employeeSignedOn: d(2025, 1, 10),
      receivedOn: d(2025, 1, 15),
    });
    expect(rev.effectiveOn.toISOString()).toBe(d(2025, 2, 1).toISOString());
    expect(rev.revokesElectionId).toBe(election.id);
  });

  // ---- History --------------------------------------------------------

  it("historical eligibility unaffected by a later revocation", async () => {
    const s = await scenario();
    // Historic dates (stop 2024, revocation 2025) so form dates
    // land in the past relative to today's clock.
    const emp = await makeEmp(s.club.id, 1958, 6, 15, "E-HIST");
    const election = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "CPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2024, 5, 4),
      receivedOn: d(2024, 5, 20),
    });
    // Later revocation.
    await recordCppRevocation(s.paP, s.club.id, {
      employeeId: emp.id,
      revokesElectionId: election.id,
      employeeSignedOn: d(2025, 3, 1),
      receivedOn: d(2025, 3, 5),
    });

    // A historical pay dated Aug 15, 2024 must resolve to STOPPED
    // per the ACTIVE election on that date — the revocation was
    // effective April 2025 and does not touch 2024.
    const augElection = await resolveActiveElectionOn(s.club.id, emp.id, d(2024, 8, 15));
    expect(augElection?.kind).toBe("ELECTION_TO_STOP");
    const historical = resolveCppContributionEligibility({
      dateOfBirth: d(1958, 6, 15),
      payDate: d(2024, 8, 15),
      cppElection: augElection
        ? { kind: augElection.kind, effectiveOn: augElection.effectiveOn }
        : null,
    });
    expect(historical.cppApplicable).toBe(false);
    expect(historical.reason).toBe("CPT30_ELECTION_STOP");

    // A 2025 pay dated after the revocation effective date resumes.
    const mayActive = await resolveActiveElectionOn(s.club.id, emp.id, d(2025, 5, 1));
    expect(mayActive?.kind).toBe("REVOCATION_OF_ELECTION");
    const resumed = resolveCppContributionEligibility({
      dateOfBirth: d(1958, 6, 15),
      payDate: d(2025, 5, 1),
      cppElection: mayActive
        ? { kind: mayActive.kind, effectiveOn: mayActive.effectiveOn }
        : null,
    });
    expect(resumed.cppApplicable).toBe(true);
  });

  it("listCppElections returns full history most-recent-effective first", async () => {
    const s = await scenario();
    const emp = await makeEmp(s.club.id, 1958, 6, 15, "E-LIST");
    const e1 = await recordCppStopElection(s.paP, s.club.id, {
      employeeId: emp.id,
      pensionType: "CPP",
      retirementPensionReceived: true,
      employeeSignedOn: d(2024, 5, 4),
      receivedOn: d(2024, 5, 20),
    });
    await recordCppRevocation(s.paP, s.club.id, {
      employeeId: emp.id,
      revokesElectionId: e1.id,
      employeeSignedOn: d(2025, 3, 1),
      receivedOn: d(2025, 3, 5),
    });
    const history = await listCppElections(s.paP, s.club.id, emp.id);
    expect(history.length).toBe(2);
    expect(history[0].kind).toBe("REVOCATION_OF_ELECTION");
    expect(history[1].kind).toBe("ELECTION_TO_STOP");
  });
});
