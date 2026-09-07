// Scheduling Foundation (2026-09-07) — idempotent shift-template seed
// for the Coulee Ridge staging tenant.
//
// This is the manual seeding tool the founder authorised in Slice 8A
// Phase A §4 amendment:
//   "For Coulee Ridge staging, seed appropriate department templates
//    manually, including the design-reference examples:
//        Day Shift      11:00 AM – 5:30 PM
//        Evening Shift  5:30 PM – 11:00 PM
//    Architecture must remain department/tenant configurable and must
//    not hardcode these as universal Spectre shifts."
//
// Usage:
//   npm run seed:scheduling-templates -- --apply           (staging)
//   npm run seed:scheduling-templates -- --dry-run         (audit)
//
// SAFETY GATES (all must pass):
//   1. ALLOW_STAGING_TA_FIXTURE=YES
//   2. Coulee Ridge club id + name + FOUNDER_REVIEW
//   3. Only writes ShiftTemplate rows for existing departments —
//      never mutates any other table.
//
// Idempotent: upserts on (clubId, departmentId, code). Rerunning
// converges without duplicates.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import {
  guardDemoTenant,
  COULEE_RIDGE_STAGING_CLUB_ID,
  COULEE_RIDGE_STAGING_CLUB_NAME,
} from "../src/lib/fixtures/demo-tenant-guard";

const prisma = new PrismaClient();

// The founder's brief shows the Coulee Ridge reference set. Times are
// minutes since midnight in the club's local timezone.
interface SeedEntry {
  departmentCode: string;
  code: string;
  name: string;
  startTimeMinutes: number;
  endTimeMinutes: number;
  sortOrder: number;
}
const REFERENCE_SEEDS: SeedEntry[] = [
  { departmentCode: "EVENTS",  code: "DAY",     name: "Day Shift",     startTimeMinutes: 11 * 60,        endTimeMinutes: 17 * 60 + 30, sortOrder: 10 },
  { departmentCode: "EVENTS",  code: "EVENING", name: "Evening Shift", startTimeMinutes: 17 * 60 + 30,   endTimeMinutes: 23 * 60,      sortOrder: 20 },
  { departmentCode: "GROUNDS", code: "MORNING", name: "Grounds Morning", startTimeMinutes: 5 * 60 + 30,  endTimeMinutes: 13 * 60 + 30, sortOrder: 10 },
  { departmentCode: "GROUNDS", code: "AFTERNOON", name: "Grounds Afternoon", startTimeMinutes: 13 * 60 + 30, endTimeMinutes: 21 * 60,  sortOrder: 20 },
];

interface Args { apply: boolean; dryRun: boolean }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    apply: argv.includes("--apply") && !argv.includes("--dry-run"),
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs();
  if (!args.apply && !args.dryRun) {
    console.error("Refusing to run without --apply or --dry-run.");
    process.exit(2);
  }

  await guardDemoTenant({
    prisma,
    clubId: COULEE_RIDGE_STAGING_CLUB_ID,
    apply: args.apply,
    callerName: "scheduling-seed-shift-templates",
    writeClass: "SYNTHETIC_TIME_ATTENDANCE",
  }).catch((e) => {
    if (args.dryRun) {
      console.log("DRY-RUN: guard --apply bailed as expected; continuing with read-only inspection.");
    } else {
      throw e;
    }
  });

  const club = await prisma.club.findUniqueOrThrow({ where: { id: COULEE_RIDGE_STAGING_CLUB_ID } });
  if (club.name !== COULEE_RIDGE_STAGING_CLUB_NAME) {
    throw new Error(`Refusing: club.name="${club.name}"`);
  }
  if (club.stagingDataMode !== "FOUNDER_REVIEW") {
    throw new Error(`Refusing: stagingDataMode="${club.stagingDataMode}"`);
  }

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const seed of REFERENCE_SEEDS) {
    const dept = await prisma.department.findUnique({
      where: { clubId_code: { clubId: club.id, code: seed.departmentCode } },
    });
    if (!dept) {
      skipped.push(`${seed.departmentCode}::${seed.code} — department not present`);
      continue;
    }
    const existing = await prisma.shiftTemplate.findUnique({
      where: {
        clubId_departmentId_code: { clubId: club.id, departmentId: dept.id, code: seed.code },
      },
    });
    if (existing) {
      const drift =
        existing.name !== seed.name
        || existing.startTimeMinutes !== seed.startTimeMinutes
        || existing.endTimeMinutes !== seed.endTimeMinutes
        || existing.sortOrder !== seed.sortOrder
        || existing.active !== true;
      if (!drift) { skipped.push(`${seed.departmentCode}::${seed.code} — already up to date`); continue; }
      if (args.apply) {
        await prisma.shiftTemplate.update({
          where: { id: existing.id },
          data: {
            name: seed.name,
            startTimeMinutes: seed.startTimeMinutes,
            endTimeMinutes: seed.endTimeMinutes,
            sortOrder: seed.sortOrder,
            active: true,
          },
        });
      }
      updated.push(`${seed.departmentCode}::${seed.code}`);
    } else {
      if (args.apply) {
        await prisma.shiftTemplate.create({
          data: {
            clubId: club.id, departmentId: dept.id,
            code: seed.code, name: seed.name,
            startTimeMinutes: seed.startTimeMinutes,
            endTimeMinutes: seed.endTimeMinutes,
            sortOrder: seed.sortOrder,
            active: true,
          },
        });
      }
      created.push(`${seed.departmentCode}::${seed.code}`);
    }
  }

  console.log(JSON.stringify({
    club: { id: club.id, name: club.name, stagingDataMode: club.stagingDataMode },
    dryRun: args.dryRun,
    created, updated, skipped,
  }, null, 2));

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
