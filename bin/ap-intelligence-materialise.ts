#!/usr/bin/env tsx
// Sprint 3 Checkpoint 15E (2026-07-24) — Founder-controlled AP-invoice
// intelligence CLI. Staging-only.
//
// Usage:
//   npx tsx bin/ap-intelligence-materialise.ts --club=<clubId> [--dry-run|--apply] [--limit=N] [--verbose]

import { runApMaterialisation } from "../src/lib/ap-intelligence/materialise";
import { prisma } from "../src/lib/prisma";

async function main() {
  const appUrl = process.env.APP_URL ?? "";
  if (!appUrl.includes("staging") && !appUrl.includes("localhost")) {
    console.error(`REFUSED: APP_URL does not indicate staging or localhost (${appUrl}).`);
    process.exit(3);
  }

  const argv = process.argv.slice(2);
  let clubId: string | null = null;
  let apply = false;
  let limit = 200;
  let verbose = false;
  for (const a of argv) {
    if (a.startsWith("--club=")) clubId = a.slice("--club=".length);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--verbose") verbose = true;
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length)) || 200;
  }
  if (!clubId) { console.error("REFUSED: --club=<clubId> required"); process.exit(2); }

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, slug: true, name: true },
  });
  if (!club) { console.error(`REFUSED: club not found: ${clubId}`); process.exit(4); }
  if (club.slug === "silver-springs" || (club.name ?? "").toLowerCase().includes("silver springs")) {
    console.error("REFUSED: Silver Springs is out of scope");
    process.exit(5);
  }

  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`Running AP-invoice intelligence · mode=${mode} · club=${club.slug} · limit=${limit}${verbose ? " · verbose" : ""}`);
  const started = process.hrtime.bigint();
  const result = await runApMaterialisation({
    clubId,
    now: new Date(),
    dryRun: !apply,
    maxDocs: limit,
  });
  const ms = Number((process.hrtime.bigint() - started) / BigInt(1_000_000));

  console.log("\n=== AP-INVOICE MATERIALISATION RESULT ===");
  console.log(JSON.stringify({
    clubSlug: club.slug,
    mode,
    executionMs: ms,
    ...result,
    errorsSample: result.errors.slice(0, 3),
  }, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
