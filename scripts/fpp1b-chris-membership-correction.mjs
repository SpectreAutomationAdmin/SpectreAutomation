// FPP-1B (2026-09-20) — Chris Turcato CRGCC-SM membership effectiveFrom
// correction. Staging-only. Narrowly-scoped mutation of ONE membership
// row: shift effectiveFrom from 2026-09-16 → 2026-08-24 so Chris becomes
// eligible for the Sep 15 founder parallel payroll.
//
// Fails closed unless every one of the 15 preconditions holds. Refuses
// production, refuses any employee other than Chris, refuses any pay
// group other than CRGCC-SM, refuses Marc entirely.
//
// Modes:
//   --status  (default) — read-only. Prints each precondition + PASS/FAIL.
//   --apply             — verify all preconditions then UPDATE only
//                         Chris's active CRGCC-SM membership's
//                         effectiveFrom to 2026-08-24. Nothing else.
//
// Does NOT:
//   - delete or recreate Chris
//   - create a second active membership
//   - change the pay group itself
//   - change any pay period
//   - touch Marc

const CHRIS_ID = "cmu0fiaod000187prcy9ufo2d";
const MARC_ID  = "cmu0ndf4p001vk9md2ntmo2ck";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const CRGCC_SM_PG_ID = "cmu5kg3e40002h4iupsaxezdl";
const CURRENT_EFFECTIVE_FROM_ISO = "2026-09-16T00:00:00.000Z";
const TARGET_EFFECTIVE_FROM_ISO  = "2026-08-24T00:00:00.000Z";
const SEP15_EXPECTED = {
  periodStartIso: "2026-08-24T00:00:00.000Z",
  periodEndIso:   "2026-09-09T00:00:00.000Z",
  payDateIso:     "2026-09-15T00:00:00.000Z",
};

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function bail(msg) { console.error(`\n[FPP1B][REFUSE] ${msg}\n`); process.exit(2); }
function log(msg)  { console.log(`[FPP1B] ${msg}`); }

async function assertStagingEnvironment() {
  const bypass = process.argv.includes("--i-know-this-is-staging");
  const env = process.env.SPECTRE_ENV ?? "";
  if (!bypass && env !== "staging") {
    bail(`SPECTRE_ENV="${env}" — refuse. Pass --i-know-this-is-staging inside spectre-staging.`);
  }
  const flyApp = process.env.FLY_APP_NAME ?? "";
  if (flyApp && flyApp !== "spectre-staging") {
    bail(`FLY_APP_NAME="${flyApp}" — refuse.`);
  }
}

