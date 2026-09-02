// TA-1C Founder Preview fixture — Coulee Ridge edition.
//
// Founder direction (TA-1C hotfix, 2026-09-04):
//   > Coulee Ridge Golf & Country Club is Spectre's designated
//     development/test tenant. Founder-preview testing lives inside
//     Coulee Ridge; synthetic org records are added there rather
//     than in a separate fictional Club.
//
// This script:
//   1. Finds the existing Coulee Ridge Club (does NOT create a Club).
//   2. Ensures the small canonical Departments needed by the TA-1C org
//      structure exist inside Coulee Ridge.
//   3. Ensures the TA-1C organizational-position catalogue exists.
//   4. Ensures nine synthetic administrative Users exist with names
//      like Alex Preview / Chris Fixture / Raelene Sample, all
//      belonging to Coulee Ridge (not a second tenant).
//   5. Assigns each synthetic user a UserClubProfile with position +
//      department + reports-to.
//   6. Bootstraps TENANT_ADMINISTRATION Primary to Alex Preview only
//      if no active Primary exists yet at Coulee Ridge.
//
// Also: cleans up the prior "Willow Creek Golf & Country Club" tenant
// and every profile/position/user/membership tied to it, IF present.
// The cleanup is scoped by Club slug — nothing else is touched.
//
// Never overwrites existing real Coulee Ridge data:
//   - existing Users are left as-is (upsert on new synthetic emails only).
//   - existing Departments are reused (upsert on `(clubId, code)`).
//   - existing PayrollClubConfig / ResponsibilityAssignments are not
//     modified.
//
// Idempotent: rerun safely.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const COULEE_SLUG = "coulee-ridge";
const COULEE_NAME = "Coulee Ridge Golf & Country Club";
const COULEE_NAME_FRAGMENT = "Coulee Ridge";
// Local dev's prisma/seed.ts seeds "Silver Springs Golf & Country
// Club" as the canonical fixture Club. Staging has been renamed to
// Coulee Ridge, and the founder-directed dev convention is that
// Coulee Ridge is Spectre's canonical dev tenant. When we find the
// seed Club under its original name locally, rename it in place
// (name + slug only — id stays the same, all foreign keys keep
// resolving). This normalisation runs once; subsequent runs no-op.
const SEED_LEGACY_SLUG = "silver-springs";
const SEED_LEGACY_NAME_FRAGMENT = "Silver Springs";

const OLD_TENANT_SLUG = "willow-creek";

const PASSWORD = "TA1C-Preview-99";
let passwordHash = "";

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

async function cleanupOldTenant() {
  const old = await prisma.club.findFirst({ where: { slug: OLD_TENANT_SLUG } });
  if (!old) return;
  console.log(`Removing legacy '${OLD_TENANT_SLUG}' tenant from local dev DB…`);
  // Cascade cleanup — ordered to respect FKs.
  await prisma.responsibilityAssignment.deleteMany({ where: { clubId: old.id } });
  await prisma.adminInvitation.deleteMany({ where: { clubId: old.id } });
  await prisma.userClubProfile.deleteMany({ where: { clubId: old.id } });
  await prisma.organizationalPosition.deleteMany({ where: { clubId: old.id } });
  await prisma.userClubRole.deleteMany({ where: { clubId: old.id } });
  await prisma.department.deleteMany({ where: { clubId: old.id } });
  // Remove synthetic Users that were created only for the old tenant.
  await prisma.user.deleteMany({ where: { email: { endsWith: "@willowcreek.test" } } });
  await prisma.club.delete({ where: { id: old.id } });
  console.log("  legacy tenant removed.");
}

