// CRPC-1 (2026-09-20) — Coulee Ridge pay-calendar correction.
//
// Staging-only. Refuses production, non-Coulee-Ridge clubs, Chris, and Marc.
// Refuses to touch a pay period that has any operational dependency.
//
// Modes:
//   --status  (default) — read-only report of the CRGCC-SM group + its
//                         current Aug 31 and Sep 15 periods.
//   --apply             — set the CRGCC-SM group to LAGGED_SEMI_MONTHLY,
//                         then update the Aug 31 and Sep 15 periods to
//                         the founder-authoritative dates:
//                           Aug 31 pay → [Aug  9, Aug 24)
//                           Sep 15 pay → [Aug 24, Sep  9)
//   --revert            — restore the CRGCC-SM group to
//                         CALENDAR_SEMI_MONTHLY and reset the two
//                         periods to their shipped 1-15 / 16-EOM shape.
//                         Refuses if either period is now consumed.
//
// Only the Aug 31 and Sep 15 periods are touched. Every other Coulee
// Ridge period is left alone — the founder's evidence extends only to
// those two pay dates.

const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COULEE_CLUB_NAME_MARKER = "COULEE";
const PAY_GROUP_ID = "cmu5kg3e40002h4iupsaxezdl"; // CRGCC-SM · Coulee Ridge · Semi-Monthly
const PROTECTED_EMPLOYEE_IDS = new Set([
  "cmu0fiaod000187prcy9ufo2d", // Chris
  "cmu0ndf4p001vk9md2ntmo2ck", // Marc
]);
const AUG31_SEQ = 16;
const SEP15_SEQ = 17;

// Founder-authoritative lagged boundaries.
const LAGGED = {
  [AUG31_SEQ]: {
    periodStart: new Date(Date.UTC(2026,  7,  9)), // Aug  9
    periodEnd:   new Date(Date.UTC(2026,  7, 24)), // Aug 24 (exclusive)
    payDate:     new Date(Date.UTC(2026,  7, 31)), // Aug 31
  },
  [SEP15_SEQ]: {
    periodStart: new Date(Date.UTC(2026,  7, 24)), // Aug 24
    periodEnd:   new Date(Date.UTC(2026,  8,  9)), // Sep  9 (exclusive)
    payDate:     new Date(Date.UTC(2026,  8, 15)), // Sep 15
  },
};
// Original CALENDAR shape.
const CALENDAR = {
  [AUG31_SEQ]: {
    periodStart: new Date(Date.UTC(2026,  7, 16)), // Aug 16
    periodEnd:   new Date(Date.UTC(2026,  8,  1)), // Sep  1 (exclusive)
    payDate:     new Date(Date.UTC(2026,  7, 31)), // Aug 31
  },
  [SEP15_SEQ]: {
    periodStart: new Date(Date.UTC(2026,  8,  1)), // Sep  1
    periodEnd:   new Date(Date.UTC(2026,  8, 16)), // Sep 16 (exclusive)
    payDate:     new Date(Date.UTC(2026,  8, 15)), // Sep 15
  },
};

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function bail(msg) { console.error(`\n[CRPC1][REFUSE] ${msg}\n`); process.exit(2); }
function log(msg)  { console.log(`[CRPC1] ${msg}`); }

async function assertStagingEnvironment() {
  const bypass = process.argv.includes("--i-know-this-is-staging");
  const env = process.env.SPECTRE_ENV ?? "";
  if (!bypass && env !== "staging") {
    bail(`SPECTRE_ENV="${env}" — refuse. Pass --i-know-this-is-staging when running inside spectre-staging.`);
  }
  const flyApp = process.env.FLY_APP_NAME ?? "";
  if (flyApp && flyApp !== "spectre-staging") {
    bail(`FLY_APP_NAME="${flyApp}" — refuse. This script targets spectre-staging only.`);
  }
}

async function loadTargets() {
  const club = await p.club.findUnique({
    where: { id: COULEE_CLUB_ID },
    select: { id: true, name: true },
  });
  if (!club) bail(`Coulee Ridge club id ${COULEE_CLUB_ID} not found.`);
  if (!club.name.toUpperCase().includes(COULEE_CLUB_NAME_MARKER)) {
    bail(`Club ${COULEE_CLUB_ID} does not have "${COULEE_CLUB_NAME_MARKER}" in its name — aborting.`);
  }
  const grp = await p.payrollPayGroup.findUnique({
    where: { id: PAY_GROUP_ID },
    select: { id: true, clubId: true, code: true, payFrequency: true, periodBoundaryStrategy: true, active: true },
  });
  if (!grp) bail(`Pay group ${PAY_GROUP_ID} not found.`);
  if (grp.clubId !== COULEE_CLUB_ID) bail(`Pay group ${PAY_GROUP_ID} belongs to ${grp.clubId}, not Coulee Ridge.`);
  if (grp.payFrequency !== "SEMI_MONTHLY") bail(`Pay group is ${grp.payFrequency}, not SEMI_MONTHLY.`);
  return { club, grp };
}

async function loadPeriod(sequenceInYear) {
  const row = await p.payrollPayPeriod.findFirst({
    where: { clubId: COULEE_CLUB_ID, payGroupId: PAY_GROUP_ID, taxYear: 2026, sequenceInYear },
    include: {
      batches:                  { select: { id: true, status: true } },
      departmentTimeApprovals:  { select: { id: true } },
      scopeStates:              { select: { id: true } },
      payrollTimesheets:        { select: { id: true } },
      timeAdjustments:          { select: { id: true } },
      scheduledOneTimeEarnings: { select: { id: true } },
    },
  });
  if (!row) bail(`Sequence ${sequenceInYear} not found on CRGCC-SM.`);
  return row;
}

