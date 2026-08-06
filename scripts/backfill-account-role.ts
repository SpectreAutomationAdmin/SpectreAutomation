// Sprint 3 · Post-16H Phase 2.1 (2026-08-06) — one-time migration:
// backfill Account.accountRole from the reporting-side helper +
// existing schema flags. Runtime eligibility consults ONLY
// accountRole afterward — never the reporting helper.
//
// Usage:
//   tsx scripts/backfill-account-role.ts --club <clubId> --dry-run
//   tsx scripts/backfill-account-role.ts --club <clubId> --apply
//
// Refuses to run against a production URL.  Requires --apply to
// mutate; --dry-run is the default and prints the manifest only.
//
// Detection sources (priority order — first hit wins):
//   1. isBankAccount    → BANK
//   2. isCashAccount    → CASH
//   3. isControlAccount → CONTROL
//   4. accumulated depreciation / amortization name pattern
//      (reporting-side helper only)                → CONTRA_ASSET
//   5. otherwise → STANDARD

/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import { isAccumulatedDepreciationLine } from "@/lib/reporting/ledger/classification-resolver";

interface ProposedChange {
  accountId: string;
  accountIdTail: string;
  accountNumber: string;
  name: string;
  type: string;
  normalBalance: string;
  isActive: boolean;
  categoryKey: string | null;
  fsGroupKey: string | null;
  currentRole: string;
  proposedRole: string;
  reason: string;
}

function parseArgs(argv: string[]) {
  const out = { club: null as string | null, apply: false as boolean, dryRun: true as boolean };
  for (const a of argv.slice(2)) {
    if (a === "--apply") { out.apply = true; out.dryRun = false; }
    else if (a === "--dry-run") { out.dryRun = true; out.apply = false; }
    else if (a.startsWith("--club=")) out.club = a.slice("--club=".length);
    else if (a === "--club") { /* next arg */ }
  }
  const idx = argv.indexOf("--club");
  if (idx > -1 && argv[idx + 1]) out.club = argv[idx + 1];
  return out;
}

function assertNotProduction(): void {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(dbUrl).hostname; } catch { return ""; } })();
  if (/\bprod(uction)?\b/i.test(host)) {
    console.error(`REFUSED: DATABASE_URL host looks like production (${host}).`);
    process.exit(3);
  }
  if (process.env.NODE_ENV === "production") {
    console.error(`REFUSED: NODE_ENV=production.`);
    process.exit(3);
  }
}

function propose(acct: {
  id: string; accountNumber: string; name: string; type: string;
  normalBalance: string; isActive: boolean;
  isBankAccount: boolean; isCashAccount: boolean; isControlAccount: boolean;
  categoryKey: string | null; fsGroupKey: string | null;
  accountRole: string;
}): { role: string; reason: string } {
  if (acct.isBankAccount) return { role: "BANK", reason: "isBankAccount=true" };
  if (acct.isCashAccount) return { role: "CASH", reason: "isCashAccount=true" };
  if (acct.isControlAccount) return { role: "CONTROL", reason: "isControlAccount=true" };
  // Name pattern via reporting-side helper — one-time migration only.
  if (isAccumulatedDepreciationLine({
    accountName: acct.name,
    fsGroupKey: acct.fsGroupKey ?? undefined,
  })) {
    return { role: "CONTRA_ASSET", reason: "isAccumulatedDepreciationLine match (migration aid)" };
  }
  return { role: "STANDARD", reason: "no role signal" };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.club) {
    console.error("--club <clubId> is required");
    process.exit(2);
  }
  assertNotProduction();
  const prisma = new PrismaClient();
  try {
    const accts = await prisma.account.findMany({
      where: { clubId: args.club },
      include: {
        category: { select: { key: true } },
        fsGroup: { select: { key: true } },
      },
      orderBy: { accountNumber: "asc" },
    });
    console.log(`Club: ${args.club}`);
    console.log(`Total accounts: ${accts.length}`);
    console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
    console.log("");

    const changes: ProposedChange[] = [];
    const roleCounts: Record<string, number> = {};
    for (const a of accts) {
      const catKey = a.category?.key ?? null;
      const fsKey = a.fsGroup?.key ?? null;
      const currentRole = (a as unknown as { accountRole?: string }).accountRole ?? "STANDARD";
      const { role, reason } = propose({
        id: a.id, accountNumber: a.accountNumber, name: a.name,
        type: a.type, normalBalance: a.normalBalance, isActive: a.isActive,
        isBankAccount: a.isBankAccount, isCashAccount: a.isCashAccount,
        isControlAccount: a.isControlAccount,
        categoryKey: catKey, fsGroupKey: fsKey,
        accountRole: currentRole,
      });
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      if (role !== currentRole) {
        changes.push({
          accountId: a.id,
          accountIdTail: a.id.slice(-8),
          accountNumber: a.accountNumber,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
          isActive: a.isActive,
          categoryKey: catKey,
          fsGroupKey: fsKey,
          currentRole,
          proposedRole: role,
          reason,
        });
      }
    }

    console.log("=== Distribution of PROPOSED accountRole values ===");
    for (const [k, n] of Object.entries(roleCounts).sort()) {
      console.log(`  ${k.padEnd(20)} ${n}`);
    }
    console.log("");
    console.log(`=== Changes (${changes.length}) ===`);
    for (const c of changes) {
      console.log(`  ${c.accountIdTail}  ${c.accountNumber.padEnd(8)} ${(c.currentRole+" -> "+c.proposedRole).padEnd(28)} type=${c.type} nb=${c.normalBalance} active=${c.isActive}  "${c.name}"  reason: ${c.reason}`);
    }
    console.log("");

    // Safety check — no ordinary asset should be tagged CONTRA_ASSET.
    // The helper is name-based, so verify by fsGroup + name shape.
    const contras = changes.filter((c) => c.proposedRole === "CONTRA_ASSET");
    const suspect = contras.filter((c) => !/deprec|amort/i.test(c.name));
    if (suspect.length > 0) {
      console.error(`REFUSED: ${suspect.length} proposed CONTRA_ASSET accounts have no depreciation/amortization name.`);
      for (const s of suspect) console.error(`  ${s.accountNumber}  ${s.name}`);
      process.exit(4);
    }

    if (!args.apply) {
      console.log("Dry-run complete. Re-run with --apply to persist.");
      await prisma.$disconnect();
      return;
    }

    // Apply.
    let updated = 0;
    for (const c of changes) {
      await prisma.account.update({
        where: { id: c.accountId },
        data: { accountRole: c.proposedRole },
      });
      updated++;
    }
    console.log(`APPLIED: ${updated} accounts updated.`);

    // Verify — re-read and count.
    const after = await prisma.account.findMany({
      where: { clubId: args.club },
      select: { accountRole: true },
    });
    const afterCounts: Record<string, number> = {};
    for (const r of after) afterCounts[r.accountRole ?? "STANDARD"] = (afterCounts[r.accountRole ?? "STANDARD"] ?? 0) + 1;
    console.log("");
    console.log("=== Distribution of accountRole AFTER apply ===");
    for (const [k, n] of Object.entries(afterCounts).sort()) {
      console.log(`  ${k.padEnd(20)} ${n}`);
    }

    await prisma.$disconnect();
  } catch (e) {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