async function findCouleeRidge() {
  // 1. Direct match by slug or name.
  let club = await prisma.club.findFirst({ where: { slug: COULEE_SLUG } });
  if (!club) {
    club = await prisma.club.findFirst({ where: { name: { contains: COULEE_NAME_FRAGMENT } } });
  }
  if (club) return club;

  // 2. Rename the seed Club in place. Local prisma/seed.ts still
  //    seeds "Silver Springs"; staging carries the renamed "Coulee
  //    Ridge". Normalise local dev to match staging by updating the
  //    seed Club's name + slug — the ID stays stable so every
  //    foreign key keeps resolving.
  const legacy = await prisma.club.findFirst({
    where: { OR: [{ slug: SEED_LEGACY_SLUG }, { name: { contains: SEED_LEGACY_NAME_FRAGMENT } }] },
  });
  if (legacy) {
    console.log(`Renaming legacy seed club '${legacy.name}' → '${COULEE_NAME}' (id: ${legacy.id})…`);
    const renamed = await prisma.club.update({
      where: { id: legacy.id },
      data: { slug: COULEE_SLUG, name: COULEE_NAME },
    });
    return renamed;
  }

  throw new Error(
    `Coulee Ridge is not present in the local dev database, and no\n` +
    `seed club (Silver Springs) was found to rename.\n\n` +
    `Fix locally: run 'npm run db:reset' to seed the canonical fixture\n` +
    `club, then re-run this script.`,
  );
}

const DEPARTMENTS = [
  { code: "ADM",  name: "Administration" },
  { code: "GOLF", name: "Golf Operations" },
  { code: "GRND", name: "Grounds" },
  { code: "FNB",  name: "Food & Beverage" },
  { code: "EVT",  name: "Events" },
  { code: "MEM",  name: "Membership" },
  { code: "FIN",  name: "Finance" },
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
  { name: "General Manager",             dept: "ADM" },
  { name: "Controller",                  dept: "FIN" },
  { name: "Office Manager",              dept: "ADM" },
  { name: "Head Professional",           dept: "GOLF" },
  { name: "Grounds Superintendent",      dept: "GRND" },
  { name: "Head Chef",                   dept: "FNB" },
  { name: "Front of House Manager",      dept: "FNB" },
  { name: "Banquets & Events Manager",   dept: "EVT" },
  { name: "Communications Coordinator",  dept: "MEM" },
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

// Synthetic identities — clearly test data. All emails use the
// preview.spectre.test domain so they can never accidentally deliver
// mail to a real recipient. Names carry a "Preview" / "Fixture" /
// "Sample" surname to visually distinguish them from any real Coulee
// Ridge people who might one day be added.
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

async function ensureUser(email: string, name: string, clubId: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Ensure the deprecated legacy scalar points at Coulee Ridge so
    // getActiveClubId's legacy-scalar branch also resolves correctly.
    if (existing.clubId !== clubId) {
      await prisma.user.update({ where: { id: existing.id }, data: { clubId } });
    }
    return existing;
  }
  return prisma.user.create({
    data: {
      email, name,
      role: "CLUB_ADMIN",
      passwordHash,
      status: "ACTIVE",
      clubId, // deprecated scalar; matches memberships below
    },
  });
}

async function main() {
  console.log("TA-1C Founder Preview fixture — Coulee Ridge edition\n");
  passwordHash = await bcrypt.hash(PASSWORD, 8);
  await ensureResponsibilityCatalogue();
  await cleanupOldTenant();

  const club = await findCouleeRidge();
  console.log(`Using tenant: ${club.name} (id: ${club.id})`);

  const deptIds = await ensureDepartments(club.id);
  const posIds = await ensurePositions(club.id, deptIds);

  const profileByPosition = new Map<string, string>();

  // First pass — Users + roles + profiles (skip reportsTo).
  for (const person of PEOPLE) {
    const email = `${person.first.toLowerCase()}.${person.last.toLowerCase()}@preview.spectre.test`;
    const name = `${person.first} ${person.last}`;
    const user = await ensureUser(email, name, club.id);
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
      update: { positionId, departmentId },
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
        console.log(`  Bootstrapped TENANT_ADMINISTRATION Primary → ${name}`);
      } else {
        console.log(`  TENANT_ADMINISTRATION Primary already assigned — leaving in place.`);
      }
    }
  }

  // Second pass — set reportsTo now that all profile ids exist.
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
  console.log(`  email:    alex.preview@preview.spectre.test`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`Tenant:     ${club.name}`);
  console.log(`Then open:  http://localhost:3000/app/admin/settings/users\n`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
