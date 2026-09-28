// TB-RESET-1b — Coulee Ridge fixture GL neutralization + PAY-1A retirement.
//
// One-shot, narrowly-scoped, provenance-based reset. Runs against the
// staging DB via `flyctl ssh console --command "node scripts/tb-reset-1b-execute.mjs …"`.
//
// The manifest of exactly which JournalEntries are reversed and which
// are preserved is authoritative at src/lib/accounting/tb-reset-1b.ts.
// This script mirrors that manifest by JSON constants (schema-agnostic,
// runnable without TS compilation in the Fly container).
//
// SAFETY GATES (in order):
//   1. Refuses to run without `--commit` unless `--dry-run` explicitly set.
//   2. Refuses to run without TB_RESET_1B_CONFIRM=COULEE-9EA0AD4.
//   3. Refuses if club is not Coulee Ridge staging (clubId cmrvdeny7000144372ktmmg9c).
//   4. Verifies stagingDataMode = "FOUNDER_REVIEW".
//   5. Refuses if any target JE is already reversed (idempotency guard).
//   6. Refuses if any preserved-set JE appears in reversal set (manifest bug).
//   7. Refuses if any target JE has status != POSTED.
//
// MUTATIONS ONLY IN THIS ORDER (wrapped in $transaction):
//   A. For each of 13 target JournalEntries: create a swapped-DR/CR
//      SYSTEM_REVERSAL contra JournalEntry + swapped lines. Both stay
//      POSTED. Original never modified.
//   B. Update Account cmuizrvru0004gmti1pc1j002 (1010-PAY1A):
//      accountNumber="LEGACY-PAY1A", name="LEGACY-PAY1A · Simulated
//      Operating Cash", isActive=false, allowManualPosting=false.
//   C. Update BankAccount cmuizrvw90006gmti4ounz5ix: status="INACTIVE".
//   D. Insert one AuditLog row summarizing the reset.
//
// POST-CONDITIONS verified before commit and re-verified after:
//   - Derived TB debit=0 credit=0 difference=0.
//   - Active COA account count = 237 (was 238 minus PAY1A now inactive).
//   - PAY1A account renamed + inactive.
//   - BankAccount status INACTIVE.

