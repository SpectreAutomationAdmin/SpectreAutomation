// FPP-4B (2026-09-20) — Correct the RRSP_EE + RRSP_ER canonical
// components' calculationMethod from FIXED_AMOUNT to
// PERCENT_OF_ELIGIBLE_EARNINGS.
//
// FPP-2 seeded these two components with calculationMethod=FIXED_AMOUNT
// because they were initially needed for Opening YTD dollar-amount
// entry. That is orthogonal to the LIVE benefit-plan calculation rule.
// The founder now needs to create the Club-level RRSP percentage plan,
// which fails-closed at BenefitPlan.create because linked components
// must be PERCENT_OF_ELIGIBLE_EARNINGS.
//
// Correction is safe when — and only when — every one of the following
// is true (verified before mutation):
//
//   1. Exactly the two Coulee Ridge RRSP_EE + RRSP_ER rows are targeted
//      by unique (clubId, code) lookup.
//   2. Neither component has any EmployeeRecurringPayrollComponent
//      assignment (would silently reinterpret amount vs percentBps).
//   3. Neither component has any PayrollBatchComponentSnapshot
//      (would rewrite historical payroll semantics).
//   4. Neither component is linked to any PayrollBenefitPlan (nothing
//      to reconcile).
//   5. Neither component has any PayrollScheduledOneTimeEarning
//      (percent components aren't valid one-time earnings).
//   6. Opening YTD component rows ARE permitted (they store the
//      historical dollar ytdAmount independently — schema freezes
//      componentCode/displayName/category/side/cashEffect at insert
//      per Payroll-3C-5). Chris's $3,093.79 rows will read back
//      unchanged.
//
// The correction:
//   * calculationMethod: FIXED_AMOUNT → PERCENT_OF_ELIGIBLE_EARNINGS
//   * eligibleEarningsBase: null → REGULAR_EARNINGS_ONLY
//   * every other field left UNTOUCHED (statutory treatment source,
//     rule key, taxable/CPP/EI effects, GL mappings, active, display
//     order, description, notes, createdAt).
//
// Modes:
//   --status  (default) — read-only report of the two RRSP components
//                         + their references + Chris's opening rows.
//   --apply             — verify preconditions then update in place.
//                         Idempotent: rerunning after --apply reports
//                         "already corrected" and makes no changes.
//
// Refuses production, non-Coulee clubs, and any component whose refs
// invalidate the safety proof.

const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const COULEE_MARKER = "COULEE";
const CHRIS_ID = "cmu0fiaod000187prcy9ufo2d";
const CODES = ["RRSP_EE", "RRSP_ER"];

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function bail(msg) { console.error(`\n[FPP4B][REFUSE] ${msg}\n`); process.exit(2); }
function log(msg)  { console.log(`[FPP4B] ${msg}`); }

async function assertStagingEnvironment() {
  const bypass = process.argv.includes("--i-know-this-is-staging");
  const env = process.env.SPECTRE_ENV ?? "";
  if (!bypass && env !== "staging") {
    bail(`SPECTRE_ENV="${env}" — refuse. Pass --i-know-this-is-staging inside spectre-staging.`);
  }
  const flyApp = process.env.FLY_APP_NAME ?? "";
  if (flyApp && flyApp !== "spectre-staging") bail(`FLY_APP_NAME="${flyApp}" — refuse.`);
}

async function assertCouleeClub() {
  const club = await p.club.findUnique({ where: { id: COULEE_CLUB_ID }, select: { id: true, name: true } });
  if (!club) bail(`Coulee Ridge club ${COULEE_CLUB_ID} not found.`);
  if (!club.name.toUpperCase().includes(COULEE_MARKER)) bail(`Club name "${club.name}" lacks marker.`);
  return club;
}

async function loadTargets() {
  const rows = await p.payrollComponent.findMany({
    where: { clubId: COULEE_CLUB_ID, code: { in: CODES } },
    include: {
      _count: {
        select: {
          assignments: true,
          openingBalanceRows: true,
          batchSnapshots: true,
          scheduledOneTimeEarnings: true,
          benefitPlansAsEmployee: true,
          benefitPlansAsEmployer: true,
        },
      },
    },
  });
  return rows;
}

