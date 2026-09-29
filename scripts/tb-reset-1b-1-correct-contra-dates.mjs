// TB-RESET-1b.1 — Correct entryDate + periodId on the 13 SYSTEM_REVERSAL
// contras created by TB-RESET-1b so that each contra shares the exact
// accounting date and FiscalPeriod of the JournalEntry it reverses.
//
// Root cause (proven in the TB-RESET-1b.1 investigation, 2026-09-28):
//   The reverse() primitive at src/lib/accounting/journal.ts:381 defaults
//   `reverseDate = opts.reverseDate ?? new Date()`, so every one of the
//   13 contras posted 2026-09-28 by the TB-RESET-1b script landed dated
//   today, while the reversed originals span 2026-08-15 → 2026-12-31.
//   accountBalances(clubId, { asOf: new Date() }) filters
//   entry.entryDate <= asOf, so at asOf=today six originals are still
//   future-dated and don't count while all thirteen contras count —
//   producing abnormal per-account balances even though the arithmetic
//   nets to zero at asOf ≥ 2026-12-31.
//
// This correction updates ONLY:
//   - JournalEntry.entryDate
//   - JournalEntry.periodId
// on the 13 named contras. No lines, no amounts, no source, no reversesId,
// no status. No plug journal, no delete. Uses the reversesId relation
// to look up the target date/period so it is deterministic and does not
// hard-code dates.
//
// Safety gates:
//   - Refuses without --commit unless dry-run
//   - Refuses without TB_RESET_1B_1_CONFIRM=COULEE-9EA0AD4 for commit
//   - Refuses if club != Coulee Ridge / stagingDataMode != FOUNDER_REVIEW
//   - Refuses if any target isn't POSTED, isn't SYSTEM_REVERSAL, or has
//     no reversesId
//   - Refuses if contra debit/credit totals don't invert original
//   - Refuses if target FiscalPeriod isn't OPEN
//   - Idempotent: running twice detects "already at target" and no-ops.

import { PrismaClient } from "@prisma/client";

const COULEE = "cmrvdeny7000144372ktmmg9c";
const CONFIRM_TOKEN = "COULEE-9EA0AD4";
const RESET_ACTOR_USER_ID = "cmrvdenz700034437agp7gqs5";

// The 13 target SYSTEM_REVERSAL contras created by TB-RESET-1b.
// (id → entryNumber for logging; script resolves the reversed original
// deterministically via reversesId.)
const TARGET_CONTRA_IDS = [
  { id: "cmulw6pqq000213oq1uuv130u", entryNumber: "JE-2026-000030" },
  { id: "cmulw6psj000713oq2z3f6ajo", entryNumber: "JE-2026-000031" },
  { id: "cmulw6pu2000h13oqgeqh3vv5", entryNumber: "JE-2026-000032" },
  { id: "cmulw6pvl000q13oqihuv3n2c", entryNumber: "JE-2026-000033" },
  { id: "cmulw6px0000v13oqvjp0j6rx", entryNumber: "JE-2026-000034" },
  { id: "cmulw6pyd001313oqu21zi4qu", entryNumber: "JE-2026-000035" },
  { id: "cmulw6pzq001b13oqz0t89ygg", entryNumber: "JE-2026-000036" },
  { id: "cmulw6q13001j13oqw100xzns", entryNumber: "JE-2026-000037" },
  { id: "cmulw6q2h001s13oqt0cbc9ir", entryNumber: "JE-2026-000038" },
  { id: "cmulw6q3t001w13oqpmewocxx", entryNumber: "JE-2026-000039" },
  { id: "cmulw6q56002013oq0dglk35u", entryNumber: "JE-2026-000040" },
  { id: "cmulw6q6i002413oqlpwkhiut", entryNumber: "JE-2026-000041" },
  { id: "cmulw6q7u002813oqnl3ziof1", entryNumber: "JE-2026-000042" },
];

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--commit");
const CONFIRM = process.env.TB_RESET_1B_1_CONFIRM ?? "";

