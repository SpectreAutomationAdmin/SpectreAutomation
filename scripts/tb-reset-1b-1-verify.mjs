// TB-RESET-1b.1 — Multi-asOf Trial Balance verification.
//
// Replicates accountBalances(clubId, { asOf }) verbatim from
// src/lib/accounting/balance.ts and confirms $0.00 / $0.00 at every
// checkpoint date the founder specified in the 1b.1 brief.
//
// CRITICAL — this replaces the buggy scratchpad post-verify.js that
// omitted the entry.entryDate <= asOf filter and produced a false
// TB-RESET-1b acceptance. Every asOf here applies the same filter the
// production balance service applies.

import { PrismaClient, Prisma } from "@prisma/client";

const COULEE = "cmrvdeny7000144372ktmmg9c";

const CHECKPOINTS = [
  { label: "2026-08-14 (before Microsoft AP)", asOf: new Date("2026-08-14T23:59:59Z") },
  { label: "2026-08-15 (Microsoft AP + contra)", asOf: new Date("2026-08-15T23:59:59Z") },
  { label: "2026-09-15 (JE-003 + JE-032)", asOf: new Date("2026-09-15T23:59:59Z") },
  { label: "2026-09-26 (PAY-1A settlements to date)", asOf: new Date("2026-09-26T23:59:59Z") },
  { label: "2026-09-27 (PAY-1A settlements to date)", asOf: new Date("2026-09-27T23:59:59Z") },
  { label: "2026-09-28 (today — CoA/TB default)", asOf: new Date("2026-09-28T23:59:59Z") },
  { label: "2026-09-30 (end of M09)", asOf: new Date("2026-09-30T23:59:59Z") },
  { label: "2026-10-15 (mid M10)", asOf: new Date("2026-10-15T23:59:59Z") },
  { label: "2026-11-30 (end of M11)", asOf: new Date("2026-11-30T23:59:59Z") },
  { label: "2026-12-31 (end of FY / all originals)", asOf: new Date("2026-12-31T23:59:59Z") },
];

async function hasCommittedRealTb(p) {
  const live = await p.importBatch.findFirst({
    where: {
      clubId: COULEE, domain: "OPENING_TRIAL_BALANCE", status: "COMMITTED",
      supersededAt: null, voidedAt: null,
    },
    select: { id: true },
  });
  return live !== null;
}

async function tbAt(p, asOf, excludeDemo) {
  const where = {
    clubId: COULEE,
    entry: {
      status: "POSTED",
      ...(excludeDemo ? { source: { not: "DEMO" } } : {}),
      entryDate: { lte: asOf },
    },
  };
  const grouped = await p.journalEntryLine.groupBy({
    by: ["accountId"],
    where,
    _sum: { debit: true, credit: true },
  });
  const ids = grouped.map((g) => g.accountId);
  const accs = ids.length
    ? await p.account.findMany({
        where: { id: { in: ids } },
        select: { id: true, accountNumber: true, name: true, normalBalance: true, isActive: true },
      })
    : [];
  const byId = new Map(accs.map((a) => [a.id, a]));
  let td = new Prisma.Decimal(0), tc = new Prisma.Decimal(0);
  const nonZero = [];
  for (const g of grouped) {
    const a = byId.get(g.accountId);
    if (!a) continue;
    const d = new Prisma.Decimal(g._sum.debit ?? 0);
    const c = new Prisma.Decimal(g._sum.credit ?? 0);
    const signed = d.minus(c);
    let dc = new Prisma.Decimal(0), cc = new Prisma.Decimal(0);
    if (a.normalBalance === "DEBIT") {
      if (signed.gte(0)) dc = signed; else cc = signed.negated();
    } else {
      if (signed.lte(0)) cc = signed.negated(); else dc = signed;
    }
    td = td.plus(dc); tc = tc.plus(cc);
    if (dc.abs().gt(0.005) || cc.abs().gt(0.005)) {
      nonZero.push({ acc: a.accountNumber, name: a.name, isActive: a.isActive, dr: dc.toString(), cr: cc.toString() });
    }
  }
  return {
    asOf: asOf.toISOString().slice(0, 10),
    totalDebit: td.toString(),
    totalCredit: tc.toString(),
    difference: td.minus(tc).toString(),
    isBalanced: td.equals(tc),
    isZero: td.equals(0) && tc.equals(0),
    nonZeroCount: nonZero.length,
    nonZero,
  };
}

function log(...a) { process.stdout.write(a.join(" ") + "\n"); }

async function main() {
  const p = new PrismaClient();
  try {
    const excludeDemo = await hasCommittedRealTb(p);
    log("");
    log("======================================================================");
    log("TB-RESET-1b.1 — Multi-asOf Trial Balance verification");
    log("======================================================================");
    log("Tenant guard:      ", COULEE);
    log("DEMO gate active:  ", excludeDemo);
    log("Checkpoints:       ", CHECKPOINTS.length);
    log("");

    const results = [];
    for (const cp of CHECKPOINTS) {
      const r = await tbAt(p, cp.asOf, excludeDemo);
      results.push({ ...cp, result: r });
      const status = r.isZero ? "PASS" : "FAIL";
      log("[" + status + "] " + cp.label.padEnd(48) + "  D=" + r.totalDebit.padStart(12) + "  C=" + r.totalCredit.padStart(12) + "  non-zero rows=" + r.nonZeroCount);
      if (r.nonZeroCount > 0) {
        for (const row of r.nonZero) {
          log("         " + row.acc.padEnd(14) + "  " + row.name.substring(0, 45).padEnd(45) + "  DR=" + row.dr.padStart(12) + "  CR=" + row.cr.padStart(12) + "  active=" + row.isActive);
        }
      }
    }

    const allZero = results.every((r) => r.result.isZero);
    log("");
    log(allZero ? "== TB-RESET-1b.1 ACCEPTANCE PASS: every checkpoint reports $0.00 / $0.00 =="
                : "== TB-RESET-1b.1 ACCEPTANCE FAIL: at least one checkpoint has non-zero balances ==");
    log("");
    log("---JSON---");
    log(JSON.stringify({ excludeDemo, results }, null, 2));
  } finally {
    await p.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write("FATAL: " + (err?.message ?? String(err)) + "\n");
  if (err?.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
