// Payroll-3B-5B-1 (2026-08-31) — canonical CPT30 admin service.
//
// This service is the ONLY authorised path to record a CPT30
// election-to-stop or revocation-of-election on an Employee. It
// enforces CRA CPT30 rules through structured validation, never
// admin-typed effective dates.
//
// -----------------------------------------------------------------
// Spectre business contract paraphrasing CRA CPT30 rules
// (pending founder verification against the current CRA CPT30
// publication before dollar-calculation ships):
//
//   ELECTION_TO_STOP:
//     Eligibility (all must be true at the CPT30 receipt date):
//       • Employee is at least age 65 and under age 70
//         (verified against Employee.dateOfBirth)
//       • Employee declares they are receiving a CPP or QPP
//         retirement pension (`retirementPensionReceived: true`)
//       • Employee's current employment is pensionable for CPP
//         purposes (Spectre's default; NON_PENSIONABLE_EMPLOYMENT
//         is not modeled today — see §11 gap doc)
//     Effective date:
//       • Derived as the first day of the calendar month AFTER
//         `max(employeeSignedOn ?? receivedOn, receivedOn)`. Admin
//         cannot override this to an earlier or arbitrary date.
//
//   REVOCATION_OF_ELECTION:
//     Eligibility:
//       • References a specific prior ELECTION_TO_STOP on the same
//         Employee (`revokesElectionId`)
//       • CRA same-year rule: the revocation's effective date MUST
//         be no earlier than January 1 of the calendar year
//         FOLLOWING the year of the original election. A revocation
//         with an effective date in the SAME calendar year as its
//         election is refused loudly (§5).
//     Effective date:
//       • Derived as the first day of the calendar month AFTER
//         `max(employeeSignedOn ?? receivedOn, receivedOn)`, then
//         floored to `Jan 1 (electionYear + 1)` if it would fall
//         earlier.
// -----------------------------------------------------------------
//
// The pure function `resolveCppContributionEligibility` (in
// statutory/cpp-eligibility.ts) consumes the ACTIVE election
// applicable to a specific pay date. Historical pay dates are
// unaffected by later elections/revocations — this file preserves
// the full election history and the eligibility resolver picks the
// applicable state for a given pay date.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "EmployeeCppElection";

export type CppElectionKind = "ELECTION_TO_STOP" | "REVOCATION_OF_ELECTION";
export type CppPensionType = "CPP" | "QPP";

export interface CppElectionView {
  id: string;
  clubId: string;
  employeeId: string;
  kind: CppElectionKind;
  pensionType: CppPensionType | null;
  retirementPensionReceived: boolean;
  employeeSignedOn: Date | null;
  receivedOn: Date;
  effectiveOn: Date;
  revokesElectionId: string | null;
  status: "ACTIVE" | "SUPERSEDED";
  notes: string | null;
  evidenceDocumentId: string | null;
  createdAt: Date;
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function firstOfMonthAfter(d: Date): Date {
  const utc = utcMidnight(d);
  return new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth() + 1, 1));
}

function yearsBetween(anchor: Date, from: Date): number {
  const a = utcMidnight(anchor);
  const f = utcMidnight(from);
  let years = f.getUTCFullYear() - a.getUTCFullYear();
  const monthDiff = f.getUTCMonth() - a.getUTCMonth();
  const dayDiff = f.getUTCDate() - a.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years -= 1;
  return years;
}

/** Effective date for a stop or revocation — derived from source facts. */
function deriveElectionEffectiveDate(input: {
  employeeSignedOn: Date | null;
  receivedOn: Date;
}): Date {
  const anchors = [utcMidnight(input.receivedOn)];
  if (input.employeeSignedOn) anchors.push(utcMidnight(input.employeeSignedOn));
  const latest = anchors.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  return firstOfMonthAfter(latest);
}

async function loadEmployee(clubId: string, employeeId: string) {
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, clubId },
    select: { id: true, clubId: true, dateOfBirth: true },
  });
  if (!emp) throw new NotFoundError("Employee", employeeId);
  return emp;
}

// ---------------------------------------------------------------------------
// Record an ELECTION_TO_STOP
// ---------------------------------------------------------------------------

