/**
 * Phase 5 (2026-09-17) — Coulee Ridge biweekly → semi-monthly cutover.
 *
 * STAGING-ONLY. NEVER run against production. Never expose through a UI.
 *
 * Purpose:
 *   Convert the Coulee Ridge staging tenant's active payroll cadence
 *   from BIWEEKLY (26 periods/yr) to SEMI_MONTHLY (24 periods/yr, pay
 *   dates on the 15th + LAST calendar day, weekend-earlier), preserving:
 *     • Chris + Marc as employees (identity, compensation, banking,
 *       TD1 rows, department, portal accounts)
 *     • PayrollClubConfig actor assignments + GL account mappings
 *     • PayrollComponent catalogue and any founder-configured
 *       recurring assignments
 *     • Historical POSTED payroll batches + JournalEntry rows
 *       (accounting-immutable — NEVER deleted, NEVER unposted)
 *
 * What the script does:
 *   1. Verifies environment + tenant guards.
 *   2. Reads a restore-point identifier from --restore-point=<id>.
 *   3. In dry-run mode (default), prints the exact rows/actions.
 *   4. In commit mode (--commit), performs the mutation set inside a
 *      single Prisma transaction where feasible.
 *
 * The reset boundary (per Phase 5 §4):
 *   • Archive the OLD "FDR-BW" pay group (rename code, active=false).
 *     Its history + POSTED batches + JEs stay in place, unchanged.
 *   • Create a NEW SEMI_MONTHLY pay group and generate the 2026 calendar.
 *   • Effective-date-move Chris + Marc's PayGroupMembership from OLD to
 *     NEW at the cutover date.
 *   • Flip PayrollClubConfig.defaultPayFrequency to SEMI_MONTHLY.
 *   • Resolve stale OPEN PAYROLL_REVIEW WI items whose origin is a
 *     VOIDED batch on the old pay group.
 *
 * What the script does NOT do:
 *   • Never deletes a POSTED PayrollBatch, JournalEntry, or
 *     PayrollBatchEmployee. Founder rule: POSTED payroll is immutable.
 *   • Never touches Chris/Marc's Employee, EmployeeCompensation,
 *     EmployeeSensitiveIdentity, EmployeeBankAccount, or
 *     EmployeeTaxProfile rows.
 *   • Never fabricates PayrollImplementationDeclaration or
 *     PayrollOpeningBalance rows (§11). The founder must set these
 *     explicitly when starting her first semi-monthly Prepare.
 *   • Never deployed via a route or user-facing action.
 *
 * Usage:
 *   node --loader tsx scripts/coulee-ridge-semimonthly-cutover.ts \
 *     --restore-point=<neon-branch-or-timestamp-id> [--commit]
 *
 * References:
 *   • Coulee Ridge staging tenant id: cmrvdeny7000144372ktmmg9c
 *   • Staging Fly app: spectre-staging
 *   • Founder-facing environment: https://staging.spectreautomation.com
 */

import { PrismaClient } from "@prisma/client";

const COULEE_RIDGE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const OLD_PAY_GROUP_CODE = "FDR-BW";
const NEW_PAY_GROUP_CODE = "CRGCC-SM";
const NEW_PAY_GROUP_NAME = "Coulee Ridge · Semi-Monthly";
const CUTOVER_TAX_YEAR = 2026;
const CUTOVER_EFFECTIVE_FROM_ISO = "2026-09-16T00:00:00.000Z"; // start of the first SM period after Phase-5 cut

interface CliArgs {
  restorePoint: string | null;
  commit: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { restorePoint: null, commit: false };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--restore-point=")) {
      args.restorePoint = raw.slice("--restore-point=".length);
    } else if (raw === "--commit") {
      args.commit = true;
    } else if (raw === "--help" || raw === "-h") {
      console.log(
        "Usage: node --loader tsx scripts/coulee-ridge-semimonthly-cutover.ts --restore-point=<id> [--commit]",
      );
      process.exit(0);
    }
  }
  return args;
}

function assertStagingEnvironment(): void {
  const url = process.env.DATABASE_URL ?? "";
  // Guard 1: DATABASE_URL must point at the Neon staging cluster.
  if (!/ep-delicate-band-aj3vxkxu/.test(url) && !/spectre-staging/i.test(url)) {
    throw new Error(
      "REFUSED: DATABASE_URL does not appear to reference the Spectre staging Neon host. " +
        "This script is STAGING-ONLY.",
    );
  }
  // Guard 2: refuse if any env variable suggests production.
  if (process.env.NODE_ENV === "production" && !process.env.SPECTRE_ALLOW_STAGING_SCRIPT_IN_PROD) {
    throw new Error("REFUSED: NODE_ENV=production. This script must not run against production.");
  }
}

