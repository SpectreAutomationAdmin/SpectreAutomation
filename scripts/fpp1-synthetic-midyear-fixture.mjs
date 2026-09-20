// FPP-1 (2026-09-20) §1 — synthetic MID_YEAR fixture management.
//
// Purpose: prepare the synthetic Slice-C tenant so its
// PayrollImplementationDeclaration is MID_YEAR_MIGRATION with a valid
// firstSpectrePayDate, and (optionally) roll it back to
// ZERO_OPENING_YTD when acceptance is done.
//
// Modes:
//   --apply   →  set MID_YEAR_MIGRATION + firstSpectrePayDate
//   --revert  →  restore ZERO_OPENING_YTD (and clear DRAFT opening balances
//                on the synthetic employees created by this fixture)
//   --status  →  read-only report of current declaration + counts
//
// Safety guards (all failures fail-CLOSED with a distinctive banner):
//   1. `SPECTRE_ENV` MUST be "staging" or the caller passes
//      `--i-know-this-is-staging`. Never runs in production.
//   2. The Fly app hostname (when running via `flyctl ssh console`)
//      MUST resolve to `spectre-staging`.
//   3. Refuses any club whose id is on the PROTECTED list (Coulee
//      Ridge in particular) or whose name lacks the SYNTHETIC_MARKER
//      substrings.
//   4. Never touches Chris (`cmu0fiaod000187prcy9ufo2d`) or
//      Marc (`cmu0ndf4p001vk9md2ntmo2ck`).
//   5. `PayrollImplementationDeclaration.notes` is stamped with a
//      distinctive `FPP1_SYNTHETIC_FIXTURE:` prefix so a reviewer can
//      audit that the row is fixture-owned.
//   6. `--revert` refuses if any ACTIVE opening balance exists for a
//      synthetic employee — a live opening balance is a founder-
//      authored artefact that this script MUST NOT roll back.

const SYNTHETIC_CLUB_ID = "cmu7srgkz0000oof9yzxo2izy";
const SYNTHETIC_CLUB_NAME_MARKERS = ["SLICE C BENEFITS TEST", "SYNTHETIC"];
const PROTECTED_CLUB_IDS = new Set([
  "cmrvdeny7000144372ktmmg9c", // Coulee Ridge
]);
const PROTECTED_EMPLOYEE_IDS = new Set([
  "cmu0fiaod000187prcy9ufo2d", // Chris Turcato
  "cmu0ndf4p001vk9md2ntmo2ck", // Marc Maldiney
]);
const NOTES_PREFIX = "FPP1_SYNTHETIC_FIXTURE:";
const DEFAULT_FIRST_SPECTRE_PAY_ISO = "2026-10-15";

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function bail(msg) {
  console.error(`\n[FPP1-FIXTURE][REFUSE] ${msg}\n`);
  process.exit(2);
}

function log(msg) {
  console.log(`[FPP1-FIXTURE] ${msg}`);
}

async function assertStagingEnvironment() {
  const bypass = process.argv.includes("--i-know-this-is-staging");
  const env = process.env.SPECTRE_ENV ?? "";
  if (!bypass && env !== "staging") {
    bail(
      `SPECTRE_ENV="${env}" — refusing to run outside staging. ` +
        `If you are running inside \`flyctl ssh console\` on spectre-staging, ` +
        `pass --i-know-this-is-staging or export SPECTRE_ENV=staging.`,
    );
  }
  const flyApp = process.env.FLY_APP_NAME ?? process.env.FLY_APP ?? "";
  if (flyApp && flyApp !== "spectre-staging") {
    bail(`FLY_APP_NAME="${flyApp}" — refusing. This script targets spectre-staging only.`);
  }
}

async function assertSyntheticClub() {
  const club = await p.club.findUnique({
    where: { id: SYNTHETIC_CLUB_ID },
    select: { id: true, name: true },
  });
  if (!club) {
    bail(`Synthetic club id ${SYNTHETIC_CLUB_ID} not found on this database.`);
  }
  if (PROTECTED_CLUB_IDS.has(club.id)) {
    bail(`PROTECTED_CLUB match on ${club.id} (${club.name}). Aborting.`);
  }
  const nameUpper = club.name.toUpperCase();
  const hasMarker = SYNTHETIC_CLUB_NAME_MARKERS.some((m) => nameUpper.includes(m));
  if (!hasMarker) {
    bail(
      `Club name "${club.name}" does not contain a synthetic marker ` +
        `(${SYNTHETIC_CLUB_NAME_MARKERS.join(" | ")}). Aborting.`,
    );
  }
  return club;
}

async function readStatus(club) {
  const decl = await p.payrollImplementationDeclaration.findUnique({
    where: { clubId_taxYear: { clubId: club.id, taxYear: 2026 } },
  });
  const employees = await p.employee.findMany({
    where: { clubId: club.id },
    select: { id: true, firstName: true, lastName: true, employeeNumber: true },
  });
  const empIds = employees.map((e) => e.id);
  const openings = await p.payrollOpeningBalance.findMany({
    where: { employeeId: { in: empIds }, taxYear: 2026 },
    select: {
      id: true, employeeId: true, status: true, throughPayDate: true,
      priorPayrollKind: true,
    },
  });
  const componentOpenings = await p.payrollOpeningBalanceComponent.count({
    where: { openingBalance: { employeeId: { in: empIds }, taxYear: 2026 } },
  });
  return { decl, employees, openings, componentOpenings };
}