export interface RecordStopElectionInput {
  employeeId: string;
  pensionType: CppPensionType;
  retirementPensionReceived: boolean;
  /** Date the employee signed the CPT30 form (Part D). */
  employeeSignedOn: Date;
  /** Date the employer received the completed form. */
  receivedOn: Date;
  notes?: string | null;
  evidenceDocumentId?: string | null;
}

export async function recordCppStopElection(
  principal: Principal,
  clubId: string,
  input: RecordStopElectionInput,
): Promise<CppElectionView> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.cpp-election.record-stop", ENTITY, input.employeeId);

  const emp = await loadEmployee(clubId, input.employeeId);
  const issues: { path: string; message: string }[] = [];

  if (!emp.dateOfBirth) {
    issues.push({
      path: "employeeId",
      message: "Employee has no date of birth on file. Set it before recording a CPT30 election.",
    });
  }
  if (!input.retirementPensionReceived) {
    issues.push({
      path: "retirementPensionReceived",
      message: "CPT30 stop election requires the employee to declare they are receiving a CPP or QPP retirement pension.",
    });
  }
  if (input.pensionType !== "CPP" && input.pensionType !== "QPP") {
    issues.push({ path: "pensionType", message: "pensionType must be CPP or QPP." });
  }
  if (input.employeeSignedOn.getTime() > input.receivedOn.getTime()) {
    issues.push({ path: "receivedOn", message: "receivedOn cannot be earlier than employeeSignedOn." });
  }
  const now = new Date();
  if (input.receivedOn.getTime() > now.getTime() || input.employeeSignedOn.getTime() > now.getTime()) {
    issues.push({ path: "receivedOn", message: "Form dates cannot be in the future." });
  }

  // Age check — must be at least 65 and under 70 AT THE RECEIVED DATE.
  if (emp.dateOfBirth) {
    const ageAtReceipt = yearsBetween(emp.dateOfBirth, input.receivedOn);
    if (ageAtReceipt < 65) {
      issues.push({
        path: "employeeId",
        message: `CPT30 stop election requires the employee to be at least 65 at the form-receipt date (currently ${ageAtReceipt}).`,
      });
    }
    if (ageAtReceipt >= 70) {
      issues.push({
        path: "employeeId",
        message: "CPT30 stop election does not apply once the employee has reached age 70; CPP contributions end automatically per the age-70 rule.",
      });
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);

  const effectiveOn = deriveElectionEffectiveDate({
    employeeSignedOn: input.employeeSignedOn,
    receivedOn: input.receivedOn,
  });

  const row = await prisma.employeeCppElection.create({
    data: {
      clubId,
      employeeId: input.employeeId,
      kind: "ELECTION_TO_STOP",
      pensionType: input.pensionType,
      retirementPensionReceived: true,
      employeeSignedOn: utcMidnight(input.employeeSignedOn),
      receivedOn: utcMidnight(input.receivedOn),
      effectiveOn,
      status: "ACTIVE",
      notes: input.notes ?? null,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
      createdByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "payroll.cpp-election.record-stop",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      employeeId: input.employeeId,
      pensionType: input.pensionType,
      effectiveOn: effectiveOn.toISOString(),
      receivedOn: row.receivedOn.toISOString(),
    },
  });

  return toView(row);
}

// ---------------------------------------------------------------------------
// Record a REVOCATION_OF_ELECTION
// ---------------------------------------------------------------------------

export interface RecordRevocationInput {
  employeeId: string;
  revokesElectionId: string;
  employeeSignedOn: Date;
  receivedOn: Date;
  notes?: string | null;
  evidenceDocumentId?: string | null;
}