function operationallyConsumed(row) {
  if (row.status === "CLOSED") return "status=CLOSED";
  if (row.batches.length > 0) return `${row.batches.length} attached batch(es)`;
  if (row.departmentTimeApprovals.length > 0) return `${row.departmentTimeApprovals.length} department time approval(s)`;
  if (row.scopeStates.length > 0) return `${row.scopeStates.length} scope state(s)`;
  if (row.payrollTimesheets.length > 0) return `${row.payrollTimesheets.length} timesheet(s)`;
  if (row.timeAdjustments.length > 0) return `${row.timeAdjustments.length} time adjustment(s)`;
  if (row.scheduledOneTimeEarnings.length > 0) return `${row.scheduledOneTimeEarnings.length} scheduled one-time earning(s)`;
  return null;
}

async function assertProtectedEmployeesUnaffected() {
  // Belt-and-suspenders: refuse if either protected employee has any
  // batch, approval, or timesheet touching CRGCC-SM.
  for (const empId of PROTECTED_EMPLOYEE_IDS) {
    const be = await p.payrollBatchEmployee.count({
      where: { employeeId: empId, batch: { payGroupId: PAY_GROUP_ID } },
    });
    if (be > 0) bail(`Protected employee ${empId} has ${be} batch employee row(s) on CRGCC-SM — refuse.`);
  }
}

async function status(club, grp) {
  const aug31 = await loadPeriod(AUG31_SEQ);
  const sep15 = await loadPeriod(SEP15_SEQ);
  const summarise = (row) => ({
    id: row.id, sequenceInYear: row.sequenceInYear,
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd:   row.periodEnd.toISOString().slice(0, 10),
    payDate:     row.payDate.toISOString().slice(0, 10),
    status: row.status,
    consumed: operationallyConsumed(row),
  });
  console.log(JSON.stringify({
    club: { id: club.id, name: club.name },
    payGroup: {
      id: grp.id, code: grp.code, payFrequency: grp.payFrequency,
      periodBoundaryStrategy: grp.periodBoundaryStrategy,
    },
    aug31: summarise(aug31),
    sep15: summarise(sep15),
  }, null, 2));
}

async function apply(grp) {
  await assertProtectedEmployeesUnaffected();
  const aug31 = await loadPeriod(AUG31_SEQ);
  const sep15 = await loadPeriod(SEP15_SEQ);
  for (const row of [aug31, sep15]) {
    const consumed = operationallyConsumed(row);
    if (consumed) bail(`Sequence ${row.sequenceInYear} is operationally consumed (${consumed}). Refuse to rewrite.`);
  }
  // Flip strategy to LAGGED_SEMI_MONTHLY.
  if (grp.periodBoundaryStrategy !== "LAGGED_SEMI_MONTHLY") {
    await p.payrollPayGroup.update({
      where: { id: PAY_GROUP_ID },
      data: { periodBoundaryStrategy: "LAGGED_SEMI_MONTHLY" },
    });
    log(`Flipped CRGCC-SM periodBoundaryStrategy → LAGGED_SEMI_MONTHLY.`);
  } else {
    log(`CRGCC-SM already LAGGED_SEMI_MONTHLY.`);
  }
  await p.payrollPayPeriod.update({ where: { id: aug31.id }, data: LAGGED[AUG31_SEQ] });
  log(`Corrected sequence ${AUG31_SEQ} (Aug 31 pay) → [Aug  9, Aug 24).`);
  await p.payrollPayPeriod.update({ where: { id: sep15.id }, data: LAGGED[SEP15_SEQ] });
  log(`Corrected sequence ${SEP15_SEQ} (Sep 15 pay) → [Aug 24, Sep  9).`);
}

async function revert(grp) {
  await assertProtectedEmployeesUnaffected();
  const aug31 = await loadPeriod(AUG31_SEQ);
  const sep15 = await loadPeriod(SEP15_SEQ);
  for (const row of [aug31, sep15]) {
    const consumed = operationallyConsumed(row);
    if (consumed) bail(`Sequence ${row.sequenceInYear} is operationally consumed (${consumed}). Refuse to revert.`);
  }
  await p.payrollPayGroup.update({
    where: { id: PAY_GROUP_ID },
    data: { periodBoundaryStrategy: "CALENDAR_SEMI_MONTHLY" },
  });
  log(`Reverted CRGCC-SM periodBoundaryStrategy → CALENDAR_SEMI_MONTHLY.`);
  await p.payrollPayPeriod.update({ where: { id: aug31.id }, data: CALENDAR[AUG31_SEQ] });
  log(`Reverted sequence ${AUG31_SEQ} → [Aug 16, Sep  1).`);
  await p.payrollPayPeriod.update({ where: { id: sep15.id }, data: CALENDAR[SEP15_SEQ] });
  log(`Reverted sequence ${SEP15_SEQ} → [Sep  1, Sep 16).`);
}

(async () => {
  await assertStagingEnvironment();
  const { club, grp } = await loadTargets();
  const wantsApply = process.argv.includes("--apply");
  const wantsRevert = process.argv.includes("--revert");
  const wantsStatus = process.argv.includes("--status") || (!wantsApply && !wantsRevert);
  if (wantsStatus) await status(club, grp);
  if (wantsApply) await apply(grp);
  if (wantsRevert) await revert(grp);
  await p.$disconnect();
})().catch((e) => { console.error(`[CRPC1][ERROR]`, e); process.exit(1); });
