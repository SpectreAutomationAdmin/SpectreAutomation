#!/usr/bin/env node
// HR mobile-hotfix (2026-08-30) §2 — Fingerprint backfill script.
//
// After the SIN + banking uniqueness constraints landed (commit D of
// this hotfix branch), any employee row that predates the constraint
// has `sinFingerprint = null` / `bankFingerprint = null`. This script
// decrypts each historical secret, computes the HMAC fingerprint,
// writes it back on the row, and reports any collisions that would
// have failed the new uniqueness gate.
//
// Founder invariants:
//   * Dry-run by default; --commit is required to write.
//   * Optional --club=<slug|id> scope so a single Club can be
//     remediated at a time.
//   * The console report is SANITISED: employee id + display name +
//     Club name + SIN last-three + bank last-four + conflict category
//     only. No plaintext SIN. No full account number. No transit/
//     institution number. No fingerprint hex.
//   * Never silently deletes a colliding row. When a conflict is
//     detected the script stops writing THAT fingerprint and prints
//     the conflict for a human to remediate interactively.
//   * The dedicated Chris/Lise remediation is deferred to a founder-
//     driven session — this script reports the conflict; it does not
//     choose a winner.
//
// Usage:
//   npx tsx scripts/hr-backfill-sensitive-fingerprints.ts
//   npx tsx scripts/hr-backfill-sensitive-fingerprints.ts --commit
//   npx tsx scripts/hr-backfill-sensitive-fingerprints.ts --club=nightingale
//   npx tsx scripts/hr-backfill-sensitive-fingerprints.ts --commit --club=nightingale

import { prisma } from "../src/lib/prisma";
import { decryptSecret } from "../src/lib/kms";
import {
  sinFingerprint,
  bankFingerprint,
  normaliseSin,
  normaliseBankTriple,
} from "../src/lib/kms/keyed-fingerprint";

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

interface CliArgs {
  commit: boolean;
  clubFilter: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let commit = false;
  let clubFilter: string | null = null;
  for (const raw of argv.slice(2)) {
    if (raw === "--commit") { commit = true; continue; }
    if (raw.startsWith("--club=")) {
      clubFilter = raw.slice("--club=".length).trim() || null;
      continue;
    }
    if (raw === "--help" || raw === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: npx tsx scripts/hr-backfill-sensitive-fingerprints.ts [--commit] [--club=<slug-or-id>]",
      );
      process.exit(0);
    }
    // Unknown flag — refuse loudly rather than silently ignoring.
    // eslint-disable-next-line no-console
    console.error(`Unknown argument: ${raw}`);
    process.exit(1);
  }
  return { commit, clubFilter };
}

// ---------------------------------------------------------------------------
// Sanitised display helpers.
// ---------------------------------------------------------------------------

interface EmployeeMini {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  employeeNumber: string;
  clubId: string;
  clubName: string;
}
function labelFor(emp: EmployeeMini): string {
  const display = emp.preferredName?.trim()
    ? `${emp.preferredName} ${emp.lastName}`
    : `${emp.firstName} ${emp.lastName}`;
  // Keep the printed record small — id last-8 + display name + Club +
  // employee number. Never print more; the printout is the artefact
  // the founder shares to remediate.
  return `${display} (#${emp.employeeNumber}) [emp:${emp.id.slice(-8)}] @ ${emp.clubName}`;
}

// ---------------------------------------------------------------------------
// SIN backfill.
// ---------------------------------------------------------------------------