export async function recordCppRevocation(
  principal: Principal,
  clubId: string,
  input: RecordRevocationInput,
): Promise<CppElectionView> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.cpp-election.record-revocation", ENTITY, input.employeeId);

  await loadEmployee(clubId, input.employeeId);
  const target = await prisma.employeeCppElection.findFirst({
    where: { id: input.revokesElectionId, clubId, employeeId: input.employeeId },
  });
  if (!target) {
    throw new ValidationError([{ path: "revokesElectionId", message: "Referenced election not found for this employee." }]);
  }
  if (target.kind !== "ELECTION_TO_STOP") {
    throw new ValidationError([{ path: "revokesElectionId", message: "Only an ELECTION_TO_STOP can be revoked." }]);
  }

  const issues: { path: string; message: string }[] = [];
  if (input.employeeSignedOn.getTime() > input.receivedOn.getTime()) {
    issues.push({ path: "receivedOn", message: "receivedOn cannot be earlier than employeeSignedOn." });
  }
  const now = new Date();
  if (input.receivedOn.getTime() > now.getTime() || input.employeeSignedOn.getTime() > now.getTime()) {
    issues.push({ path: "receivedOn", message: "Form dates cannot be in the future." });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  // Derive effective date per CRA rule, then apply the same-year floor.
  const derived = deriveElectionEffectiveDate({
    employeeSignedOn: input.employeeSignedOn,
    receivedOn: input.receivedOn,
  });
  const electionYear = target.effectiveOn.getUTCFullYear();
  const followingYearStart = new Date(Date.UTC(electionYear + 1, 0, 1));
  const effectiveOn = derived.getTime() < followingYearStart.getTime()
    ? followingYearStart
    : derived;

  // Same-year rule (§5): if the DERIVED date is in the election's
  // calendar year, refuse loudly. The founder wants the workflow to
  // block admins from recording an impossible revocation, not silently
  // shift the effective date forward.
  if (derived.getUTCFullYear() === electionYear) {
    throw new ValidationError([
      {
        path: "receivedOn",
        message:
          `CRA does not permit a CPT30 election to be revoked in the same calendar year (${electionYear}). ` +
          `The earliest permissible revocation would take effect January 1, ${electionYear + 1}.`,
      },
    ]);
  }

  const row = await prisma.employeeCppElection.create({
    data: {
      clubId,
      employeeId: input.employeeId,
      kind: "REVOCATION_OF_ELECTION",
      revokesElectionId: target.id,
      pensionType: target.pensionType,
      retirementPensionReceived: target.retirementPensionReceived,
      employeeSignedOn: utcMidnight(input.employeeSignedOn),
      receivedOn: utcMidnight(input.receivedOn),
      effectiveOn,
      status: "ACTIVE",
      notes: input.notes ?? null,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
      createdByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "payroll.cpp-election.record-revocation",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      employeeId: input.employeeId,
      revokesElectionId: target.id,
      effectiveOn: effectiveOn.toISOString(),
    },
  });

  return toView(row);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Full election history for an Employee, most-recent-effective first. */
export async function listCppElections(
  principal: Principal,
  clubId: string,
  employeeId: string,
): Promise<CppElectionView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.employeeCppElection.findMany({
    where: { clubId, employeeId },
    orderBy: [{ effectiveOn: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(toView);
}

/**
 * Return the election applicable on a specific pay date. Selection:
 *   • filter to ACTIVE elections with effectiveOn <= payDate
 *   • pick the one with the greatest effectiveOn (most recent)
 * `null` when no election applies.
 */
export async function resolveActiveElectionOn(
  clubId: string,
  employeeId: string,
  payDate: Date,
): Promise<CppElectionView | null> {
  const row = await prisma.employeeCppElection.findFirst({
    where: { clubId, employeeId, status: "ACTIVE", effectiveOn: { lte: utcMidnight(payDate) } },
    orderBy: [{ effectiveOn: "desc" }],
  });
  return row ? toView(row) : null;
}

function toView(row: Awaited<ReturnType<typeof prisma.employeeCppElection.findFirst>>): CppElectionView {
  if (!row) throw new NotFoundError(ENTITY, "(null)");
  return {
    id: row.id,
    clubId: row.clubId,
    employeeId: row.employeeId,
    kind: row.kind as CppElectionKind,
    pensionType: (row.pensionType as CppPensionType | null) ?? null,
    retirementPensionReceived: row.retirementPensionReceived,
    employeeSignedOn: row.employeeSignedOn,
    receivedOn: row.receivedOn,
    effectiveOn: row.effectiveOn,
    revokesElectionId: row.revokesElectionId,
    status: row.status as "ACTIVE" | "SUPERSEDED",
    notes: row.notes,
    evidenceDocumentId: row.evidenceDocumentId,
    createdAt: row.createdAt,
  };
}