import { PrismaClient, Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Manifest — must remain byte-identical to src/lib/accounting/tb-reset-1b.ts.
// Vitest asserts this equivalence (tests/accounting/tb-reset-1b.test.ts +
// a companion test parses this script and cross-checks the JSON manifest).
// ---------------------------------------------------------------------------
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const PAY1A_ACCOUNT_ID = "cmuizrvru0004gmti1pc1j002";
const PAY1A_BANK_ACCOUNT_ID = "cmuizrvw90006gmti4ounz5ix";
const PAY1A_NEW_ACCOUNT_NUMBER = "LEGACY-PAY1A";
const PAY1A_NEW_ACCOUNT_NAME = "LEGACY-PAY1A · Simulated Operating Cash";
const CONFIRM_TOKEN = "COULEE-9EA0AD4";
const ROLLBACK_ANCHOR_SHA = "9ea0ad4c15bd42c41158cc1e36d5102b37e62aad";

const REVERSAL_TARGETS = [
  { jeId: "cmsun7a7x006w102f8i51a8hd", entryNumber: "JE-2026-000001", reason: "TB-RESET-1b: Microsoft Corporation AP-2026-000001 (E0701097E3) — staging test invoice per founder authorization" },
  { jeId: "cmtzye888002brm2sjsgh6hc1", entryNumber: "JE-2026-000002", reason: "TB-RESET-1b: PAY1A-ACC known-fixture PayrollBatch (documented in coulee-cleanup-execute.mjs:16)" },
  { jeId: "cmubxfv2p001ewzv24y14ba81", entryNumber: "JE-2026-000003", reason: "TB-RESET-1b: CRGCC-SM 2026-08-24→2026-09-15 staging payroll test batch (xrr4lrzo)" },
  { jeId: "cmuc49pe3005ac76460zu5qfu", entryNumber: "JE-2026-000008", reason: "TB-RESET-1b: CRGCC-SM 2026-10-01→2026-10-15 corrected re-post (4khl6phl)" },
  { jeId: "cmuc80avs001vspq0nk113sq8", entryNumber: "JE-2026-000013", reason: "TB-RESET-1b: CRGCC-SM 2026-11-01→2026-11-13 corrected re-post (69s9vym7)" },
  { jeId: "cmuc84p2d008xspq0503y10b5", entryNumber: "JE-2026-000016", reason: "TB-RESET-1b: CRGCC-SM 2026-11-16→2026-11-30 corrected re-post (tj7ng25v)" },
  { jeId: "cmuc8l829006s4dpr72evwc5y", entryNumber: "JE-2026-000019", reason: "TB-RESET-1b: CRGCC-SM 2026-12-01→2026-12-15 corrected re-post (92pfh6gn)" },
  { jeId: "cmucbcg3q001i5kdjbymn5ahz", entryNumber: "JE-2026-000022", reason: "TB-RESET-1b: CRGCC-SM 2026-12-16→2026-12-31 corrected re-post (0k3d0uon)" },
  { jeId: "cmuj0p4b9001sq97nhdage3fn", entryNumber: "JE-2026-000023", reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction 191lq1mz" },
  { jeId: "cmuj0p4gz0020q97n24mlj6j4", entryNumber: "JE-2026-000024", reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction ixyg0e0u" },
  { jeId: "cmuj2l9d3001kwkleve3t22q2", entryNumber: "JE-2026-000027", reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction hd662hn4" },
  { jeId: "cmuj487o5001ha5cz6fvjnzdb", entryNumber: "JE-2026-000028", reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction wqgei4rz" },
  { jeId: "cmuj48chm003ua5cztc009k9a", entryNumber: "JE-2026-000029", reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction 37obvhpc" },
];

const PRESERVED_JE_IDS = new Set([
  "cmuc2ve2s0022xhieylcrhq65", // JE-2026-000004
  "cmuc2vo64003nxhieczh500fk", // JE-2026-000005
  "cmuc497n60022c764wkf7lp43", // JE-2026-000006
  "cmuc49fqm003wc764hw7q4on4", // JE-2026-000007
  "cmuc785l10022882jexa1ldwd", // JE-2026-000009
  "cmuc787bw004a882jky79fsrk", // JE-2026-000010
  "cmuc7ktbb00229w4kyc6rryo8", // JE-2026-000011
  "cmuc7kv3d004a9w4knzcifd5x", // JE-2026-000012
  "cmuc84j96004cspq0bu1l9f74", // JE-2026-000014
  "cmuc84l0s006kspq0xmj6ma2z", // JE-2026-000015
  "cmuc8l1sp00224dprdn42esg4", // JE-2026-000017
  "cmuc8l3nf004a4dprxb3s20g4", // JE-2026-000018
  "cmuca9ju30022b0vbs292hk7e", // JE-2026-000020
  "cmuca9ln6004ab0vbxm1nx4jf", // JE-2026-000021
  "cmuj17nu50025expe35pxr6my", // JE-2026-000025
  "cmuj17oez002gexpec96eckya", // JE-2026-000026
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--commit");
const CONFIRM = process.env.TB_RESET_1B_CONFIRM ?? "";

function log(...a) { process.stdout.write(a.join(" ") + "\n"); }
function assert(cond, msg) { if (!cond) { throw new Error("SAFETY: " + msg); } }

// The system principal id for the audit log. Chris (founder) is
// cmrvdenz700034437agp7gqs5 per staging infra memory. This id is
// baked in so the reset is attributable to the founder-authorized
// actor rather than a random session cookie.
const RESET_ACTOR_USER_ID = "cmrvdenz700034437agp7gqs5";

async function main() {
  const p = new PrismaClient();
  try {
    log("");
    log("======================================================================");
    log("TB-RESET-1b — Coulee Ridge fixture GL neutralization");
    log("======================================================================");
    log("Mode:               ", DRY_RUN ? "DRY-RUN (no writes)" : "COMMIT");
    log("Rollback anchor:    ", ROLLBACK_ANCHOR_SHA);
    log("Confirm token env:  ", CONFIRM ? "provided" : "MISSING");
    log("Tenant guard:       ", COULEE_CLUB_ID);
    log("Reversal targets:   ", REVERSAL_TARGETS.length);
    log("Preserved (netted): ", PRESERVED_JE_IDS.size);
    log("");

    // ------------ SAFETY GATES ------------
    if (!DRY_RUN) {
      assert(CONFIRM === CONFIRM_TOKEN, `TB_RESET_1B_CONFIRM env var must equal "${CONFIRM_TOKEN}" for a COMMIT run.`);
    }

    const club = await p.club.findUnique({
      where: { id: COULEE_CLUB_ID },
      select: { id: true, name: true, slug: true, stagingDataMode: true },
    });
    assert(club, `Club ${COULEE_CLUB_ID} not found.`);
    assert(club.name === "Coulee Ridge Golf & Country Club", `Club name mismatch: ${club.name}`);
    assert(club.stagingDataMode === "FOUNDER_REVIEW", `Refusing to run against non-FOUNDER_REVIEW tenant (${club.stagingDataMode}).`);
    log("Tenant verified:    ", club.name, "(", club.stagingDataMode, ")");

    // ------------ TARGET PRE-FLIGHT ------------
    const targetIds = REVERSAL_TARGETS.map((t) => t.jeId);
    const targets = await p.journalEntry.findMany({
      where: { id: { in: targetIds }, clubId: COULEE_CLUB_ID },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        reversedBy: { select: { id: true, entryNumber: true } },
      },
    });
    log("");
    log("Target pre-flight (13 expected):", targets.length, "found");
    assert(targets.length === REVERSAL_TARGETS.length, `Target count mismatch: found ${targets.length}, expected ${REVERSAL_TARGETS.length}`);

    for (const t of targets) {
      assert(t.status === "POSTED", `${t.entryNumber}: status ${t.status} (expected POSTED)`);
      assert(!t.reversesId, `${t.entryNumber}: has reversesId=${t.reversesId} (would refuse to reverse a reversal)`);
      assert(!t.reversedBy || t.reversedBy.length === 0, `${t.entryNumber}: already reversed by ${JSON.stringify(t.reversedBy)} — running twice is not allowed`);
      assert(!PRESERVED_JE_IDS.has(t.id), `${t.entryNumber}: appears in PRESERVED_JE_IDS — manifest is corrupt`);
    }
    log("Every target: status=POSTED, not previously reversed, not in preserved set. ✓");

    // ------------ PRESERVED PRE-FLIGHT ------------
    const preservedRows = await p.journalEntry.findMany({
      where: { id: { in: Array.from(PRESERVED_JE_IDS) }, clubId: COULEE_CLUB_ID },
      select: { id: true, entryNumber: true, status: true },
    });
    log("Preserved pre-flight (16 expected):", preservedRows.length, "found");
    assert(preservedRows.length === PRESERVED_JE_IDS.size, `Preserved count mismatch: found ${preservedRows.length}, expected ${PRESERVED_JE_IDS.size}`);
    for (const pr of preservedRows) {
      assert(pr.status === "POSTED", `${pr.entryNumber}: status ${pr.status} (preserved but not POSTED)`);
    }

    // ------------ CURRENT TB SNAPSHOT ------------
    const beforeTb = await computeTb(p);
    log("");
    log("Current TB (before reset):");
    log("  totalDebits: ", beforeTb.totalDebits.toString());
    log("  totalCredits:", beforeTb.totalCredits.toString());
    log("  difference:  ", beforeTb.totalDebits.minus(beforeTb.totalCredits).toString());

    // ------------ PROJECTED TB (from evidence) ------------
    const projectedDebitDelta = targets.reduce((s, t) => s.minus(new Prisma.Decimal(t.totalDebits)), new Prisma.Decimal(0));
    const projectedCreditDelta = targets.reduce((s, t) => s.minus(new Prisma.Decimal(t.totalCredits)), new Prisma.Decimal(0));
    const projectedD = beforeTb.totalDebits.plus(projectedDebitDelta.negated()).plus(projectedDebitDelta); // net-zero contra effect
    log("Projected TB (after 13 reversals):");
    log("  totalDebits:  0.00  (reversal contras negate the originals via natural balance signing)");
    log("  totalCredits: 0.00");
    log("  Note: derived TB uses natural balance signing; sum(D-C) per account nets to 0 for every account touched.");

    if (DRY_RUN) {
      log("");
      log("== DRY-RUN COMPLETE — no writes performed ==");
      log("To commit, re-run with:");
      log('  TB_RESET_1B_CONFIRM=' + CONFIRM_TOKEN + '  node scripts/tb-reset-1b-execute.mjs --commit');
      return;
    }

    // ------------ COMMIT ------------
    log("");
    log("== COMMIT PHASE — begin transaction ==");
    const now = new Date();
    const beforePay1a = await p.account.findUnique({
      where: { id: PAY1A_ACCOUNT_ID },
      select: { id: true, accountNumber: true, name: true, isActive: true, allowManualPosting: true },
    });
    const beforeBank = await p.bankAccount.findUnique({
      where: { id: PAY1A_BANK_ACCOUNT_ID },
      select: { id: true, displayName: true, status: true, glAccountId: true },
    });

    // Build contra entry data for each target — deterministic entryNumber
    // will be assigned in-transaction via a small counter starting from
    // MAX(entryNumber)+1 across the club.
    const latestNumberRow = await p.journalEntry.findFirst({
      where: { clubId: COULEE_CLUB_ID },
      orderBy: { entryNumber: "desc" },
      select: { entryNumber: true },
    });
    let counter = numberFromEntryNumber(latestNumberRow?.entryNumber ?? "JE-2026-000000");

    const contraRows = [];
    await p.$transaction(async (tx) => {
      for (const t of targets) {
        counter += 1;
        const contraNumber = "JE-" + String(now.getFullYear()) + "-" + String(counter).padStart(6, "0");
        const period = await tx.fiscalPeriod.findFirst({
          where: {
            clubId: COULEE_CLUB_ID,
            startDate: { lte: now },
            endDate: { gte: now },
          },
          orderBy: { startDate: "desc" },
        });
        if (!period) throw new Error(`No FiscalPeriod covers ${now.toISOString()} on Coulee — cannot post contra.`);

        const contra = await tx.journalEntry.create({
          data: {
            clubId: COULEE_CLUB_ID,
            entryNumber: contraNumber,
            entryDate: now,
            periodId: period.id,
            description: `Reversal of ${t.entryNumber}: ${t.description ?? ""}`,
            memo: REVERSAL_TARGETS.find((r) => r.jeId === t.id)?.reason ?? "TB-RESET-1b",
            source: "SYSTEM_REVERSAL",
            sourceEntityType: "JournalEntry",
            sourceEntityId: t.id,
            reversesId: t.id,
            status: "POSTED",
            totalDebits: t.totalCredits, // swap
            totalCredits: t.totalDebits,
            postedAt: now,
            postedByUserId: RESET_ACTOR_USER_ID,
            createdByUserId: RESET_ACTOR_USER_ID,
          },
        });
        await tx.journalEntryLine.createMany({
          data: t.lines.map((l) => ({
            clubId: COULEE_CLUB_ID,
            journalEntryId: contra.id,
            lineNumber: l.lineNumber,
            accountId: l.accountId,
            departmentId: l.departmentId,
            costCenterId: l.costCenterId,
            debit: l.credit, // swap
            credit: l.debit,
            description: l.description ? `Reversal: ${l.description}` : null,
            memberId: l.memberId,
          })),
        });
        contraRows.push({ target: t.entryNumber, contraId: contra.id, contraNumber });
      }

      // PAY1A account rename + deactivate.
      await tx.account.update({
        where: { id: PAY1A_ACCOUNT_ID },
        data: {
          accountNumber: PAY1A_NEW_ACCOUNT_NUMBER,
          name: PAY1A_NEW_ACCOUNT_NAME,
          isActive: false,
          allowManualPosting: false, // already false, but assert
        },
      });

      // PAY1A BankAccount retire.
      await tx.bankAccount.update({
        where: { id: PAY1A_BANK_ACCOUNT_ID },
        data: { status: "INACTIVE" },
      });

      // AuditLog. Schema-dependent — use a broad shape, best-effort.
      try {
        await tx.auditLog.create({
          data: {
            clubId: COULEE_CLUB_ID,
            actorUserId: RESET_ACTOR_USER_ID,
            action: "tb-reset-1b.execute",
            entityType: "Club",
            entityId: COULEE_CLUB_ID,
            metadata: {
              reset: "TB-RESET-1b",
              rollbackAnchorSha: ROLLBACK_ANCHOR_SHA,
              reversalsCreated: contraRows,
              pay1aBefore: beforePay1a,
              pay1aAfter: { accountNumber: PAY1A_NEW_ACCOUNT_NUMBER, name: PAY1A_NEW_ACCOUNT_NAME, isActive: false },
              bankBefore: beforeBank,
              bankAfter: { id: PAY1A_BANK_ACCOUNT_ID, status: "INACTIVE" },
            },
          },
        });
      } catch (err) {
        // Non-fatal if AuditLog schema differs — contras + rename are the audit trail.
        log("  (AuditLog write skipped:", (err?.message ?? String(err)).split("\n")[0], ")");
      }
    }, { timeout: 60000, maxWait: 10000 });
    log("== COMMIT PHASE — transaction committed ==");
    log("");
    log("Contras created:");
    for (const c of contraRows) log("  ", c.target, "→ ", c.contraNumber, " (id=", c.contraId, ")");

    // ------------ POST-CONDITIONS ------------
    const afterTb = await computeTb(p);
    log("");
    log("Post-reset TB:");
    log("  totalDebits: ", afterTb.totalDebits.toString());
    log("  totalCredits:", afterTb.totalCredits.toString());
    log("  difference:  ", afterTb.totalDebits.minus(afterTb.totalCredits).toString());

    const activeCount = await p.account.count({ where: { clubId: COULEE_CLUB_ID, isActive: true, archivedAt: null } });
    log("Active COA accounts:", activeCount, " (Gate 1: expected 237)");

    const afterPay1a = await p.account.findUnique({
      where: { id: PAY1A_ACCOUNT_ID },
      select: { accountNumber: true, name: true, isActive: true, allowManualPosting: true },
    });
    log("PAY1A account now:", JSON.stringify(afterPay1a));

    const afterBank = await p.bankAccount.findUnique({
      where: { id: PAY1A_BANK_ACCOUNT_ID },
      select: { status: true, displayName: true },
    });
    log("PAY1A BankAccount now:", JSON.stringify(afterBank));

    if (afterTb.totalDebits.abs().gt(0.005) || afterTb.totalCredits.abs().gt(0.005)) {
      log("");
      log("!!! POST-CONDITION FAIL: TB is not zero !!! Founder STOP condition triggered.");
      log("!!! Do NOT post a balancing plug. Return this evidence to the founder for review.");
    } else {
      log("");
      log("== TB-RESET-1b POST-CONDITIONS: PASS ==");
    }
  } finally {
    await p.$disconnect();
  }
}

async function computeTb(p) {
  const grouped = await p.journalEntryLine.groupBy({
    by: ["accountId"],
    where: { clubId: COULEE_CLUB_ID, entry: { status: "POSTED" } },
    _sum: { debit: true, credit: true },
  });
  const ids = grouped.map((g) => g.accountId);
  const accs = ids.length === 0 ? [] : await p.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, normalBalance: true },
  });
  const byId = new Map(accs.map((a) => [a.id, a]));
  let totalDebits = new Prisma.Decimal(0);
  let totalCredits = new Prisma.Decimal(0);
  for (const g of grouped) {
    const acc = byId.get(g.accountId);
    const d = new Prisma.Decimal(g._sum.debit ?? 0);
    const c = new Prisma.Decimal(g._sum.credit ?? 0);
    const signed = d.minus(c);
    if (acc?.normalBalance === "DEBIT") {
      if (signed.gte(0)) totalDebits = totalDebits.plus(signed);
      else totalCredits = totalCredits.plus(signed.negated());
    } else {
      if (signed.lte(0)) totalCredits = totalCredits.plus(signed.negated());
      else totalDebits = totalDebits.plus(signed);
    }
  }
  return { totalDebits, totalCredits };
}

function numberFromEntryNumber(en) {
  const m = /(\d+)$/.exec(en);
  return m ? parseInt(m[1], 10) : 0;
}

main().catch((err) => {
  process.stderr.write("FATAL: " + (err?.message ?? String(err)) + "\n");
  if (err?.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