async function backfillSin(args: CliArgs): Promise<{
  processed: number; wrote: number; conflicts: number;
}> {
  // eslint-disable-next-line no-console
  console.log("\n=== SIN backfill ===");

  const where: Record<string, unknown> = { sinFingerprint: null };
  if (args.clubFilter) {
    where.employee = { OR: [{ clubId: args.clubFilter }, { club: { slug: args.clubFilter } }] };
  }

  const rows = await prisma.employeeSensitiveIdentity.findMany({
    where,
    select: {
      id: true, employeeId: true, sinSecretRef: true, sinLastThree: true,
      employee: {
        select: {
          id: true, firstName: true, lastName: true, preferredName: true,
          employeeNumber: true, clubId: true,
          club: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Group by clubId so we can seek collisions.
  const seenByClub = new Map<string, Map<string, EmployeeMini[]>>();
  let processed = 0;
  let wrote = 0;
  let conflicts = 0;

  for (const row of rows) {
    if (!row.employee) continue;
    processed++;
    const emp: EmployeeMini = {
      id: row.employee.id,
      firstName: row.employee.firstName,
      lastName: row.employee.lastName,
      preferredName: row.employee.preferredName,
      employeeNumber: row.employee.employeeNumber,
      clubId: row.employee.clubId,
      clubName: row.employee.club?.name ?? "(unknown Club)",
    };

    let plaintext: string;
    try {
      plaintext = await decryptSecret({
        scope: "HR", secretReference: `sin:${emp.id}`,
        ciphertext: row.sinSecretRef, clubId: emp.clubId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[SIN] decrypt FAILED for ${labelFor(emp)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let fp: string;
    try {
      const normalised = normaliseSin(plaintext);
      fp = sinFingerprint(normalised);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[SIN] normalise FAILED for ${labelFor(emp)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Look up any existing employee in the same Club with this same
    // fingerprint (either freshly-written by this run or a row that
    // already had the fingerprint written).
    const clubMap = seenByClub.get(emp.clubId) ?? new Map();
    seenByClub.set(emp.clubId, clubMap);
    const priorSameFp = clubMap.get(fp);

    // Also check the persisted DB for the same fingerprint (a previous
    // run may have already written it for another employee).
    const dbConflict = await prisma.employeeSensitiveIdentity.findFirst({
      where: { clubId: emp.clubId, sinFingerprint: fp, employeeId: { not: emp.id } },
      select: { employeeId: true },
    });

    if (priorSameFp || dbConflict) {
      conflicts++;
      // eslint-disable-next-line no-console
      console.error(
        `[SIN CONFLICT] SIN last-3 ${row.sinLastThree ?? "???"}\n` +
        `  This row : ${labelFor(emp)}\n` +
        (priorSameFp
          ? `  Colliding with (in-run): ${priorSameFp.map(labelFor).join(", ")}\n`
          : "") +
        (dbConflict
          ? `  Colliding with (in DB) : employee emp:${dbConflict.employeeId.slice(-8)}\n`
          : "") +
        `  Action    : SKIPPED writing fingerprint. Human review required.\n`,
      );
      const list = priorSameFp ?? [];
      list.push(emp);
      clubMap.set(fp, list);
      continue;
    }
    clubMap.set(fp, [emp]);

    if (!args.commit) {
      // eslint-disable-next-line no-console
      console.log(`[SIN dry-run] would write fingerprint for ${labelFor(emp)}`);
      continue;
    }
    await prisma.employeeSensitiveIdentity.update({
      where: { employeeId: emp.id },
      data: { sinFingerprint: fp },
    });
    wrote++;
  }
  return { processed, wrote, conflicts };
}

// ---------------------------------------------------------------------------
// Bank backfill.
// ---------------------------------------------------------------------------

async function backfillBank(args: CliArgs): Promise<{
  processed: number; wrote: number; conflicts: number;
}> {
  // eslint-disable-next-line no-console
  console.log("\n=== Bank fingerprint backfill ===");

  const where: Record<string, unknown> = { bankFingerprint: null };
  if (args.clubFilter) {
    where.employee = { OR: [{ clubId: args.clubFilter }, { club: { slug: args.clubFilter } }] };
  }
  const rows = await prisma.employeeBankAccount.findMany({
    where,
    select: {
      id: true, employeeId: true, status: true,
      accountLastFour: true, holderName: true,
      institutionSecretRef: true, transitSecretRef: true, accountSecretRef: true,
      employee: {
        select: {
          id: true, firstName: true, lastName: true, preferredName: true,
          employeeNumber: true, clubId: true,
          club: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const seenByClub = new Map<string, Map<string, Array<{ emp: EmployeeMini; status: string }>>>();
  let processed = 0;
  let wrote = 0;
  let conflicts = 0;

  for (const row of rows) {
    if (!row.employee) continue;
    processed++;
    const emp: EmployeeMini = {
      id: row.employee.id,
      firstName: row.employee.firstName,
      lastName: row.employee.lastName,
      preferredName: row.employee.preferredName,
      employeeNumber: row.employee.employeeNumber,
      clubId: row.employee.clubId,
      clubName: row.employee.club?.name ?? "(unknown Club)",
    };

    let institution: string;
    let transit: string;
    let account: string;
    try {
      [institution, transit, account] = await Promise.all([
        decryptSecret({
          scope: "HR", secretReference: `bank:${emp.id}:institution`,
          ciphertext: row.institutionSecretRef, clubId: emp.clubId,
        }),
        decryptSecret({
          scope: "HR", secretReference: `bank:${emp.id}:transit`,
          ciphertext: row.transitSecretRef, clubId: emp.clubId,
        }),
        decryptSecret({
          scope: "HR", secretReference: `bank:${emp.id}:account`,
          ciphertext: row.accountSecretRef, clubId: emp.clubId,
        }),
      ]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[BANK] decrypt FAILED for ${labelFor(emp)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let fp: string;
    try {
      const triple = normaliseBankTriple({ institution, transit, account });
      fp = bankFingerprint(triple);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[BANK] normalise FAILED for ${labelFor(emp)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Only ACTIVE (PENDING_PENNY_TEST | VERIFIED) rows collide;
    // historical INACTIVE / REJECTED rows may share fingerprints.
    const isActive = row.status === "PENDING_PENNY_TEST" || row.status === "VERIFIED";
    const clubMap = seenByClub.get(emp.clubId) ?? new Map();
    seenByClub.set(emp.clubId, clubMap);
    const priorSameFp = clubMap.get(fp);

    const dbConflict = isActive
      ? await prisma.employeeBankAccount.findFirst({
          where: {
            clubId: emp.clubId,
            bankFingerprint: fp,
            employeeId: { not: emp.id },
            status: { in: ["PENDING_PENNY_TEST", "VERIFIED"] },
          },
          select: { employeeId: true, status: true },
        })
      : null;

    if (isActive && (priorSameFp?.some((p: { status: string }) => p.status === "PENDING_PENNY_TEST" || p.status === "VERIFIED") || dbConflict)) {
      conflicts++;
      // eslint-disable-next-line no-console
      console.error(
        `[BANK CONFLICT] account last-4 ${row.accountLastFour ?? "????"} · status ${row.status}\n` +
        `  This row : ${labelFor(emp)}\n` +
        (priorSameFp
          ? `  Colliding with (in-run): ${priorSameFp.map((p: { emp: EmployeeMini; status: string }) => `${labelFor(p.emp)}[${p.status}]`).join(", ")}\n`
          : "") +
        (dbConflict
          ? `  Colliding with (in DB) : employee emp:${dbConflict.employeeId.slice(-8)} [${dbConflict.status}]\n`
          : "") +
        `  Action    : SKIPPED writing fingerprint. Human review required.\n`,
      );
      const list = priorSameFp ?? [];
      list.push({ emp, status: row.status });
      clubMap.set(fp, list);
      continue;
    }
    const list = clubMap.get(fp) ?? [];
    list.push({ emp, status: row.status });
    clubMap.set(fp, list);

    if (!args.commit) {
      // eslint-disable-next-line no-console
      console.log(`[BANK dry-run] would write fingerprint for ${labelFor(emp)} · row ${row.id.slice(-8)} [${row.status}]`);
      continue;
    }
    await prisma.employeeBankAccount.update({
      where: { id: row.id },
      data: { bankFingerprint: fp },
    });
    wrote++;
  }
  return { processed, wrote, conflicts };
}

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  // eslint-disable-next-line no-console
  console.log(`HR fingerprint backfill · commit=${args.commit} · clubFilter=${args.clubFilter ?? "(all)"}`);

  const sinResult = await backfillSin(args);
  const bankResult = await backfillBank(args);

  // eslint-disable-next-line no-console
  console.log(`\n=== Summary ===`);
  // eslint-disable-next-line no-console
  console.log(`SIN  : processed=${sinResult.processed}, wrote=${sinResult.wrote}, conflicts=${sinResult.conflicts}`);
  // eslint-disable-next-line no-console
  console.log(`BANK : processed=${bankResult.processed}, wrote=${bankResult.wrote}, conflicts=${bankResult.conflicts}`);
  if (!args.commit) {
    // eslint-disable-next-line no-console
    console.log(`\n(dry-run — nothing written. Re-run with --commit to apply.)`);
  }
  if (sinResult.conflicts + bankResult.conflicts > 0) {
    // eslint-disable-next-line no-console
    console.log(`\nCONFLICTS DETECTED — review the sanitised report above and remediate interactively. Exiting non-zero.`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", err);
  process.exit(1);
});
