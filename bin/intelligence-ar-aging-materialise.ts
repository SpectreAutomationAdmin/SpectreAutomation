#!/usr/bin/env tsx
// Sprint 3 Checkpoint 15C (2026-07-24) — Founder-controlled AR-aging
// materialisation command. Staging-only. One-shot: exits cleanly on
// completion. Never installs itself as a daemon or scheduler.
//
// Usage:
//   npx tsx bin/intelligence-ar-aging-materialise.ts --club=<clubId> [--dry-run|--apply] [--limit=N] [--verbose]
//
// Aliases (kept for backward compatibility with 15B invocations):
//   --max=N   is a synonym for --limit=N
//
// Guards:
//   * refuses to run unless APP_URL contains "staging" or "localhost"
//   * requires --club and validates the club id exists
//   * default is dry-run — --apply required for real writes
//   * refuses Silver Springs by slug or name
//   * bounded by MAX_ACCOUNTS_PER_RUN (500)
//   * one-shot execution: no worker, no scheduler, no recurring job
//   * logs structured summary without member names / emails / balances

import { runArAgingMaterialisation } from "../src/lib/intelligence/materialisers/ar-aging";
import { prisma } from "../src/lib/prisma";

interface CliArgs {
  clubId: string;
  apply: boolean;
  limit: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let clubId: string | null = null;
  let apply = false;
  let limit = 500;
  let verbose = false;
  for (const arg of argv) {
    if (arg.startsWith("--club=")) clubId = arg.slice("--club=".length);
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--verbose") verbose = true;
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length)) || 500;
    else if (arg.startsWith("--max=")) limit = Number(arg.slice("--max=".length)) || 500;
  }
  if (!clubId) {
    console.error("REFUSED: --club=<clubId> is required.");
    process.exit(2);
  }
  return { clubId, apply, limit, verbose };
}

async function main() {
  const appUrl = process.env.APP_URL ?? "";
  if (!appUrl.includes("staging") && !appUrl.includes("localhost")) {
    console.error(`REFUSED: APP_URL does not indicate staging or localhost (${appUrl}).`);
    console.error("This command is staging-only. It will not run against production.");
    process.exit(3);
  }

  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  const club = await prisma.club.findUnique({
    where: { id: args.clubId },
    select: { id: true, slug: true, name: true },
  });
  if (!club) {
    console.error(`REFUSED: club not found: ${args.clubId}`);
    process.exit(4);
  }
  if (club.slug === "silver-springs" || club.name?.toLowerCase().includes("silver springs")) {
    console.error("REFUSED: Silver Springs data is out of scope for this checkpoint.");
    console.error("Use the dedicated Spectre staging platform club.");
    process.exit(5);
  }

  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `Running AR-aging materialisation · mode=${mode} · club=${club.slug} · limit=${args.limit}${args.verbose ? " · verbose" : ""}`,
  );

  const startedAt = process.hrtime.bigint();
  const result = await runArAgingMaterialisation({
    clubId: args.clubId,
    now,
    dryRun: !args.apply,
    maxAccounts: args.limit,
  });
  const finishedAt = process.hrtime.bigint();
  const executionMs = Number((finishedAt - startedAt) / BigInt(1_000_000));

  // Bounded per-intake breakdown for evidence in the closeout report.
  // Uses only counts + referenceId tails — never member names / emails.
  let perIntake: Array<{
    intakeIdTail: string;
    accountIdTail: string;
    originCount: number;
    activeFindings: number;
    supersededFindings: number;
    rejectedFindings: number;
  }> = [];
  if (args.verbose && args.apply) {
    const intakes = await prisma.workIntakeItem.findMany({
      where: {
        clubId: args.clubId,
        origins: { some: { kind: "MEMBER_ACCOUNT", role: "PRIMARY" } },
      },
      select: {
        id: true,
        origins: { where: { role: "PRIMARY", kind: "MEMBER_ACCOUNT" }, select: { referenceId: true } },
        _count: { select: { origins: true, findings: true } },
        findings: { select: { state: true } },
      },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    perIntake = intakes.map((i) => ({
      intakeIdTail: i.id.slice(-6),
      accountIdTail: i.origins[0]?.referenceId.slice(-6) ?? "n/a",
      originCount: i._count.origins,
      activeFindings: i.findings.filter((f) => f.state === "CONFIRMED" || f.state === "OBSERVED").length,
      supersededFindings: i.findings.filter((f) => f.state === "SUPERSEDED").length,
      rejectedFindings: i.findings.filter((f) => f.state === "USER_REJECTED").length,
    }));
  }

  console.log("\n=== MATERIALISATION RESULT ===");
  console.log(
    JSON.stringify(
      {
        clubSlug: club.slug,
        mode,
        runAt: result.runAt,
        executionMs,
        accountsExamined: result.accountsExamined,
        situationsMatched: result.situationsMatched,
        intakesCreated: result.intakesCreated,
        intakesReused: result.intakesReused,
        findingsCreated: result.findingsCreated,
        findingsPreserved: result.findingsPreserved,
        findingsSuperseded: result.findingsSuperseded,
        findingsRejectedPreserved: result.findingsRejectedPreserved,
        errorCount: result.errors.length,
        errorsSample: result.errors.slice(0, 3).map((e) => ({
          category: e.category,
          referenceIdTail: e.referenceId ? e.referenceId.slice(-6) : null,
          message: e.message.slice(0, 100),
        })),
        ...(args.verbose && args.apply ? { perIntake } : {}),
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("FATAL", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