function log(...a) { process.stdout.write(a.join(" ") + "\n"); }
function assert(cond, msg) { if (!cond) throw new Error("SAFETY: " + msg); }

async function main() {
  const p = new PrismaClient();
  try {
    log("");
    log("======================================================================");
    log("TB-RESET-1b.1 — Contra date/period correction");
    log("======================================================================");
    log("Mode:              ", DRY_RUN ? "DRY-RUN (no writes)" : "COMMIT");
    log("Confirm token env: ", CONFIRM ? "provided" : "MISSING");
    log("Tenant guard:      ", COULEE);
    log("Contras to correct:", TARGET_CONTRA_IDS.length);
    log("");

    if (!DRY_RUN) {
      assert(CONFIRM === CONFIRM_TOKEN, `TB_RESET_1B_1_CONFIRM env var must equal "${CONFIRM_TOKEN}" for a COMMIT run.`);
    }

    const club = await p.club.findUnique({
      where: { id: COULEE },
      select: { id: true, name: true, stagingDataMode: true },
    });
    assert(club, `Club ${COULEE} not found.`);
    assert(club.name === "Coulee Ridge Golf & Country Club", `Club name mismatch: ${club.name}`);
    assert(club.stagingDataMode === "FOUNDER_REVIEW", `Refusing to run against non-FOUNDER_REVIEW tenant (${club.stagingDataMode}).`);
    log("Tenant verified:   ", club.name, "(", club.stagingDataMode, ")");
    log("");

    // Load all 13 contras with their originals + lines
    const contras = await p.journalEntry.findMany({
      where: { id: { in: TARGET_CONTRA_IDS.map((t) => t.id) }, clubId: COULEE },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        reverses: {
          include: {
            lines: { orderBy: { lineNumber: "asc" } },
            period: true,
          },
        },
        period: true,
      },
    });

    // Pre-flight validations
    assert(contras.length === TARGET_CONTRA_IDS.length,
      `Contra count mismatch: found ${contras.length}, expected ${TARGET_CONTRA_IDS.length}`);

    const plan = [];
    for (const c of contras) {
      assert(c.status === "POSTED", `${c.entryNumber}: status=${c.status} (expected POSTED)`);
      assert(c.source === "SYSTEM_REVERSAL", `${c.entryNumber}: source=${c.source} (expected SYSTEM_REVERSAL)`);
      assert(c.reversesId, `${c.entryNumber}: no reversesId — cannot resolve original`);
      assert(c.reverses, `${c.entryNumber}: reverses relation empty — original may not exist`);
      const o = c.reverses;
      assert(o.status === "POSTED", `${c.entryNumber}: original ${o.entryNumber} not POSTED (status=${o.status})`);

      // Amounts inverted
      assert(c.totalDebits.toString() === o.totalCredits.toString() && c.totalCredits.toString() === o.totalDebits.toString(),
        `${c.entryNumber}: totalDebits/totalCredits do not invert original ${o.entryNumber}`);

      // Line-level inversion check
      assert(c.lines.length === o.lines.length, `${c.entryNumber}: line count ${c.lines.length} != original ${o.lines.length}`);
      for (let i = 0; i < c.lines.length; i++) {
        const cl = c.lines[i], ol = o.lines[i];
        assert(cl.accountId === ol.accountId, `${c.entryNumber}[${i}]: accountId ${cl.accountId} != original ${ol.accountId}`);
        assert(cl.debit.toString() === ol.credit.toString(), `${c.entryNumber}[${i}]: contra debit ${cl.debit} != original credit ${ol.credit}`);
        assert(cl.credit.toString() === ol.debit.toString(), `${c.entryNumber}[${i}]: contra credit ${cl.credit} != original debit ${ol.debit}`);
      }

      // Target FiscalPeriod check
      assert(o.period, `${c.entryNumber}: original period missing`);
      assert(o.period.status === "OPEN", `${c.entryNumber}: target period ${o.period.label} status=${o.period.status} (must be OPEN — script refuses to write into locked periods)`);

      const currentDateISO = c.entryDate.toISOString();
      const targetDateISO = o.entryDate.toISOString();
      const isAlreadyCorrect = currentDateISO === targetDateISO && c.periodId === o.periodId;

      plan.push({
        contra: { id: c.id, entryNumber: c.entryNumber, entryDate: currentDateISO, periodId: c.periodId, periodLabel: c.period?.label ?? null },
        original: { id: o.id, entryNumber: o.entryNumber, entryDate: targetDateISO, periodId: o.periodId, periodLabel: o.period.label },
        needsUpdate: !isAlreadyCorrect,
      });
    }

    log("Pre-flight validated: 13/13 contras healthy, invertible, target periods OPEN.");
    log("");
    log("Change schedule:");
    for (const row of plan) {
      const flag = row.needsUpdate ? "→ UPDATE" : "  no-op ";
      log(`  ${row.contra.entryNumber} ${flag}: entryDate ${row.contra.entryDate.slice(0,10)} → ${row.original.entryDate.slice(0,10)}, period ${row.contra.periodLabel} → ${row.original.periodLabel}`);
    }
    const willUpdate = plan.filter((r) => r.needsUpdate);
    log("");
    log(`Contras requiring update: ${willUpdate.length} of 13`);

    if (DRY_RUN) {
      log("");
      log("== DRY-RUN COMPLETE — no writes performed ==");
      log("To commit, re-run with:");
      log(`  TB_RESET_1B_1_CONFIRM=${CONFIRM_TOKEN}  node scripts/tb-reset-1b-1-correct-contra-dates.mjs --commit`);
      return;
    }

    if (willUpdate.length === 0) {
      log("");
      log("== NO-OP: all 13 contras already at target date/period ==");
      return;
    }

    log("");
    log("== COMMIT PHASE — begin transaction ==");
    const applied = [];
    await p.$transaction(async (tx) => {
      for (const row of willUpdate) {
        await tx.journalEntry.update({
          where: { id: row.contra.id },
          data: {
            entryDate: new Date(row.original.entryDate),
            periodId: row.original.periodId,
          },
        });
        applied.push({
          entryNumber: row.contra.entryNumber,
          prevEntryDate: row.contra.entryDate,
          newEntryDate: row.original.entryDate,
          prevPeriodId: row.contra.periodId,
          newPeriodId: row.original.periodId,
          reversesId: row.original.id,
          reversesEntryNumber: row.original.entryNumber,
        });
      }

      // Best-effort AuditLog. AuditLog schema shape uncertain from the
      // TB-RESET-1b run — try the same conservative shape and skip on
      // any schema mismatch. The applied[] array is the authoritative
      // before/after evidence returned on stdout regardless.
      try {
        await tx.auditLog.create({
          data: {
            clubId: COULEE,
            actorUserId: RESET_ACTOR_USER_ID,
            action: "tb-reset-1b1.correct-contra-dates",
            entityType: "Club",
            entityId: COULEE,
            metadata: {
              reset: "TB-RESET-1b.1",
              reason: "correction of TB-RESET-1b reversal-date error (contras dated today; corrected to match reversed originals)",
              applied,
            },
          },
        });
      } catch (err) {
        log(`  (AuditLog write skipped: ${(err?.message ?? String(err)).split("\n")[0]})`);
      }
    }, { timeout: 60000, maxWait: 10000 });

    log("== COMMIT PHASE — transaction committed ==");
    log("");
    log(`Applied ${applied.length} corrections:`);
    for (const a of applied) {
      log(`  ${a.entryNumber} (reverses ${a.reversesEntryNumber}): entryDate ${a.prevEntryDate.slice(0,10)} → ${a.newEntryDate.slice(0,10)}, periodId ${a.prevPeriodId} → ${a.newPeriodId}`);
    }

    log("");
    log("== TB-RESET-1b.1 CORRECTION COMPLETE ==");
    log("Run scripts/tb-reset-1b-1-verify.mjs for the multi-asOf acceptance matrix.");
  } finally {
    await p.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write("FATAL: " + (err?.message ?? String(err)) + "\n");
  if (err?.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