async function apply(club) {
  // Never touch a protected employee even if they were somehow linked
  // to the synthetic club (defence in depth).
  const emps = await p.employee.findMany({
    where: { clubId: club.id },
    select: { id: true },
  });
  for (const e of emps) {
    if (PROTECTED_EMPLOYEE_IDS.has(e.id)) {
      bail(`Synthetic club unexpectedly contains a PROTECTED employee (${e.id}). Aborting.`);
    }
  }

  const firstPay = new Date(process.env.FPP1_FIRST_SPECTRE_PAY_ISO ?? DEFAULT_FIRST_SPECTRE_PAY_ISO);
  if (Number.isNaN(firstPay.getTime())) {
    bail(`FPP1_FIRST_SPECTRE_PAY_ISO="${process.env.FPP1_FIRST_SPECTRE_PAY_ISO}" is not a valid date.`);
  }
  const notes = `${NOTES_PREFIX} MID_YEAR_MIGRATION set by fpp1-synthetic-midyear-fixture.mjs at ${new Date().toISOString()}`;
  const decl = await p.payrollImplementationDeclaration.upsert({
    where: { clubId_taxYear: { clubId: club.id, taxYear: 2026 } },
    create: {
      clubId: club.id,
      taxYear: 2026,
      mode: "MID_YEAR_MIGRATION",
      firstSpectrePayDate: firstPay,
      confirmedAt: new Date(),
      notes,
    },
    update: {
      mode: "MID_YEAR_MIGRATION",
      firstSpectrePayDate: firstPay,
      confirmedAt: new Date(),
      notes,
    },
  });
  log(`APPLY OK — clubId=${club.id} taxYear=2026 mode=${decl.mode} firstSpectrePayDate=${decl.firstSpectrePayDate?.toISOString().slice(0, 10)}`);
}

async function revert(club) {
  const emps = await p.employee.findMany({
    where: { clubId: club.id },
    select: { id: true },
  });
  const empIds = emps.map((e) => e.id);
  const activeOpenings = await p.payrollOpeningBalance.count({
    where: { employeeId: { in: empIds }, taxYear: 2026, status: "ACTIVE" },
  });
  if (activeOpenings > 0) {
    bail(
      `${activeOpenings} ACTIVE opening balance(s) exist for synthetic employees. ` +
        `--revert refuses to remove founder-authored artefacts. Deactivate them first via the app UI.`,
    );
  }
  // Delete DRAFT/VALIDATED openings created during acceptance. Component
  // openings cascade via onDelete: Cascade in the schema.
  const drafts = await p.payrollOpeningBalance.findMany({
    where: { employeeId: { in: empIds }, taxYear: 2026, status: { in: ["DRAFT", "VALIDATED"] } },
    select: { id: true },
  });
  if (drafts.length > 0) {
    await p.payrollOpeningBalance.deleteMany({
      where: { id: { in: drafts.map((d) => d.id) } },
    });
    log(`Deleted ${drafts.length} DRAFT/VALIDATED opening balance(s) on synthetic employees.`);
  }
  const notes = `${NOTES_PREFIX} reverted to ZERO_OPENING_YTD at ${new Date().toISOString()}`;
  const decl = await p.payrollImplementationDeclaration.upsert({
    where: { clubId_taxYear: { clubId: club.id, taxYear: 2026 } },
    create: {
      clubId: club.id,
      taxYear: 2026,
      mode: "ZERO_OPENING_YTD",
      firstSpectrePayDate: null,
      confirmedAt: new Date(),
      notes,
    },
    update: {
      mode: "ZERO_OPENING_YTD",
      firstSpectrePayDate: null,
      confirmedAt: new Date(),
      notes,
    },
  });
  log(`REVERT OK — clubId=${club.id} taxYear=2026 mode=${decl.mode}`);
}

(async () => {
  await assertStagingEnvironment();
  const club = await assertSyntheticClub();
  const wantsApply = process.argv.includes("--apply");
  const wantsRevert = process.argv.includes("--revert");
  const wantsStatus = process.argv.includes("--status") || (!wantsApply && !wantsRevert);
  if (wantsStatus) {
    const s = await readStatus(club);
    console.log(JSON.stringify({
      club: { id: club.id, name: club.name },
      declaration: s.decl,
      employees: s.employees,
      openingBalances: s.openings,
      componentOpenings: s.componentOpenings,
    }, null, 2));
  }
  if (wantsApply) await apply(club);
  if (wantsRevert) await revert(club);
  await p.$disconnect();
})().catch((err) => {
  console.error(`[FPP1-FIXTURE][ERROR]`, err);
  process.exit(1);
});