function summariseComponent(c) {
  return {
    id: c.id, code: c.code, displayName: c.displayName,
    side: c.side, category: c.category, cashEffect: c.cashEffect,
    calculationMethod: c.calculationMethod, eligibleEarningsBase: c.eligibleEarningsBase,
    taxableEffect: c.taxableEffect, cppPensionableEffect: c.cppPensionableEffect,
    eiInsurableEffect: c.eiInsurableEffect,
    statutoryTreatmentSource: c.statutoryTreatmentSource,
    statutoryRuleKey: c.statutoryRuleKey, statutoryRuleVariant: c.statutoryRuleVariant,
    active: c.active,
    references: c._count,
  };
}

async function status(club) {
  const rows = await loadTargets();
  const chrisOpening = await p.payrollOpeningBalance.findFirst({
    where: { employeeId: CHRIS_ID, taxYear: 2026 },
    include: {
      componentOpenings: {
        where: { componentCode: { in: CODES } },
        select: { componentCode: true, ytdAmount: true, sourceComponentId: true },
      },
    },
  });
  console.log(JSON.stringify({
    club: { id: club.id, name: club.name },
    components: rows.map(summariseComponent),
    chrisOpeningRows: chrisOpening?.componentOpenings ?? [],
    chrisOpeningStatus: chrisOpening?.status ?? null,
  }, null, 2));
}

function assertSafeToCorrect(rows) {
  if (rows.length !== CODES.length) {
    bail(`Expected ${CODES.length} components (${CODES.join(", ")}), found ${rows.length}.`);
  }
  const byCode = new Map(rows.map((r) => [r.code, r]));
  for (const code of CODES) {
    const c = byCode.get(code);
    if (!c) bail(`Missing target component "${code}".`);
    if (c.clubId !== COULEE_CLUB_ID) bail(`Component ${code} clubId mismatch.`);
    if (c._count.assignments > 0) bail(`Component ${code} has ${c._count.assignments} recurring assignment(s); refuse.`);
    if (c._count.batchSnapshots > 0) bail(`Component ${code} has ${c._count.batchSnapshots} snapshot(s); refuse.`);
    if (c._count.scheduledOneTimeEarnings > 0) bail(`Component ${code} has ${c._count.scheduledOneTimeEarnings} one-time earning(s); refuse.`);
    if (c._count.benefitPlansAsEmployee > 0 || c._count.benefitPlansAsEmployer > 0) {
      bail(`Component ${code} is already linked to a benefit plan; refuse.`);
    }
  }
}

async function apply(club) {
  const before = await loadTargets();
  const allAlreadyCorrect = before.every(
    (r) =>
      r.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS" &&
      r.eligibleEarningsBase === "REGULAR_EARNINGS_ONLY",
  );
  if (allAlreadyCorrect) {
    log(`Both RRSP components already report calculationMethod=PERCENT and eligibleEarningsBase=REGULAR_EARNINGS_ONLY. No change.`);
    return;
  }
  assertSafeToCorrect(before);

  await p.$transaction(async (tx) => {
    for (const row of before) {
      await tx.payrollComponent.update({
        where: { id: row.id },
        data: {
          calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
          eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
        },
      });
      log(`Corrected ${row.code} (id=${row.id}): FIXED_AMOUNT → PERCENT_OF_ELIGIBLE_EARNINGS · eligibleEarningsBase=REGULAR_EARNINGS_ONLY`);
    }
  });

  // Post-check: Chris's opening YTD rows must be untouched.
  const chris = await p.payrollOpeningBalance.findFirst({
    where: { employeeId: CHRIS_ID, taxYear: 2026 },
    include: {
      componentOpenings: {
        where: { componentCode: { in: CODES } },
        select: { componentCode: true, ytdAmount: true },
      },
    },
  });
  log(`Chris opening YTD status: ${chris?.status}; RRSP openings: ${JSON.stringify(chris?.componentOpenings ?? [])}`);
}

(async () => {
  await assertStagingEnvironment();
  const club = await assertCouleeClub();
  const wantsApply = process.argv.includes("--apply");
  const wantsStatus = process.argv.includes("--status") || !wantsApply;
  if (wantsStatus) await status(club);
  if (wantsApply) await apply(club);
  await p.$disconnect();
})().catch((e) => { console.error(`[FPP4B][ERROR]`, e); process.exit(1); });