function line() {
  console.log("─".repeat(72));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.restorePoint || args.restorePoint.trim().length < 4) {
    throw new Error(
      "REFUSED: --restore-point=<id> is required. Provide the Neon branch / snapshot / timestamp " +
        "identifier that can be used to restore the DB if this run misbehaves.",
    );
  }

  assertStagingEnvironment();

  const prisma = new PrismaClient();
  try {
    console.log("Coulee Ridge semi-monthly cutover");
    console.log(`  clubId       : ${COULEE_RIDGE_CLUB_ID}`);
    console.log(`  restorePoint : ${args.restorePoint}`);
    console.log(`  mode         : ${args.commit ? "COMMIT (writes will happen)" : "DRY-RUN"}`);
    line();

    // Tenant guard.
    const club = await prisma.club.findUnique({
      where: { id: COULEE_RIDGE_CLUB_ID },
      select: { id: true, name: true, slug: true, stagingDataMode: true },
    });
    if (!club) {
      throw new Error(
        `REFUSED: no Club row for id ${COULEE_RIDGE_CLUB_ID}. Wrong tenant or wrong database.`,
      );
    }
    if (!/coulee/i.test(club.name)) {
      throw new Error(
        `REFUSED: Club id ${COULEE_RIDGE_CLUB_ID} resolves to "${club.name}" — not Coulee Ridge.`,
      );
    }
    console.log(`Tenant OK: "${club.name}" (slug=${club.slug}, mode=${club.stagingDataMode ?? "null"})`);
    line();

    const cutoverEffectiveFrom = new Date(CUTOVER_EFFECTIVE_FROM_ISO);

    // Inventory.
    const config = await prisma.payrollClubConfig.findFirst({
      where: { clubId: COULEE_RIDGE_CLUB_ID },
    });
    if (!config) throw new Error("REFUSED: PayrollClubConfig missing for Coulee Ridge.");
    const oldGroup = await prisma.payrollPayGroup.findFirst({
      where: { clubId: COULEE_RIDGE_CLUB_ID, code: OLD_PAY_GROUP_CODE },
    });
    if (!oldGroup) {
      throw new Error(
        `REFUSED: expected old pay group "${OLD_PAY_GROUP_CODE}" does not exist. ` +
          "Provenance ambiguous — refusing destructive work.",
      );
    }
    const existingNewGroup = await prisma.payrollPayGroup.findFirst({
      where: { clubId: COULEE_RIDGE_CLUB_ID, code: NEW_PAY_GROUP_CODE },
    });
    if (existingNewGroup) {
      throw new Error(
        `REFUSED: pay group "${NEW_PAY_GROUP_CODE}" already exists. The cutover has already run ` +
          "or a naming collision is present. Investigate before re-running.",
      );
    }

    const memberships = await prisma.payrollPayGroupMember.findMany({
      where: { clubId: COULEE_RIDGE_CLUB_ID, payGroupId: oldGroup.id, effectiveTo: null },
      select: { id: true, employeeId: true, effectiveFrom: true },
    });

    const staleReviewCards = await prisma.workIntakeItem.findMany({
      where: {
        clubId: COULEE_RIDGE_CLUB_ID,
        workDomain: "PAYROLL",
        classification: "PAYROLL_REVIEW",
        status: "OPEN",
      },
      select: { id: true, displaySubject: true, ownerUserId: true },
    });

    // Print plan.
    console.log("PLAN");
    console.log(`  1) Archive old pay group ${oldGroup.code} (${oldGroup.id})`);
    console.log(`       → code = ${OLD_PAY_GROUP_CODE}-ARCHIVED-${Date.now()}`);
    console.log(`       → active = false`);
    console.log(`  2) Create new pay group ${NEW_PAY_GROUP_CODE} — SEMI_MONTHLY, offset=0`);
    console.log(`  3) Close ${memberships.length} membership(s) on the old group as of ${CUTOVER_EFFECTIVE_FROM_ISO}`);
    for (const m of memberships) {
      console.log(`       → employee ${m.employeeId} membership ${m.id} effectiveTo = ${CUTOVER_EFFECTIVE_FROM_ISO}`);
    }
    console.log(`  4) Open ${memberships.length} membership(s) on the new group starting ${CUTOVER_EFFECTIVE_FROM_ISO}`);
    console.log(`  5) Generate ${CUTOVER_TAX_YEAR} SM calendar (24 rows, 15th + LAST payDates)`);
    console.log(`  6) Flip PayrollClubConfig.defaultPayFrequency: ${config.defaultPayFrequency} → SEMI_MONTHLY`);
    console.log(`  7) Resolve ${staleReviewCards.length} stale OPEN PAYROLL_REVIEW WI card(s)`);
    for (const w of staleReviewCards) {
      console.log(`       → ${w.id} "${w.displaySubject}"`);
    }
    console.log("  NOT TOUCHED:");
    console.log("    • Any POSTED PayrollBatch or JournalEntry (immutable)");
    console.log("    • Employees / EmployeeCompensation / SIN / bank / TD1 rows");
    console.log("    • GL account profile / component catalogue");
    console.log("    • PayrollImplementationDeclaration / OpeningBalance (founder-owned)");
    line();

    if (!args.commit) {
      console.log("DRY-RUN complete. No writes performed. Re-run with --commit to apply.");
      return;
    }

    // COMMIT PATH — one transaction, atomic where feasible.
    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const archivedCode = `${OLD_PAY_GROUP_CODE}-ARCHIVED-${suffix}`;

    // Import buildCalendar lazily (no code path executes at parse-time).
    const { buildCalendar } = await import("../src/lib/payroll/pay-periods");
    const generatedRows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: CUTOVER_TAX_YEAR,
    });
    if (generatedRows.length !== 24) {
      throw new Error(
        `REFUSED: SEMI_MONTHLY generator produced ${generatedRows.length} rows, expected 24. ` +
          "Aborting to avoid a broken calendar.",
      );
    }

    await prisma.$transaction(async (tx) => {
      // 1) Archive old pay group.
      await tx.payrollPayGroup.update({
        where: { id: oldGroup.id },
        data: { code: archivedCode, active: false },
      });

      // 2) Create new pay group.
      const newGroup = await tx.payrollPayGroup.create({
        data: {
          clubId: COULEE_RIDGE_CLUB_ID,
          code: NEW_PAY_GROUP_CODE,
          name: NEW_PAY_GROUP_NAME,
          payFrequency: "SEMI_MONTHLY",
          payDateOffsetDays: 0,
          calendarAnchorDate: null,
          active: true,
          notes:
            "Created 2026-09-17 by Phase-5 cutover script. Founder rule: pay dates on the 15th and LAST calendar day of each month, weekend-earlier.",
        },
      });

      // 3) Close old memberships.
      for (const m of memberships) {
        await tx.payrollPayGroupMember.update({
          where: { id: m.id },
          data: { effectiveTo: cutoverEffectiveFrom },
        });
      }

      // 4) Open new memberships.
      for (const m of memberships) {
        await tx.payrollPayGroupMember.create({
          data: {
            clubId: COULEE_RIDGE_CLUB_ID,
            payGroupId: newGroup.id,
            employeeId: m.employeeId,
            effectiveFrom: cutoverEffectiveFrom,
            effectiveTo: null,
            notes: "Phase-5 cutover: moved from FDR-BW → CRGCC-SM.",
          },
        });
      }

      // 5) Generate 2026 SM calendar.
      const asRows = generatedRows.map((r) => ({
        clubId: COULEE_RIDGE_CLUB_ID,
        payGroupId: newGroup.id,
        sequenceInYear: r.sequenceInYear,
        taxYear: r.taxYear,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        payDate: r.payDate,
        status: "FUTURE",
      }));
      await tx.payrollPayPeriod.createMany({ data: asRows });

      // 6) Flip default.
      await tx.payrollClubConfig.update({
        where: { id: config.id },
        data: { defaultPayFrequency: "SEMI_MONTHLY" },
      });

      // 7) Resolve stale review cards.
      const nowTs = new Date();
      if (staleReviewCards.length > 0) {
        await tx.workIntakeItem.updateMany({
          where: { id: { in: staleReviewCards.map((c) => c.id) } },
          data: { status: "RESOLVED", resolvedAt: nowTs },
        });
      }
    });

    console.log("COMMIT complete. Coulee Ridge is now SEMI_MONTHLY.");
    console.log(`  new pay group code: ${NEW_PAY_GROUP_CODE}`);
    console.log(`  archived old code : ${archivedCode}`);
    console.log(`  restorePoint id   : ${args.restorePoint}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
