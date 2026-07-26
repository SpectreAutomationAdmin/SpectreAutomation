// One-shot reconcile for dining tables stuck in SEATED after every
// linked check has actually closed.
//
// Usage:
//   npm run pos:reconcile-tables -- --club silver-springs
//   npm run pos:reconcile-tables -- --club silver-springs --apply
//
// Defaults to dry-run. Pass --apply to actually mutate. A summary is
// printed in both modes; --apply also writes one audit row per change.
//
// The script loads a CLUB_ADMIN principal for the target club so the
// reconcile service's permission check + audit log carry a real actor.
// If no CLUB_ADMIN exists, the script exits non-zero and explains.

import { prisma } from "@/lib/prisma";
import { loadPrincipal } from "@/lib/rbac";
import { reconcileSettledTablesToDirty } from "@/lib/pos/reconcile-tables";

function flagValue(name: string): string | null {
  // Accepts `--name value` or `--name=value`.
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1] ?? null;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}
function hasFlag(name: string): boolean {
  return process.argv.slice(2).some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

async function main() {
  const clubSlug = flagValue("club");
  if (!clubSlug) {
    console.error("Missing --club <slug>. Example:");
    console.error("  npm run pos:reconcile-tables -- --club silver-springs");
    process.exit(2);
  }
  const apply = hasFlag("apply");

  // Resolve club by slug. We accept the literal slug OR the legacy
  // dash/space-flexible name lookup so "silver-springs" and the seed's
  // actual `slug` both work without a guessing game.
  const club =
    (await prisma.club.findFirst({ where: { slug: clubSlug } })) ??
    (await prisma.club.findFirst({
      where: { slug: clubSlug.replace(/-/g, "_") },
    })) ??
    (await prisma.club.findFirst({
      where: { name: { contains: clubSlug.replace(/-/g, " ") } },
    }));
  if (!club) {
    console.error(`No club matched "${clubSlug}".`);
    process.exit(1);
  }

  // Find a CLUB_ADMIN at this club so the reconcile service's
  // requirePermission check + audit trail carries a real actor.
  const adminRole = await prisma.userClubRole.findFirst({
    where: {
      clubId: club.id,
      roleKey: "CLUB_ADMIN",
      user: { status: "ACTIVE" },
    },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!adminRole) {
    console.error(`No active CLUB_ADMIN found at ${club.name} (${club.id}).`);
    console.error("Seed an admin first.");
    process.exit(1);
  }
  const principal = await loadPrincipal(adminRole.userId, club.id);
  if (!principal) {
    console.error(`Failed to load principal for user ${adminRole.userId}.`);
    process.exit(1);
  }

  const banner = apply ? "APPLY" : "DRY-RUN";
  console.log(`\n[${banner}] Reconciling dining tables stuck in SEATED at ${club.name} (${club.id})`);
  console.log(`        Actor: ${principal.email}`);
  console.log("");

  const result = await reconcileSettledTablesToDirty(principal, {
    clubId: club.id,
    apply,
  });

  console.log(`Tables scanned (status=SEATED):       ${result.tablesScanned}`);
  console.log(`Tables ${apply ? "changed" : "WOULD CHANGE"} to DIRTY: ${result.tablesChanged}`);
  if (result.tableNumbersChanged.length > 0) {
    console.log(`  → ${result.tableNumbersChanged.join(", ")}`);
  }
  if (result.skippedTables.length > 0) {
    console.log("");
    console.log("Skipped:");
    for (const s of result.skippedTables) {
      console.log(`  · ${s.tableNumber} (${s.status}) — ${s.reason}${s.detail ? `: ${s.detail}` : ""}`);
    }
  }

  if (!apply && result.tablesChanged > 0) {
    console.log("");
    console.log("Re-run with --apply to actually mutate. Example:");
    console.log(`  npm run pos:reconcile-tables -- --club ${clubSlug} --apply`);
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error("[pos:reconcile-tables] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
