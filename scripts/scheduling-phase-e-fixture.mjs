// Scheduling Foundation · Phase E (2026-09-07) — Playwright multi-
// user fixture for the shift-exchange lifecycle.
//
// Creates a fresh isolated Club with:
//   Employee A (Sam Fixture)   — hourly, portal credential,
//                                 EVENTS + Server, one upcoming shift
//   Employee B (Riley Fixture) — hourly, portal credential,
//                                 EVENTS + Server (eligible to pick up A's shift)
//
// Emits JSON on stdout with the identifiers + login credentials.
//
// The upcoming shift is dated TOMORROW at 17:30 (Evening Shift) so
// it renders on today's My Schedule week + the countdown looks
// reasonable.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const prisma = new PrismaClient();

const seed = crypto.randomBytes(4).toString("hex");
const PASSWORD = "PhaseE-Preview-99";
const CLUB_SLUG = `phase-e-fixture-${seed}`;
const NOW = new Date();
function monday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000);
}
const WEEK_START = monday(NOW);

async function ensureClub() {
  return prisma.club.create({
    data: {
      slug: CLUB_SLUG,
      name: `Phase E Fixture Club ${seed}`,
      wordmark: `Phase E Fixture Club ${seed}`,
      timezone: "America/Edmonton", payrollProvince: "AB",
      stagingDataMode: "OFF",
    },
  });
}
async function ensureDept(clubId) {
  return prisma.department.create({
    data: { clubId, code: "EVENTS", name: "Events", isActive: true },
  });
}
async function ensurePosition(clubId, departmentId, code, name) {
  return prisma.employeePosition.create({
    data: { clubId, code, name, departmentId, defaultPayRate: 20, isActive: true },
  });
}
async function ensureEmployee(clubId, firstName, lastName, key) {
  const emp = await prisma.employee.create({
    data: {
      clubId, firstName, lastName,
      email: `${key}-${seed}@fixture.spectre.test`,
      personalEmail: `${key}-${seed}@fixture.spectre.test`,
      hireDate: new Date("2026-04-01T00:00:00Z"),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `PE-${key}-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
  const hash = await bcrypt.hash(PASSWORD, 8);
  await prisma.employeePortalCredential.create({
    data: { employeeId: emp.id, clubId, passwordHash: hash, passwordUpdatedAt: new Date() },
  });
  return emp;
}
async function ensureAssignment(clubId, employeeId, departmentId, positionId) {
  return prisma.employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role: "PRIMARY", employmentType: "PART_TIME",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      departmentId, positionId,
    },
  });
}
async function ensureTemplate(clubId, departmentId, code, name, startMin, endMin) {
  return prisma.shiftTemplate.create({
    data: { clubId, departmentId, code, name,
      startTimeMinutes: startMin, endTimeMinutes: endMin, active: true },
  });
}
async function ensureShiftAssignment(clubId, departmentId, templateId, positionId, employeeId, employmentAssignmentId, startAt, endAt) {
  const shift = await prisma.shift.create({
    data: {
      clubId, departmentId, shiftTemplateId: templateId, positionId,
      shiftDate: startAt, startAt, endAt, state: "PUBLISHED",
    },
  });
  const assn = await prisma.shiftAssignment.create({
    data: { clubId, shiftId: shift.id, employeeId, employmentAssignmentId, state: "ASSIGNED" },
  });
  return { shift, assignment: assn };
}

async function main() {
  const club = await ensureClub();
  const events = await ensureDept(club.id);
  const server = await ensurePosition(club.id, events.id, "SERVER", "Server");
  const eveTpl = await ensureTemplate(club.id, events.id, "EVENING", "Evening Shift", 17 * 60 + 30, 23 * 60);
  const dayTpl = await ensureTemplate(club.id, events.id, "DAY", "Day Shift", 11 * 60, 17 * 60 + 30);

  const empA = await ensureEmployee(club.id, "Sam", "Fixture", "sam");
  const empB = await ensureEmployee(club.id, "Riley", "Fixture", "riley");
  const asnA = await ensureAssignment(club.id, empA.id, events.id, server.id);
  const asnB = await ensureAssignment(club.id, empB.id, events.id, server.id);

  // One upcoming Evening shift for Employee A — anchored to
  // TOMORROW so the current-week view shows it (unless "tomorrow"
  // crosses the Monday boundary — in that case it lands on the
  // start of next week, which still exercises the page).
  const tomorrow = new Date(NOW.getTime() + 86_400_000);
  const shiftStart = new Date(Date.UTC(
    tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(),
    17, 30,
  ));
  const shiftEnd = new Date(shiftStart.getTime() + (5 * 60 + 30) * 60_000);
  const { shift, assignment } = await ensureShiftAssignment(
    club.id, events.id, eveTpl.id, server.id,
    empA.id, asnA.id, shiftStart, shiftEnd,
  );

  const out = {
    clubId: club.id, clubSlug: CLUB_SLUG,
    weekStartIso: WEEK_START.toISOString(),
    employeeA: {
      id: empA.id, loginEmail: empA.personalEmail, password: PASSWORD,
      assignmentId: assignment.id,
    },
    employeeB: {
      id: empB.id, loginEmail: empB.personalEmail, password: PASSWORD,
    },
    shift: {
      id: shift.id, startIso: shiftStart.toISOString(), endIso: shiftEnd.toISOString(),
    },
    // Suppress unused-warnings on the helpers we return.
    _seeded: { dayTplId: dayTpl.id, empBAssignmentId: asnB.id },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