async function gather() {
  const club = await p.club.findUnique({
    where: { id: COULEE_CLUB_ID },
    select: { id: true, name: true },
  });
  const chris = await p.employee.findUnique({
    where: { id: CHRIS_ID },
    select: { id: true, firstName: true, lastName: true, employeeNumber: true, clubId: true },
  });
  const chrisComp = await p.employeeCompensation.findFirst({
    where: { employeeId: CHRIS_ID, effectiveTo: null },
    select: { id: true, cadence: true, rate: true, effectiveFrom: true },
  });
  const pg = await p.payrollPayGroup.findUnique({
    where: { id: CRGCC_SM_PG_ID },
    select: {
      id: true, clubId: true, code: true, name: true,
      payFrequency: true, periodBoundaryStrategy: true, active: true,
    },
  });
  const activeMemberships = await p.payrollPayGroupMember.findMany({
    where: { employeeId: CHRIS_ID, payGroupId: CRGCC_SM_PG_ID, effectiveTo: null },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  const sep15 = await p.payrollPayPeriod.findFirst({
    where: {
      clubId: COULEE_CLUB_ID, payGroupId: CRGCC_SM_PG_ID,
      taxYear: 2026, sequenceInYear: 17,
    },
    include: {
      batches:                  { select: { id: true, status: true } },
      departmentTimeApprovals:  { select: { id: true } },
      scopeStates:              { select: { id: true } },
      payrollTimesheets:        { select: { id: true } },
      timeAdjustments:          { select: { id: true } },
      scheduledOneTimeEarnings: { select: { id: true } },
    },
  });
  const chrisBatchEmployees            = await p.payrollBatchEmployee.count({ where: { employeeId: CHRIS_ID } });
  const chrisOpeningBalances           = await p.payrollOpeningBalance.count({ where: { employeeId: CHRIS_ID } });
  const chrisOpeningBalanceComponents  = await p.payrollOpeningBalanceComponent.count({
    where: { openingBalance: { employeeId: CHRIS_ID } },
  });
  const chrisOneTime                   = await p.payrollScheduledOneTimeEarning.count({ where: { employeeId: CHRIS_ID } });
  const chrisApprovedTime              = await p.payrollApprovedTimeEntry.count({ where: { employeeId: CHRIS_ID } });
  const chrisComponentSnapshots        = await p.payrollBatchComponentSnapshot.count({ where: { employeeId: CHRIS_ID } });
  const chrisPostedGl                  = await p.payrollBatch.count({
    where: {
      employees: { some: { employeeId: CHRIS_ID } },
      glJournalEntryId: { not: null },
      status: "POSTED",
    },
  });
  return {
    club, chris, chrisComp, pg, activeMemberships, sep15,
    counts: {
      chrisBatchEmployees, chrisOpeningBalances, chrisOpeningBalanceComponents,
      chrisOneTime, chrisApprovedTime, chrisComponentSnapshots, chrisPostedGl,
    },
  };
}

function pcond(label, pass, detail) {
  const tag = pass ? "PASS" : "FAIL";
  return { label, pass, detail, line: `  [${tag}] ${label}${detail ? ` — ${detail}` : ""}` };
}

async function evaluate() {
  const s = await gather();
  const results = [
    pcond(
      "1. exact club = Coulee Ridge Golf & Country Club",
      s.club?.name === "Coulee Ridge Golf & Country Club",
      s.club ? `name="${s.club.name}"` : "club not found",
    ),
    pcond(
      "2. exact employee = Chris Turcato / E-00002",
      s.chris?.firstName === "Chris" && s.chris?.lastName === "Turcato" && s.chris?.employeeNumber === "E-00002",
      s.chris ? `${s.chris.firstName} ${s.chris.lastName} / ${s.chris.employeeNumber}` : "not found",
    ),
    pcond(
      "3. exact pay group = CRGCC-SM",
      s.pg?.code === "CRGCC-SM" && s.pg?.clubId === COULEE_CLUB_ID,
      s.pg ? `code=${s.pg.code} club=${s.pg.clubId}` : "not found",
    ),
    pcond(
      "4. pay frequency = SEMI_MONTHLY",
      s.pg?.payFrequency === "SEMI_MONTHLY",
      s.pg?.payFrequency,
    ),
    pcond(
      "5. periodBoundaryStrategy = LAGGED_SEMI_MONTHLY",
      s.pg?.periodBoundaryStrategy === "LAGGED_SEMI_MONTHLY",
      s.pg?.periodBoundaryStrategy,
    ),
    pcond(
      "6. current membership effectiveFrom = 2026-09-16",
      s.activeMemberships.length === 1 &&
        s.activeMemberships[0].effectiveFrom.toISOString() === CURRENT_EFFECTIVE_FROM_ISO,
      s.activeMemberships.length === 1
        ? s.activeMemberships[0].effectiveFrom.toISOString()
        : `${s.activeMemberships.length} active memberships`,
    ),
    pcond("7. Chris has zero PayrollBatchEmployee history",     s.counts.chrisBatchEmployees === 0, `${s.counts.chrisBatchEmployees}`),
    pcond("8. Chris has zero opening balances",                 s.counts.chrisOpeningBalances === 0, `${s.counts.chrisOpeningBalances}`),
    pcond("9. Chris has zero opening component balances",       s.counts.chrisOpeningBalanceComponents === 0, `${s.counts.chrisOpeningBalanceComponents}`),
    pcond("10. Chris has zero one-time payroll earnings",       s.counts.chrisOneTime === 0, `${s.counts.chrisOneTime}`),
    pcond("11. Chris has zero approved payroll time",           s.counts.chrisApprovedTime === 0, `${s.counts.chrisApprovedTime}`),
    pcond("12. Chris has zero payroll component snapshots",     s.counts.chrisComponentSnapshots === 0, `${s.counts.chrisComponentSnapshots}`),
    pcond("13. Chris has zero posted payroll GL history",       s.counts.chrisPostedGl === 0, `${s.counts.chrisPostedGl}`),
    pcond(
      "14. Sep 15 pay period exactly [2026-08-24, 2026-09-09), payDate 2026-09-15",
      s.sep15 &&
        s.sep15.periodStart.toISOString() === SEP15_EXPECTED.periodStartIso &&
        s.sep15.periodEnd.toISOString()   === SEP15_EXPECTED.periodEndIso &&
        s.sep15.payDate.toISOString()     === SEP15_EXPECTED.payDateIso,
      s.sep15
        ? `[${s.sep15.periodStart.toISOString().slice(0, 10)}, ${s.sep15.periodEnd.toISOString().slice(0, 10)}) pay ${s.sep15.payDate.toISOString().slice(0, 10)}`
        : "not found",
    ),
    pcond(
      "15. Sep 15 period has NO batch / approval / timesheet / adjustment / scope state / one-time",
      s.sep15 &&
        s.sep15.batches.length === 0 &&
        s.sep15.departmentTimeApprovals.length === 0 &&
        s.sep15.scopeStates.length === 0 &&
        s.sep15.payrollTimesheets.length === 0 &&
        s.sep15.timeAdjustments.length === 0 &&
        s.sep15.scheduledOneTimeEarnings.length === 0,
      s.sep15
        ? `batches=${s.sep15.batches.length} approvals=${s.sep15.departmentTimeApprovals.length} scope=${s.sep15.scopeStates.length} timesheets=${s.sep15.payrollTimesheets.length} adjustments=${s.sep15.timeAdjustments.length} oneTime=${s.sep15.scheduledOneTimeEarnings.length}`
        : "n/a",
    ),
  ];
  return { snapshot: s, results };
}

async function assertMarcUntouched() {
  const marc = await p.employee.findUnique({ where: { id: MARC_ID }, select: { id: true, firstName: true, lastName: true } });
  if (!marc || marc.firstName !== "Marc" || marc.lastName !== "Maldiney") {
    bail(`Sanity: Marc record moved or renamed. Aborting to preserve zero-write invariant on Marc.`);
  }
}

(async () => {
  await assertStagingEnvironment();
  const { snapshot, results } = await evaluate();
  console.log("\n=== FPP-1B pre-write provenance ===");
  for (const r of results) console.log(r.line);
  const allPass = results.every((r) => r.pass);
  console.log(`\n${allPass ? "ALL 15 preconditions PASS" : "PRECONDITIONS FAIL"}\n`);

  const wantsApply = process.argv.includes("--apply");
  if (!wantsApply) return;
  if (!allPass) bail("Refusing --apply: one or more preconditions failed. See above.");

  await assertMarcUntouched();

  const membership = snapshot.activeMemberships[0];
  const beforeIso = membership.effectiveFrom.toISOString();
  await p.payrollPayGroupMember.update({
    where: { id: membership.id },
    data: { effectiveFrom: new Date(TARGET_EFFECTIVE_FROM_ISO) },
  });
  const afterRow = await p.payrollPayGroupMember.findUniqueOrThrow({
    where: { id: membership.id },
    select: { id: true, effectiveFrom: true, effectiveTo: true, employeeId: true, payGroupId: true },
  });
  log(`APPLY OK — membership ${membership.id}`);
  log(`  before.effectiveFrom = ${beforeIso}`);
  log(`  after.effectiveFrom  = ${afterRow.effectiveFrom.toISOString()}`);
  log(`  effectiveTo          = ${afterRow.effectiveTo?.toISOString() ?? "null"}`);
})().catch((e) => { console.error(`[FPP1B][ERROR]`, e); process.exit(1); });
