// TA-1C — Founder Preview fixture.
//
// Seeds a local SQLite dev DB with a synthetic Club that exercises
// the organizational structure end-to-end:
//   - General Manager (bootstrap TENANT_ADMINISTRATION Primary)
//   - Controller reports to GM
//   - Office Manager reports to Controller
//   - Head Professional, Grounds Superintendent, Head Chef, and
//     Communications Coordinator all report to GM
//   - Front of House Manager + Banquets & Events Manager report to Head Chef
//
// A synthetic OrganizationalPosition per person. Every user is
// linked to a synthetic Employee where appropriate. The Club is a
// fictional "Willow Creek Golf & Country Club" — Coulee Ridge is
// deliberately not touched.
//
// Idempotent: rerun safely. Prints the login URL + credentials for
// the founder to sign in as the GM.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const CLUB_SLUG = "willow-creek";
const CLUB_NAME = "Willow Creek Golf & Country Club";

const PASSWORD = "TA1C-Preview-99";
let passwordHash = "";

async function ensureClub() {
  const existing = await prisma.club.findFirst({ where: { slug: CLUB_SLUG } });
  if (existing) return existing;
  return prisma.club.create({
    data: {
      slug: CLUB_SLUG,
      name: CLUB_NAME,
      region: "AB", salesTaxRegion: "AB",
      foundedYear: 1998,
      timezone: "America/Edmonton",
    },
  });
}

const DEPARTMENTS = [
  { code: "ADM", name: "Administration" },
  { code: "GOLF", name: "Golf Operations" },
  { code: "GRND", name: "Grounds" },
  { code: "FNB", name: "Food & Beverage" },
  { code: "EVT", name: "Events" },
  { code: "MEM", name: "Membership" },
  { code: "FIN", name: "Finance" },
] as const;

async function ensureDepartments(clubId: string) {
  const results = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const existing = await prisma.department.findFirst({ where: { clubId, code: d.code } });
    if (existing) { results.set(d.code, existing.id); continue; }
    const created = await prisma.department.create({
      data: { clubId, code: d.code, name: d.name, isActive: true, sortOrder: 0 },
    });
    results.set(d.code, created.id);
  }
  return results;
}

const POSITIONS = [
  { name: "General Manager", dept: "ADM" },
  { name: "Controller", dept: "FIN" },
  { name: "Office Manager", dept: "ADM" },
  { name: "Head Professional", dept: "GOLF" },
  { name: "Grounds Superintendent", dept: "GRND" },
  { name: "Head Chef", dept: "FNB" },
  { name: "Front of House Manager", dept: "FNB" },
  { name: "Banquets & Events Manager", dept: "EVT" },
  { name: "Communications Coordinator", dept: "MEM" },
] as const;

async function ensurePositions(clubId: string, deptIds: Map<string, string>) {
  const results = new Map<string, string>();
  for (let i = 0; i < POSITIONS.length; i++) {
    const p = POSITIONS[i];
    const existing = await prisma.organizationalPosition.findFirst({ where: { clubId, name: p.name } });
    if (existing) { results.set(p.name, existing.id); continue; }
    const created = await prisma.organizationalPosition.create({
      data: {
        clubId, name: p.name,
        departmentId: deptIds.get(p.dept) ?? null,
        sortOrder: i,
      },
    });
    results.set(p.name, created.id);
  }
  return results;
}

const PEOPLE = [
  { first: "Alex",    last: "Preview",   position: "General Manager",            reportsTo: null,                          roleKeys: ["CLUB_ADMIN", "GENERAL_MANAGER"], bootstrap: true },
  { first: "Chris",   last: "Fixture",   position: "Controller",                 reportsTo: "General Manager",             roleKeys: ["CONTROLLER"],                    bootstrap: false },
  { first: "Raelene", last: "Sample",    position: "Office Manager",             reportsTo: "Controller",                  roleKeys: ["PAYROLL_ADMIN"],                 bootstrap: false },
  { first: "Riley",   last: "Sample",    position: "Head Professional",          reportsTo: "General Manager",             roleKeys: ["PRO_SHOP_MANAGER"],              bootstrap: false },
  { first: "Sam",     last: "Sample",    position: "Grounds Superintendent",     reportsTo: "General Manager",             roleKeys: ["DEPARTMENT_MANAGER"],            bootstrap: false },
  { first: "Taylor",  last: "Sample",    position: "Head Chef",                  reportsTo: "General Manager",             roleKeys: ["F_AND_B_MANAGER"],               bootstrap: false },
  { first: "Jordan",  last: "Sample",    position: "Front of House Manager",     reportsTo: "Head Chef",                   roleKeys: ["STAFF"],                         bootstrap: false },
  { first: "Quinn",   last: "Sample",    position: "Banquets & Events Manager",  reportsTo: "Head Chef",                   roleKeys: ["EVENT_MANAGER"],                 bootstrap: false },
  { first: "Morgan",  last: "Sample",    position: "Communications Coordinator", reportsTo: "General Manager",             roleKeys: ["STAFF"],                         bootstrap: false },
] as const;

