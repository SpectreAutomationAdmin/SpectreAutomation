// Sprint 3 · Phase 4 Slice 5.7B follow-up (2026-08-09) — §3 §4
// one-time bounded repair script.
//
// Purpose: recover ProductReference rows that were written under
// `provider IN ('null', 'null-fallback')` — i.e. the worker had no
// PRODUCT_REFERENCE_API_KEY when it processed the research job — from
// their currently-poisoned FAILED_TERMINAL state to the corrected
// INFRASTRUCTURE_UNCONFIGURED sentinel.
//
// Founder amendment: preferred recovery is
//   FAILED_TERMINAL/null-provider → INFRASTRUCTURE_UNCONFIGURED
// (NOT directly PENDING). This lets the corrected state machine
// perform the normal enqueue transition on the next canonical
// analysis, proving the corrected semantics end-to-end.
//
// Safety invariants:
//   - Never touches rows whose `provider` is a real provider name
//     (e.g. `claude-web-search`). Those are genuine research
//     conclusions.
//   - Never touches rows with accepted external evidence
//     (identityEvidenceJson length > 0).
//   - Never touches invoices, work-intake items, IngestedDocuments,
//     accounting state, or COA.
//   - Dry-run is default; --apply is required to mutate.
//   - Prints normalizedKey only (never accounting/invoice IDs, which
//     don't exist on ProductReference anyway).
//
// Usage:
//   node -r ts-node/register scripts/repair-product-reference-null-provider.ts
//   node -r ts-node/register scripts/repair-product-reference-null-provider.ts --apply

import { PrismaClient } from "@prisma/client";

async function main() {
  const APPLY = process.argv.includes("--apply");

  const prisma = new PrismaClient();
  try {
    // Bounded query: FAILED_TERMINAL rows produced under a null
    // provider. `identityEvidenceJson = '[]'` is the SQL-side check
    // for "no accepted external evidence."
    const eligible = await prisma.productReference.findMany({
      where: {
        researchState: "FAILED_TERMINAL",
        provider: { in: ["null", "null-fallback"] },
        identityEvidenceJson: "[]",
      },
      select: {
        id: true,
        normalizedKey: true,
        researchState: true,
        provider: true,
        identityEvidenceJson: true,
        researchAttempts: true,
        lastResearchError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Also inspect (but never touch) genuine terminal rows for the audit trail.
    const genuineTerminal = await prisma.productReference.count({
      where: {
        researchState: { in: ["FAILED_TERMINAL", "NO_RESULT", "CONFLICTING_EVIDENCE"] },
        provider: { notIn: ["null", "null-fallback"] },
      },
    });

    const totalPr = await prisma.productReference.count();

    console.log("=".repeat(72));
    console.log("Repair dry-run — Slice 5.7B §3 §4 recovery");
    console.log("=".repeat(72));
    console.log(`ProductReference rows total          : ${totalPr}`);
    console.log(`Rows in genuine terminal (NOT TOUCHED): ${genuineTerminal}`);
    console.log(`Rows eligible for repair              : ${eligible.length}`);
    console.log("-".repeat(72));
    for (const row of eligible) {
      console.log(`  id=${row.id.slice(-8)} normalizedKey=${row.normalizedKey}`);
      console.log(`    current state=${row.researchState} provider=${row.provider}`);
      console.log(`    identityEvidenceCount=${JSON.parse(row.identityEvidenceJson).length ?? 0}`);
      console.log(`    attempts=${row.researchAttempts} lastError=${(row.lastResearchError ?? "").slice(0, 80)}`);
      console.log(`    proposed state=INFRASTRUCTURE_UNCONFIGURED (rerunnable via corrected state machine)`);
    }
    console.log("=".repeat(72));

    if (!APPLY) {
      console.log("DRY-RUN. Re-run with --apply to make the change.");
      return;
    }

    // Apply — one-shot, bounded. Never touches any other tables.
    const updated = await prisma.productReference.updateMany({
      where: {
        researchState: "FAILED_TERMINAL",
        provider: { in: ["null", "null-fallback"] },
        identityEvidenceJson: "[]",
      },
      data: {
        researchState: "INFRASTRUCTURE_UNCONFIGURED",
        lastResearchError: "repaired from FAILED_TERMINAL to INFRASTRUCTURE_UNCONFIGURED (Slice 5.7B §3 recovery)",
      },
    });
    console.log(`APPLIED. Rows transitioned: ${updated.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[repair] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