async function ensureUser(email: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email, name,
      role: "CLUB_ADMIN", // deprecated scalar; kept in sync
      passwordHash,
      status: "ACTIVE",
    },
  });
}

async function ensureResponsibilityCatalogue() {
  await prisma.responsibility.upsert({
    where: { key: "TENANT_ADMINISTRATION" },
    update: {},
    create: {
      key: "TENANT_ADMINISTRATION",
      displayLabel: "Tenant Administrator",
      scopeKind: "CLUB",
      cardinality: "PRIMARY_AND_BACKUPS",
      description:
        "Holds Tenant Administration authority for this Club. Primary invites and manages administrative users.",
      isSpectreDefined: true,
    },
  });
}

async function main() {
  console.log("Seeding TA-1C Founder Preview fixture…");
  passwordHash = await bcrypt.hash(PASSWORD, 8);
  await ensureResponsibilityCatalogue();
  const club = await ensureClub();
  const deptIds = await ensureDepartments(club.id);
  const posIds = await ensurePositions(club.id, deptIds);

  const profileByPosition = new Map<string, string>();
  const profileByEmail = new Map<string, string>();

  // First pass — create users + profiles + role rows (skip reportsTo).
  for (const person of PEOPLE) {
    const email = `${person.first.toLowerCase()}.${person.last.toLowerCase()}@willowcreek.test`;
    const name = `${person.first} ${person.last}`;
    const user = await ensureUser(email, name);
    profileByEmail.set(email, user.id);

    for (const rk of person.roleKeys) {
      await prisma.userClubRole.upsert({
        where: { userId_clubId_roleKey: { userId: user.id, clubId: club.id, roleKey: rk } },
        update: {},
        create: { userId: user.id, clubId: club.id, roleKey: rk },
      });
    }
    const positionId = posIds.get(person.position)!;
    const dept = POSITIONS.find((p) => p.name === person.position)!.dept;
    const departmentId = deptIds.get(dept)!;
    const profile = await prisma.userClubProfile.upsert({
      where: { clubId_userId: { clubId: club.id, userId: user.id } },
      update: { positionId, departmentId, displayTitle: null },
      create: {
        clubId: club.id, userId: user.id,
        displayTitle: null,
        positionId, departmentId,
        status: "ACTIVE",
      },
    });
    profileByPosition.set(person.position, profile.id);

    if (person.bootstrap) {
      const existingPrimary = await prisma.responsibilityAssignment.findFirst({
        where: {
          clubId: club.id, responsibilityKey: "TENANT_ADMINISTRATION",
          role: "PRIMARY", effectiveTo: null,
        },
      });
      if (!existingPrimary) {
        await prisma.responsibilityAssignment.create({
          data: {
            clubId: club.id, userId: user.id,
            responsibilityKey: "TENANT_ADMINISTRATION",
            role: "PRIMARY", assignedByUserId: user.id,
            notes: "Auto-assigned by ta1c-founder-preview-fixture.ts",
          },
        });
      }
    }
  }

  // Second pass — set reportsTo (profiles now all exist).
  for (const person of PEOPLE) {
    if (!person.reportsTo) continue;
    const subjectProfileId = profileByPosition.get(person.position);
    const managerProfileId = profileByPosition.get(person.reportsTo);
    if (!subjectProfileId || !managerProfileId) continue;
    await prisma.userClubProfile.update({
      where: { id: subjectProfileId },
      data: { reportsToProfileId: managerProfileId },
    });
  }

  console.log("\nTA-1C Founder Preview fixture ready.");
  console.log("Sign in at http://localhost:3000/login");
  console.log(`  email:    alex.preview@willowcreek.test`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`Club:       ${CLUB_NAME}`);
  console.log(`Then open:  http://localhost:3000/app/admin/settings/users`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
